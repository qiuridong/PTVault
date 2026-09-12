import type { AppConfig } from '../config/env.js';
import type { Clock } from '../core/clock.js';
import type { AppDatabase } from '../db/database.js';
import { QbCredentialStore } from './credentials.js';
import { TorrentPreflightService } from './preflight.js';
import { DbQbControlRegistry } from './registry.js';
import { QbRepository } from './repository.js';
import { QbInventoryCoordinator, QbInventorySync } from './sync.js';

export type QbServices = {
  repository: QbRepository;
  credentials: QbCredentialStore;
  registry: DbQbControlRegistry;
  sync: QbInventorySync;
  coordinator: QbInventoryCoordinator;
  preflight: TorrentPreflightService;
};

export type CreateQbServicesOptions = {
  db: AppDatabase;
  config: Pick<AppConfig, 'masterKey' | 'qbPathMaps' | 'qbAllowedRoots'>;
  now?: Clock;
};

/**
 * Builds the qB service graph once so every caller shares the same instances.
 *
 * Sharing matters for `QbInventorySync`: its `SYNC_IN_PROGRESS` guard lives in a
 * per-object `Set`. If the periodic scheduler and the manual "refresh now" button
 * each held their own sync object, they could poll the same instance
 * simultaneously — the reconcile transaction keeps the database consistent, but
 * the duplicated work and the contradictory inserted/updated counts reported back
 * to the UI would both be real. One graph, one guard.
 *
 * `preflight` lives here for a different reason: the read-only route and the
 * offload handler must judge a torrent against the same allowed-root set. Two
 * instances built from two config reads could disagree about what is in bounds,
 * and the disagreement that matters is the one where the UI says "eligible" and
 * the executor then touches a path the operator never allow-listed.
 */
export function createQbServices(options: CreateQbServicesOptions): QbServices {
  const now: Clock = options.now ?? (() => new Date());
  const repository = new QbRepository(options.db);
  const credentials = new QbCredentialStore(options.db, options.config.masterKey, now);
  const registry = new DbQbControlRegistry({ repository, credentials });
  const sync = new QbInventorySync({
    repository,
    registry,
    now,
    pathMaps: options.config.qbPathMaps,
  });
  const coordinator = new QbInventoryCoordinator({ repository, sync });
  const preflight = new TorrentPreflightService({
    repository,
    allowedRoots: options.config.qbAllowedRoots,
  });

  return { repository, credentials, registry, sync, coordinator, preflight };
}
