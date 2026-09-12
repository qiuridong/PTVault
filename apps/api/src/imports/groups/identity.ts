import { createHash } from 'node:crypto';
import type { ArchiveGroup } from '../archive/inspection.js';

type Identity = {
  fsid: string;
  path: string;
  relativePath: string;
  size: string;
  mtime: string;
  md5?: string | undefined;
};

/** Order-independent, byte-exact group identity. Paths include their source directory. */
export function importGroupKey(kind: ArchiveGroup['kind'], objects: readonly Identity[]): string {
  const ordered = objects
    .map((x) => ({
      fsid: x.fsid,
      path: x.path,
      relativePath: x.relativePath,
      size: x.size,
      mtime: x.mtime,
      ...(x.md5 === undefined ? {} : { md5: x.md5 }),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, kind, objects: ordered }))
    .digest('hex');
}
