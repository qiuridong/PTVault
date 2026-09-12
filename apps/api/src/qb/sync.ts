import { InfoHashSchema, QbInstanceIdSchema } from '@ptvault/contracts';
import { z } from 'zod';

import type { Clock } from '../core/clock.js';
import { normalizeTorrentState } from './client.js';
import { applyPathMaps, parsePathMaps, type PathMap } from './path-map.js';
import {
  canonicalHash,
  type InventoryRecord,
  type QbInstanceRecord,
  type QbRepository,
} from './repository.js';
import type { QbControlRegistry } from './types.js';

const QbTorrentSchema = z.object({
  hash: InfoHashSchema,
  name: z.string().min(1),
  progress: z.number().finite().min(0).max(1),
  state: z.string().min(1),
  size: z.number().finite().int().nonnegative(),
  amount_left: z.number().finite().int().nonnegative(),
  content_path: z.string().min(1),
  save_path: z.string().min(1),
  ratio: z.number().finite().nonnegative(),
  seeding_time: z.number().finite().int().nonnegative(),
  completion_on: z
    .number()
    .finite()
    .int()
    .min(-1)
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
});

const QbTorrentListSchema = z.array(QbTorrentSchema);

export type InventorySyncResult = {
  instanceId: string;
  seen: number;
  inserted: number;
  updated: number;
  markedAbsent: number;
  finishedAt: number;
};

export type InventorySyncFailure = {
  instanceId: string;
  error: unknown;
};

export type InventoryInstanceReport =
  | { instanceId: string; success: true; result: InventorySyncResult }
  | { instanceId: string; success: false; error: unknown };

export type InventoryCoordinatorReport = {
  reports: InventoryInstanceReport[];
  successes: InventorySyncResult[];
  failures: InventorySyncFailure[];
};

export type InventorySyncErrorCode =
  | 'INVALID_INSTANCE_ID'
  | 'INVALID_TORRENT_LIST'
  | 'DUPLICATE_TORRENT_HASH'
  | 'TORRENT_PATH_CONTAINS_NUL'
  | 'INVALID_PATH_MAP'
  | 'SYNC_IN_PROGRESS';

const ERROR_MESSAGES: Record<InventorySyncErrorCode, string> = {
  INVALID_INSTANCE_ID: 'qB instance ID is invalid',
  INVALID_TORRENT_LIST: 'qB torrent list is invalid',
  DUPLICATE_TORRENT_HASH: 'qB torrent list contains a duplicate hash',
  TORRENT_PATH_CONTAINS_NUL: 'qB torrent path contains a NUL byte',
  INVALID_PATH_MAP: 'qB instance path mapping is invalid',
  SYNC_IN_PROGRESS: 'SYNC_IN_PROGRESS',
};

export class InventorySyncError extends Error {
  constructor(readonly code: InventorySyncErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'InventorySyncError';
  }
}

export type QbInventorySyncOptions = {
  repository: QbRepository;
  registry: QbControlRegistry;
  now?: Clock;
  /**
   * Container→host rewrites applied to every path qB reports, before anything is
   * persisted. qB runs in Docker and reports its own namespace; storing those
   * paths verbatim would leave preflight unable to stat files that plainly exist.
   */
  pathMaps?: readonly PathMap[];
};

export class QbInventorySync {
  private readonly repository: QbRepository;
  private readonly registry: QbControlRegistry;
  private readonly now: Clock;
  private readonly pathMaps: readonly PathMap[];
  private readonly inFlight = new Set<string>();

  constructor(options: QbInventorySyncOptions);
  constructor(repository: QbRepository, registry: QbControlRegistry, now?: Clock);
  constructor(
    optionsOrRepository: QbInventorySyncOptions | QbRepository,
    registry?: QbControlRegistry,
    now: Clock = () => new Date(),
  ) {
    if ('repository' in optionsOrRepository) {
      this.repository = optionsOrRepository.repository;
      this.registry = optionsOrRepository.registry;
      this.now = optionsOrRepository.now ?? (() => new Date());
      this.pathMaps = optionsOrRepository.pathMaps ?? [];
      return;
    }
    if (!registry) throw new InventorySyncError('INVALID_INSTANCE_ID');
    this.repository = optionsOrRepository;
    this.registry = registry;
    this.now = now;
    this.pathMaps = [];
  }

