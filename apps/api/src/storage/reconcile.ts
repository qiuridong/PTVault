import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { AppDatabase } from '../db/database.js';
import type { CloudState, QbRepository } from '../qb/repository.js';
import { hasVerifiedPrimaryForEveryFile } from './replica-guard.js';

/**
 * A staging prefix observed on a remote at startup, paired with the account it
 * was found under. Reconciliation compares these against the prefixes still
 * claimed by live jobs; anything unaccounted for is quarantined in the database
 * (recorded, never deleted) for a human to inspect.
 */
export type ObservedStaging = {
  prefix: string;
  accountId: string;
};

export type ReconcileOptions = {
  observedStaging?: readonly ObservedStaging[];
};

export type ReconcileDisposition = 'RETRY' | 'RESUME_CLEANUP' | 'BLOCKED';

export type ReconcileEntry = {
  jobId: string;
  currentStep: string;
  disposition: ReconcileDisposition;
  reason?: string;
  requiresFreshPermit?: boolean;
};

export type ReconcileReport = {
  entries: ReconcileEntry[];
  quarantined: string[];
};

export type ReconcileServiceOptions = {
  db: AppDatabase;
  torrentRepository: Pick<QbRepository, 'setCloudState'>;
  now?: () => number;
};

type SnapshotRow = {
  jobId: string;
  instanceId: string;
  torrentHash: string;
  currentStep: string;
  contentRoot: string | null;
  stagingPrefix: string | null;
};

const COMMIT_INDEX: Record<string, number> = {
  PREFLIGHT: 0,
  PAUSING: 1,
  SNAPSHOTTING: 2,
  HASHING: 3,
  UPLOADING_STAGING: 4,
  VERIFYING: 5,
  FINALIZING_REMOTE: 6,
  CLOUD_COMMITTED: 7,
  LOCAL_CLEANUP: 8,
  COMPLETED: 9,
};

const CLOUD_COMMITTED_INDEX = 7;

/**
 * Startup crash recovery for the offload pipeline. `reconcile` walks every
 * non-terminal, non-cancelled offload job and decides — without deleting
 * anything — how each should resume:
 *
 * - **Pre-commit, local present** → RETRY the pipeline; staging is left intact.
 * - **Pre-commit, local gone** → BLOCKED with LOCAL_MISSING_REMOTE_UNCOMMITTED;
 *   the source vanished before a verified cloud copy existed, so the torrent is
 *   marked BLOCKED for a human — never silently completed.
 * - **Committed, primary replica verified** → RESUME_CLEANUP, but only under a
 *   freshly issued permit; reconciliation itself never unlinks a byte.
 * - **Committed, primary replica missing** → BLOCKED (PRIMARY_REPLICA_NOT_VERIFIED).
 *
 * Any staging prefix seen on a remote that no live job claims is quarantined in
 * the database (recorded, never auto-deleted) for manual inspection.
 */
export class ReconcileService {
  private readonly now: () => number;

