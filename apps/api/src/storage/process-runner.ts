import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import {
  NativeRcloneConfigCoordinator,
  type NativeConfigOptions,
  type NativeCredentialBinding,
} from './rclone-native-config.js';

export type ProcessSpec = {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStderrLine?: (line: string) => void;
  /** Internal capability metadata; never converted to argv/environment. */
  rcloneCredentialBindings?: readonly NativeCredentialBinding[];
  onSpawn?: (pid: number | undefined) => void;
};

export type ProcessResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
};

const secretFlags = new Set(['--password', '--rc-pass', '--config']);

const MAX_OUTPUT_BYTES = 1_048_576;
export const PROCESS_ABORT_TERMINATE_GRACE_MS = 5_000;

type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>;

type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string | undefined;
    env: NodeJS.ProcessEnv | undefined;
    shell: false;
    windowsHide: true;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => SpawnedProcess;

export type ProcessRunnerOptions = {
  spawnProcess?: SpawnProcess;
  terminateGraceMs?: number;
  nativeConfig?: NativeConfigOptions;
};

/**
 * The external-process capability that higher layers depend on. Depending on the
 * interface (not the concrete {@link ProcessRunner}) lets tests substitute a fake
 * that records argv and returns canned output without spawning anything.
 */
export interface CommandRunner {
  run(spec: ProcessSpec, maxOutputBytes?: number): Promise<ProcessResult>;
  streamStdout(spec: ProcessSpec): { stream: Readable; completed: Promise<ProcessResult> };
  recoverRcloneConfig?(filename: string): Promise<void>;
}

export function redactedCommand(spec: ProcessSpec): string {
  const redacted: string[] = [];
  for (let index = 0; index < spec.args.length; index += 1) {
    const value = spec.args[index] ?? '';
    redacted.push(value);
    if ((secretFlags.has(value) || value === 'obscure') && index + 1 < spec.args.length) {
      redacted.push('[REDACTED]');
      index += 1;
    }
  }
  return [spec.executable, ...redacted].join(' ');
}

export class ProcessRunner implements CommandRunner {
  private readonly spawnProcess: SpawnProcess;
  private readonly terminateGraceMs: number;
  private readonly nativeConfig: NativeRcloneConfigCoordinator;

