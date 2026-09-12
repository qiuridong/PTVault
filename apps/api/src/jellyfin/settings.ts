import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type JellyfinConnectionError,
  type JellyfinLibrary,
  type JellyfinTestResult,
} from '@ptvault/contracts';
import { z } from 'zod';

import { applyPathMaps, type PathMap } from '../qb/path-map.js';

export const DEFAULT_JELLYFIN_SETTINGS_TIMEOUT_MS = 5_000;

type ActionableJellyfinError = Exclude<JellyfinConnectionError, 'NOT_CONFIGURED'>;

/** An error whose code is safe to put in an administrator-facing response. */
export class JellyfinSettingsError extends Error {
  readonly code: ActionableJellyfinError;

  constructor(code: ActionableJellyfinError) {
    super(code);
    this.name = 'JellyfinSettingsError';
    this.code = code;
  }
}

export type JellyfinSettingsClientOptions = {
  baseUrl: string;
  tokenFile: string;
  pathMaps: readonly PathMap[];
  /** Null roots mean the deployment has no media farm to classify yet. */
  hotRoot: string | null;
  farmRoot: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type JellyfinSettingsReader = {
  listLibraries: () => Promise<JellyfinLibrary[]>;
  testConnection: () => Promise<JellyfinTestResult>;
};

const VirtualFolderSchema = z.object({
  Name: z.string().trim().min(1).max(256),
  CollectionType: z.string().trim().min(1).max(64).nullable().optional(),
  Locations: z.array(z.string().trim().min(1).max(4096)).max(256),
});

const VirtualFoldersSchema = z.array(VirtualFolderSchema).max(512);

const SystemInfoResponseSchema = z.object({
  ServerName: z.string().trim().min(1).max(128),
  Version: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d+){0,3}[A-Za-z0-9.+-]{0,32}$/),
});

/**
 * Read-only Jellyfin calls used by the settings page.
 *
 * The client deliberately accepts no URL or token from a request body. The
 * origin and credential file are startup configuration, and the origin is
 * constrained to loopback before the first byte is sent.
 */
