import { randomUUID } from 'node:crypto';

import {
  RehydrateSnapshotSchema,
  type JobState,
  type RehydrateSnapshot,
  type RehydrateStep,
} from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';
import { canonicalHash } from '../qb/repository.js';

/**
 * The only legal step order.
 *
 * `VERIFYING_LOCAL -> INSTALLING_LOCAL` and
 * `QB_RECHECKING -> QB_RESUMING` are the two load-bearing adjacencies: corrupt
 * bytes are never installed, and qB never announces bytes it has not confirmed.
 */
const STEP_ORDER: readonly RehydrateStep[] = [
  'RESERVING_SPACE',
  'EVICTING_CACHE',
  'DOWNLOADING_TEMP',
  'VERIFYING_LOCAL',
  'INSTALLING_LOCAL',
  'QB_RECHECKING',
  'QB_RESUMING',
  'COMPLETED',
];

/** Reservation can move directly to download when no cache eviction is needed. */
const SKIPPABLE: ReadonlySet<RehydrateStep> = new Set(['EVICTING_CACHE']);

type SnapshotRow = {
  jobId: string;
  instanceId: string;
  torrentHash: string;
  currentStep: RehydrateStep;
  jobState: JobState;
  autoResume: number;
  reservedBytes: number;
  blockedMissingBytes: number | null;
  tempDirectory: string | null;
  installedAt: number | null;
  cancelledAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type RehydrateWorkState = {
  jobId: string;
  instanceId: string;
  torrentHash: string;
  currentStep: RehydrateStep;
  jobState: JobState;
  autoResume: boolean;
  reservedBytes: number;
  blockedMissingBytes: number | null;
  tempDirectory: string | null;
  installedAt: number | null;
  cancelledAt: number | null;
};

export type CreateRehydrate = {
  instanceId: string;
  torrentHash: string;
  autoResume?: boolean;
  jobId?: string;
};

export type RehydrateFields = {
  reservedBytes?: number;
  blockedMissingBytes?: number | null;
  tempDirectory?: string | null;
  installedAt?: number;
};

export class RehydrateMachine {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Creates the worker job and durable snapshot atomically. */
  create(input: CreateRehydrate): RehydrateSnapshot {
    const jobId = input.jobId ?? randomUUID();
    const hash = canonicalHash(input.torrentHash);
    const timestamp = this.now();
    try {
      this.db.transaction(() => {
        const torrent = this.db
          .prepare('SELECT 1 FROM torrents WHERE instance_id = ? AND hash = ?')
          .get(input.instanceId, hash);
        if (!torrent) throw new Error('REHYDRATE_TORRENT_NOT_FOUND');

        this.db
          .prepare(
            `INSERT INTO jobs(
               id, kind, state, idempotency_key, payload_json, progress, attempt,
               run_after, created_at, updated_at, last_error_code
             ) VALUES (?, 'REHYDRATE', 'QUEUED', ?, ?, 0, 0, ?, ?, ?, NULL)`,
          )
          .run(
            jobId,
            `rehydrate:${input.instanceId}:${hash}:${jobId}`,
            JSON.stringify({ jobId }),
            timestamp,
            timestamp,
            timestamp,
          );
        this.db
          .prepare(
            `INSERT INTO rehydrate_snapshots(
               job_id, instance_id, torrent_hash, current_step, auto_resume,
               created_at, updated_at
             ) VALUES (?, ?, ?, 'RESERVING_SPACE', ?, ?, ?)`,
          )
          .run(
            jobId,
            input.instanceId,
            hash,
            input.autoResume === false ? 0 : 1,
            timestamp,
            timestamp,
          );
        const updatedTorrent = this.db
          .prepare(
            `UPDATE torrents SET cloud_state = 'REHYDRATING'
             WHERE instance_id = ? AND hash = ?`,
          )
          .run(input.instanceId, hash);
        if (updatedTorrent.changes !== 1) throw new Error('REHYDRATE_TORRENT_NOT_FOUND');
        this.insertEvent(jobId, 'REHYDRATE_CREATED', timestamp);
      })();
    } catch (error: unknown) {
      if (isActiveIdentityConstraint(error)) throw new Error('REHYDRATE_ALREADY_ACTIVE');
      throw error;
    }
    return this.require(jobId);
  }

  get(jobId: string): RehydrateSnapshot | null {
    const row = this.getRow(jobId);
    return row ? toSnapshot(row) : null;
  }

  /** Internal fields needed for crash recovery but intentionally not exposed by the API. */
  workState(jobId: string): RehydrateWorkState | null {
    const row = this.getRow(jobId);
    return row ? toWorkState(row) : null;
  }

  transition(
    jobId: string,
    from: RehydrateStep,
    to: RehydrateStep,
    fields: RehydrateFields = {},
  ): RehydrateSnapshot {
    assertLegalTransition(from, to);
    this.updateSnapshot(jobId, from, fields, to);
    return this.require(jobId);
  }

  /** Updates evidence on the current step without pretending the step advanced. */
  updateFields(
    jobId: string,
    expectedStep: RehydrateStep,
    fields: RehydrateFields,
  ): RehydrateSnapshot {
    this.updateSnapshot(jobId, expectedStep, fields);
    return this.require(jobId);
  }

  /**
   * Records an operator cancellation request before install begins.
   *
   * Final job-state/cloud-state changes happen only after the handler has stopped
   * writing and removed its job-owned temp directory.
   */
  requestCancel(jobId: string): { cancelled: true; localPreserved: true } {
    this.db.transaction(() => {
      const current = this.requireWork(jobId);
      if (current.cancelledAt !== null) throw new Error('REHYDRATE_CANCEL_CONFLICT');
      if (
        current.installedAt !== null ||
        STEP_ORDER.indexOf(current.currentStep) >= STEP_ORDER.indexOf('INSTALLING_LOCAL')
      ) {
        throw new Error('REHYDRATE_ALREADY_INSTALLED');
      }
      const updated = this.db
        .prepare(
          `UPDATE rehydrate_snapshots SET cancelled_at = ?, updated_at = ?
           WHERE job_id = ? AND cancelled_at IS NULL`,
        )
        .run(this.now(), this.now(), jobId);
      if (updated.changes !== 1) throw new Error('REHYDRATE_CANCEL_CONFLICT');
      this.insertEvent(jobId, 'REHYDRATE_CANCEL_REQUESTED', this.now());
    })();
    return { cancelled: true, localPreserved: true };
  }

  /** Marks a requested cancellation complete after temp cleanup and release. */
  finalizeCancellation(jobId: string): void {
    this.db.transaction(() => {
      const current = this.requireWork(jobId);
      if (current.cancelledAt === null) throw new Error('REHYDRATE_NOT_CANCELLED');
      if (current.installedAt !== null) throw new Error('REHYDRATE_ALREADY_INSTALLED');
      const updated = this.db
        .prepare(
          `UPDATE jobs SET state = 'CANCELLED_SAFE', last_error_code = NULL, updated_at = ?
           WHERE id = ? AND state != 'COMPLETED'`,
        )
        .run(this.now(), jobId);
      if (updated.changes === 0 && current.jobState !== 'CANCELLED_SAFE') {
        throw new Error('REHYDRATE_CANCEL_CONFLICT');
      }
      this.db
        .prepare(
          `UPDATE torrents SET cloud_state = 'CLOUD'
           WHERE instance_id = ? AND hash = ?`,
        )
        .run(current.instanceId, current.torrentHash);
      if (current.jobState !== 'CANCELLED_SAFE') {
        this.insertEvent(jobId, 'REHYDRATE_CANCELLED_SAFE', this.now());
      }
    })();
  }

  /** Synchronous compatibility path for callers that have no active handler. */
  cancel(jobId: string): { cancelled: true; localPreserved: true } {
    const result = this.requestCancel(jobId);
    this.finalizeCancellation(jobId);
    return result;
  }

  /** Requeues a safely stopped job at its persisted step. */
  retry(jobId: string): { jobId: string; resumingFrom: RehydrateStep } {
    return this.db.transaction(() => {
      const current = this.requireWork(jobId);
      if (current.cancelledAt !== null) throw new Error('REHYDRATE_CANCELLED');
      if (current.currentStep === 'COMPLETED') throw new Error('REHYDRATE_ALREADY_COMPLETED');
      const changed = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'QUEUED', run_after = ?, last_error_code = NULL, updated_at = ?
           WHERE id = ? AND state IN ('FAILED_SAFE', 'BLOCKED', 'RETRY_WAIT')`,
        )
        .run(this.now(), this.now(), jobId);
      if (changed.changes !== 1) throw new Error('REHYDRATE_NOT_RETRYABLE');
      this.db
        .prepare(
          `UPDATE torrents SET cloud_state = 'REHYDRATING'
           WHERE instance_id = ? AND hash = ?`,
        )
        .run(current.instanceId, current.torrentHash);
      this.insertEvent(jobId, 'REHYDRATE_RETRY_QUEUED', this.now());
      return { jobId, resumingFrom: current.currentStep };
    })();
  }

  activeHolder(
    instanceId: string,
    torrentHash: string,
  ): { jobId: string; currentStep: RehydrateStep; jobState: JobState } | null {
    const row = this.db
      .prepare(
        `SELECT s.job_id AS jobId, s.current_step AS currentStep, j.state AS jobState
         FROM rehydrate_snapshots s JOIN jobs j ON j.id = s.job_id
         WHERE s.instance_id = ? AND s.torrent_hash = ?
           AND s.current_step != 'COMPLETED' AND s.cancelled_at IS NULL`,
      )
      .get(instanceId, canonicalHash(torrentHash)) as
      { jobId: string; currentStep: RehydrateStep; jobState: JobState } | undefined;
    return row ?? null;
  }

  list(): RehydrateSnapshot[] {
    const rows = this.db
      .prepare(
        `${snapshotSelect()}
         ORDER BY s.created_at DESC, s.job_id DESC`,
      )
      .all() as SnapshotRow[];
    return rows.map(toSnapshot);
  }

  private updateSnapshot(
    jobId: string,
    expectedStep: RehydrateStep,
    fields: RehydrateFields,
    nextStep?: RehydrateStep,
  ): void {
    this.db.transaction(() => {
      const current = this.requireWork(jobId);
      if (current.cancelledAt !== null) throw new Error('REHYDRATE_CANCELLED');
      const updated = this.db
        .prepare(
          `UPDATE rehydrate_snapshots SET
             current_step = CASE WHEN @setStep = 1 THEN @nextStep ELSE current_step END,
             reserved_bytes = CASE WHEN @setReserved = 1 THEN @reservedBytes ELSE reserved_bytes END,
             blocked_missing_bytes = CASE WHEN @setBlocked = 1 THEN @blockedMissingBytes
                                          ELSE blocked_missing_bytes END,
             temp_directory = CASE WHEN @setTemp = 1 THEN @tempDirectory ELSE temp_directory END,
             installed_at = CASE WHEN @setInstalled = 1 THEN @installedAt ELSE installed_at END,
             updated_at = @updatedAt
           WHERE job_id = @jobId AND current_step = @expectedStep AND cancelled_at IS NULL`,
        )
        .run({
          jobId,
          expectedStep,
          setStep: nextStep === undefined ? 0 : 1,
          nextStep: nextStep ?? expectedStep,
          setReserved: fields.reservedBytes === undefined ? 0 : 1,
          reservedBytes: fields.reservedBytes ?? 0,
          setBlocked: 'blockedMissingBytes' in fields ? 1 : 0,
          blockedMissingBytes: fields.blockedMissingBytes ?? null,
          setTemp: 'tempDirectory' in fields ? 1 : 0,
          tempDirectory: fields.tempDirectory ?? null,
          setInstalled: fields.installedAt === undefined ? 0 : 1,
          installedAt: fields.installedAt ?? 0,
          updatedAt: this.now(),
        });
      if (updated.changes !== 1) throw new Error('REHYDRATE_STEP_CONFLICT');
    })();
  }

  private getRow(jobId: string): SnapshotRow | null {
    const row = this.db.prepare(`${snapshotSelect()} WHERE s.job_id = ?`).get(jobId) as
      SnapshotRow | undefined;
    return row ?? null;
  }

  private require(jobId: string): RehydrateSnapshot {
    const snapshot = this.get(jobId);
    if (!snapshot) throw new Error('REHYDRATE_NOT_FOUND');
    return snapshot;
  }

  private requireWork(jobId: string): RehydrateWorkState {
    const state = this.workState(jobId);
    if (!state) throw new Error('REHYDRATE_NOT_FOUND');
    return state;
  }

  private insertEvent(jobId: string, eventType: string, createdAt: number): void {
    this.db
      .prepare(
        `INSERT INTO job_events(id, job_id, event_type, detail_json, created_at)
         VALUES (?, ?, ?, '{}', ?)`,
      )
      .run(randomUUID(), jobId, eventType, createdAt);
  }
}

function snapshotSelect(): string {
  return `SELECT s.job_id AS jobId, s.instance_id AS instanceId,
                 s.torrent_hash AS torrentHash, s.current_step AS currentStep,
                 j.state AS jobState, s.auto_resume AS autoResume,
                 s.reserved_bytes AS reservedBytes,
                 s.blocked_missing_bytes AS blockedMissingBytes,
                 s.temp_directory AS tempDirectory, s.installed_at AS installedAt,
                 s.cancelled_at AS cancelledAt, s.created_at AS createdAt,
                 s.updated_at AS updatedAt
          FROM rehydrate_snapshots s JOIN jobs j ON j.id = s.job_id`;
}

function assertLegalTransition(from: RehydrateStep, to: RehydrateStep): void {
  const fromIndex = STEP_ORDER.indexOf(from);
  const toIndex = STEP_ORDER.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) throw new Error('REHYDRATE_STEP_UNKNOWN');
  if (toIndex <= fromIndex) throw new Error('REHYDRATE_STEP_NOT_FORWARD');
  if (toIndex === fromIndex + 1) return;
  const skipped = STEP_ORDER.slice(fromIndex + 1, toIndex);
  if (skipped.every((step) => SKIPPABLE.has(step))) return;
  throw new Error('REHYDRATE_STEP_SKIPPED');
}

function toSnapshot(row: SnapshotRow): RehydrateSnapshot {
  return RehydrateSnapshotSchema.parse({
    jobId: row.jobId,
    instanceId: row.instanceId,
    torrentHash: row.torrentHash,
    currentStep: row.currentStep,
    jobState: row.jobState,
    autoResume: row.autoResume === 1,
    reservedBytes: row.reservedBytes,
    blockedMissingBytes: row.blockedMissingBytes,
    installedAt: row.installedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toWorkState(row: SnapshotRow): RehydrateWorkState {
  return {
    jobId: row.jobId,
    instanceId: row.instanceId,
    torrentHash: row.torrentHash,
    currentStep: row.currentStep,
    jobState: row.jobState,
    autoResume: row.autoResume === 1,
    reservedBytes: row.reservedBytes,
    blockedMissingBytes: row.blockedMissingBytes,
    tempDirectory: row.tempDirectory,
    installedAt: row.installedAt,
    cancelledAt: row.cancelledAt,
  };
}

function isActiveIdentityConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: rehydrate_snapshots\.instance_id, rehydrate_snapshots\.torrent_hash/i.test(
      error.message,
    )
  );
}
