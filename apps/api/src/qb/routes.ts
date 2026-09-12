import type { FastifyInstance, onRequestHookHandler, preHandlerAsyncHookHandler } from 'fastify';

import {
  InfoHashSchema,
  QbInstanceConfigSchema,
  QbInstanceIdSchema,
  QbInstanceTestSchema,
  QbSyncRequestSchema,
  TorrentSummarySchema,
  type QbInstanceTestResult,
  type TorrentSummary,
} from '@ptvault/contracts';
import { z } from 'zod';

import { QbClient, QbClientError } from './client.js';
import type { QbCredentialStore } from './credentials.js';
import { PathMapError, parsePathMaps } from './path-map.js';
import { PreflightError } from './preflight.js';
import type { TorrentPreflightService } from './preflight.js';
import { QbRegistryError } from './registry.js';
import { canonicalHash, type QbRepository, type TorrentRecord } from './repository.js';
import { InventorySyncError } from './sync.js';
import type { InventorySyncResult, QbInventoryCoordinator, QbInventorySync } from './sync.js';

/** Dials a qB with credentials that are not (yet) stored anywhere. */
export type QbProbe = { version: () => Promise<string> };

export type QbRouteDependencies = {
  repository: QbRepository;
  credentials: QbCredentialStore;
  sync: Pick<QbInventorySync, 'run'>;
  coordinator: Pick<QbInventoryCoordinator, 'runEnabled'>;
  preflight: TorrentPreflightService;
  requireSession: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
  /**
   * Builds the throwaway client used by the connection test. Injectable for
   * tests; the default carries the same guardrails as the registry's clients,
   * including the production rule that plain HTTP must target loopback.
   */
  probeFactory?: (options: { baseUrl: string; username: string; password: string }) => QbProbe;
};

/** Deterministic secret_ref for an instance the web UI created. */
function secretRefFor(instanceId: string): string {
  return `qb-instance:${instanceId}`;
}

/**
 * qB reports something like `v4.6.5` or `5.0.4`. Anything else is treated as a
 * non-answer.
 *
 * This is the narrow point where a byte the operator chose the address of comes
 * back out to the browser. Without a shape check the endpoint would be a
 * read primitive: point `baseUrl` at any local service and the first line of its
 * response is echoed as a "version". Reporting BAD_RESPONSE instead loses
 * nothing an operator needed — a server that does not answer with a version
 * string is not the qB they were trying to reach.
 */
function asQbVersion(raw: string): string | null {
  const version = raw.trim();
  return /^v?\d+(?:\.\d+){0,3}[A-Za-z0-9.\-+]{0,16}$/.test(version) ? version : null;
}

/**
 * Why a test failed, in terms the operator can act on.
 *
 * Only three outcomes, because only three different things can be done about
 * them: fix the password, fix the address, or look at what is answering there.
 * The underlying error is deliberately not forwarded — qB's client errors carry
 * the base URL and response bodies.
 */
function testFailureCode(error: unknown): QbInstanceTestResult['error'] {
  if (error instanceof QbClientError) {
    if (error.code === 'AUTH_FAILED' || error.code === 'AUTH_COOKIE_MISSING') return 'AUTH_FAILED';
    if (error.code === 'INVALID_RESPONSE' || error.code === 'AUTH_RESPONSE_INVALID') {
      return 'BAD_RESPONSE';
    }
    // A rejected request is only "unreachable" when the far side did not refuse
    // us specifically. 401/403 on `app/version` reaches here after the client
    // has already retried with a fresh login, so the credentials are the answer.
    if (error.code === 'REQUEST_FAILED' && (error.status === 401 || error.status === 403)) {
      return 'AUTH_FAILED';
    }
  }
  return 'UNREACHABLE';
}

/**
 * Encodes the mapping set for storage, or `undefined` to leave it alone.
 *
 * An absent key and an empty array mean different things and must keep meaning
 * different things: a rename posted without `pathMaps` has to preserve whatever
 * is stored, while an operator who cleared the field is asking for no mapping.
 */
