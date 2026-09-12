import { RehydrateRequestSchema } from '@ptvault/contracts';
import type { FastifyInstance, onRequestHookHandler, preHandlerAsyncHookHandler } from 'fastify';

import type { AuditRepository } from '../audit/repository.js';
import type { AppMode } from '../config/env.js';
import { canonicalHash } from '../qb/repository.js';
import type { CacheGovernor } from './cache.js';
import type { MediaCatalog } from './catalog.js';
import type { DisksResponse } from '@ptvault/contracts';

import { admissibleBytes, type DiskPolicy } from './disk.js';
import type { MountSupervisor } from './mount-supervisor.js';
import type { RehydrateMachine } from './rehydrate-machine.js';

export type MediaRouteDependencies = {
  mode: AppMode;
  catalog: Pick<MediaCatalog, 'list' | 'setLocalHot'>;
  supervisor: Pick<MountSupervisor, 'list' | 'isHealthy'>;
  governor: Pick<CacheGovernor, 'pin' | 'unpin' | 'pinnedPaths' | 'outstandingReservedBytes'>;
  rehydrate: Pick<RehydrateMachine, 'create' | 'get' | 'list' | 'retry' | 'activeHolder'>;
  cancelRehydrate: (jobId: string) => Promise<{ cancelled: true; localPreserved: true }>;
  policy: DiskPolicy;
  readFreeBytes: () => Promise<number>;
  /**
   * Capacity of both pools, and what the migrations have freed.
   *
   * Supplied as one function because all three come from places this module has no
   * business reaching into — two `statfs` calls on paths it does not own, and a
   * `GROUP BY` over the torrent table.
   */
  readDisks?: () => Promise<DisksResponse>;
  audit: Pick<AuditRepository, 'append'>;
  requireSession: preHandlerAsyncHookHandler;
  requireRecentMfa: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
};

/**
 * Read and command routes for the media surface.
 *
 * Reads need only a session — knowing what is cached or unavailable changes
 * nothing. Commands additionally need a fresh TOTP: a restore writes hundreds of
 * gigabytes to the hot disk and then tells a tracker to start announcing, so a
 * stolen cookie must not be able to start one.
 *
 * Every command returns 202 with a job id rather than doing the work inline. A
 * restore of a 578 GiB torrent takes hours at the measured throughput; holding an
 * HTTP request open for that would fail on the first proxy timeout and leave the
 * operator with no way to see where it got to.
 */
