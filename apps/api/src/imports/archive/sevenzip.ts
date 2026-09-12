import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { writeMappedArchiveStream } from './mapped-output.js';
import {
  ArchiveError,
  archiveAssert,
  parseArchiveListing,
  type ArchiveMember,
} from './inspection.js';
import {
  assertArchiveFreeSpace,
  assertArchiveRoot,
  scanArchiveTree,
  type ArchiveCodec,
  type ArchiveCodecInput,
} from './engine.js';

type ExtractInput = Parameters<ArchiveCodec['extract']>[0];
type NativeResult = { code: number; stdout: string; stderr: string };
export type SevenZipOptions = {
  binary: string;
  sandboxHelper?: string;
  pythonBinary?: string;
  timeoutMs?: number;
  /** Only the Windows synthetic fixture suite can opt out of the Linux helper. */
  allowUnsandboxedTests?: boolean;
};

export function sevenZipArguments(
  kind: 'list' | 'extract' | 'stream',
  input: ArchiveCodecInput & { outputRoot?: string },
): string[] {
  const flags = ['-sccUTF-8', '-bb0', '-bsp0', '-mmt=2'];
  if (kind === 'list') return ['l', '-slt', '-ba', ...flags, '--', input.entry];
  if (kind === 'stream') return ['x', '-so', '-bso2', '-bse2', ...flags, '--', input.entry];
  archiveAssert(input.outputRoot !== undefined, 'ARCHIVE_ROOT_INVALID');
  return ['x', '-y', '-aos', ...flags, `-o${input.outputRoot}`, '--', input.entry];
}

