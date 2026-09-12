import { constants } from 'node:fs';
import { lstat, open, realpath, statfs, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import path from 'node:path';

import type { SetupPathCheckResult } from '@ptvault/contracts';

import { canonicalAllowedPath, isPathWithinRoot, PathSafetyError } from '../core/paths.js';
import { applyPathMaps, parsePathMaps } from '../qb/path-map.js';

const MiB = 1024n ** 2n;
const GiB = 1024n ** 3n;

export function recommendSpoolBudget(availableBytes: bigint) {
  if (availableBytes < 64n * MiB) return null;
  const maxBytes = ((availableBytes * 3n) / 4n / MiB) * MiB;
  const reserveBytes = maxBytes / 8n < 10n * GiB ? maxBytes / 8n : 10n * GiB;
  return { maxBytes: maxBytes.toString(), reserveBytes: reserveBytes.toString() };
}

function outcomeFor(error: unknown): SetupPathCheckResult['outcome'] {
  if (error instanceof PathSafetyError) {
    if (error.code === 'SYMLINK_ESCAPE') return 'SYMLINK_ESCAPE';
    if (error.code === 'PATH_MISSING') return 'NOT_FOUND';
    return 'OUTSIDE_ALLOWED_ROOT';
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'NOT_FOUND';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'PERMISSION_DENIED';
  if (code === 'ELOOP') return 'PATH_CHANGED';
  return 'IO_ERROR';
}

function result(kind: 'SOURCE' | 'SPOOL', reportedPath: string | null): SetupPathCheckResult {
  return {
    kind, outcome: 'IO_ERROR', reportedPath, hostPath: null,
    serviceUser: userInfo().username,
    serviceUid: process.getuid?.() ?? null,
    bytesRead: 0, sizeBytes: null, availableBytes: null, suggestedBudget: null,
  };
}

async function canonicalRoot(root: string): Promise<string> {
  try { return await realpath(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(root);
    throw error;
  }
}

export class SetupPathProbe {
  constructor(private readonly options: {
    allowedRoots: readonly string[];
    protectedRoots: readonly string[];
    spoolRoot: string | null;
  }) {}

  async source(input: { path: string; pathMaps: readonly string[]; expectedBytes?: string | undefined }): Promise<SetupPathCheckResult> {
    const checked = result('SOURCE', input.path);
    if (this.options.allowedRoots.length === 0) return { ...checked, outcome: 'NOT_CONFIGURED' };
    try {
      const mapped = applyPathMaps(input.path, parsePathMaps(input.pathMaps));
      if (!path.isAbsolute(mapped)) return { ...checked, outcome: 'OUTSIDE_ALLOWED_ROOT' };
      const hostPath = await canonicalAllowedPath(mapped, this.options.allowedRoots);
      const protectedRoots = await Promise.all(this.options.protectedRoots.map(canonicalRoot));
      if (protectedRoots.some((root) => isPathWithinRoot(hostPath, root))) {
        return { ...checked, outcome: 'OUTSIDE_ALLOWED_ROOT' };
      }
      checked.hostPath = hostPath;
      const before = await lstat(hostPath, { bigint: true });
      if (!before.isFile()) return { ...checked, outcome: 'NOT_FILE' };
      checked.sizeBytes = before.size.toString();
      if (input.expectedBytes !== undefined && before.size !== BigInt(input.expectedBytes)) {
        return { ...checked, outcome: 'SIZE_CHANGED' };
      }
      // O_NONBLOCK prevents a file→FIFO race from hanging the check. Only a
      // regular, same-inode descriptor is ever read; no bytes leave this method.
      const file = await open(hostPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await file.stat({ bigint: true });
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) {
          return { ...checked, outcome: 'PATH_CHANGED' };
        }
        const read = await file.read(Buffer.alloc(1), 0, 1, 0);
        const after = await file.stat({ bigint: true });
        if (after.size !== opened.size) return { ...checked, outcome: 'SIZE_CHANGED' };
        return { ...checked, outcome: 'READABLE', bytesRead: read.bytesRead };
      } finally { await file.close(); }
    } catch (error) {
      return { ...checked, outcome: outcomeFor(error) };
    }
  }

  async spool(): Promise<SetupPathCheckResult> {
    const directory = this.options.spoolRoot;
    const checked = result('SPOOL', directory);
    if (directory === null) return { ...checked, outcome: 'NOT_CONFIGURED' };
    let probePath: string | undefined;
    let probeIdentity: { ino: bigint; dev: bigint } | undefined;
    try {
      const entry = await lstat(directory);
      if (entry.isSymbolicLink()) return { ...checked, outcome: 'SYMLINK_ESCAPE' };
      if (!entry.isDirectory()) return { ...checked, outcome: 'NOT_DIRECTORY' };
      const hostPath = await realpath(directory);
      checked.hostPath = hostPath;
      const roots = await Promise.all(this.options.allowedRoots.map(canonicalRoot));
      if (roots.some((root) => isPathWithinRoot(root, hostPath) || isPathWithinRoot(hostPath, root))) {
        return { ...checked, outcome: 'PATH_OVERLAP' };
      }
      probePath = path.join(hostPath, `.ptvault-write-test-${randomUUID()}`);
      const file = await open(probePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const created = await file.stat({ bigint: true });
        probeIdentity = { ino: created.ino, dev: created.dev };
        await file.write('PTVault temporary directory check\n');
        await file.sync();
      } finally { await file.close(); }
      const capacity = await statfs(hostPath, { bigint: true });
      const available = capacity.bavail * capacity.bsize;
      return { ...checked, outcome: 'WRITABLE', availableBytes: available.toString(), suggestedBudget: recommendSpoolBudget(available) };
    } catch (error) {
      return { ...checked, outcome: outcomeFor(error) };
    } finally {
      if (probePath !== undefined && probeIdentity !== undefined) {
        try {
          const current = await lstat(probePath, { bigint: true });
          if (current.isFile() && current.ino === probeIdentity.ino && current.dev === probeIdentity.dev) await unlink(probePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }
}
