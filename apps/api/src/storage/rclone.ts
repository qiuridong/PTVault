import type { Readable } from 'node:stream';
import path from 'node:path';

import type { CommandRunner, ProcessResult } from './process-runner.js';

const REMOTE_ALIAS = /^[A-Za-z0-9_-]+:$/;
const ENCODE_BATCH_CHAR_LIMIT = 24_000;

export interface RcloneControl {
  listRemotes(): Promise<Set<string>>;
  about(remote: string): Promise<{ total: number | null; free: number | null }>;
  encodePaths(remote: string, plaintextPaths: readonly string[]): Promise<string[]>;
  stat(remotePath: string, signal?: AbortSignal): Promise<{ size: number; name: string } | null>;
  copy(
    source: string,
    destination: string,
    signal: AbortSignal,
    onProgress?: RcloneProgressCallback,
  ): Promise<void>;
  move(source: string, destination: string, signal: AbortSignal): Promise<void>;
  deleteFile(remotePath: string, signal: AbortSignal): Promise<void>;
  cat(
    remotePath: string,
    signal: AbortSignal,
  ): { stream: Readable; completed: Promise<ProcessResult> };
}

export type RcloneClientOptions = {
  runner: CommandRunner;
  executable: string;
  configPath: string;
};

export type RcloneProgress = { bytesDone: string };
export type RcloneProgressCallback = (progress: RcloneProgress) => void;

export class RcloneError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'RcloneError';
  }
}

/**
 * Split a remote path such as `crypt-a:library/movie.mkv` into its alias
 * (`crypt-a:`) and the path within the remote (`library/movie.mkv`). The alias
 * — everything up to and including the first colon — is validated against the
 * strict rclone alias grammar so a caller can never inject flags or a second
 * remote through the path segment.
 */
function splitRemotePath(remotePath: string): { alias: string; rest: string } {
  const colon = remotePath.indexOf(':');
  if (colon === -1) {
    throw new RcloneError(`invalid remote alias: ${remotePath}`, -1);
  }
  const alias = remotePath.slice(0, colon + 1);
  assertAlias(alias);
  return { alias, rest: remotePath.slice(colon + 1) };
}

function assertAlias(remote: string): void {
  if (!REMOTE_ALIAS.test(remote)) {
    throw new RcloneError(`invalid remote alias: ${remote}`, -1);
  }
}

function assertPlaintextPath(plaintextPath: string): void {
  const segments = plaintextPath.split(/[\\/]/);
  if (
    plaintextPath.length === 0 ||
    plaintextPath.includes('\0') ||
    path.posix.isAbsolute(plaintextPath) ||
    path.win32.isAbsolute(plaintextPath) ||
    segments.includes('..')
  ) {
    throw new RcloneError('invalid plaintext path for rclone encoder', -1);
  }
}

function encodeArgumentCost(value: string): number {
  let escapedCharacters = 0;
  for (const character of value) {
    if (character === '"' || character === '\\') escapedCharacters += 1;
  }
  return value.length + escapedCharacters + 3;
}

