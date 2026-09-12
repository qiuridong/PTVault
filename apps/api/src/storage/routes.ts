import {
  OffloadSnapshotSchema,
  RecoveryCloudCopySchema,
  RecoveryExportSchema,
  RecoveryStatusSchema,
  StorageAccountSchema,
  type JobState,
} from '@ptvault/contracts';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';

import type { JobRepository } from '../jobs/repository.js';
import type { RecoveryRepository } from '../recovery/repository.js';
import type { RecoveryReadiness } from '../recovery/preparation-readiness.js';
import type { StorageAccountRepository } from './accounts.js';
import type { OffloadMachine } from './offload-machine.js';

/**
 * The timeline event projection the web job timeline consumes. Kept in lockstep
 * with the public wire contract: only the id/jobId/
 * eventType/detail{from?,to?}/createdAt fields are exposed.
 */
type JobEventView = {
  id: string;
  jobId: string;
  eventType: string;
  detail: { from?: JobState; to?: JobState };
  createdAt: number;
};

export type StorageRouteDependencies = {
  accounts: Pick<StorageAccountRepository, 'list'>;
  machine: Pick<OffloadMachine, 'list'>;
  jobs: Pick<JobRepository, 'listEvents'>;
  recovery: Pick<RecoveryRepository, 'listExports' | 'listCloudCopies'>;
  readiness: RecoveryReadiness;
  requireSession: preHandlerAsyncHookHandler;
};

const UuidSchema = z.string().uuid();
const VersionSchema = z.coerce.number().int().positive();

/**
 * Registers the read-only offload / storage-account / recovery routes that the
 * web UI consumes. Every endpoint is a GET behind the session guard: nothing
 * here pauses, uploads, deletes, or otherwise mutates. The offload trigger
 * (POST /api/offloads) is deliberately NOT registered — it belongs to the
 * go-live surface (PTVAULT_MODE=ACTIVE + recent MFA + a fresh preflight +
 * recovery-ready + an approved mutation manifest) and is out of scope while the
 * system runs in SHADOW. Any future mutation must arrive behind that manifest,
 * not by extending this module quietly.
 *
 * Response envelopes match the pinned wire contract verbatim so the frontend
 * clients (accountApi/jobApi/recoveryApi) resolve without translation.
 */
export function registerStorageRoutes(app: FastifyInstance, deps: StorageRouteDependencies): void {
  const guard = { preHandler: deps.requireSession };

  app.get('/api/storage/accounts', guard, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    const accounts = deps.accounts.list().map((account) => StorageAccountSchema.parse(account));
    return { accounts };
  });

  app.get('/api/offloads', guard, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    const offloads = deps.machine
      .list()
      .map((snapshot) => OffloadSnapshotSchema.parse(snapshot))
      .sort((left, right) => right.createdAt - left.createdAt);
    return { offloads };
  });

  app.get('/api/offloads/:jobId/events', guard, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const jobId = UuidSchema.safeParse((request.params as { jobId: string }).jobId);
    if (!jobId.success) {
      return reply.code(400).send({ error: 'Invalid job id' });
    }
    const events: JobEventView[] = deps.jobs.listEvents(jobId.data).map((event) => ({
      id: event.id,
      jobId: event.jobId,
      eventType: event.eventType,
      detail: projectDetail(event.detail),
      createdAt: event.createdAt,
    }));
    return { events };
  });

  app.get('/api/recovery/status', guard, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    return { status: RecoveryStatusSchema.parse(await deps.readiness.currentStatus()) };
  });

  app.get('/api/recovery/exports', guard, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    const exports = deps.recovery
      .listExports()
      .map((entry) => RecoveryExportSchema.parse(entry))
      .sort((left, right) => right.version - left.version);
    return { exports };
  });

  app.get('/api/recovery/exports/:version/cloud-copies', guard, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const version = VersionSchema.safeParse((request.params as { version: string }).version);
    if (!version.success) {
      return reply.code(400).send({ error: 'Invalid export version' });
    }
    const cloudCopies = deps.recovery
      .listCloudCopies(version.data)
      .map((copy) => RecoveryCloudCopySchema.parse(copy));
    return { cloudCopies };
  });
}

/** Narrow the persisted job-event detail to the timeline's {from?,to?} shape. */
function projectDetail(detail: { from?: JobState | undefined; to?: JobState | undefined }): {
  from?: JobState;
  to?: JobState;
} {
  const projected: { from?: JobState; to?: JobState } = {};
  if (detail.from !== undefined) projected.from = detail.from;
  if (detail.to !== undefined) projected.to = detail.to;
  return projected;
}
