import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync } from 'node:fs';
import { lstat, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';

export const MAX_RCLONE_CONFIG_BYTES = 4 * 1024 * 1024;
export class RcloneConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RcloneConfigError';
  }
}
export const configDigest = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}
export async function readRcloneConfig(filename: string): Promise<string> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RCLONE_CONFIG_BYTES)
    throw new RcloneConfigError('RCLONE_CONFIG_INVALID');
  const value = await readFile(filename, 'utf8');
  if (Buffer.byteLength(value) > MAX_RCLONE_CONFIG_BYTES)
    throw new RcloneConfigError('RCLONE_CONFIG_INVALID');
  return value;
}
export async function syncPrivateFile(filename: string): Promise<void> {
  const handle = await open(filename, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export function syncConfigDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EACCES', 'EBADF', 'EISDIR', 'EINVAL', 'EPERM'].some((code) => hasCode(error, code))
    )
      throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Shared by provision and all product native-process snapshot/commit paths.
 * Only file/credential critical sections enter it; never an upload or mount body. */
export async function withRcloneConfigLock<T>(
  filename: string,
  action: (canonical: string) => Promise<T>,
): Promise<T> {
  const canonical = await realpath(filename);
  // SQLite's OS-backed RESERVED lock is released by a crashed owner, unlike an
  // O_EXCL sentinel. Timeout zero + async retries avoid blocking this Node event
  // loop while another local invocation is inside an async file critical section.
  // This sidecar contains no credentials and is not the application's database.
  // Do not unlink it: unlink/recreate would split lock identity for live peers.
  const lock = `${canonical}.ptvault-config-lock.sqlite3`;
  try {
    await lstat(`${canonical}.ptvault-write-lock`);
    throw new RcloneConfigError('RCLONE_CONFIG_LEGACY_OWNER_DRAIN_REQUIRED');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  try {
    const file = await open(lock, 'wx', 0o600);
    await file.close();
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  const info = await lstat(lock);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new RcloneConfigError('RCLONE_CONFIG_LOCK_INVALID');
  const mutex = new Database(lock, { timeout: 0 });
  const deadline = Date.now() + 5_000;
  try {
    while (!mutex.inTransaction) {
      try {
        mutex.exec('BEGIN IMMEDIATE');
      } catch (error) {
        if (!hasCode(error, 'SQLITE_BUSY') || Date.now() >= deadline)
          throw new RcloneConfigError('RCLONE_CONFIG_FENCE_REJECTED');
        await delay(10);
      }
    }
    return await action(canonical);
  } finally {
    try {
      if (mutex.inTransaction) mutex.exec('ROLLBACK');
    } finally {
      mutex.close();
    }
  }
}

/** The final rename executes synchronously inside the caller's SQLite IMMEDIATE
 * transaction, so DB authority cannot change across a file-publication await. */
export async function prepareRcloneConfigSwap(
  filename: string,
  contents: string,
  expected: string,
): Promise<{ apply(): void; dispose(): Promise<void> }> {
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${randomUUID()}.swap`,
  );
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  await syncPrivateFile(temporary);
  return {
    apply() {
      if (configDigest(readFileSync(filename)) !== configDigest(expected))
        throw new RcloneConfigError('RCLONE_CONFIG_FENCE_REJECTED');
      renameSync(temporary, filename);
      syncConfigDirectory(path.dirname(filename));
    },
    async dispose() {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    },
  };
}

export type RcloneSections = Map<string, Map<string, string>>;
export function parseRcloneConfig(source: string): RcloneSections {
  const result: RcloneSections = new Map();
  let section: Map<string, string> | undefined;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (header !== null) {
      if (result.has(header[1]!)) throw new RcloneConfigError('RCLONE_CONFIG_INVALID');
      section = new Map();
      result.set(header[1]!, section);
      continue;
    }
    const field = /^([A-Za-z0-9_]+)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (field === null || section === undefined || section.has(field[1]!))
      throw new RcloneConfigError('RCLONE_CONFIG_INVALID');
    section.set(field[1]!, field[2]!.trim());
  }
  return result;
}
export function sectionIdentity(fields: ReadonlyMap<string, string>): string {
  return JSON.stringify(
    [...fields].filter(([key]) => key !== 'token').sort(([a], [b]) => a.localeCompare(b)),
  );
}
export function setRcloneToken(source: string, alias: string, token: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(alias) || /[\r\n\0]/.test(token))
    throw new RcloneConfigError('RCLONE_CONFIG_INVALID');
  const header = new RegExp(`^\\[${alias}\\][ \\t]*(?:\\r?\\n|$)`, 'm').exec(source);
  if (header === null) throw new RcloneConfigError('RCLONE_CONFIG_FENCE_REJECTED');
  const start = header.index + header[0].length;
  const next = /^\[[^\]\r\n]+\]/m.exec(source.slice(start));
  const end = next === null ? source.length : start + next.index;
  let body = source.slice(start, end);
  const field = /^[ \t]*token[ \t]*=.*$/m;
  body = field.test(body)
    ? body.replace(field, () => `token = ${token}`)
    : `${body}${body.endsWith('\n') ? '' : '\n'}token = ${token}\n`;
  return source.slice(0, start) + body + source.slice(end);
}
