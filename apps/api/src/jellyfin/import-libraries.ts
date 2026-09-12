import path from 'node:path';
import { z } from 'zod';
import type { JellyfinImportLibrary, JellyfinLibraryDiscoveryError } from '@ptvault/contracts';
import { applyPathMaps, type PathMap } from '../qb/path-map.js';

export const ImportLibraryRowsSchema = z
  .array(
    z.object({
      ItemId: z.string().regex(/^[a-fA-F0-9]{32}$/),
      Name: z.string().min(1).max(120),
      CollectionType: z.string().nullable().optional(),
      Locations: z.array(z.string().min(1).max(4096)).max(128).default([]),
    }),
  )
  .max(64)
  .superRefine((rows, context) => {
    if (new Set(rows.map((row) => row.ItemId.toLowerCase())).size !== rows.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate library identity' });
  });
export type ImportLibraryRow = z.infer<typeof ImportLibraryRowsSchema>[number];
export interface ImportLibraryCatalog {
  list(): readonly JellyfinImportLibrary[];
  refresh(force?: boolean): Promise<void>;
  error(): JellyfinLibraryDiscoveryError | null;
}
type Options = {
  baseUrl: string;
  readToken: () => Promise<string>;
  farmRoot: string;
  pathMaps: readonly PathMap[];
  photoRoots?: readonly string[];
  legacy?: readonly JellyfinImportLibrary[];
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function importLibraryContentType(
  row: ImportLibraryRow,
  photoRoots: readonly string[] = [],
): JellyfinImportLibrary['contentType'] {
  if (
    row.Locations.some((location) =>
      photoRoots.some((root) => {
        const prefix = path.posix.normalize(root);
        const current = path.posix.normalize(location);
        return current === prefix || current.startsWith(prefix + '/');
      }),
    )
  )
    return 'Photos';
  switch (row.CollectionType?.toLowerCase()) {
    case 'movies':
      return 'Movies';
    case 'tvshows':
      return 'Shows';
    case 'homevideos':
      return 'HomeVideos';
    case 'photos':
      return 'Photos';
    case 'boxsets':
      return 'Collections';
    case '':
    case undefined:
      return 'Mixed';
    default:
      return 'Other';
  }
}

class CatalogFailure extends Error {
  constructor(readonly code: JellyfinLibraryDiscoveryError) {
    super(code);
  }
}

/** No discovery timer or library writes. Reads are bounded, cached and shared by HTTP and worker. */
export class LiveImportLibraryCatalog implements ImportLibraryCatalog {
  private readonly base: URL;
  private readonly now: () => number;
  private lastAttempt = -Infinity;
  private lastError: JellyfinLibraryDiscoveryError | null = null;
  private snapshot: JellyfinImportLibrary[];
  private lastGood: JellyfinImportLibrary[] = [];
  private inFlight: Promise<void> | undefined;
  constructor(private readonly options: Options) {
    this.base = new URL(options.baseUrl);
    if (
      this.base.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(this.base.hostname) ||
      this.base.username ||
      this.base.password ||
      this.base.pathname !== '/' ||
      this.base.search ||
      this.base.hash
    )
      throw Error('JELLYFIN_URL_NOT_LOOPBACK');
    this.now = options.now ?? Date.now;
    this.snapshot = (options.legacy ?? []).map((row) => ({
      ...row,
      unavailableReason: 'DISCOVERY_UNAVAILABLE',
    }));
  }
  list(): JellyfinImportLibrary[] {
    return this.snapshot.map((row) => ({ ...row }));
  }
  error(): JellyfinLibraryDiscoveryError | null {
    return this.lastError;
  }
  async refresh(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!force && this.now() - this.lastAttempt < 30_000) return;
    this.lastAttempt = this.now();
    const work = this.load()
      .then((rows) => {
        this.lastGood = rows;
        this.snapshot = rows;
        this.lastError = null;
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof CatalogFailure ? error.code : 'JELLYFIN_UNREACHABLE';
        this.snapshot = (this.lastGood.length ? this.lastGood : (this.options.legacy ?? [])).map(
          (row) => ({ ...row, unavailableReason: 'DISCOVERY_UNAVAILABLE' }),
        );
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = undefined;
      });
    this.inFlight = work;
    return work;
  }
  private async load(): Promise<JellyfinImportLibrary[]> {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 3000);
    try {
      const token = (await this.options.readToken()).trim();
      if (!token || token.length > 4096 || /[\r\n]/.test(token))
        throw new CatalogFailure('JELLYFIN_AUTH_FAILED');
      const response = await (this.options.fetchImpl ?? fetch)(
        new URL('/Library/VirtualFolders', this.base),
        {
          method: 'GET',
          headers: { 'x-emby-token': token, accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new CatalogFailure('JELLYFIN_AUTH_FAILED');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CatalogFailure('JELLYFIN_UNREACHABLE');
      }
      const maximum = 1024 * 1024;
      if (Number(response.headers.get('content-length') ?? 0) > maximum || response.body === null) {
        await response.body?.cancel();
        throw new CatalogFailure('LIBRARY_RESPONSE_INVALID');
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maximum) {
            controller.abort();
            throw new CatalogFailure('LIBRARY_RESPONSE_INVALID');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      let rows: ImportLibraryRow[];
      try {
        rows = ImportLibraryRowsSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        throw new CatalogFailure('LIBRARY_RESPONSE_INVALID');
      }
      const toContainer = this.options.pathMaps.map((map) => ({ from: map.to, to: map.from }));
      return rows
        .map((row) => {
          const libraryId = row.ItemId.toLowerCase(),
            legacy = this.options.legacy?.find(
              (item) => item.libraryId.toLowerCase() === libraryId,
            );
          const libraryKey = legacy?.libraryKey ?? 'ptvault-library-' + libraryId;
          const hostPath = path.posix.join(this.options.farmRoot, libraryKey);
          const containerPath = legacy?.containerPath ?? applyPathMaps(hostPath, toContainer);
          const contentType = importLibraryContentType(row, this.options.photoRoots);
          const unavailableReason: JellyfinImportLibrary['unavailableReason'] =
            contentType === 'Photos'
              ? 'PHOTOS_ONLY'
              : contentType === 'Collections'
                ? 'COLLECTION_ONLY'
                : contentType === 'Other'
                  ? 'TYPE_UNSUPPORTED'
                  : containerPath === hostPath
                    ? 'PATH_UNMAPPED'
                    : null;
          return {
            libraryId,
            libraryKey,
            containerPath,
            displayName: row.Name,
            contentType,
            unavailableReason,
            ...(legacy === undefined ? { managedRoot: true } : {}),
          };
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
    } finally {
      clearTimeout(timer);
    }
  }
}
