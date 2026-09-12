import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { applyPathMaps, type PathMap } from '../qb/path-map.js';
import type { FarmSyncResult } from '../media/symlink-farm.js';

export type JellyfinLibraryNotifierOptions = {
  baseUrl: string;
  tokenFile: string;
  /** Host path the symlink farm is built at, e.g. `/mnt/ptvault-farm`. */
  farmRoot: string;
  /** The same container→host maps the playback probe uses, applied in reverse here. */
  pathMaps: readonly PathMap[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export const DEFAULT_JELLYFIN_NOTIFY_TIMEOUT_MS = 5_000;

export type JellyfinLibraryNotifier = {
  /** Tells Jellyfin which farm links appeared or disappeared. Never throws. */
  notify(result: FarmSyncResult): Promise<void>;
};

/**
 * Tells Jellyfin that the symlink farm changed.
 *
 * Without this the farm and Jellyfin's library drift apart, and both directions
 * were observed in production: a title cleaned up locally stayed invisible until
 * an operator added `/cloud/pt` to a library by hand, and a title rehydrated back
 * to local left its `/cloud/...` entry behind — clicking it played nothing,
 * because the link it pointed at had been removed by design.
 *
 * `Library/Media/Updated` rather than a library scan: a scan walks every media
 * tree on the box, which on this machine means thousands of files on a mechanical
 * disk, to learn about one link. The notification names the exact paths.
 *
 * Paths are translated into Jellyfin's namespace before sending. Jellyfin sees the
 * farm as `/cloud`, this process sees it as `/mnt/ptvault-farm`, and a path from
 * the wrong namespace is silently ignored — the same trap the playback probe maps
 * around, which is why both use one set of maps.
 */
export function createJellyfinLibraryNotifier(
  options: JellyfinLibraryNotifierOptions,
): JellyfinLibraryNotifier {
  const baseUrl = assertLoopbackOrigin(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JELLYFIN_NOTIFY_TIMEOUT_MS;
  // Reversed: the shared maps are container→host, and this is the one caller that
  // needs to go the other way.
  const toContainer = options.pathMaps.map((entry) => ({ from: entry.to, to: entry.from }));
  let token: string | undefined;

  const readToken = async (): Promise<string> => {
    if (token !== undefined) return token;
    const value = (await readFile(options.tokenFile, 'utf8')).trim();
    if (value.length === 0) throw new Error('JELLYFIN_TOKEN_EMPTY');
    token = value;
    return token;
  };

  return {
    async notify(result: FarmSyncResult): Promise<void> {
      const updates = [
        // A repointed link is the same library entry backed by different bytes —
        // reported as a modification so Jellyfin refreshes rather than re-adds.
        ...result.created.map((link) => update(link, 'Created')),
        ...result.repointed.map((link) => update(link, 'Modified')),
        ...result.removed.map((link) => update(link, 'Deleted')),
      ].filter((entry): entry is { Path: string; UpdateType: string } => entry !== null);
      if (updates.length === 0) return;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await fetchImpl(new URL('/Library/Media/Updated', baseUrl), {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-emby-token': await readToken(),
          },
          body: JSON.stringify({ Updates: updates }),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };

  /** Farm-relative link → the absolute path Jellyfin knows it by, or null if unmappable. */
  function update(
    linkRelativePath: string,
    updateType: string,
  ): { Path: string; UpdateType: string } | null {
    const hostPath = path.posix.join(options.farmRoot, linkRelativePath);
    const containerPath = applyPathMaps(hostPath, toContainer);
    // Unmapped means this deployment has no Jellyfin view of the farm. Dropping the
    // entry is right: sending a host path would have Jellyfin look somewhere that
    // does not exist inside it, and reporting it as an error would fail a farm sync
    // over a notification nobody can act on.
    if (containerPath === hostPath) return null;
    return { Path: containerPath, UpdateType: updateType };
  }
}

/** Loopback only, for the same reason the playback probe is: the token rides on it. */
function assertLoopbackOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('JELLYFIN_URL_NOT_LOOPBACK');
  }
  return url;
}
