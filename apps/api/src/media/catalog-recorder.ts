import path from 'node:path';

import type { CatalogRecorder } from '../storage/offload-handler.js';
import type { MediaCatalog } from './catalog.js';

/**
 * The production `CatalogRecorder`.
 *
 * Computes the Jellyfin-facing logical path of a committed torrent — its content
 * path relative to the hot root, e.g. `movie/Some Title.mkv` — and records it in
 * the catalog together with the account holding the verified primary.
 *
 * Multi-file torrents are excluded, deliberately. A torrent's content can be a
 * directory of files, but the media catalog records one logical path per title,
 * and the farm builds one symlink per title. For a multi-file torrent there is no
 * single path that Jellyfin could read that would present the title correctly;
 * until the directory form exists, such titles stay out of the catalog entirely —
 * absent and obviously so, rather than present with a broken single link.
 */
export function createCatalogRecorder(input: {
  catalog: MediaCatalog;
  /** Where local media lives, e.g. `/data/downloads`. */
  hotRoot: string;
}): CatalogRecorder {
  return {
    record({ instanceId, torrentHash, contentRoot, accountId }): void {
      const logicalPath = logicalPathForContent(input.hotRoot, contentRoot);
      if (logicalPath === null) return;

      input.catalog.upsert({
        instanceId,
        torrentHash,
        logicalPath,
        activeAccountId: accountId,
        // The commit happens before any cleanup: the local copy is still present,
        // so local-first precedence must keep serving it. `LOCAL_CLEANUP` flips
        // this to false when the local bytes are actually gone.
        localHot: true,
      });
    },
  };
}

/**
 * The content root's path relative to the hot root, or null when it does not
 * belong there.
 *
 * A content root outside the hot root is a configuration error that must not be
 * silently flattened into a misleading catalog path — the title simply stays out
 * of the catalog.
 */
export function logicalPathForContent(hotRoot: string, contentRoot: string): string | null {
  const relative = path.posix.relative(hotRoot, contentRoot);
  if (
    relative === '' ||
    relative === '.' ||
    relative.startsWith('..') ||
    path.posix.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}