function batchEncodePaths(plaintextPaths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let characters = 0;

  for (const plaintextPath of plaintextPaths) {
    const cost = encodeArgumentCost(plaintextPath);
    if (batch.length > 0 && characters + cost > ENCODE_BATCH_CHAR_LIMIT) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(plaintextPath);
    characters += cost;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export class RcloneClient implements RcloneControl {
  private readonly runner: CommandRunner;
  private readonly executable: string;
  private readonly configPath: string;

  constructor(options: RcloneClientOptions) {
    this.runner = options.runner;
    this.executable = options.executable;
    this.configPath = options.configPath;
  }

  private baseArgs(): string[] {
    return ['--config', this.configPath];
  }

  async listRemotes(): Promise<Set<string>> {
    const result = await this.runner.run({
      executable: this.executable,
      args: [...this.baseArgs(), 'listremotes'],
    });
    this.assertOk(result, 'listremotes');
    const remotes = result.stdout
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return new Set(remotes);
  }

  async about(remote: string): Promise<{ total: number | null; free: number | null }> {
    assertAlias(remote);
    const result = await this.runner.run({
      executable: this.executable,
      args: [...this.baseArgs(), 'about', '--json', remote],
    });
    this.assertOk(result, 'about');
    const parsed = JSON.parse(result.stdout.toString('utf8')) as {
      total?: number;
      free?: number;
    };
    return {
      total: typeof parsed.total === 'number' ? parsed.total : null,
      free: typeof parsed.free === 'number' ? parsed.free : null,
    };
  }

  async encodePaths(remote: string, plaintextPaths: readonly string[]): Promise<string[]> {
    assertAlias(remote);
    for (const plaintextPath of plaintextPaths) assertPlaintextPath(plaintextPath);

    const encodedPaths: string[] = [];
    for (const batch of batchEncodePaths(plaintextPaths)) {
      const result = await this.runner.run({
        executable: this.executable,
        args: [...this.baseArgs(), 'backend', 'encode', remote, '--json', '--', ...batch],
      });
      this.assertOk(result, 'backend encode');

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout.toString('utf8')) as unknown;
      } catch {
        throw new RcloneError('invalid rclone encoder output', -1);
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length !== batch.length ||
        !parsed.every((value): value is string => typeof value === 'string')
      ) {
        throw new RcloneError('invalid rclone encoder output', -1);
      }
      encodedPaths.push(...parsed);
    }
    return encodedPaths;
  }

  async stat(
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<{ size: number; name: string } | null> {
    splitRemotePath(remotePath);
    const result = await this.runner.run({
      executable: this.executable,
      args: [...this.baseArgs(), 'lsjson', '--stat', remotePath],
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) {
      // A missing object is not an error condition for stat; the caller
      // interprets null as absence. Genuine failures still surface through the
      // verifier, which requires a present object before trusting a replica.
      return null;
    }
    const parsed = JSON.parse(result.stdout.toString('utf8')) as {
      Name?: string;
      Size?: number;
      IsDir?: boolean;
    };
    if (typeof parsed.Size !== 'number' || typeof parsed.Name !== 'string') {
      return null;
    }
    return { size: parsed.Size, name: parsed.Name };
  }

  async copy(
    source: string,
    destination: string,
    signal: AbortSignal,
    onProgress?: RcloneProgressCallback,
  ): Promise<void> {
    if (path.isAbsolute(source)) {
      if (source.includes('\0')) throw new RcloneError('invalid local source path', -1);
    } else {
      splitRemotePath(source);
    }
    if (path.isAbsolute(destination)) {
      if (destination.includes('\0')) throw new RcloneError('invalid local destination path', -1);
    } else {
      splitRemotePath(destination);
    }
    const progressArgs = onProgress
      ? ['--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE']
      : [];
    const result = await this.runner.run({
      executable: this.executable,
      args: [...this.baseArgs(), ...progressArgs, 'copyto', source, destination],
      signal,
      ...(onProgress
        ? { onStderrLine: (line: string) => this.parseProgressLine(line, onProgress) }
        : {}),
    });
    this.assertOk(result, 'copyto');
  }

  async move(source: string, destination: string, signal: AbortSignal): Promise<void> {
    splitRemotePath(source);
    splitRemotePath(destination);
    const result = await this.runner.run({
      executable: this.executable,
      args: [...this.baseArgs(), 'moveto', source, destination],
      signal,
    });
    this.assertOk(result, 'moveto');
  }

  async deleteFile(remotePath: string, signal: AbortSignal): Promise<void> {
    splitRemotePath(remotePath);
    const result = await this.runner.run({
      executable: this.executable,
      args: [...this.baseArgs(), 'deletefile', remotePath],
      signal,
    });
    this.assertOk(result, 'deletefile');
  }

  cat(
    remotePath: string,
    signal: AbortSignal,
  ): { stream: Readable; completed: Promise<ProcessResult> } {
    splitRemotePath(remotePath);
    return this.runner.streamStdout({
      executable: this.executable,
      args: [...this.baseArgs(), 'cat', remotePath],
      signal,
    });
  }

  private assertOk(result: ProcessResult, operation: string): void {
    if (result.exitCode !== 0) {
      throw new RcloneError(
        `rclone ${operation} failed with exit code ${result.exitCode}`,
        result.exitCode,
      );
    }
  }

  private parseProgressLine(line: string, onProgress: RcloneProgressCallback): void {
    let parsed: unknown;
    try {
      const lossless = line.replace(/("(?:bytes|totalBytes)"\s*:\s*)(-?[0-9]+)/g, '$1"$2"');
      parsed = JSON.parse(lossless) as unknown;
    } catch {
      throw new Error('RCLONE_PROGRESS_INVALID');
    }
    if (!parsed || typeof parsed !== 'object' || !('stats' in parsed)) return;
    const stats = (parsed as { stats?: unknown }).stats;
    if (!stats || typeof stats !== 'object') throw new Error('RCLONE_PROGRESS_INVALID');
    const bytes = (stats as { bytes?: unknown }).bytes;
    if (typeof bytes !== 'string' || !/^(?:0|[1-9][0-9]{0,29})$/.test(bytes)) {
      throw new Error('RCLONE_PROGRESS_INVALID');
    }
    onProgress({ bytesDone: bytes });
  }
}
