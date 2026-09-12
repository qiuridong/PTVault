import path from 'node:path';

/**
 * One container→host path rewrite.
 *
 * qBittorrent runs inside Docker and reports paths in its own namespace (e.g.
 * `/downloads/x.mkv`), but this server reads bytes on the host, where the same
 * file lives under the bind-mount source (e.g. `/data/downloads/x.mkv`). Without
 * the rewrite every path qB reports is a path we cannot stat, so preflight sees
 * PATH_MISSING for a file that is plainly there.
 */
export type PathMap = { from: string; to: string };

export class PathMapError extends Error {
  readonly code = 'INVALID_PATH_MAP';

  constructor(readonly entry: string) {
    super('INVALID_PATH_MAP');
    this.name = 'PathMapError';
  }
}

/**
 * Parses `<container>=<host>` entries.
 *
 * Both sides must be absolute so a prefix rewrite is unambiguous. The container
 * side is validated as POSIX (qB reports POSIX paths even when this server runs
 * on Windows); the host side is validated against the local platform, because
 * that is the path this process will actually open.
 */
export function parsePathMaps(entries: readonly string[]): PathMap[] {
  return entries.map((entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new PathMapError(entry);
    const from = entry.slice(0, separator);
    const to = entry.slice(separator + 1);
    if (!from || !to || !path.posix.isAbsolute(from) || !path.isAbsolute(to)) {
      throw new PathMapError(entry);
    }
    return { from, to };
  });
}

/**
 * Rewrites a container-namespace path into its host equivalent using the first
 * matching prefix.
 *
 * A prefix matches only on a path-segment boundary, so `/downloads` does not
 * rewrite `/downloads-extra` — mapping that by accident would point the uploader
 * at an unrelated tree. Returns the input unchanged when no map applies.
 */
export function applyPathMaps(target: string, maps: readonly PathMap[]): string {
  for (const { from, to } of maps) {
    if (target === from) return to;
    const prefix = from.endsWith('/') ? from : `${from}/`;
    if (target.startsWith(prefix)) {
      return path.posix.join(to, target.slice(prefix.length));
    }
  }
  return target;
}