  constructor(private readonly options: ReconcileServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  reconcile(options: ReconcileOptions = {}): ReconcileReport {
    const snapshots = this.readActiveSnapshots();
    const entries: ReconcileEntry[] = [];

    for (const snapshot of snapshots) {
      entries.push(this.reconcileOne(snapshot));
    }

    const quarantined = this.quarantineUnknownStaging(options.observedStaging ?? [], snapshots);

    return { entries, quarantined };
  }

  private reconcileOne(snapshot: SnapshotRow): ReconcileEntry {
    const stepIndex = COMMIT_INDEX[snapshot.currentStep] ?? -1;
    const committed = stepIndex >= CLOUD_COMMITTED_INDEX;

    if (!committed) {
      // Before the cloud commit, the local source is the only copy. If it is
      // still there, the pipeline can safely retry from its persisted step. If
      // it is gone, there is no verified cloud copy yet — block for a human.
      const localPresent = this.localPresent(snapshot);
      if (!localPresent) {
        return this.block(snapshot, 'LOCAL_MISSING_REMOTE_UNCOMMITTED');
      }
      return { jobId: snapshot.jobId, currentStep: snapshot.currentStep, disposition: 'RETRY' };
    }

    // After the cloud commit, the verified primary replica is the safety net.
    // If it is gone the job cannot safely proceed to cleanup — block it. If it
    // is present, cleanup may resume, but only under a freshly issued permit;
    // reconciliation deletes nothing.
    if (!this.hasVerifiedPrimaryForEveryFile(snapshot.jobId)) {
      return this.block(snapshot, 'PRIMARY_REPLICA_NOT_VERIFIED');
    }
    return {
      jobId: snapshot.jobId,
      currentStep: snapshot.currentStep,
      disposition: 'RESUME_CLEANUP',
      requiresFreshPermit: true,
    };
  }

  private block(snapshot: SnapshotRow, reason: string): ReconcileEntry {
    this.options.db.transaction(() => {
      this.options.db
        .prepare(
          `UPDATE jobs SET state = 'BLOCKED', last_error_code = ?, updated_at = ? WHERE id = ?`,
        )
        .run(reason, this.now(), snapshot.jobId);
      this.options.db
        .prepare(
          `INSERT INTO job_events(id, job_id, event_type, detail_json, created_at)
           VALUES (?, ?, 'OFFLOAD_BLOCKED', ?, ?)`,
        )
        .run(randomId(), snapshot.jobId, JSON.stringify({ reason }), this.now());
    })();
    this.options.torrentRepository.setCloudState(
      snapshot.instanceId,
      snapshot.torrentHash,
      'BLOCKED' satisfies CloudState,
    );
    return {
      jobId: snapshot.jobId,
      currentStep: snapshot.currentStep,
      disposition: 'BLOCKED',
      reason,
    };
  }

  private quarantineUnknownStaging(
    observed: readonly ObservedStaging[],
    snapshots: readonly SnapshotRow[],
  ): string[] {
    if (observed.length === 0) return [];
    const claimed = new Set<string>();
    for (const snapshot of snapshots) {
      if (snapshot.stagingPrefix) claimed.add(snapshot.stagingPrefix);
    }
    // Also treat prefixes claimed by any offload row (including terminal ones)
    // as known: a completed job's staging having lingered is not "orphan".
    for (const prefix of this.allKnownStagingPrefixes()) claimed.add(prefix);

    const quarantined: string[] = [];
    const insert = this.options.db.prepare(
      `INSERT INTO offload_quarantine(staging_prefix, account_id, reason, created_at)
       VALUES (?, ?, 'UNKNOWN_STAGING', ?)
       ON CONFLICT(staging_prefix) DO NOTHING`,
    );
    for (const entry of observed) {
      if (claimed.has(entry.prefix)) continue;
      insert.run(entry.prefix, entry.accountId, this.now());
      quarantined.push(entry.prefix);
    }
    return quarantined;
  }

  private allKnownStagingPrefixes(): string[] {
    return this.options.db
      .prepare(
        `SELECT staging_prefix AS prefix FROM offload_snapshots WHERE staging_prefix IS NOT NULL`,
      )
      .pluck()
      .all() as string[];
  }

  private localPresent(snapshot: SnapshotRow): boolean {
    if (!snapshot.contentRoot) return false;
    try {
      // Synchronous existence probe kept off the hot path; reconcile runs once
      // at startup over a bounded job set.
      return statSyncExists(snapshot.contentRoot);
    } catch {
      return false;
    }
  }

  private hasVerifiedPrimaryForEveryFile(jobId: string): boolean {
    return hasVerifiedPrimaryForEveryFile(this.options.db, jobId);
  }

  private readActiveSnapshots(): SnapshotRow[] {
    return this.options.db
      .prepare(
        `SELECT job_id AS jobId, instance_id AS instanceId, torrent_hash AS torrentHash,
                current_step AS currentStep, canonical_content_root AS contentRoot,
                staging_prefix AS stagingPrefix
         FROM offload_snapshots
         WHERE current_step <> 'COMPLETED' AND cancelled_at IS NULL
         ORDER BY created_at, job_id`,
      )
      .all() as SnapshotRow[];
  }
}

function randomId(): string {
  return randomUUID();
}

function statSyncExists(target: string): boolean {
  return path.isAbsolute(target) && existsSync(target);
}