export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDependencies): void {
  const readOptions = { preHandler: deps.requireSession };
  const commandOptions = {
    onRequest: deps.protectCsrf,
    preHandler: [deps.requireSession, deps.requireRecentMfa],
  };

  app.get('/api/media', readOptions, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    // Asked per account, not once for the library: a title is UNAVAILABLE when the
    // account backing it is down, and titles on every other account keep playing.
    // A single library-wide flag would report an outage the others are not having.
    return { entries: deps.catalog.list((accountId) => deps.supervisor.isHealthy(accountId)) };
  });

  /**
   * Capacity for both disks, plus what migrating has bought back.
   *
   * Separate from `/api/media/health`: that endpoint's `diskFreeBytes` describes
   * the **cache** disk, because everything reported beside it — cache bytes, the
   * ceiling, the pressure verdict — is about the disk the VFS cache lives on. The
   * hot root's free space had no endpoint at all, which is why a dashboard could
   * not show the one number an operator most wants: how much room is left for
   * torrents.
   */
  app.get('/api/media/disks', readOptions, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    if (!deps.readDisks) return reply.code(503).send({ error: 'Disk telemetry unavailable' });
    return reply.send(await deps.readDisks());
  });

  app.get('/api/media/health', readOptions, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    // A list, one entry per supervised mount. An empty list is a real state — no
    // storage account registered yet — and is not an error.
    return { mounts: deps.supervisor.list() };
  });

  app.get('/api/media/rehydrates', readOptions, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    return { rehydrates: deps.rehydrate.list() };
  });

  /**
   * What a restore would cost, before committing to it.
   *
   * Answers the question the operator actually has — "will this fit, and what
   * happens to my free space" — instead of making them start one to find out.
   */
  app.get('/api/media/rehydrate-preview', readOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const query = request.query as { bytes?: string } | undefined;
    const requested = Number(query?.bytes ?? '0');
    if (!Number.isSafeInteger(requested) || requested < 0) {
      return reply.code(400).send({ error: 'Invalid byte count' });
    }

    const freeBytes = await deps.readFreeBytes();
    const outstandingReservedBytes = deps.governor.outstandingReservedBytes();
    const available = admissibleBytes({
      freeBytes,
      reserveBytes: deps.policy.reserveBytes,
      outstandingReservedBytes,
    });
    return {
      requestedBytes: requested,
      freeBytes,
      reserveBytes: deps.policy.reserveBytes,
      outstandingReservedBytes,
      availableBytes: available,
      /** Free space once this restore lands, so the operator sees the aftermath. */
      freeBytesAfter: Math.max(0, freeBytes - requested),
      admissible: available >= requested,
      missingBytes: available >= requested ? 0 : requested - available,
      /** True when the restore would eat into the protected reserve. */
      wouldBreachReserve: freeBytes - requested < deps.policy.reserveBytes,
    };
  });

  app.post('/api/media/pin', commandOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    // A pin decides what cache eviction may not reclaim, so it changes what a later
    // ACTIVE process does. SHADOW must not accumulate that: the graph is now built
    // in both modes so the read surface works, and this is one of the writes that
    // gate keeps out.
    if (deps.mode !== 'ACTIVE') {
      return reply.code(409).send({ error: 'MODE_NOT_ACTIVE' });
    }

    const body = request.body as
      | { logicalPath?: unknown; instanceId?: unknown; torrentHash?: unknown; pinned?: unknown }
      | undefined;
    if (
      typeof body?.logicalPath !== 'string' ||
      body.logicalPath.length === 0 ||
      typeof body.instanceId !== 'string' ||
      typeof body.torrentHash !== 'string' ||
      typeof body.pinned !== 'boolean'
    ) {
      return reply.code(400).send({ error: 'Invalid pin request' });
    }

    if (body.pinned) {
      deps.governor.pin({
        logicalPath: body.logicalPath,
        instanceId: body.instanceId,
        torrentHash: canonicalHash(body.torrentHash),
      });
    } else {
      deps.governor.unpin(body.logicalPath);
    }
    deps.audit.append({
      actorAdminId: request.authenticatedAdmin?.adminId ?? null,
      sourceIp: request.ip,
      action: 'MEDIA_PIN_SET',
      subject: body.logicalPath,
      outcome: 'SUCCESS',
      correlationId: String(request.id),
      detail: { pinned: body.pinned },
    });
    return { pinned: [...deps.governor.pinnedPaths()] };
  });

  app.post('/api/media/rehydrate', commandOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    // ACTIVE is re-checked here even though the caller only registers these routes
    // in ACTIVE: a restore writes to the hot disk and controls qB, which is exactly
    // what SHADOW promises not to do.
    if (deps.mode !== 'ACTIVE') {
      return reply.code(409).send({ error: 'MODE_NOT_ACTIVE' });
    }

    const parsed = RehydrateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid rehydrate request' });
    }
    const { instanceId, autoResume } = parsed.data;
    const torrentHash = canonicalHash(parsed.data.torrentHash);

    const holder = deps.rehydrate.activeHolder(instanceId, torrentHash);
    if (holder) {
      // Named rather than a bare conflict, so the UI can offer to act on it instead
      // of leaving the operator with a torrent that cannot be restored.
      return reply.code(409).send({
        error: 'REHYDRATE_ALREADY_ACTIVE',
        conflict: {
          jobId: holder.jobId,
          currentStep: holder.currentStep,
          jobState: holder.jobState,
        },
      });
    }

    const snapshot = deps.rehydrate.create({ instanceId, torrentHash, autoResume });
    deps.audit.append({
      actorAdminId: request.authenticatedAdmin?.adminId ?? null,
      sourceIp: request.ip,
      action: 'MEDIA_REHYDRATE_STARTED',
      subject: `${instanceId}:${torrentHash}`,
      outcome: 'SUCCESS',
      correlationId: String(request.id),
      detail: { jobId: snapshot.jobId, autoResume },
    });
    return reply.code(202).send(snapshot);
  });

  app.post('/api/media/rehydrate/cancel', commandOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    // Nothing can be running in SHADOW to cancel — the handlers are not registered —
    // so this is refused for the same reason as the other commands rather than
    // quietly answering 404 for a job that could never have existed.
    if (deps.mode !== 'ACTIVE') {
      return reply.code(409).send({ error: 'MODE_NOT_ACTIVE' });
    }

    const body = request.body as { jobId?: unknown } | undefined;
    if (typeof body?.jobId !== 'string') {
      return reply.code(400).send({ error: 'Invalid cancel request' });
    }

    try {
      const result = await deps.cancelRehydrate(body.jobId);
      deps.audit.append({
        actorAdminId: request.authenticatedAdmin?.adminId ?? null,
        sourceIp: request.ip,
        action: 'MEDIA_REHYDRATE_CANCELLED',
        subject: body.jobId,
        outcome: 'SUCCESS',
        correlationId: String(request.id),
        detail: {},
      });
      return { jobId: body.jobId, ...result };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'REHYDRATE_CANCEL_FAILED';
      // 409 rather than 500: refusing to cancel an already-installed restore is the
      // rule working, not the server failing.
      const status = code === 'REHYDRATE_NOT_FOUND' ? 404 : 409;
      return reply.code(status).send({ error: code });
    }
  });

  app.post('/api/media/rehydrate/retry', commandOptions, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    if (deps.mode !== 'ACTIVE') {
      return reply.code(409).send({ error: 'MODE_NOT_ACTIVE' });
    }
    const body = request.body as { jobId?: unknown } | undefined;
    if (typeof body?.jobId !== 'string') {
      return reply.code(400).send({ error: 'Invalid retry request' });
    }
    try {
      const result = deps.rehydrate.retry(body.jobId);
      deps.audit.append({
        actorAdminId: request.authenticatedAdmin?.adminId ?? null,
        sourceIp: request.ip,
        action: 'MEDIA_REHYDRATE_RETRIED',
        subject: body.jobId,
        outcome: 'SUCCESS',
        correlationId: String(request.id),
        detail: { resumingFrom: result.resumingFrom },
      });
      return { ...result, requeued: true as const };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'REHYDRATE_RETRY_FAILED';
      return reply.code(code === 'REHYDRATE_NOT_FOUND' ? 404 : 409).send({ error: code });
    }
  });
}