  async run(instanceId: string): Promise<InventorySyncResult> {
    const parsedInstanceId = QbInstanceIdSchema.safeParse(instanceId);
    if (!parsedInstanceId.success) throw new InventorySyncError('INVALID_INSTANCE_ID');

    const canonicalInstanceId = parsedInstanceId.data;
    if (this.inFlight.has(canonicalInstanceId)) {
      throw new InventorySyncError('SYNC_IN_PROGRESS');
    }
    this.inFlight.add(canonicalInstanceId);

    try {
      const control = this.registry.get(canonicalInstanceId);
      const registeredInstance = this.repository.getInstance(canonicalInstanceId);
      if (!registeredInstance) throw new InventorySyncError('INVALID_INSTANCE_ID');
      const rawRecords: unknown = await control.list();
      const records = validateRecords(rawRecords, this.mapsFor(registeredInstance));
      const finishedAt = this.now().getTime();
      const counts = this.repository.reconcile(canonicalInstanceId, records, finishedAt);
      this.recordOutcome(canonicalInstanceId, finishedAt, null);

      return {
        instanceId: canonicalInstanceId,
        seen: records.length,
        ...counts,
        finishedAt,
      };
    } catch (error) {
      // A failed pass is recorded too. Without it a quiet instance and one that
      // has been unreachable for a day look identical on every read surface,
      // and the only trace was a log line nobody reads.
      this.recordOutcome(canonicalInstanceId, this.now().getTime(), codeOf(error));
      throw error;
    } finally {
      this.inFlight.delete(canonicalInstanceId);
    }
  }

  /**
   * The rewrites to apply to this instance's paths.
   *
   * An instance-level mapping replaces the global one rather than extending it:
   * merging two sets of prefix rules would make the effective mapping depend on
   * ordering between a database row and an environment variable, and the first
   * matching prefix wins. "This instance maps its own paths" is the statement an
   * operator is making by filling that field in.
   */
  private mapsFor(instance: QbInstanceRecord): readonly PathMap[] {
    const stored = instance.pathMaps;
    if (stored === null || stored === undefined || stored.trim() === '') return this.pathMaps;

    try {
      return parsePathMaps(stored.split(',').map((entry) => entry.trim()));
    } catch {
      // Refuse rather than silently falling back to the global map: the global
      // one is wrong for this instance — that is why an override exists — and
      // storing paths under it would put files where nothing can find them.
      throw new InventorySyncError('INVALID_PATH_MAP');
    }
  }

  private recordOutcome(instanceId: string, at: number, errorCode: string | null): void {
    try {
      this.repository.recordSyncOutcome(instanceId, { at, errorCode });
    } catch {
      // Bookkeeping must not turn a successful inventory refresh into a failure,
      // nor mask the original error on the failure path.
    }
  }
}

/** A stable code for the sync-status column; never a message. */
function codeOf(error: unknown): string {
  if (error instanceof InventorySyncError) return error.code;
  return 'SYNC_FAILED';
}

export type QbInventoryCoordinatorOptions = {
  repository: QbRepository;
  sync: QbInventorySync;
};

export class QbInventoryCoordinator {
  private readonly repository: QbRepository;
  private readonly sync: QbInventorySync;

  constructor(options: QbInventoryCoordinatorOptions);
  constructor(repository: QbRepository, sync: QbInventorySync);
  constructor(
    optionsOrRepository: QbInventoryCoordinatorOptions | QbRepository,
    sync?: QbInventorySync,
  ) {
    if ('repository' in optionsOrRepository) {
      this.repository = optionsOrRepository.repository;
      this.sync = optionsOrRepository.sync;
      return;
    }
    if (!sync) throw new Error('QbInventorySync is required');
    this.repository = optionsOrRepository;
    this.sync = sync;
  }

  async runEnabled(): Promise<InventoryCoordinatorReport> {
    const instanceIds = this.repository
      .listInstances({ enabledOnly: true })
      .map((instance) => instance.id);
    const reports = await Promise.all(
      instanceIds.map(async (instanceId): Promise<InventoryInstanceReport> => {
        try {
          const result = await this.sync.run(instanceId);
          return { instanceId, success: true, result };
        } catch (error: unknown) {
          return { instanceId, success: false, error };
        }
      }),
    );

    const successes: InventorySyncResult[] = [];
    const failures: InventorySyncFailure[] = [];
    for (const report of reports) {
      if (report.success) successes.push(report.result);
      else failures.push({ instanceId: report.instanceId, error: report.error });
    }
    return { reports, successes, failures };
  }

  run(): Promise<InventoryCoordinatorReport> {
    return this.runEnabled();
  }

  runAllEnabled(): Promise<InventoryCoordinatorReport> {
    return this.runEnabled();
  }
}

export const QbInventorySyncCoordinator = QbInventoryCoordinator;

function validateRecords(input: unknown, pathMaps: readonly PathMap[]): InventoryRecord[] {
  const parsed = QbTorrentListSchema.safeParse(input);
  if (!parsed.success) throw new InventorySyncError('INVALID_TORRENT_LIST');

  const hashes = new Set<string>();
  return parsed.data.map((record) => {
    // Checked before rewriting: a NUL in qB's output must be rejected outright,
    // not carried into a host path.
    if (record.content_path.includes('\0') || record.save_path.includes('\0')) {
      throw new InventorySyncError('TORRENT_PATH_CONTAINS_NUL');
    }
    const hash = canonicalHash(record.hash);
    if (hashes.has(hash)) throw new InventorySyncError('DUPLICATE_TORRENT_HASH');
    hashes.add(hash);
    return {
      ...record,
      hash,
      state: normalizeTorrentState(record.state),
      content_path: applyPathMaps(record.content_path, pathMaps),
      save_path: applyPathMaps(record.save_path, pathMaps),
    };
  });
}
