import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export type StableFileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
};

export type SourceFileSnapshot = StableFileIdentity & {
  absolutePath: string;
  relativePath: string;
  allocatedBytes: bigint;
};

function sourceChanged(error?: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  return new Error('SOURCE_CHANGED', { cause: error });
}

function sameIdentity(left: StableFileIdentity, right: StableFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

async function readIdentity(absolutePath: string): Promise<StableFileIdentity> {
  try {
    const value = await lstat(absolutePath, { bigint: true });
    return { dev: value.dev, ino: value.ino, size: value.size, mtimeNs: value.mtimeNs };
  } catch (error: unknown) {
    throw sourceChanged(error);
  }
}

export async function hashStableFile(
  absolutePath: string,
  expected: StableFileIdentity,
  signal: AbortSignal,
  onProgress?: (chunkBytes: bigint) => void | Promise<void>,
): Promise<string> {
  const before = await readIdentity(absolutePath);
  if (!sameIdentity(before, expected)) throw sourceChanged();

  const hash = createHash('sha256');
  try {
    const stream = createReadStream(absolutePath, { signal });
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      hash.update(buffer);
      await onProgress?.(BigInt(buffer.length));
    }
  } catch (error: unknown) {
    throw sourceChanged(error);
  }

  const after = await readIdentity(absolutePath);
  if (!sameIdentity(after, expected)) throw sourceChanged();
  return hash.digest('hex');
}

async function snapshotEntry(
  absolutePath: string,
  relativePath: string,
): Promise<SourceFileSnapshot[]> {
  const value = await lstat(absolutePath, { bigint: true });
  if (value.isSymbolicLink()) throw new Error('SOURCE_CHANGED');
  if (value.isFile()) {
    return [
      {
        absolutePath,
        relativePath,
        dev: value.dev,
        ino: value.ino,
        size: value.size,
        mtimeNs: value.mtimeNs,
        allocatedBytes: value.blocks * 512n,
      },
    ];
  }
  if (!value.isDirectory()) throw new Error('SOURCE_CHANGED');

  const result: SourceFileSnapshot[] = [];
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childAbsolute = path.join(absolutePath, entry.name);
    const childRelative = path.posix.join(relativePath, entry.name);
    result.push(...(await snapshotEntry(childAbsolute, childRelative)));
  }
  return result;
}

/** Capture a deterministic, lstat-based file list without following symlinks. */
export async function snapshotSourceFiles(contentPath: string): Promise<SourceFileSnapshot[]> {
  const canonicalPath = await realpath(contentPath);
  const value = await lstat(canonicalPath, { bigint: true });
  const relative = value.isDirectory() ? '' : path.basename(canonicalPath);
  return snapshotEntry(canonicalPath, relative);
}