export function createJellyfinSettingsClient(
  options: JellyfinSettingsClientOptions,
): JellyfinSettingsReader {
  const baseUrl = assertLoopbackHttpOrigin(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JELLYFIN_SETTINGS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new JellyfinSettingsError('BAD_RESPONSE');
  }

  let token: string | undefined;
  const readToken = async (): Promise<string> => {
    if (token !== undefined) return token;
    let value: string;
    try {
      value = (await readFile(options.tokenFile, 'utf8')).trim();
    } catch {
      throw new JellyfinSettingsError('AUTH_FAILED');
    }
    if (value.length === 0) throw new JellyfinSettingsError('AUTH_FAILED');
    token = value;
    return token;
  };

  async function request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Credential failures are authentication failures, not network failures.
      // Read before entering the fetch catch so a missing root-owned file is not
      // mislabeled as an unreachable Jellyfin.
      const credential = await readToken();
      let response: Response;
      try {
        response = await fetchImpl(new URL(pathname, baseUrl), {
          ...init,
          signal: controller.signal,
          headers: {
            ...(init.headers ?? {}),
            'x-emby-token': credential,
          },
        });
      } catch {
        throw new JellyfinSettingsError('UNREACHABLE');
      }

      if (response.status === 401 || response.status === 403) {
        throw new JellyfinSettingsError('AUTH_FAILED');
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function jsonResponse(response: Response): Promise<unknown> {
    if (!response.ok) throw new JellyfinSettingsError('BAD_RESPONSE');
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new JellyfinSettingsError('BAD_RESPONSE');
    }
    // A virtual-folder or system-info response should be tiny. Refuse an
    // unexpectedly large body before it reaches any contract parser or response.
    if (body.length > 256 * 1024) throw new JellyfinSettingsError('BAD_RESPONSE');
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new JellyfinSettingsError('BAD_RESPONSE');
    }
  }

  async function systemInfo(): Promise<{ serverName: string; version: string }> {
    const response = await request('/System/Info');
    const parsed = SystemInfoResponseSchema.safeParse(await jsonResponse(response));
    if (!parsed.success) throw new JellyfinSettingsError('BAD_RESPONSE');
    return { serverName: parsed.data.ServerName, version: parsed.data.Version };
  }

  return {
    async listLibraries(): Promise<JellyfinLibrary[]> {
      const response = await request('/Library/VirtualFolders');
      const parsed = VirtualFoldersSchema.safeParse(await jsonResponse(response));
      if (!parsed.success) throw new JellyfinSettingsError('BAD_RESPONSE');

      return parsed.data.map((folder, index) => {
        const typeConflicts = parsed.data.flatMap((other, otherIndex) => {
          if (
            index === otherIndex ||
            (folder.CollectionType ?? null) === (other.CollectionType ?? null)
          )
            return [];
          return folder.Locations.flatMap((location) =>
            other.Locations.flatMap((otherPath) => {
              const left = path.posix.normalize(applyPathMaps(location, options.pathMaps));
              const right = path.posix.normalize(applyPathMaps(otherPath, options.pathMaps));
              return relativeWithin(left, right) !== null || relativeWithin(right, left) !== null
                ? [
                    {
                      libraryName: other.Name,
                      collectionType: other.CollectionType ?? null,
                      path: location,
                      otherPath,
                    },
                  ]
                : [];
            }),
          );
        });
        const classified = folder.Locations.map((location) => {
          // Jellyfin paths are POSIX paths in the production container. A
          // relative value cannot be safely classified or shown as a mounted tree.
          if (!location.startsWith('/')) throw new JellyfinSettingsError('BAD_RESPONSE');
          const mapped = applyPathMaps(location, options.pathMaps);
          const cloudRelative = relativeWithin(mapped, options.farmRoot);
          const localRelative = relativeWithin(mapped, options.hotRoot);
          if (cloudRelative !== null) {
            return { location: { path: location, kind: 'CLOUD' } as const, cloudRelative };
          }
          if (localRelative !== null) {
            return { location: { path: location, kind: 'LOCAL' } as const, localRelative };
          }
          return { location: { path: location, kind: 'OTHER' } as const };
        });
        const locations = classified.map(({ location }) => location);
        const hasLocal = locations.some((location) => location.kind === 'LOCAL');
        const hasCloud = locations.some((location) => location.kind === 'CLOUD');
        const localTrees = new Set(
          classified.flatMap((entry) => ('localRelative' in entry ? [entry.localRelative] : [])),
        );
        const cloudTrees = new Set(
          classified.flatMap((entry) => ('cloudRelative' in entry ? [entry.cloudRelative] : [])),
        );
        const covered =
          localTrees.size > 0 && [...localTrees].every((tree) => cloudTrees.has(tree));
        return {
          name: folder.Name,
          collectionType: folder.CollectionType ?? null,
          locations,
          hasLocal,
          hasCloud,
          covered,
          ...(typeConflicts.length > 0 ? { typeConflicts } : {}),
        } satisfies JellyfinLibrary;
      });
    },

    async testConnection(): Promise<JellyfinTestResult> {
      let identity: { serverName: string; version: string };
      try {
        identity = await systemInfo();
      } catch (error) {
        return resultForError(error);
      }

      try {
        const response = await request('/Library/Media/Updated', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ Updates: [] }),
        });
        if (!response.ok) {
          return {
            ok: false,
            serverName: identity.serverName,
            version: identity.version,
            notificationAccepted: false,
            error: 'NOTIFICATION_REJECTED',
          };
        }
      } catch (error) {
        return {
          ok: false,
          serverName: identity.serverName,
          version: identity.version,
          notificationAccepted: false,
          error: errorCode(error),
        };
      }

      return {
        ok: true,
        serverName: identity.serverName,
        version: identity.version,
        notificationAccepted: true,
        error: null,
      };
    },
  };

  function resultForError(error: unknown): JellyfinTestResult {
    return {
      ok: false,
      serverName: null,
      version: null,
      notificationAccepted: false,
      error: errorCode(error),
    };
  }

  function errorCode(error: unknown): ActionableJellyfinError {
    return error instanceof JellyfinSettingsError ? error.code : 'UNREACHABLE';
  }
}

function relativeWithin(candidate: string, root: string | null): string | null {
  if (root === null) return null;
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  if (candidate === normalizedRoot) return '';
  const prefix = `${normalizedRoot}/`;
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : null;
}

function assertLoopbackHttpOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new JellyfinSettingsError('BAD_RESPONSE');
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new JellyfinSettingsError('BAD_RESPONSE');
  }
  return url;
}