  constructor(options: ProcessRunnerOptions = {}) {
    this.nativeConfig = new NativeRcloneConfigCoordinator(options.nativeConfig);
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, args, spawnOptions) => spawn(executable, [...args], spawnOptions));
    this.terminateGraceMs = options.terminateGraceMs ?? PROCESS_ABORT_TERMINATE_GRACE_MS;
    if (!Number.isSafeInteger(this.terminateGraceMs) || this.terminateGraceMs < 0) {
      throw new Error('INVALID_PROCESS_TERMINATE_GRACE');
    }
  }

  async run(spec: ProcessSpec, maxOutputBytes = MAX_OUTPUT_BYTES): Promise<ProcessResult> {
    return this.nativeConfig.run(spec, (privateSpec) =>
      this.runNative(privateSpec, maxOutputBytes),
    );
  }

  async recoverRcloneConfig(filename: string): Promise<void> {
    await this.nativeConfig.recover(filename);
  }

  private async runNative(spec: ProcessSpec, maxOutputBytes: number): Promise<ProcessResult> {
    const child = this.spawnProcess(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const termination = this.watchTermination(child, spec.signal);
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) return;
      const remaining = maxOutputBytes - stdoutBytes;
      const kept = chunk.subarray(0, remaining);
      stdout.push(kept);
      stdoutBytes += kept.length;
    });
    child.stderr.setEncoding('utf8');
    let pendingLine = '';
    let lineError: unknown;
    const deliverLine = (line: string): void => {
      if (!spec.onStderrLine || lineError !== undefined) return;
      try {
        spec.onStderrLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      } catch (error) {
        lineError = error;
        termination.terminate();
      }
    };
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-maxOutputBytes);
      if (!spec.onStderrLine || lineError !== undefined) return;
      pendingLine += chunk;
      if (pendingLine.length > maxOutputBytes) {
        lineError = new Error('PROCESS_STDERR_LINE_TOO_LONG');
        termination.terminate();
        return;
      }
      const lines = pendingLine.split('\n');
      pendingLine = lines.pop() ?? '';
      for (const line of lines) deliverLine(line);
    });
    let processError: Error | undefined;
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', (error) => {
        // `error` can also mean a failed kill. It is not proof that a process
        // which already spawned has exited, so settle only after `close`.
        processError = error;
      });
      child.once('close', (code) => {
        const abortError = termination.abortError();
        termination.cleanup();
        if (pendingLine !== '') deliverLine(pendingLine);
        if (lineError !== undefined) {
          reject(
            lineError instanceof Error
              ? lineError
              : new Error('PROCESS_STDERR_CALLBACK_FAILED', { cause: lineError }),
          );
          return;
        }
        if (processError) {
          reject(processError);
          return;
        }
        if (abortError) {
          reject(abortError);
          return;
        }
        resolve(code ?? -1);
      });
      spec.onSpawn?.(child.pid);
    });
    return { exitCode, stdout: Buffer.concat(stdout), stderr };
  }

  streamStdout(spec: ProcessSpec): { stream: Readable; completed: Promise<ProcessResult> } {
    return this.nativeConfig.stream(spec, (privateSpec) => this.streamNative(privateSpec));
  }

  private streamNative(spec: ProcessSpec): { stream: Readable; completed: Promise<ProcessResult> } {
    const output = new PassThrough();
    const child = this.spawnProcess(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const termination = this.watchTermination(child, spec.signal);
    child.stdout.pipe(output);
    let stderr = '';
    let pendingLine = '';
    let lineError: unknown;
    const deliverLine = (line: string): void => {
      if (!spec.onStderrLine || lineError !== undefined) return;
      try {
        spec.onStderrLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      } catch (error) {
        lineError = error;
        termination.terminate();
      }
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES);
      if (!spec.onStderrLine || lineError !== undefined) return;
      pendingLine += chunk;
      if (pendingLine.length > MAX_OUTPUT_BYTES) {
        lineError = new Error('PROCESS_STDERR_LINE_TOO_LONG');
        termination.terminate();
        return;
      }
      const lines = pendingLine.split('\n');
      pendingLine = lines.pop() ?? '';
      for (const line of lines) deliverLine(line);
    });
    let processError: Error | undefined;
    const completed = new Promise<ProcessResult>((resolve, reject) => {
      child.once('error', (error) => {
        processError = error;
        output.destroy(error);
      });
      child.once('close', (code) => {
        const abortError = termination.abortError();
        termination.cleanup();
        if (pendingLine !== '') deliverLine(pendingLine);
        if (lineError !== undefined) {
          reject(
            lineError instanceof Error ? lineError : new Error('PROCESS_STDERR_CALLBACK_FAILED'),
          );
          return;
        }
        if (processError) {
          reject(processError);
          return;
        }
        if (abortError) {
          reject(abortError);
          return;
        }
        resolve({ exitCode: code ?? -1, stdout: Buffer.alloc(0), stderr });
      });
      spec.onSpawn?.(child.pid);
    });
    return { stream: output, completed };
  }

  private watchTermination(
    child: SpawnedProcess,
    signal?: AbortSignal,
  ): {
    terminate(): void;
    abortError(): Error | null;
    cleanup(): void;
  } {
    let closed = false;
    let terminationStarted = false;
    let forcedTimer: ReturnType<typeof setTimeout> | undefined;
    let observedAbort: Error | null = null;

    const terminate = (): void => {
      if (closed || terminationStarted) return;
      terminationStarted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Still arm the force step: a platform-specific graceful signal failure
        // is not evidence that the child has exited.
      }
      forcedTimer = setTimeout(() => {
        if (closed) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // Completion remains pending until `close`; never fabricate an exit.
        }
      }, this.terminateGraceMs);
    };
    const onAbort = (): void => {
      observedAbort = abortReason(signal);
      terminate();
    };
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (forcedTimer !== undefined) clearTimeout(forcedTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    // Defer an already-aborted signal until run()/streamStdout() has attached
    // its close/error listeners. A test double may emit `close` synchronously
    // from kill(), and observing that close is part of the drain guarantee.
    if (signal?.aborted) queueMicrotask(onAbort);
    return {
      terminate,
      abortError: () => observedAbort,
      cleanup,
    };
  }
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}
