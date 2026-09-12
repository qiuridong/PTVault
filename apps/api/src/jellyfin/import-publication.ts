import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ImportPublicationError } from '@ptvault/contracts';

import type {
  ImportPublicationJellyfin,
  ImportPublicationJellyfinInput,
} from '../imports/publication.js';
import { applyPathMaps, type PathMap } from '../qb/path-map.js';
import { ImportLibraryRowsSchema, importLibraryContentType } from './import-libraries.js';

export type StrictImportJellyfinOptions = {
  baseUrl: string;
  tokenFile: string;
  farmRoot: string;
  pathMaps: readonly PathMap[];
  photoRoots?: readonly string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  waitForRootRegistration?: (milliseconds: number) => Promise<void>;
};

export class ImportJellyfinError extends Error {
  constructor(
    readonly code: Extract<
      ImportPublicationError,
      'JELLYFIN_UNREACHABLE' | 'JELLYFIN_AUTH_FAILED' | 'NOTIFICATION_REJECTED'
    >,
  ) {
    super(code);
  }
}

export function createStrictImportJellyfin(
  options: StrictImportJellyfinOptions,
): ImportPublicationJellyfin {
  const baseUrl = loopbackOrigin(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const waitForRootRegistration =
    options.waitForRootRegistration ?? ((milliseconds) => delay(milliseconds));
  const toContainer = options.pathMaps.map((entry) => ({ from: entry.to, to: entry.from }));
  let token: string | undefined;
  const rootRegistrations = new Map<string, Promise<void>>();

  const readToken = async (): Promise<string> => {
    token ??= (await readFile(options.tokenFile, 'utf8')).trim();
    if (token.length === 0) throw new ImportJellyfinError('JELLYFIN_AUTH_FAILED');
    return token;
  };

  const mutate = async (
    input: ImportPublicationJellyfinInput,
    updateType: 'Created' | 'Deleted',
  ): Promise<void> => {
    if (input.library.unavailableReason != null)
      throw new ImportJellyfinError('NOTIFICATION_REJECTED');
    const updates = input.linkRelativePaths.map((linkRelativePath) => {
      const hostPath = path.posix.join(options.farmRoot, linkRelativePath);
      const containerPath = applyPathMaps(hostPath, toContainer);
      const root = path.posix.normalize(input.library.containerPath);
      if (
        containerPath === hostPath ||
        (containerPath !== root && !containerPath.startsWith(`${root}/`))
      ) {
        throw new ImportJellyfinError('NOTIFICATION_REJECTED');
      }
      return { Path: containerPath, UpdateType: updateType };
    });
    if (updateType === 'Created') {
      const ensureRoot = async (): Promise<void> => {
        const root = path.posix.normalize(input.library.containerPath);
        if (input.library.managedRoot) {
          const expectedKey = 'ptvault-library-' + input.library.libraryId.toLowerCase();
          if (
            input.library.libraryKey !== expectedKey ||
            updates.length === 0 ||
            root !== applyPathMaps(path.posix.join(options.farmRoot, expectedKey), toContainer)
          )
            throw new ImportJellyfinError('NOTIFICATION_REJECTED');
          const readFolders = async () => {
            const parsed = ImportLibraryRowsSchema.safeParse(
              await checkedFetch('/Library/VirtualFolders', { method: 'GET' }),
            );
            if (!parsed.success) throw new ImportJellyfinError('NOTIFICATION_REJECTED');
            return parsed.data;
          };
          const folders = await readFolders(),
            selected = folders.find(
              (row) => row.ItemId.toLowerCase() === input.library.libraryId.toLowerCase(),
            );
          if (
            !selected ||
            importLibraryContentType(selected, options.photoRoots) !== input.library.contentType
          )
            throw new ImportJellyfinError('NOTIFICATION_REJECTED');
          const overlaps = (location: string) => {
            const current = path.posix.normalize(location);
            return (
              current === root ||
              current.startsWith(root + '/') ||
              root.startsWith(current.replace(/\/$/, '') + '/')
            );
          };
          if (folders.some((row) => row.ItemId !== selected.ItemId && row.Locations.some(overlaps)))
            throw new ImportJellyfinError('NOTIFICATION_REJECTED');
          if (!selected.Locations.some((location) => path.posix.normalize(location) === root)) {
            await checkedFetch('/Library/VirtualFolders/Paths?refreshLibrary=false', {
              method: 'POST',
              body: JSON.stringify({ Name: selected.Name, PathInfo: { Path: root } }),
            });
            const confirmed = (await readFolders()).find((row) => row.ItemId === selected.ItemId);
            if (
              !confirmed ||
              !confirmed.Locations.includes(root) ||
              !selected.Locations.every((location) => confirmed.Locations.includes(location))
            )
              throw new ImportJellyfinError('NOTIFICATION_REJECTED');
          }
        }
        const rootRegistered = async (): Promise<boolean> => {
          const roots = await checkedFetch('/Library/PhysicalPaths', { method: 'GET' });
          if (
            !Array.isArray(roots) ||
            !roots.every((entry): entry is string => typeof entry === 'string')
          ) {
            throw new ImportJellyfinError('NOTIFICATION_REJECTED');
          }
          return roots.some((entry) => path.posix.normalize(entry) === root);
        };
        if (!(await rootRegistered())) {
          // Jellyfin 10.10 can register an empty CollectionFolder without its
          // physical root. Refreshing that collection then returns 204 but scans
          // no files. Its normal library-registration scan is needed once when
          // the root first gains media; subsequent publications stay scoped to
          // the selected library. No definitions or viewing data are rewritten.
          await checkedFetch('/Library/Refresh', { method: 'POST' });
          let registered = false;
          for (let attempt = 0; attempt < 15; attempt += 1) {
            await waitForRootRegistration(2_000);
            if (await rootRegistered()) {
              registered = true;
              break;
            }
          }
          if (!registered) throw new ImportJellyfinError('NOTIFICATION_REJECTED');
        }
      };
      const key = input.library.libraryId + '\0' + input.library.containerPath;
      let pending = rootRegistrations.get(key);
      if (pending === undefined) {
        pending = ensureRoot();
        rootRegistrations.set(key, pending);
      }
      try {
        await pending;
      } finally {
        if (rootRegistrations.get(key) === pending) rootRegistrations.delete(key);
      }
    }
    await checkedFetch('/Library/Media/Updated', {
      method: 'POST',
      body: JSON.stringify({ Updates: updates }),
    });
    // Normal refresh stays on the allowlisted collection. The only server-wide
    // scan above is registration of a previously absent physical root.
    await checkedFetch(
      `/Items/${encodeURIComponent(input.library.libraryId)}/Refresh?MetadataRefreshMode=Default&ImageRefreshMode=Default&ReplaceAllMetadata=false`,
      { method: 'POST' },
    );
  };

  const checkedFetch = async (
    pathname: string,
    init: { method: 'POST' | 'GET'; body?: string },
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(new URL(pathname, baseUrl), {
          method: init.method,
          signal: controller.signal,
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-emby-token': await readToken(),
          },
          ...(init.body === undefined ? {} : { body: init.body }),
        });
      } catch (error) {
        if (error instanceof ImportJellyfinError) throw error;
        throw new ImportJellyfinError('JELLYFIN_UNREACHABLE');
      }
      if (response.status === 401 || response.status === 403) {
        throw new ImportJellyfinError('JELLYFIN_AUTH_FAILED');
      }
      if (!response.ok) throw new ImportJellyfinError('NOTIFICATION_REJECTED');
      if (init.method === 'GET') {
        try {
          if (
            Number(response.headers.get('content-length') ?? 0) > 1024 * 1024 ||
            response.body === null
          ) {
            await response.body?.cancel();
            throw new ImportJellyfinError('NOTIFICATION_REJECTED');
          }
          const reader = response.body.getReader(),
            chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 1024 * 1024) {
                controller.abort();
                throw new ImportJellyfinError('NOTIFICATION_REJECTED');
              }
              chunks.push(part.value);
            }
          } finally {
            reader.releaseLock();
          }
          return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } catch {
          throw new ImportJellyfinError('NOTIFICATION_REJECTED');
        }
      }
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    publish: (input) => mutate(input, 'Created'),
    unpublish: (input) => mutate(input, 'Deleted'),
  };
}

function loopbackOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) ||
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
