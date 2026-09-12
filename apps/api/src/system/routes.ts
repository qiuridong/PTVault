import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';

import type { SystemInfo, SystemMetrics } from '@ptvault/contracts';

import type { AppConfig } from '../config/env.js';
import type { AppDatabase } from '../db/database.js';
import { readMigrationThroughput } from '../storage/throughput.js';
import type { HostSnapshot } from './host-metrics.js';

export type SystemRouteDependencies = {
  db: AppDatabase;
  mode: AppConfig['mode'];
  version: string | null;
  buildCommit: string | null;
  /** Runtime media facts are optional on a fresh install without media paths. */
  media?: () => { total: number; healthy: number; lastReconciledAt: number | null };
  /**
   * The last host reading. Optional so a process without a sampler still answers
   * with a well-formed body: the migration throughput below comes from the
   * database and is worth having on its own.
   */
  host?: () => HostSnapshot;
  requireSession: preHandlerAsyncHookHandler;
};

/** Reported when no sampler is running, so the shape never depends on the wiring. */
const NO_SAMPLER: HostSnapshot = {
  source: 'UNAVAILABLE',
  unavailableReason: 'SAMPLER_NOT_RUNNING',
  sampledAt: null,
  sampleIntervalMs: 10_000,
  uptimeSeconds: null,
  cpu: null,
  memory: null,
  interfaces: [],
  omittedInterfaces: 0,
  disks: [],
  history: [],
};

/**
 * Host telemetry plus measured migration throughput.
 *
 * Registered in both modes and independently of the media services: knowing
 * whether the machine is busy is a read, and gating it behind ACTIVE would mean
 * an operator has to throw the destructive switch to find out whether now is a
 * good time to throw it. Same reasoning that put the recovery and media *read*
 * surfaces in SHADOW.
 *
 * One endpoint rather than two because the panel it feeds makes a single
 * judgement — "can I start an upload now, and how big" — out of the current
 * uplink use, the load on the box, and how fast past migrations actually went.
 * Two endpoints would let the browser render half an answer.
 */
export function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDependencies): void {
  app.get('/api/system/metrics', { preHandler: deps.requireSession }, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    const host = deps.host?.() ?? NO_SAMPLER;
    const metrics: SystemMetrics = { ...host, throughput: readMigrationThroughput(deps.db) };
    return metrics;
  });

  app.get('/api/system/info', { preHandler: deps.requireSession }, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    const media = deps.media?.() ?? { total: 0, healthy: 0, lastReconciledAt: null };
    const version = deps.db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get();
    const info: SystemInfo = {
      mode: deps.mode,
      version: deps.version,
      buildCommit: deps.buildCommit,
      schemaVersion: typeof version === 'number' ? version : 0,
      mounts: { total: media.total, healthy: media.healthy },
      lastReconciledAt: media.lastReconciledAt,
    };
    return info;
  });
}