function classify(result: NativeResult, encrypted: boolean): void {
  if (result.code === 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  if (/ARCHIVE_SANDBOX_[A-Z_]+/.test(output)) throw new ArchiveError('ARCHIVE_SANDBOX_UNAVAILABLE');
  if (
    /wrong password|can not open encrypted archive|cannot open encrypted archive/i.test(output) ||
    (encrypted && /data error|crc failed/i.test(output))
  )
    throw new ArchiveError('ARCHIVE_PASSWORD_REJECTED');
  if (/unexpected end|missing volume|can not find volume|cannot find volume/i.test(output))
    throw new ArchiveError('ARCHIVE_VOLUME_MISSING_OR_DAMAGED');
  if (
    /unsupported method|unsupported archive|can not open.*as archive|cannot open.*as archive/i.test(
      output,
    )
  )
    throw new ArchiveError('ARCHIVE_FORMAT_UNSUPPORTED');
  if (/not enough memory|cannot allocate memory|can't allocate/i.test(output) || result.code === 8)
    throw new ArchiveError('ARCHIVE_MEMORY_LIMIT');
  throw new ArchiveError('ARCHIVE_DATA_DAMAGED');
}

/** Native output remains private; only fixed codes and parsed inventory escape. */
export class SevenZipArchiveCodec implements ArchiveCodec {
  constructor(private readonly options: SevenZipOptions) {}

  async list(input: ArchiveCodecInput): Promise<ArchiveMember[]> {
    const result = await this.run('list', input);
    classify(result, false);
    return parseArchiveListing(result.stdout);
  }

  async extract(input: ExtractInput): Promise<void> {
    const mapped = input.members.some((member) => member.sourcePath !== undefined);
    const result = await this.run(
      'extract',
      input,
      mapped
        ? (stream) =>
            writeMappedArchiveStream({
              root: input.outputRoot,
              members: input.members,
              stream,
              maxBytes: input.maxBytes,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            })
        : undefined,
    );
    classify(
      result,
      input.members.some((member) => member.encrypted),
    );
  }

  private async run(
    kind: 'list' | 'extract',
    input: ArchiveCodecInput | ExtractInput,
    consumeStdout?: (stream: Readable) => Promise<void>,
  ): Promise<NativeResult> {
    input.signal?.throwIfAborted();
    const root = await assertArchiveRoot(input.inputRoot);
    const entry = await realpath(input.entry);
    const info = await lstat(input.entry);
    archiveAssert(
      info.isFile() && !info.isSymbolicLink() && entry.startsWith(root + path.sep),
      'ARCHIVE_ROOT_INVALID',
    );
    archiveAssert(
      !/[\r\n\0]/.test(input.password) && input.password.length <= 256,
      'ARCHIVE_CREDENTIAL_INVALID',
    );
    const extract = kind === 'extract' ? (input as ExtractInput) : null;
    if (extract !== null) {
      const output = await assertArchiveRoot(extract.outputRoot);
      archiveAssert(
        output !== root &&
          !output.startsWith(root + path.sep) &&
          !root.startsWith(output + path.sep),
        'ARCHIVE_ROOT_INVALID',
      );
      archiveAssert((await scanArchiveTree(output, 1)).length === 0, 'ARCHIVE_OUTPUT_NOT_EMPTY');
    }
    archiveAssert(path.isAbsolute(this.options.binary), 'ARCHIVE_TOOL_UNAVAILABLE');
    const args = sevenZipArguments(consumeStdout === undefined ? kind : 'stream', input);
    let command = this.options.binary,
      nativeArgs = args;
    if (!(
      process.platform === 'win32' &&
      process.env['NODE_ENV'] === 'test' &&
      this.options.allowUnsandboxedTests === true
    )) {
      archiveAssert(
        process.platform === 'linux' &&
          this.options.sandboxHelper !== undefined &&
          path.isAbsolute(this.options.sandboxHelper),
        'ARCHIVE_SANDBOX_UNAVAILABLE',
      );
      command = this.options.pythonBinary ?? '/usr/bin/python3';
      nativeArgs = [
        '-I',
        this.options.sandboxHelper,
        '--binary',
        this.options.binary,
        '--input',
        root,
        ...(extract === null || consumeStdout !== undefined
          ? []
          : ['--output', extract.outputRoot, '--max-file-bytes', extract.maxBytes]),
        '--',
        ...args,
      ];
    }
    const timeoutMs =
      kind === 'list'
        ? Math.min(this.options.timeoutMs ?? 120000, 120000)
        : (this.options.timeoutMs ?? 6 * 60 * 60 * 1000);
    archiveAssert(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 24 * 60 * 60 * 1000,
      'ARCHIVE_LIMIT_INVALID',
    );
    return new Promise<NativeResult>((resolve, reject) => {
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let stdoutBytes = 0,
        stderrBytes = 0,
        failure: Error | null = null;
      let checking: Promise<void> | null = null;
      const child = spawn(command, nativeArgs, {
        cwd: root,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Do not inherit OAuth/master keys, service settings or credential paths.
        env: {
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          ...(process.platform === 'win32'
            ? { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows' }
            : {}),
        },
      });
      const stop = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const abort = () => stop(new DOMException('Archive operation aborted', 'AbortError'));
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
      const timeout = setTimeout(() => stop(new ArchiveError('ARCHIVE_TIME_LIMIT')), timeoutMs);
      const monitor =
        extract === null
          ? null
          : setInterval(() => {
              if (checking !== null || failure !== null) return;
              checking = (async () => {
                await assertArchiveFreeSpace(extract.outputRoot, 0n, BigInt(extract.reserveBytes));
                const files = await scanArchiveTree(extract.outputRoot, extract.maxFiles);
                const used = files.reduce((sum, file) => sum + BigInt(file.size), 0n);
                archiveAssert(used <= BigInt(extract.maxBytes), 'ARCHIVE_EXPANSION_LIMIT');
                await extract.onProgress?.(used.toString());
              })()
                .catch((error: unknown) =>
                  stop(
                    error instanceof ArchiveError
                      ? error
                      : new ArchiveError('ARCHIVE_OUTPUT_INVALID'),
                  ),
                )
                .finally(() => {
                  checking = null;
                });
            }, 500);
      const streamed = consumeStdout?.(child.stdout).catch((error: unknown) => {
        stop(error instanceof ArchiveError ? error : new ArchiveError('ARCHIVE_OUTPUT_INVALID'));
      });
      if (consumeStdout === undefined)
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > 32 * 1024 * 1024) stop(new ArchiveError('ARCHIVE_LIST_LIMIT'));
          else stdout.push(chunk);
        });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 128 * 1024) stop(new ArchiveError('ARCHIVE_DIAGNOSTIC_LIMIT'));
        else stderr.push(chunk);
      });
      child.stdin.on('error', () => {
        /* A tool that needs no password can exit before the pipe drains. */
      });
      child.once('error', () => {
        failure ??= new ArchiveError('ARCHIVE_TOOL_UNAVAILABLE');
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (monitor !== null) clearInterval(monitor);
        input.signal?.removeEventListener('abort', abort);
        void (async () => {
          await checking;
          await streamed;
          if (
            consumeStdout !== undefined &&
            failure instanceof ArchiveError &&
            failure.code === 'ARCHIVE_OUTPUT_MISMATCH' &&
            code !== 0
          ) {
            try {
              classify(
                { code: code ?? -1, stdout: '', stderr: Buffer.concat(stderr).toString('utf8') },
                extract?.members.some((member) => member.encrypted) ?? false,
              );
            } catch (error) {
              reject(error instanceof Error ? error : new ArchiveError('ARCHIVE_DATA_DAMAGED'));
              return;
            }
          }
          if (failure !== null) reject(failure);
          else
            resolve({
              code: code ?? -1,
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
            });
        })();
      });
      // Deliberately no -p switch: an empty -p means an empty password, not a prompt.
      child.stdin.end(input.password + '\n', 'utf8');
    });
  }
}
