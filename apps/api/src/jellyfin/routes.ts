import type { FastifyInstance, onRequestHookHandler, preHandlerAsyncHookHandler } from 'fastify';

import {
  JellyfinInfoSchema,
  JellyfinTestResultSchema,
  type JellyfinConnectionError,
  type JellyfinInfo,
} from '@ptvault/contracts';
import { z } from 'zod';

import type { AppConfig } from '../config/env.js';
import type { PathMap } from '../qb/path-map.js';
import {
  createJellyfinSettingsClient,
  JellyfinSettingsError,
  type JellyfinSettingsReader,
} from './settings.js';

export type JellyfinRouteDependencies = {
  config: Pick<
    AppConfig,
    'jellyfinUrl' | 'jellyfinTokenFile' | 'jellyfinPathMaps' | 'mediaHotRoot' | 'mediaFarmRoot'
  >;
  requireSession: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
  /** Injectable to test the HTTP boundary without storing a token in a fixture. */
  reader?: JellyfinSettingsReader;
  now?: () => number;
};

const NOT_CONFIGURED_RESULT = {
  ok: false as const,
  serverName: null,
  version: null,
  notificationAccepted: false,
  error: 'NOT_CONFIGURED' as const,
};

const EmptyTestRequestSchema = z.object({}).strict();

export function registerJellyfinRoutes(
  app: FastifyInstance,
  deps: JellyfinRouteDependencies,
): void {
  const now = deps.now ?? (() => Date.now());
  const configured = deps.config.jellyfinUrl !== null && deps.config.jellyfinTokenFile !== null;
  const reader =
    deps.reader ??
    (configured
      ? createJellyfinSettingsClient({
          baseUrl: deps.config.jellyfinUrl as string,
          tokenFile: deps.config.jellyfinTokenFile as string,
          pathMaps: deps.config.jellyfinPathMaps,
          hotRoot: deps.config.mediaHotRoot,
          farmRoot: deps.config.mediaFarmRoot,
        })
      : undefined);

  app.get('/api/jellyfin/info', { preHandler: deps.requireSession }, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    if (!configured || reader === undefined) return unconfiguredInfo();

    const checkedAt = now();
    try {
      const info: JellyfinInfo = {
        configured: true,
        baseUrl: deps.config.jellyfinUrl,
        tokenFile: deps.config.jellyfinTokenFile,
        pathMaps: encodePathMaps(deps.config.jellyfinPathMaps),
        libraries: await reader.listLibraries(),
        checkedAt,
        error: null,
      };
      return JellyfinInfoSchema.parse(info);
    } catch (error) {
      const info: JellyfinInfo = {
        configured: true,
        baseUrl: deps.config.jellyfinUrl,
        tokenFile: deps.config.jellyfinTokenFile,
        pathMaps: encodePathMaps(deps.config.jellyfinPathMaps),
        libraries: [],
        checkedAt,
        error: errorCode(error),
      };
      return JellyfinInfoSchema.parse(info);
    }
  });

  app.post(
    '/api/jellyfin/test',
    { onRequest: deps.protectCsrf, preHandler: deps.requireSession },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      if (!EmptyTestRequestSchema.safeParse(request.body ?? {}).success) {
        return reply.code(400).send({ error: 'Invalid connection test' });
      }
      const result = configured && reader ? await reader.testConnection() : NOT_CONFIGURED_RESULT;
      return JellyfinTestResultSchema.parse(result);
    },
  );
}

function unconfiguredInfo(): JellyfinInfo {
  return {
    configured: false,
    baseUrl: null,
    tokenFile: null,
    pathMaps: [],
    libraries: [],
    checkedAt: null,
    error: null,
  };
}

function encodePathMaps(maps: readonly PathMap[]): string[] {
  return maps.map(({ from, to }) => `${from}=${to}`);
}

function errorCode(error: unknown): Exclude<JellyfinConnectionError, 'NOT_CONFIGURED'> {
  return error instanceof JellyfinSettingsError ? error.code : 'UNREACHABLE';
}
