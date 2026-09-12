import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_PRIVATE_JSON_BYTES = 2 * 1024 * 1024;

/** Never repair someone else's directory permissions or follow a redirected setup directory. */
export function ensurePrivateDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const chain: string[] = [];
  let current = absolute;
  while (path.dirname(current) !== current) {
    chain.unshift(current);
    current = path.dirname(current);
  }
  for (const entry of chain) {
    if (!existsSync(entry)) mkdirSync(entry, { mode: 0o700 });
    const stats = lstatSync(entry);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('SETUP_FILE_UNSAFE');
  }
  if (process.platform !== 'win32' && (lstatSync(absolute).mode & 0o077) !== 0) {
    throw new Error('SETUP_FILE_NOT_PRIVATE');
  }
}

export function readPrivateText(filename: string, maxBytes = MAX_PRIVATE_JSON_BYTES): string {
  const before = lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('SETUP_FILE_UNSAFE');
  }
  if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) {
    throw new Error('SETUP_FILE_NOT_PRIVATE');
  }
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(fd);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || before.ino !== actual.ino || before.dev !== actual.dev || !actual.isFile() || actual.nlink !== 1 || actual.size > maxBytes || actual.size !== before.size || (process.platform !== 'win32' && (actual.mode & 0o077) !== 0)) {
      throw new Error('SETUP_FILE_UNSAFE');
    }
    const buffer = Buffer.alloc(actual.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(fd, buffer, length, buffer.length - length, length);
      if (bytes === 0) break;
      length += bytes;
    }
    const after = fstatSync(fd);
    if (length !== actual.size || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs) throw new Error('SETUP_FILE_UNSAFE');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

export function readPrivateJson(filename: string): unknown {
  const text = readPrivateText(filename);
  try { return JSON.parse(text) as unknown; } catch { throw new Error('SETUP_FILE_INVALID'); }
}

export function writePrivateJson(filename: string, value: unknown): void {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new Error('SETUP_FILE_INVALID');
  writePrivateText(filename, `${serialized}\n`);
}

export function writePrivateText(filename: string, payload: string): void {
  if (Buffer.byteLength(payload, 'utf8') > MAX_PRIVATE_JSON_BYTES) throw new Error('SETUP_FILE_TOO_LARGE');
  const directory = path.dirname(filename);
  ensurePrivateDirectory(directory);
  if (existsSync(filename)) readPrivateText(filename);
  // lstat still detects a dangling link, which existsSync deliberately follows.
  try {
    if (lstatSync(filename).isSymbolicLink()) throw new Error('SETUP_FILE_UNSAFE');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path.join(directory, `.setup-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let renamed = false;
  try {
    try {
      if (process.platform !== 'win32') {
        fchmodSync(fd, 0o600);
        if (process.geteuid?.() === 0) {
          const owner = lstatSync(directory);
          fchownSync(fd, owner.uid, owner.gid);
        }
      }
      writeFileSync(fd, payload, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, filename);
    renamed = true;
    if (process.platform !== 'win32') {
      const dirFd = openSync(directory, constants.O_RDONLY);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } finally {
    if (!renamed && existsSync(temporary)) unlinkSync(temporary);
  }
}
