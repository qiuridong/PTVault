import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { PlaybackProbe } from '../storage/cleanup.js';
import { applyPathMaps, type PathMap } from '../qb/path-map.js';

export type JellyfinPlaybackProbeOptions = {
  baseUrl: string;
  tokenFile: string;
  /** Jellyfin container path to host path rewrites, e.g. `/media=/data/downloads`. */
  pathMaps?: readonly PathMap[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export const DEFAULT_JELLYFIN_TIMEOUT_MS = 4_000;

type JellyfinSession = {
  NowPlayingItem?: {
    Path?: unknown;
    MediaSources?: unknown;
  } | null;
  PlayState?: { IsPaused?: unknown } | null;
  TranscodingInfo?: { Path?: unknown } | null;
};

/**
 * Fail-closed active-playback probe for local cleanup.
 *
 * Jellyfin is queried on loopback and the token is carried only in a header. A
 * timeout, 401, malformed response, or session whose source path cannot be
 * determined all throws: deletion must stop when the observer is unavailable or
 * ambiguous, never assume "not playing" from a broken probe.
 */
export function createJellyfinPlaybackProbe(options: JellyfinPlaybackProbeOptions): PlaybackProbe {
  const baseUrl = assertLoopbackOrigin(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JELLYFIN_TIMEOUT_MS;
  const pathMaps = options.pathMaps ?? [];
  let token: string | undefined;

  const readToken = async (): Promise<string> => {
    if (token !== undefined) return token;
    const value = (await readFile(options.tokenFile, 'utf8')).trim();
    if (value.length === 0) throw new Error('JELLYFIN_TOKEN_EMPTY');
    token = value;
    return token;
  };

  return {
    async isActive(absolutePath: string): Promise<boolean> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(new URL('/Sessions', baseUrl), {
          method: 'GET',
          signal: controller.signal,
          headers: { 'x-emby-token': await readToken() },
        });
        if (!response.ok) throw new Error(`JELLYFIN_STATUS_${response.status}`);

        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          throw new Error('JELLYFIN_SESSIONS_INVALID', { cause: error });
        }
        if (!Array.isArray(payload)) throw new Error('JELLYFIN_SESSIONS_INVALID');
        const target = canonicalPath(absolutePath);
        for (const raw of payload) {
          if (!raw || typeof raw !== 'object') throw new Error('JELLYFIN_SESSIONS_INVALID');
          const session = raw as JellyfinSession;
          if (!session.NowPlayingItem) continue;

          const mediaPaths = sessionMediaPaths(session);
          if (mediaPaths.length === 0) throw new Error('JELLYFIN_PLAYBACK_PATH_UNKNOWN');
          for (const candidate of mediaPaths) {
            if (canonicalPath(mapSessionPath(candidate, pathMaps)) === target) return true;
          }
        }
        return false;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('JELLYFIN_UNAVAILABLE', { cause: error });
        }
        if (error instanceof Error && error.message.startsWith('JELLYFIN_')) throw error;
        throw new Error('JELLYFIN_UNAVAILABLE', { cause: error });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function sessionMediaPaths(session: JellyfinSession): string[] {
  const paths = new Set<string>();
  const itemPath = session.NowPlayingItem?.Path;
  if (typeof itemPath === 'string' && itemPath.length > 0) paths.add(itemPath);
  const mediaSources = session.NowPlayingItem?.MediaSources;
  if (Array.isArray(mediaSources)) {
    for (const source of mediaSources) {
      if (!source || typeof source !== 'object') continue;
      const sourcePath = (source as { Path?: unknown }).Path;
      if (typeof sourcePath === 'string' && sourcePath.length > 0) paths.add(sourcePath);
    }
  }
  return [...paths];
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function mapSessionPath(value: string, maps: readonly PathMap[]): string {
  if (maps.length === 0) return value;
  const mapped = applyPathMaps(value, maps);
  if (mapped === value) throw new Error('JELLYFIN_PLAYBACK_PATH_UNMAPPED');
  return mapped;
}

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