function encodePathMaps(pathMaps: readonly string[] | undefined): string | null | undefined {
  if (pathMaps === undefined) return undefined;
  if (pathMaps.length === 0) return null;
  return pathMaps.join(',');
}

/** Splits the stored column back into the array the config form posts. */
function decodePathMaps(stored: string | null | undefined): string[] {
  if (stored === null || stored === undefined || stored.trim() === '') return [];
  return stored
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function toSummary(record: TorrentRecord): TorrentSummary {
  return TorrentSummarySchema.parse({
    instanceId: record.instanceId,
    hash: record.hash,
    name: record.name,
    progress: record.progress,
    state: record.state,
    totalSize: record.totalSize,
    amountLeft: record.amountLeft,
    contentPath: record.contentPath,
    savePath: record.savePath,
    ratio: record.ratio,
    seedingSeconds: record.seedingSeconds,
    completedAt: record.completedAt,
    cloudState: record.cloudState,
  });
}

/**
 * Reduces a sync failure to a stable code. The raw error must not reach the
 * client: a qB connection error carries the base URL, and some carry response
 * bodies, so echoing it would leak instance topology to anyone with a session.
 */
function syncFailureCode(error: unknown): string {
  if (error instanceof InventorySyncError) return error.code;
  if (error instanceof QbRegistryError) return error.code;
  return 'SYNC_FAILED';
}

function toSyncSummary(result: InventorySyncResult): {
  instanceId: string;
  seen: number;
  inserted: number;
  updated: number;
  markedAbsent: number;
  finishedAt: number;
} {
  return {
    instanceId: result.instanceId,
    seen: result.seen,
    inserted: result.inserted,
    updated: result.updated,
    markedAbsent: result.markedAbsent,
    finishedAt: result.finishedAt,
  };
}

const PositiveIntegerQuerySchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .refine(Number.isSafeInteger);

/**
 * Registers the qB inventory routes.
 *
 * The GET endpoints are read-only projections of the shadow inventory. Three POST
 * endpoints exist alongside them:
 *
 *  - `POST /api/qb/instances` writes *our own* config (which qB to poll, and the
 *    credentials to poll it with). It touches no torrent and no media file.
 *  - `POST /api/qb/instances/test` dials a qB and reads its version. It writes
 *    nothing at all, on either side.
 *  - `POST /api/qb/sync` triggers an inventory refresh, which only ever *reads*
 *    from qB (`torrents/info`). It cannot pause, delete, or move anything.
 *
 * None of them is the gated mutation surface. The gate covers pausing torrents,
 * uploading media, and deleting local files — those still require a separately
 * approved manifest and must not be added by quietly extending this module.
 */
export function registerQbRoutes(app: FastifyInstance, deps: QbRouteDependencies): void {
  const mutationOptions = {
    onRequest: deps.protectCsrf,
    preHandler: deps.requireSession,
  };

  // `environment: 'production'` matches the registry: a test that succeeded
  // against an address the poller will later refuse would be worse than no test
  // at all. The placeholder instance id is never persisted — it exists only
  // because the client requires one to label its own errors.
  const probeFactory: NonNullable<QbRouteDependencies['probeFactory']> =
    deps.probeFactory ??
    ((options) => new QbClient({ ...options, instanceId: 'probe', environment: 'production' }));

  app.get('/api/qb/instances', { preHandler: deps.requireSession }, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    const instances = deps.repository.listInstances().map((instance) => {
      const credential = deps.credentials.get(instance.secretRef);
      return {
        id: instance.id,
        displayName: instance.displayName,
        enabled: instance.enabled,
        // Enough for the config form to round-trip without ever exposing the
        // password (not even its ciphertext) or the secret_ref indirection.
        baseUrl: credential?.baseUrl ?? null,
        username: credential?.username ?? null,
        hasCredential: credential !== null,
        pathMaps: decodePathMaps(instance.pathMaps),
        // What the poller last observed, so a settings page can say "last synced
        // 4 minutes ago" instead of leaving the operator to guess whether an
        // instance is quiet or has been unreachable since yesterday.
        lastSyncAt: instance.lastSyncAt ?? null,
        lastSyncError: instance.lastSyncError ?? null,
      };
    });
    return { instances };
  });

  app.post('/api/qb/instances', mutationOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const parsed = QbInstanceConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid instance configuration' });
    }
    const config = parsed.data;

    // Parsed with the same function the sync path uses, so a set that would make
    // every later refresh fail with INVALID_PATH_MAP is rejected while the
    // operator is still on the form rather than stored and discovered later.
    if (config.pathMaps !== undefined) {
      try {
        parsePathMaps(config.pathMaps);
      } catch (error) {
        if (error instanceof PathMapError) {
          return reply.code(400).send({ error: 'Invalid path mapping', entry: error.entry });
        }
        throw error;
      }
    }

    // Reuse the existing secret_ref when the instance is already known so a
    // rename never orphans the stored credential.
    const existing = deps.repository.getInstance(config.id);
    const secretRef = existing?.secretRef ?? secretRefFor(config.id);
    const storedCredential = deps.credentials.get(secretRef);

    if (config.password === undefined && !storedCredential) {
      // A first-time instance has nothing to fall back on.
      return reply.code(400).send({ error: 'Password is required for a new instance' });
    }

    const password = config.password ?? deps.credentials.open(storedCredential!.encryptedPassword);

    deps.credentials.upsert({
      id: secretRef,
      baseUrl: config.baseUrl,
      username: config.username,
      password,
    });
    const encodedPathMaps = encodePathMaps(config.pathMaps);
    deps.repository.upsertInstance({
      id: config.id,
      displayName: config.displayName,
      enabled: config.enabled,
      secretRef,
      ...(encodedPathMaps === undefined ? {} : { pathMaps: encodedPathMaps }),
    });

    return reply.code(200).send({
      instance: {
        id: config.id,
        displayName: config.displayName,
        enabled: config.enabled,
        baseUrl: config.baseUrl,
        username: config.username,
        hasCredential: true,
        // Read back from storage rather than echoed from the request: when the
        // key was omitted the stored set is the answer, and the form needs to
        // see what it will actually be polled with.
        pathMaps: decodePathMaps(deps.repository.getInstance(config.id)?.pathMaps),
      },
    });
  });

  /**
   * Dials a qB with credentials the operator has typed but not yet saved.
   *
   * Nothing is written — not the instance row, not the credential, not an audit
   * subject — because nothing was decided yet. Only `app/version` is called: it
   * proves the address, the password, and that a qB is what answers, and it is
   * the one endpoint that cannot change a single thing on the far side.
   *
   * A rejected password answers 200 with `ok: false`. Mirroring qB's status here
   * would force the client to tell "your qB said no" apart from "this endpoint
   * is broken" by reading a status code that means both.
   */
  app.post('/api/qb/instances/test', mutationOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const parsed = QbInstanceTestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid connection test' });
    }

    let probe: QbProbe;
    try {
      probe = probeFactory(parsed.data);
    } catch (error) {
      // A base URL the client accepted but the qB client refuses — non-loopback
      // plain HTTP in production is the usual one. That is a fact about the
      // address, so it reports as a failed test, not as a broken endpoint.
      const result: QbInstanceTestResult = { ok: false, version: null, error: 'UNREACHABLE' };
      void error;
      return reply.code(200).send(result);
    }

    try {
      const version = asQbVersion(await probe.version());
      const result: QbInstanceTestResult =
        version === null
          ? { ok: false, version: null, error: 'BAD_RESPONSE' }
          : { ok: true, version, error: null };
      return reply.code(200).send(result);
    } catch (error) {
      const result: QbInstanceTestResult = {
        ok: false,
        version: null,
        error: testFailureCode(error),
      };
      return reply.code(200).send(result);
    }
  });

  app.post('/api/qb/sync', mutationOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const parsed = QbSyncRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid sync request' });
    }

    const instanceId = parsed.data.instanceId;
    if (instanceId !== undefined) {
      if (!deps.repository.getInstance(instanceId)) {
        return reply.code(404).send({ error: 'Unknown instance' });
      }
      try {
        const result = await deps.sync.run(instanceId);
        return { synced: [toSyncSummary(result)], failed: [] };
      } catch (error) {
        const code = syncFailureCode(error);
        // A refresh already running is not a client error worth retrying blindly.
        if (code === 'SYNC_IN_PROGRESS') {
          return reply.code(409).send({ error: 'Sync already in progress' });
        }
        return reply.code(502).send({ error: 'Sync failed', code });
      }
    }

    // Whole-fleet refresh: one unreachable instance must not fail the others,
    // so partial failure is reported in the body rather than as a status code.
    const report = await deps.coordinator.runEnabled();
    return {
      synced: report.successes.map(toSyncSummary),
      failed: report.failures.map((failure) => ({
        instanceId: failure.instanceId,
        code: syncFailureCode(failure.error),
      })),
    };
  });

  app.get('/api/qb/torrents', { preHandler: deps.requireSession }, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const query = request.query as
      { instanceId?: unknown; page?: unknown; size?: unknown } | undefined;
    const rawInstance = query?.instanceId;

    let instanceFilter: string | undefined;
    if (rawInstance !== undefined) {
      if (typeof rawInstance !== 'string') {
        return reply.code(400).send({ error: 'Invalid instanceId' });
      }
      const parsed = QbInstanceIdSchema.safeParse(rawInstance);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid instanceId' });
      }
      if (!deps.repository.getInstance(parsed.data)) {
        return reply.code(404).send({ error: 'Unknown instance' });
      }
      instanceFilter = parsed.data;
    }

    const paginationRequested = query?.page !== undefined || query?.size !== undefined;
    if (!paginationRequested) {
      const torrents = deps.repository.listTorrents(instanceFilter).map(toSummary);
      return { torrents };
    }

    const parsedPage =
      query?.page === undefined
        ? { success: true as const, data: 1 }
        : PositiveIntegerQuerySchema.safeParse(query.page);
    const parsedSize =
      query?.size === undefined
        ? { success: true as const, data: 50 }
        : PositiveIntegerQuerySchema.safeParse(query.size);
    if (!parsedPage.success || !parsedSize.success) {
      return reply.code(400).send({ error: 'Invalid pagination' });
    }
    const result = deps.repository.listTorrentsPage({
      ...(instanceFilter === undefined ? {} : { instanceId: instanceFilter }),
      page: parsedPage.data,
      size: Math.min(parsedSize.data, 200),
    });
    return {
      torrents: result.torrents.map(toSummary),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  });

  app.get(
    '/api/qb/torrents/:instanceId/:hash/preflight',
    { preHandler: deps.requireSession },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      const params = request.params as { instanceId: string; hash: string };
      const instance = QbInstanceIdSchema.safeParse(params.instanceId);
      const hash = InfoHashSchema.safeParse(params.hash);
      if (!instance.success || !hash.success) {
        return reply.code(400).send({ error: 'Invalid torrent identity' });
      }

      try {
        const preflight = await deps.preflight.check({
          instanceId: instance.data,
          hash: canonicalHash(hash.data),
        });
        return { preflight };
      } catch (error) {
        if (error instanceof PreflightError) {
          if (error.code === 'TORRENT_NOT_FOUND') {
            return reply.code(404).send({ error: 'Torrent not found' });
          }
          return reply.code(400).send({ error: 'Invalid torrent identity' });
        }
        throw error;
      }
    },
  );
}
