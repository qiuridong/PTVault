import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  CreateOffloadSchema,
  OffloadCancelResultSchema,
  OffloadControlIdempotencyKeySchema,
  OffloadPauseResultSchema,
  OffloadResumeResultSchema,
  OffloadResourceWaitSchema,
  OffloadSchedulerStatusSchema,
  OffloadSnapshotSchema,
  OffloadStepSchema,
  type CreateOffload,
  type OffloadAvailableAction,
  type OffloadCancelResult,
  type OffloadControlAction,
  type OffloadControlEventCode,
  type OffloadDeploymentBlocker,
  type OffloadPauseResult,
  type OffloadResourceWait,
  type OffloadResumeResult,
  type OffloadSchedulerStatus,
  type OffloadSnapshot,
  type OffloadStep,
  type JobState,
} from '@ptvault/contracts';

import type { AppDatabase } from '../db/database.js';
import {
  OFFLOAD_CONTROL_RECEIPT_PRUNE_BATCH,
  OFFLOAD_CONTROL_RECEIPT_TTL_MS,
  OFFLOAD_PAUSE_ACK_TIMEOUT_MS,
} from './offload-control-policy.js';
import type { OffloadSnapshotPublication } from './offload-event-publisher.js';
import { hasVerifiedPrimaryForEveryFile } from './replica-guard.js';

const ORDERED_STEPS: readonly OffloadStep[] = [
  'PREFLIGHT',
  'PAUSING',
  'SNAPSHOTTING',
  'HASHING',
  'UPLOADING_STAGING',
  'VERIFYING',
  'FINALIZING_REMOTE',
  'CLOUD_COMMITTED',
  'LOCAL_CLEANUP',
  'COMPLETED',
];

type SnapshotRow = {
  jobId: string;
  instanceId: string;
  torrentHash: string;
  importance: CreateOffload['importance'];
  currentStep: OffloadStep;
  jobState: OffloadSnapshot['jobState'];
  lastErrorCode: string | null;
  recoveryVersion: number | null;
  cancelledAt: number | null;
  cleanupCompletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  stepBytesDone: string | null;
  stepBytesTotal: string | null;
  verifiedBytes: string | null;
  totalBytes: string | null;
  filesDone: number | null;
  fileCount: number | null;
  currentFileAlias: string | null;
  uploadRateBps: string | null;
  hashRateBps: string | null;
  verifyRateBps: string | null;
  etaSeconds: number | null;
  ratesSampledAt: number | null;
  pauseRequestedAt: number | null;
  pausedAt: number | null;
  pauseAcknowledgementDeadlineAt: number | null;
  qbPauseConfirmedAt: number | null;
  resourceWait: OffloadResourceWait | null;
  resourceQueuePosition: number | null;
  resourceActive: number | null;
  resourceCapacity: number | null;
};

type ControlScope = 'JOB' | 'ALL';
type ControlReceipt =
  OffloadPauseResult | OffloadResumeResult | OffloadCancelResult | OffloadSchedulerStatus;

const TelemetryPatchSchema = z.object({
  stepBytesDone: OffloadSnapshotSchema.shape.stepBytesDone.unwrap().nullable().optional(),
  stepBytesTotal: OffloadSnapshotSchema.shape.stepBytesTotal.unwrap().nullable().optional(),
  verifiedBytes: OffloadSnapshotSchema.shape.verifiedBytes.unwrap().nullable().optional(),
  totalBytes: OffloadSnapshotSchema.shape.totalBytes.unwrap().nullable().optional(),
  filesDone: OffloadSnapshotSchema.shape.filesDone.unwrap().nullable().optional(),
  fileCount: OffloadSnapshotSchema.shape.fileCount.unwrap().nullable().optional(),
  currentFileAlias: OffloadSnapshotSchema.shape.currentFileAlias.unwrap().nullable().optional(),
  uploadRateBps: OffloadSnapshotSchema.shape.uploadRateBps.unwrap().nullable().optional(),
  hashRateBps: OffloadSnapshotSchema.shape.hashRateBps.unwrap().nullable().optional(),
  verifyRateBps: OffloadSnapshotSchema.shape.verifyRateBps.unwrap().nullable().optional(),
  etaSeconds: OffloadSnapshotSchema.shape.etaSeconds.unwrap().nullable().optional(),
  ratesSampledAt: OffloadSnapshotSchema.shape.ratesSampledAt.unwrap().nullable().optional(),
});

const ResourceWaitPatchSchema = z
  .object({
    resourceWait: OffloadResourceWaitSchema,
    resourceQueuePosition: z.number().int().positive().optional(),
    resourceActive: z.number().int().nonnegative(),
    resourceCapacity: z.number().int().positive(),
  })
  .strict();

export type OffloadResourceWaitPatch = z.infer<typeof ResourceWaitPatchSchema>;

export type OffloadTelemetryPatch = z.infer<typeof TelemetryPatchSchema>;

const TELEMETRY_COLUMNS: Record<keyof OffloadTelemetryPatch, string> = {
  stepBytesDone: 'step_bytes_done',
  stepBytesTotal: 'step_bytes_total',
  verifiedBytes: 'verified_bytes',
  totalBytes: 'total_bytes',
  filesDone: 'files_done',
  fileCount: 'file_count',
  currentFileAlias: 'current_file_alias',
  uploadRateBps: 'upload_rate_bps',
  hashRateBps: 'hash_rate_bps',
  verifyRateBps: 'verify_rate_bps',
  etaSeconds: 'eta_seconds',
  ratesSampledAt: 'rates_sampled_at',
};

export type OffloadEvidence = {
  primaryReplicaVerified?: boolean;
  cleanupCompleted?: boolean;
};

export type RestartAction = {
  jobId: string;
  currentStep: OffloadStep;
  action: 'RECHECK' | 'RETRY';
};

export class OffloadMachine {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = () => Date.now(),
    private readonly onPublish?: (
      snapshot: OffloadSnapshot,
      eventCode?: OffloadControlEventCode,
      publication?: OffloadSnapshotPublication,
    ) => void,
    private readonly creationEnabled: () => boolean = () => true,
  ) {}

  /** Cheap route guard; {@link create} repeats this inside its write transaction. */
  assertCreateAllowed(): void {
    if (!this.creationEnabled()) {
      throw new Error('OFFLOAD_CREATION_DISABLED');
    }
    if (this.schedulerState() !== 'RUNNING') {
      throw new Error('OFFLOAD_SCHEDULER_NOT_RUNNING');
    }
  }

  create(input: CreateOffload): OffloadSnapshot {
    const parsed = CreateOffloadSchema.parse(input);
    const id = randomUUID();
    const timestamp = this.now();
    const hash = parsed.torrentHash.toLowerCase();
    try {
      this.db.transaction(() => {
        // This is the authority, not the route's early check. Holding the same
        // SQLite write transaction across the gate read and both inserts closes
        // create-vs-pause-all without leaving an orphan job/snapshot/event.
        this.assertCreateAllowed();
        this.db
          .prepare(
            `INSERT INTO jobs(
               id, kind, state, idempotency_key, payload_json, progress, attempt,
               run_after, created_at, updated_at, last_error_code
             ) VALUES (?, 'OFFLOAD', 'QUEUED', ?, ?, 0, 0, ?, ?, ?, NULL)`,
          )
          .run(
            id,
            `offload:${parsed.instanceId}:${hash}:${id}`,
            JSON.stringify({ instanceId: parsed.instanceId, torrentHash: hash }),
            timestamp,
            timestamp,
            timestamp,
          );
        this.db
          .prepare(
            `INSERT INTO offload_snapshots(
               job_id, instance_id, torrent_hash, importance, current_step,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'PREFLIGHT', ?, ?)`,
          )
          .run(id, parsed.instanceId, hash, parsed.importance, timestamp, timestamp);
        this.insertEvent(id, 'OFFLOAD_CREATED', timestamp);
      })();
    } catch (error: unknown) {
      if (isActiveIdentityConstraint(error)) throw new Error('OFFLOAD_ALREADY_ACTIVE');
      throw error;
    }
    return this.publish(this.require(id));
  }

  get(jobId: string): OffloadSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT s.job_id AS jobId, s.instance_id AS instanceId,
                s.torrent_hash AS torrentHash, s.importance,
                s.current_step AS currentStep, j.state AS jobState,
                j.last_error_code AS lastErrorCode,
                s.recovery_version AS recoveryVersion,
                s.cancelled_at AS cancelledAt,
                s.cleanup_completed_at AS cleanupCompletedAt,
                s.created_at AS createdAt, s.updated_at AS updatedAt,
                s.step_bytes_done AS stepBytesDone,
                s.step_bytes_total AS stepBytesTotal,
                s.verified_bytes AS verifiedBytes, s.total_bytes AS totalBytes,
                s.files_done AS filesDone, s.file_count AS fileCount,
                s.current_file_alias AS currentFileAlias,
                s.upload_rate_bps AS uploadRateBps, s.hash_rate_bps AS hashRateBps,
                s.verify_rate_bps AS verifyRateBps, s.eta_seconds AS etaSeconds,
                s.rates_sampled_at AS ratesSampledAt,
                s.pause_requested_at AS pauseRequestedAt, s.paused_at AS pausedAt,
                s.pause_ack_deadline_at AS pauseAcknowledgementDeadlineAt,
                s.qb_paused_at AS qbPauseConfirmedAt,
                s.resource_wait AS resourceWait,
                s.resource_queue_position AS resourceQueuePosition,
                s.resource_active AS resourceActive,
                s.resource_capacity AS resourceCapacity
         FROM offload_snapshots s JOIN jobs j ON j.id = s.job_id
         WHERE s.job_id = ?`,
      )
      .get(jobId) as SnapshotRow | undefined;
    return row ? this.parseSnapshot(row) : null;
  }

  /** Lists every offload snapshot, newest first, for the read-only jobs view. */
  list(): OffloadSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT s.job_id AS jobId, s.instance_id AS instanceId,
                s.torrent_hash AS torrentHash, s.importance,
                s.current_step AS currentStep, j.state AS jobState,
                j.last_error_code AS lastErrorCode,
                s.recovery_version AS recoveryVersion,
                s.cancelled_at AS cancelledAt,
                s.cleanup_completed_at AS cleanupCompletedAt,
                s.created_at AS createdAt, s.updated_at AS updatedAt,
                s.step_bytes_done AS stepBytesDone,
                s.step_bytes_total AS stepBytesTotal,
                s.verified_bytes AS verifiedBytes, s.total_bytes AS totalBytes,
                s.files_done AS filesDone, s.file_count AS fileCount,
                s.current_file_alias AS currentFileAlias,
                s.upload_rate_bps AS uploadRateBps, s.hash_rate_bps AS hashRateBps,
                s.verify_rate_bps AS verifyRateBps, s.eta_seconds AS etaSeconds,
                s.rates_sampled_at AS ratesSampledAt,
                s.pause_requested_at AS pauseRequestedAt, s.paused_at AS pausedAt,
                s.pause_ack_deadline_at AS pauseAcknowledgementDeadlineAt,
                s.qb_paused_at AS qbPauseConfirmedAt,
                s.resource_wait AS resourceWait,
                s.resource_queue_position AS resourceQueuePosition,
                s.resource_active AS resourceActive,
                s.resource_capacity AS resourceCapacity
         FROM offload_snapshots s JOIN jobs j ON j.id = s.job_id
         ORDER BY s.created_at DESC, s.job_id DESC`,
      )
      .all() as SnapshotRow[];
    return rows.map((row) => this.parseSnapshot(row));
  }

  updateTelemetry(
    jobId: string,
    patch: OffloadTelemetryPatch,
    publication: OffloadSnapshotPublication = 'IMMEDIATE',
  ): OffloadSnapshot {
    const parsed = TelemetryPatchSchema.parse(patch);
    const entries = Object.entries(parsed) as Array<
      [keyof OffloadTelemetryPatch, string | number | null]
    >;
    if (entries.length === 0) return this.require(jobId);
    const timestamp = this.now();
    this.db.transaction(() => {
      const assignments = entries.map(([key]) => `${TELEMETRY_COLUMNS[key]} = ?`).join(', ');
      const changed = this.db
        .prepare(`UPDATE offload_snapshots SET ${assignments}, updated_at = ? WHERE job_id = ?`)
        .run(...entries.map(([, value]) => value), timestamp, jobId);
      if (changed.changes !== 1) throw new Error('OFFLOAD_NOT_FOUND');
    })();
    return this.publish(this.require(jobId), undefined, publication);
  }

  /** Records a physical semaphore wait separately from the logical transfer step. */
  setResourceWait(jobId: string, wait: OffloadResourceWaitPatch | null): OffloadSnapshot {
    const parsed = wait === null ? null : ResourceWaitPatchSchema.parse(wait);
    const timestamp = this.now();
    const changed = this.db
      .prepare(
        `UPDATE offload_snapshots SET
           resource_wait = ?, resource_queue_position = ?,
           resource_active = ?, resource_capacity = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(
        parsed?.resourceWait ?? null,
        parsed?.resourceQueuePosition ?? null,
        parsed?.resourceActive ?? null,
        parsed?.resourceCapacity ?? null,
        timestamp,
        jobId,
      );
    if (changed.changes !== 1) throw new Error('OFFLOAD_NOT_FOUND');
    return this.publish(this.require(jobId));
  }

  /**
   * Persists the physical qB acknowledgement immediately after waitForPaused.
   * A crash after this commit but before torrent export therefore leaves PAUSING
   * with positive evidence instead of an ambiguous boolean inferred from a step.
   */
  confirmQbPaused(jobId: string): OffloadSnapshot {
    const timestamp = this.now();
    this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT current_step AS currentStep, cancelled_at AS cancelledAt,
                  qb_paused_at AS qbPauseConfirmedAt
           FROM offload_snapshots WHERE job_id = ?`,
        )
        .get(jobId) as
        | {
            currentStep: OffloadStep;
            cancelledAt: number | null;
            qbPauseConfirmedAt: number | null;
          }
        | undefined;
      if (!row) throw new Error('OFFLOAD_NOT_FOUND');
      if (row.cancelledAt !== null) throw new Error('OFFLOAD_CANCELLED');
      if (row.qbPauseConfirmedAt !== null) return;
      if (row.currentStep !== 'PAUSING') throw new Error('OFFLOAD_QB_PAUSE_CONFIRM_CONFLICT');
      const changed = this.db
        .prepare(
          `UPDATE offload_snapshots SET qb_paused_at = ?, updated_at = ?
           WHERE job_id = ? AND current_step = 'PAUSING' AND qb_paused_at IS NULL
             AND cancelled_at IS NULL`,
        )
        .run(timestamp, timestamp, jobId);
      if (changed.changes !== 1) throw new Error('OFFLOAD_QB_PAUSE_CONFIRM_CONFLICT');
      this.insertEvent(jobId, 'OFFLOAD_QB_PAUSE_CONFIRMED', timestamp);
    })();
    return this.publish(this.require(jobId));
  }

  tryAdmitPausedPipeline(jobId: string, maximum: number): OffloadSnapshot | null {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 31) {
      throw new Error('INVALID_PAUSED_PIPELINE_LIMIT');
    }
    const admitted = this.db.transaction(() => {
      const current = this.db
        .prepare(
          'SELECT current_step AS currentStep, cancelled_at AS cancelledAt FROM offload_snapshots WHERE job_id = ?',
        )
        .get(jobId) as { currentStep: OffloadStep; cancelledAt: number | null } | undefined;
      if (!current) throw new Error('OFFLOAD_NOT_FOUND');
      if (current.cancelledAt !== null) throw new Error('OFFLOAD_CANCELLED');
      if (current.currentStep !== 'PREFLIGHT') return this.require(jobId);
      const occupied = this.db
        .prepare(
          `SELECT COUNT(*) FROM offload_snapshots
           WHERE cancelled_at IS NULL AND current_step IN (
             'PAUSING', 'SNAPSHOTTING', 'HASHING', 'UPLOADING_STAGING',
             'VERIFYING', 'FINALIZING_REMOTE'
           )`,
        )
        .pluck()
        .get() as number;
      if (occupied >= maximum) return null;
      const timestamp = this.now();
      const changed = this.db
        .prepare(
          `UPDATE offload_snapshots SET current_step = 'PAUSING',
             resource_wait = NULL, resource_queue_position = NULL,
             resource_active = NULL, resource_capacity = NULL, updated_at = ?
           WHERE job_id = ? AND current_step = 'PREFLIGHT' AND cancelled_at IS NULL`,
        )
        .run(timestamp, jobId);
      if (changed.changes !== 1) throw new Error('OFFLOAD_TRANSITION_CONFLICT');
      this.insertEvent(jobId, 'OFFLOAD_STEP_CHANGED', timestamp, 'PREFLIGHT', 'PAUSING');
      return this.require(jobId);
    })();
    return admitted ? this.publish(admitted) : null;
  }

  transition(
    jobId: string,
    expected: OffloadStep,
    next: OffloadStep,
    evidence: OffloadEvidence = {},
  ): OffloadSnapshot {
    OffloadStepSchema.parse(expected);
    OffloadStepSchema.parse(next);
    if (ORDERED_STEPS.indexOf(next) !== ORDERED_STEPS.indexOf(expected) + 1) {
      throw new Error('INVALID_OFFLOAD_TRANSITION');
    }
    if (next === 'COMPLETED' && evidence.cleanupCompleted !== true) {
      throw new Error('CLEANUP_NOT_CONFIRMED');
    }

    this.db.transaction(() => {
      if (
        (next === 'CLOUD_COMMITTED' || next === 'LOCAL_CLEANUP') &&
        !this.hasVerifiedPrimary(jobId)
      ) {
        throw new Error('PRIMARY_REPLICA_NOT_VERIFIED');
      }
      if (next === 'CLOUD_COMMITTED') this.persistAndAssertVerifiedTotals(jobId);
      if (next === 'COMPLETED' && !this.isCleanupPersisted(jobId)) {
        throw new Error('CLEANUP_NOT_CONFIRMED');
      }
      if (next === 'CLOUD_COMMITTED') {
        // A final commit that races an operator pause is the stronger durable
        // boundary: every committed plaintext byte is already verified and the
        // local source is still present. Clear the unacknowledged request so the
        // Worker cannot regress this transfer to operator-paused BLOCKED after
        // the handler returns.
        this.db
          .prepare(
            `UPDATE offload_snapshots
             SET pause_requested_at = NULL, pause_ack_deadline_at = NULL, paused_at = NULL
             WHERE job_id = ?`,
          )
          .run(jobId);
      }
      if (next === 'COMPLETED') {
        this.db
          .prepare(
            `UPDATE offload_snapshots
             SET current_file_alias = NULL, upload_rate_bps = NULL, hash_rate_bps = NULL,
                 verify_rate_bps = NULL, eta_seconds = NULL, rates_sampled_at = NULL
             WHERE job_id = ?`,
          )
          .run(jobId);
      }
      const updated = this.db
        .prepare(
          `UPDATE offload_snapshots
           SET current_step = ?,
               resource_wait = NULL, resource_queue_position = NULL,
               resource_active = NULL, resource_capacity = NULL,
               cleanup_completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE cleanup_completed_at END,
               updated_at = ?
           WHERE job_id = ? AND current_step = ? AND cancelled_at IS NULL`,
        )
        .run(
          next,
          next,
          evidence.cleanupCompleted ? this.now() : null,
          this.now(),
          jobId,
          expected,
        );
      if (updated.changes !== 1) throw new Error('OFFLOAD_TRANSITION_CONFLICT');

      const jobState = next === 'COMPLETED' ? 'COMPLETED' : 'RUNNING';
      this.db
        .prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?')
        .run(jobState, this.now(), jobId);
      this.insertEvent(jobId, `OFFLOAD_${next}`, this.now(), expected, next);
    })();
    return this.publish(this.require(jobId));
  }

  /**
   * The snapshot currently holding `(instanceId, torrentHash)` against the
   * active-identity index, or `null` if nothing does.
   *
   * Exists so a refused trigger can name the holder. Reporting "already
   * migrating" without it leaves the operator with no way to find the job that
   * says so, which is how one failed transfer makes a torrent permanently
   * unmigratable.
   */
  activeHolder(
    instanceId: string,
    torrentHash: string,
  ): { jobId: string; currentStep: OffloadStep; jobState: JobState } | null {
    // Joins `jobs` so the caller learns the step *and* whether a worker still
    // holds it, from one query against the same rows the unique index guards.
    // Two lookups could disagree, and the disagreement that matters is offering
    // the operator a cancel button for a job that just started running.
    const row = this.db
      .prepare(
        `SELECT s.job_id AS jobId, s.current_step AS currentStep, j.state AS jobState
           FROM offload_snapshots s JOIN jobs j ON j.id = s.job_id
          WHERE s.instance_id = ? AND s.torrent_hash = ?
            AND s.current_step NOT IN ('COMPLETED') AND s.cancelled_at IS NULL`,
      )
      .get(instanceId, torrentHash.toLowerCase()) as
      { jobId: string; currentStep: OffloadStep; jobState: JobState } | undefined;
    return row ?? null;
  }

  /**
   * Durably requests an operator pause without changing the offload identity.
   *
   * QUEUED/RETRY_WAIT work is parked in the same transaction, so a worker claim
   * can never win after this method returns. RUNNING work records only the
   * request; the Worker acknowledges it after streams and child processes have
   * actually unwound.
   */
  requestOperatorPause(jobId: string, idempotencyKey: string): OffloadPauseResult {
    const key = OffloadControlIdempotencyKeySchema.parse(idempotencyKey);
    const replay = this.replayControlRequest(key, 'PAUSE', jobId);
    if (replay) return OffloadPauseResultSchema.parse(replay);

    let eventCode: OffloadControlEventCode = 'OFFLOAD_PAUSED';
    const result = this.db.transaction(() => {
      const repeated = this.readControlReceipt(key, 'JOB', 'PAUSE', jobId);
      if (repeated) return OffloadPauseResultSchema.parse(repeated);
      const row = this.db
        .prepare(
          `SELECT s.current_step AS currentStep, s.cancelled_at AS cancelledAt,
                   s.pause_requested_at AS pauseRequestedAt, s.paused_at AS pausedAt,
                   s.pause_ack_deadline_at AS pauseAcknowledgementDeadlineAt,
                   j.state AS jobState, j.last_error_code AS lastErrorCode
           FROM offload_snapshots s JOIN jobs j ON j.id = s.job_id
           WHERE s.job_id = ?`,
        )
        .get(jobId) as
        | {
            currentStep: OffloadStep;
            cancelledAt: number | null;
            pauseRequestedAt: number | null;
            pausedAt: number | null;
            pauseAcknowledgementDeadlineAt: number | null;
            jobState: OffloadSnapshot['jobState'];
            lastErrorCode: string | null;
          }
        | undefined;
      if (!row) throw new Error('OFFLOAD_NOT_FOUND');
      if (
        row.cancelledAt !== null ||
        row.currentStep === 'CLOUD_COMMITTED' ||
        row.currentStep === 'LOCAL_CLEANUP' ||
        row.currentStep === 'COMPLETED' ||
        row.jobState === 'CANCELLED_SAFE' ||
        row.jobState === 'COMPLETED'
      ) {
        throw new Error('OFFLOAD_NOT_PAUSABLE');
      }

      const timestamp = this.now();
      if (
        row.jobState === 'BLOCKED' &&
        row.lastErrorCode === 'OPERATOR_PAUSED' &&
        row.pausedAt !== null
      ) {
        eventCode = 'OFFLOAD_PAUSED';
      } else if (row.jobState === 'RUNNING') {
        eventCode = 'OFFLOAD_PAUSE_REQUESTED';
        if (row.pauseRequestedAt === null) {
          const changed = this.db
            .prepare(
              `UPDATE offload_snapshots
               SET pause_requested_at = ?, pause_ack_deadline_at = ?, updated_at = ?
               WHERE job_id = ? AND pause_requested_at IS NULL AND paused_at IS NULL`,
            )
            .run(timestamp, timestamp + OFFLOAD_PAUSE_ACK_TIMEOUT_MS, timestamp, jobId);
          if (changed.changes !== 1) throw new Error('OFFLOAD_PAUSE_CONFLICT');
          this.insertControlEvent(jobId, 'OFFLOAD_PAUSE_REQUESTED', timestamp);
        }
      } else if (row.jobState === 'QUEUED' || row.jobState === 'RETRY_WAIT') {
        eventCode = 'OFFLOAD_PAUSED';
        const snapshotChanged = this.db
          .prepare(
            `UPDATE offload_snapshots
              SET pause_requested_at = NULL, pause_ack_deadline_at = NULL,
                  paused_at = ?, updated_at = ?,
                 current_file_alias = NULL, upload_rate_bps = NULL, hash_rate_bps = NULL,
                 verify_rate_bps = NULL, eta_seconds = NULL, rates_sampled_at = NULL
             WHERE job_id = ? AND paused_at IS NULL`,
          )
          .run(timestamp, timestamp, jobId);
        const jobChanged = this.db
          .prepare(
            `UPDATE jobs
             SET state = 'BLOCKED', last_error_code = 'OPERATOR_PAUSED', updated_at = ?
             WHERE id = ? AND state IN ('QUEUED', 'RETRY_WAIT')`,
          )
          .run(timestamp, jobId);
        if (snapshotChanged.changes !== 1 || jobChanged.changes !== 1) {
          throw new Error('OFFLOAD_PAUSE_CONFLICT');
        }
        this.insertControlEvent(
          jobId,
          'OFFLOAD_PAUSED',
          timestamp,
          row.jobState,
          'BLOCKED',
          'OPERATOR_PAUSED',
        );
      } else {
        throw new Error('OFFLOAD_NOT_PAUSABLE');
      }

      const snapshot = this.require(jobId);
      const response = OffloadPauseResultSchema.parse({
        jobId,
        pauseRequested: snapshot.pauseRequestedAt !== undefined,
        operatorPaused: snapshot.operatorPaused === true,
        jobState: snapshot.jobState,
        currentStep: snapshot.currentStep,
        localPreserved: true,
        resumeGranularity: 'FILE',
        currentFileMayRestart: true,
        pauseAcknowledgementState: snapshot.pauseAcknowledgementState,
        ...(snapshot.pauseAcknowledgementDeadlineAt === undefined
          ? {}
          : { pauseAcknowledgementDeadlineAt: snapshot.pauseAcknowledgementDeadlineAt }),
        qbPauseState: snapshot.qbPauseState,
        ...(snapshot.qbPauseConfirmedAt === undefined
          ? {}
          : { qbPauseConfirmedAt: snapshot.qbPauseConfirmedAt }),
        qbTorrentRemainsPaused: snapshot.qbTorrentRemainsPaused,
        qbTorrentAutoResume: false,
      });
      this.storeControlReceipt(key, 'JOB', 'PAUSE', jobId, response, timestamp);
      return response;
    })();
    this.publish(this.require(jobId), eventCode);
    return result;
  }

  resumeOperatorPause(jobId: string, idempotencyKey: string): OffloadResumeResult {
    const key = OffloadControlIdempotencyKeySchema.parse(idempotencyKey);
    const replay = this.replayControlRequest(key, 'RESUME', jobId);
    if (replay) return OffloadResumeResultSchema.parse(replay);

    const result = this.db.transaction(() => {
      const repeated = this.readControlReceipt(key, 'JOB', 'RESUME', jobId);
      if (repeated) return OffloadResumeResultSchema.parse(repeated);
      if (this.schedulerState() !== 'RUNNING') throw new Error('OFFLOAD_SCHEDULER_PAUSED');
      const row = this.db
        .prepare(
          `SELECT s.current_step AS currentStep, s.cancelled_at AS cancelledAt,
                   s.paused_at AS pausedAt, j.state AS jobState,
                   j.last_error_code AS lastErrorCode,
                   s.qb_paused_at AS qbPauseConfirmedAt
           FROM offload_snapshots s JOIN jobs j ON j.id = s.job_id
           WHERE s.job_id = ?`,
        )
        .get(jobId) as
        | {
            currentStep: OffloadStep;
            cancelledAt: number | null;
            pausedAt: number | null;
            jobState: OffloadSnapshot['jobState'];
            lastErrorCode: string | null;
            qbPauseConfirmedAt: number | null;
          }
        | undefined;
      if (!row) throw new Error('OFFLOAD_NOT_FOUND');
      if (
        row.cancelledAt !== null ||
        row.currentStep === 'CLOUD_COMMITTED' ||
        row.currentStep === 'LOCAL_CLEANUP' ||
        row.currentStep === 'COMPLETED'
      ) {
        throw new Error('OFFLOAD_NOT_RESUMABLE');
      }
      if (
        row.pausedAt === null ||
        row.jobState !== 'BLOCKED' ||
        row.lastErrorCode !== 'OPERATOR_PAUSED'
      ) {
        throw new Error('OFFLOAD_NOT_OPERATOR_PAUSED');
      }
      const timestamp = this.now();
      const snapshotChanged = this.db
        .prepare(
          `UPDATE offload_snapshots
           SET pause_requested_at = NULL, pause_ack_deadline_at = NULL,
               paused_at = NULL, updated_at = ?
           WHERE job_id = ? AND paused_at IS NOT NULL`,
        )
        .run(timestamp, jobId);
      const jobChanged = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'QUEUED', run_after = ?, last_error_code = NULL, updated_at = ?
           WHERE id = ? AND state = 'BLOCKED' AND last_error_code = 'OPERATOR_PAUSED'`,
        )
        .run(timestamp, timestamp, jobId);
      if (snapshotChanged.changes !== 1 || jobChanged.changes !== 1) {
        throw new Error('OFFLOAD_RESUME_CONFLICT');
      }
      this.insertControlEvent(jobId, 'OFFLOAD_RESUMED', timestamp, 'BLOCKED', 'QUEUED');
      const qbPause = qbPauseProjection(row.currentStep, row.qbPauseConfirmedAt);
      const response = OffloadResumeResultSchema.parse({
        jobId,
        requeued: true,
        resumingFrom: row.currentStep,
        resumeGranularity: 'FILE',
        currentFileMayRestart: true,
        qbPauseState: qbPause.state,
        ...(row.qbPauseConfirmedAt === null ? {} : { qbPauseConfirmedAt: row.qbPauseConfirmedAt }),
        qbTorrentRemainsPaused: qbPause.confirmed,
        qbTorrentAutoResume: false,
      });
      this.storeControlReceipt(key, 'JOB', 'RESUME', jobId, response, timestamp);
      return response;
    })();
    this.publish(this.require(jobId), 'OFFLOAD_RESUMED');
    return result;
  }

  requestPauseAll(
    idempotencyKey: string,
    activeOffloadHandlers: number,
    activeWorkerHandlers: number = activeOffloadHandlers,
  ): OffloadSchedulerStatus {
    const key = OffloadControlIdempotencyKeySchema.parse(idempotencyKey);
    this.assertActiveCounts(activeOffloadHandlers, activeWorkerHandlers);
    const replay = this.replayControlRequest(key, 'PAUSE_ALL');
    if (replay) return OffloadSchedulerStatusSchema.parse(replay);

    const affected: Array<{ jobId: string; eventCode: OffloadControlEventCode }> = [];
    const result = this.db.transaction(() => {
      const repeated = this.readControlReceipt(key, 'ALL', 'PAUSE_ALL', null);
      if (repeated) return OffloadSchedulerStatusSchema.parse(repeated);
      const timestamp = this.now();
      const state = this.schedulerState();
      if (state === 'RUNNING') {
        const gated = this.db
          .prepare(
            `UPDATE offload_scheduler_control
             SET state = 'PAUSING', revision = revision + 1, updated_at = ?
             WHERE singleton = 1 AND state = 'RUNNING'`,
          )
          .run(timestamp);
        if (gated.changes !== 1) throw new Error('OFFLOAD_SCHEDULER_CONFLICT');
      }

      const rows = this.db
        .prepare(
          `SELECT s.job_id AS jobId, j.state AS jobState,
                  s.pause_requested_at AS pauseRequestedAt, s.paused_at AS pausedAt
           FROM offload_snapshots s JOIN jobs j ON j.id = s.job_id
           WHERE s.cancelled_at IS NULL
             AND s.current_step NOT IN ('CLOUD_COMMITTED', 'LOCAL_CLEANUP', 'COMPLETED')
             AND j.state IN ('RUNNING', 'QUEUED', 'RETRY_WAIT')
           ORDER BY s.created_at, s.job_id`,
        )
        .all() as Array<{
        jobId: string;
        jobState: OffloadSnapshot['jobState'];
        pauseRequestedAt: number | null;
        pausedAt: number | null;
      }>;
      for (const row of rows) {
        if (row.jobState === 'RUNNING') {
          affected.push({ jobId: row.jobId, eventCode: 'OFFLOAD_PAUSE_REQUESTED' });
          if (row.pauseRequestedAt === null) {
            this.db
              .prepare(
                `UPDATE offload_snapshots
                 SET pause_requested_at = ?, pause_ack_deadline_at = ?, updated_at = ?
                 WHERE job_id = ? AND paused_at IS NULL`,
              )
              .run(timestamp, timestamp + OFFLOAD_PAUSE_ACK_TIMEOUT_MS, timestamp, row.jobId);
            this.insertControlEvent(row.jobId, 'OFFLOAD_PAUSE_REQUESTED', timestamp);
          }
          continue;
        }
        affected.push({ jobId: row.jobId, eventCode: 'OFFLOAD_PAUSED' });
        this.db
          .prepare(
            `UPDATE offload_snapshots
             SET pause_requested_at = NULL, pause_ack_deadline_at = NULL,
                 paused_at = COALESCE(paused_at, ?),
                 current_file_alias = NULL, upload_rate_bps = NULL, hash_rate_bps = NULL,
                 verify_rate_bps = NULL, eta_seconds = NULL, rates_sampled_at = NULL,
                 updated_at = ?
             WHERE job_id = ?`,
          )
          .run(timestamp, timestamp, row.jobId);
        const parked = this.db
          .prepare(
            `UPDATE jobs
             SET state = 'BLOCKED', last_error_code = 'OPERATOR_PAUSED', updated_at = ?
             WHERE id = ? AND state IN ('QUEUED', 'RETRY_WAIT')`,
          )
          .run(timestamp, row.jobId);
        if (parked.changes !== 1) throw new Error('OFFLOAD_PAUSE_CONFLICT');
        this.insertControlEvent(
          row.jobId,
          'OFFLOAD_PAUSED',
          timestamp,
          row.jobState,
          'BLOCKED',
          'OPERATOR_PAUSED',
        );
      }

      if (activeOffloadHandlers === 0 && this.countRunningOffloads() === 0) {
        this.db
          .prepare(
            `UPDATE offload_scheduler_control
             SET state = 'PAUSED', revision = revision + 1, updated_at = ?
             WHERE singleton = 1 AND state = 'PAUSING'`,
          )
          .run(timestamp);
      }
      const response = this.schedulerStatus(activeOffloadHandlers, activeWorkerHandlers);
      this.storeControlReceipt(key, 'ALL', 'PAUSE_ALL', null, response, timestamp);
      return response;
    })();
    for (const { jobId, eventCode } of affected) {
      this.publish(this.require(jobId), eventCode);
    }
    return result;
  }

  resumeAll(
    idempotencyKey: string,
    activeOffloadHandlers: number,
    activeWorkerHandlers: number = activeOffloadHandlers,
  ): OffloadSchedulerStatus {
    const key = OffloadControlIdempotencyKeySchema.parse(idempotencyKey);
    this.assertActiveCounts(activeOffloadHandlers, activeWorkerHandlers);
    const replay = this.replayControlRequest(key, 'RESUME_ALL');
    if (replay) return OffloadSchedulerStatusSchema.parse(replay);

    const resumed: string[] = [];
    const result = this.db.transaction(() => {
      const repeated = this.readControlReceipt(key, 'ALL', 'RESUME_ALL', null);
      if (repeated) return OffloadSchedulerStatusSchema.parse(repeated);
      if (activeOffloadHandlers !== 0 || this.countRunningOffloads() !== 0) {
        throw new Error('OFFLOAD_SCHEDULER_NOT_DRAINED');
      }
      const timestamp = this.now();
      const rows = this.db
        .prepare(
          `SELECT s.job_id AS jobId
           FROM offload_snapshots s JOIN jobs j ON j.id = s.job_id
           WHERE s.paused_at IS NOT NULL AND j.state = 'BLOCKED'
             AND j.last_error_code = 'OPERATOR_PAUSED'
             AND s.cancelled_at IS NULL
             AND s.current_step NOT IN ('CLOUD_COMMITTED', 'LOCAL_CLEANUP', 'COMPLETED')
           ORDER BY s.created_at, s.job_id`,
        )
        .all() as Array<{ jobId: string }>;
      this.db
        .prepare(
          `UPDATE offload_scheduler_control
           SET state = 'RUNNING', revision = revision + 1, updated_at = ?
           WHERE singleton = 1 AND state IN ('PAUSING', 'PAUSED')`,
        )
        .run(timestamp);
      for (const { jobId } of rows) {
        this.db
          .prepare(
            `UPDATE offload_snapshots
             SET pause_requested_at = NULL, pause_ack_deadline_at = NULL,
                 paused_at = NULL, updated_at = ?
             WHERE job_id = ?`,
          )
          .run(timestamp, jobId);
        const changed = this.db
          .prepare(
            `UPDATE jobs
             SET state = 'QUEUED', run_after = ?, last_error_code = NULL, updated_at = ?
             WHERE id = ? AND state = 'BLOCKED' AND last_error_code = 'OPERATOR_PAUSED'`,
          )
          .run(timestamp, timestamp, jobId);
        if (changed.changes !== 1) throw new Error('OFFLOAD_RESUME_CONFLICT');
        this.insertControlEvent(jobId, 'OFFLOAD_RESUMED', timestamp, 'BLOCKED', 'QUEUED');
        resumed.push(jobId);
      }
      const response = this.schedulerStatus(activeOffloadHandlers, activeWorkerHandlers);
      this.storeControlReceipt(key, 'ALL', 'RESUME_ALL', null, response, timestamp);
      return response;
    })();
    for (const jobId of resumed) this.publish(this.require(jobId), 'OFFLOAD_RESUMED');
    return result;
  }

  schedulerStatus(
    activeOffloadHandlers: number,
    activeWorkerHandlers: number = activeOffloadHandlers,
  ): OffloadSchedulerStatus {
    this.assertActiveCounts(activeOffloadHandlers, activeWorkerHandlers);
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN s.pause_requested_at IS NOT NULL THEN 1 ELSE 0 END) AS requestedCount,
           SUM(CASE WHEN s.pause_requested_at IS NOT NULL
                          AND s.pause_ack_deadline_at IS NOT NULL
                          AND s.pause_ack_deadline_at <= ? THEN 1 ELSE 0 END) AS stalledCount,
           SUM(CASE WHEN j.state = 'RUNNING' THEN 1 ELSE 0 END) AS runningCount,
           SUM(CASE WHEN s.paused_at IS NOT NULL AND j.state = 'BLOCKED'
                          AND j.last_error_code = 'OPERATOR_PAUSED' THEN 1 ELSE 0 END) AS pausedCount,
           SUM(CASE WHEN j.state IN ('QUEUED', 'RETRY_WAIT') THEN 1 ELSE 0 END) AS queuedCount
         FROM offload_snapshots s JOIN jobs j ON j.id = s.job_id
         WHERE s.cancelled_at IS NULL
           AND s.current_step NOT IN ('CLOUD_COMMITTED', 'LOCAL_CLEANUP', 'COMPLETED')`,
      )
      .get(this.now()) as {
      requestedCount: number | null;
      stalledCount: number | null;
      runningCount: number | null;
      pausedCount: number | null;
      queuedCount: number | null;
    };
    const scheduler = this.schedulerControl();
    const activeJobs = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN kind = 'OFFLOAD'
                         AND state IN ('RUNNING', 'QUEUED', 'RETRY_WAIT') THEN 1 ELSE 0 END)
             AS offloadJobs,
           SUM(CASE WHEN kind <> 'OFFLOAD'
                         AND state IN ('RUNNING', 'QUEUED', 'RETRY_WAIT') THEN 1 ELSE 0 END)
             AS nonOffloadJobs
         FROM jobs`,
      )
      .get() as { offloadJobs: number | null; nonOffloadJobs: number | null };
    const imports = this.db
      .prepare(
        `SELECT COUNT(*) FROM import_jobs
         WHERE state IN ('RUNNING', 'QUEUED', 'RETRY_WAIT')`,
      )
      .pluck()
      .get() as number;
    const schedulerState = scheduler.state;
    const requestedCount = counts.requestedCount ?? 0;
    const stalledCount = counts.stalledCount ?? 0;
    const runningCount = counts.runningCount ?? 0;
    const pausedCount = counts.pausedCount ?? 0;
    const queuedCount = counts.queuedCount ?? 0;
    const offloadJobs = activeJobs.offloadJobs ?? 0;
    const nonOffloadJobs = activeJobs.nonOffloadJobs ?? 0;
    const offloadDrained =
      schedulerState === 'PAUSED' &&
      requestedCount === 0 &&
      offloadJobs === 0 &&
      activeOffloadHandlers === 0;
    const databaseDrained =
      offloadDrained && nonOffloadJobs === 0 && imports === 0 && activeWorkerHandlers === 0;
    const deploymentBlockers: OffloadDeploymentBlocker[] = [];
    if (schedulerState !== 'PAUSED') {
      deploymentBlockers.push('OFFLOAD_SCHEDULER_NOT_PAUSED');
    }
    if (requestedCount !== 0 || offloadJobs !== 0) {
      deploymentBlockers.push('OFFLOAD_JOBS_ACTIVE');
    }
    if (activeOffloadHandlers !== 0) {
      deploymentBlockers.push('OFFLOAD_HANDLERS_ACTIVE');
    }
    if (nonOffloadJobs !== 0) deploymentBlockers.push('NON_OFFLOAD_JOBS_ACTIVE');
    if (imports !== 0) deploymentBlockers.push('IMPORTS_ACTIVE');
    if (activeWorkerHandlers !== 0) deploymentBlockers.push('WORKER_HANDLERS_ACTIVE');
    return OffloadSchedulerStatusSchema.parse({
      schedulerState,
      revision: scheduler.revision,
      requestedCount,
      stalledCount,
      runningCount,
      pausedCount,
      queuedCount,
      activeOffloadHandlers,
      activeWorkerHandlers,
      offloadJobs,
      nonOffloadJobs,
      imports,
      offloadDrained,
      databaseDrained,
      deploymentBlockers,
      deploymentReadiness: databaseDrained ? 'DB_DRAINED_RCLONE_CHECK_REQUIRED' : 'NOT_DRAINED',
      resumeGranularity: 'FILE',
      currentFileMayRestart: true,
    });
  }

  replayControlRequest(
    idempotencyKey: string,
    action: OffloadControlAction,
    jobId?: string,
  ): ControlReceipt | null {
    const key = OffloadControlIdempotencyKeySchema.parse(idempotencyKey);
    this.pruneExpiredControlRequests();
    const scope: ControlScope =
      action === 'PAUSE' || action === 'RESUME' || action === 'CANCEL' ? 'JOB' : 'ALL';
    return this.readControlReceipt(key, scope, action, jobId ?? null);
  }

  /** Deletes at most one small batch so control traffic never creates a long write lock. */
  pruneExpiredControlRequests(): number {
    const result = this.db
      .prepare(
        `DELETE FROM offload_control_requests
         WHERE rowid IN (
           SELECT rowid FROM offload_control_requests
           WHERE expires_at <= ?
           ORDER BY expires_at, idempotency_key
           LIMIT ?
         )`,
      )
      .run(this.now(), OFFLOAD_CONTROL_RECEIPT_PRUNE_BATCH);
    return result.changes;
  }

  /**
   * Re-queues a transfer that stopped safely, keeping its snapshot.
   *
   * Preferred over cancel-then-start: the snapshot may already hold the exported
   * .torrent and per-file hashes, and the handler's steps are written to resume
   * (`pauseAndSnapshot` returns early when its work is already recorded). So a
   * retry continues rather than repeating an upload that may already be partly done.
   *
   * Refused past CLOUD_COMMITTED, where re-running would mean re-deciding a
   * deletion that the cleanup gate has already authorized against a specific
   * recovery version.
   */
  retry(jobId: string): { jobId: string; resumingFrom: OffloadStep } {
    const result = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT s.current_step AS currentStep, s.cancelled_at AS cancelledAt,
                  s.paused_at AS pausedAt, j.last_error_code AS lastErrorCode
             FROM offload_snapshots s JOIN jobs j ON j.id = s.job_id WHERE s.job_id = ?`,
        )
        .get(jobId) as
        | {
            currentStep: OffloadStep;
            cancelledAt: number | null;
            pausedAt: number | null;
            lastErrorCode: string | null;
          }
        | undefined;
      if (!row) throw new Error('OFFLOAD_NOT_FOUND');
      if (row.cancelledAt !== null) throw new Error('OFFLOAD_CANCELLED');
      if (row.pausedAt !== null || row.lastErrorCode === 'OPERATOR_PAUSED') {
        throw new Error('OFFLOAD_OPERATOR_PAUSED');
      }
      if (
        row.currentStep === 'CLOUD_COMMITTED' ||
        row.currentStep === 'LOCAL_CLEANUP' ||
        row.currentStep === 'COMPLETED'
      ) {
        throw new Error('OFFLOAD_ALREADY_CLOUD_COMMITTED');
      }

      // Only a job that has stopped may be re-queued. A RUNNING job is still held
      // by a worker, and re-queueing it would let two workers drive one snapshot.
      const timestamp = this.now();
      const changed = this.db
        .prepare(
          `UPDATE jobs
              SET state = 'QUEUED', run_after = ?, last_error_code = NULL, updated_at = ?
            WHERE id = ? AND state IN ('FAILED_SAFE', 'BLOCKED', 'RETRY_WAIT')`,
        )
        .run(timestamp, timestamp, jobId);
      if (changed.changes !== 1) throw new Error('OFFLOAD_NOT_RETRYABLE');
      this.insertEvent(jobId, 'OFFLOAD_RETRY_QUEUED', timestamp);
      return { jobId, resumingFrom: row.currentStep };
    })();
    this.publish(this.require(jobId));
    return result;
  }

  cancel(jobId: string, idempotencyKey: string): OffloadCancelResult {
    const key = OffloadControlIdempotencyKeySchema.parse(idempotencyKey);
    const replay = this.replayControlRequest(key, 'CANCEL', jobId);
    if (replay) return OffloadCancelResultSchema.parse(replay);

    const outcome = this.db.transaction(
      (): {
        response: OffloadCancelResult;
        mutated: boolean;
      } => {
        const repeated = this.readControlReceipt(key, 'JOB', 'CANCEL', jobId);
        if (repeated) {
          return { response: OffloadCancelResultSchema.parse(repeated), mutated: false };
        }
        const row = this.db
          .prepare('SELECT current_step AS currentStep FROM offload_snapshots WHERE job_id = ?')
          .get(jobId) as { currentStep: OffloadStep } | undefined;
        if (!row) throw new Error('OFFLOAD_NOT_FOUND');
        if (
          row.currentStep === 'CLOUD_COMMITTED' ||
          row.currentStep === 'LOCAL_CLEANUP' ||
          row.currentStep === 'COMPLETED'
        ) {
          throw new Error('OFFLOAD_ALREADY_CLOUD_COMMITTED');
        }
        const timestamp = this.now();
        const changed = this.db
          .prepare(
            `UPDATE offload_snapshots
           SET cancelled_at = ?, updated_at = ?, current_file_alias = NULL,
               pause_requested_at = NULL, pause_ack_deadline_at = NULL, paused_at = NULL,
               resource_wait = NULL, resource_queue_position = NULL,
               resource_active = NULL, resource_capacity = NULL,
               upload_rate_bps = NULL, hash_rate_bps = NULL, verify_rate_bps = NULL,
               eta_seconds = NULL, rates_sampled_at = NULL
           WHERE job_id = ? AND cancelled_at IS NULL`,
          )
          .run(timestamp, timestamp, jobId);
        if (changed.changes !== 1) throw new Error('OFFLOAD_CANCEL_CONFLICT');
        this.db
          .prepare('UPDATE jobs SET state = ?, last_error_code = NULL, updated_at = ? WHERE id = ?')
          .run('CANCELLED_SAFE', timestamp, jobId);
        this.insertEvent(jobId, 'OFFLOAD_CANCELLED_SAFE', timestamp);
        const response = OffloadCancelResultSchema.parse({
          jobId,
          cancelled: true,
          localPreserved: true,
        });
        this.storeControlReceipt(key, 'JOB', 'CANCEL', jobId, response, timestamp);
        return { response, mutated: true };
      },
    )();
    if (outcome.mutated) this.publish(this.require(jobId));
    return outcome.response;
  }

  reconcileAfterRestart(): RestartAction[] {
    this.db
      .prepare(
        `UPDATE offload_snapshots SET
           resource_wait = NULL, resource_queue_position = NULL,
           resource_active = NULL, resource_capacity = NULL
         WHERE resource_wait IS NOT NULL OR resource_queue_position IS NOT NULL
            OR resource_active IS NOT NULL OR resource_capacity IS NOT NULL`,
      )
      .run();
    const rows = this.db
      .prepare(
        `SELECT job_id AS jobId, current_step AS currentStep
         FROM offload_snapshots
         WHERE current_step <> 'COMPLETED' AND cancelled_at IS NULL
         ORDER BY created_at, job_id`,
      )
      .all() as Array<{ jobId: string; currentStep: OffloadStep }>;
    return rows.map((row) => ({
      ...row,
      action: 'RECHECK',
    }));
  }

  private hasVerifiedPrimary(jobId: string): boolean {
    return hasVerifiedPrimaryForEveryFile(this.db, jobId);
  }

  private isCleanupPersisted(jobId: string): boolean {
    const counts = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
         FROM offload_files
         WHERE job_id = ?`,
      )
      .get(jobId) as { total: number; deleted: number | null };
    return counts.total > 0 && counts.total === (counts.deleted ?? 0);
  }

  private require(jobId: string): OffloadSnapshot {
    const value = this.get(jobId);
    if (!value) throw new Error('OFFLOAD_NOT_FOUND');
    return value;
  }

  private publish(
    snapshot: OffloadSnapshot,
    eventCode?: OffloadControlEventCode,
    publication: OffloadSnapshotPublication = 'IMMEDIATE',
  ): OffloadSnapshot {
    try {
      this.onPublish?.(snapshot, eventCode, publication);
    } catch {
      // A subscriber is advisory. Durable safety state has already committed.
    }
    return snapshot;
  }

  private parseSnapshot(row: SnapshotRow): OffloadSnapshot {
    const withoutNullTelemetry: Record<string, unknown> = { ...row };
    for (const key of Object.keys(TELEMETRY_COLUMNS) as Array<keyof OffloadTelemetryPatch>) {
      if (withoutNullTelemetry[key] === null) delete withoutNullTelemetry[key];
    }
    if (withoutNullTelemetry.pauseRequestedAt === null) {
      delete withoutNullTelemetry.pauseRequestedAt;
    }
    if (withoutNullTelemetry.pausedAt === null) delete withoutNullTelemetry.pausedAt;
    if (withoutNullTelemetry.pauseAcknowledgementDeadlineAt === null) {
      delete withoutNullTelemetry.pauseAcknowledgementDeadlineAt;
    }
    if (withoutNullTelemetry.qbPauseConfirmedAt === null) {
      delete withoutNullTelemetry.qbPauseConfirmedAt;
    }
    if (withoutNullTelemetry.resourceWait === null) delete withoutNullTelemetry.resourceWait;
    if (withoutNullTelemetry.resourceQueuePosition === null) {
      delete withoutNullTelemetry.resourceQueuePosition;
    }
    if (withoutNullTelemetry.resourceActive === null) delete withoutNullTelemetry.resourceActive;
    if (withoutNullTelemetry.resourceCapacity === null) {
      delete withoutNullTelemetry.resourceCapacity;
    }
    const operatorPaused = row.pausedAt !== null && row.lastErrorCode === 'OPERATOR_PAUSED';
    withoutNullTelemetry.operatorPaused = operatorPaused;
    const acknowledgementDeadline =
      row.pauseAcknowledgementDeadlineAt ??
      (row.pauseRequestedAt === null ? null : row.pauseRequestedAt + OFFLOAD_PAUSE_ACK_TIMEOUT_MS);
    if (row.pauseRequestedAt !== null && acknowledgementDeadline !== null) {
      withoutNullTelemetry.pauseAcknowledgementDeadlineAt = acknowledgementDeadline;
    }
    withoutNullTelemetry.pauseAcknowledgementState = operatorPaused
      ? 'ACKNOWLEDGED'
      : row.pauseRequestedAt === null
        ? 'NOT_REQUESTED'
        : acknowledgementDeadline !== null && this.now() >= acknowledgementDeadline
          ? 'STALLED'
          : 'PENDING';
    withoutNullTelemetry.availableActions = this.availableActions(row, operatorPaused);
    withoutNullTelemetry.resumeGranularity = 'FILE';
    withoutNullTelemetry.currentFileMayRestart = true;
    const qbPause = qbPauseProjection(row.currentStep, row.qbPauseConfirmedAt);
    withoutNullTelemetry.qbPauseState = qbPause.state;
    withoutNullTelemetry.qbTorrentRemainsPaused = qbPause.confirmed;
    withoutNullTelemetry.qbTorrentAutoResume = false;
    delete withoutNullTelemetry.lastErrorCode;
    return OffloadSnapshotSchema.parse(withoutNullTelemetry);
  }

  private availableActions(row: SnapshotRow, operatorPaused: boolean): OffloadAvailableAction[] {
    if (row.cancelledAt !== null || row.jobState === 'CANCELLED_SAFE') return [];
    if (row.currentStep === 'COMPLETED') return [];
    if (row.currentStep === 'CLOUD_COMMITTED' || row.currentStep === 'LOCAL_CLEANUP') {
      return row.currentStep === 'CLOUD_COMMITTED' ? ['CLEANUP'] : [];
    }
    if (operatorPaused) {
      return this.schedulerState() === 'RUNNING' ? ['RESUME', 'CANCEL'] : ['CANCEL'];
    }
    if (row.pauseRequestedAt !== null) return ['CANCEL'];
    if (row.jobState === 'QUEUED' || row.jobState === 'RUNNING' || row.jobState === 'RETRY_WAIT') {
      return this.schedulerState() === 'RUNNING' ? ['PAUSE'] : [];
    }
    if (row.jobState === 'FAILED_SAFE' || row.jobState === 'BLOCKED') {
      return this.schedulerState() === 'RUNNING' ? ['RETRY', 'CANCEL'] : ['CANCEL'];
    }
    return [];
  }

  private schedulerState(): OffloadSchedulerStatus['schedulerState'] {
    return this.schedulerControl().state;
  }

  private schedulerControl(): {
    state: OffloadSchedulerStatus['schedulerState'];
    revision: number;
  } {
    const row = this.db
      .prepare(
        `SELECT state, revision FROM offload_scheduler_control
         WHERE singleton = 1`,
      )
      .get() as { state: unknown; revision: unknown } | undefined;
    const state = row?.state;
    if (state !== 'RUNNING' && state !== 'PAUSING' && state !== 'PAUSED') {
      throw new Error('OFFLOAD_SCHEDULER_STATE_INVALID');
    }
    const revision = row?.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      throw new Error('OFFLOAD_SCHEDULER_REVISION_INVALID');
    }
    return { state, revision: revision as number };
  }

  private countRunningOffloads(): number {
    return this.db
      .prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'OFFLOAD' AND state = 'RUNNING'")
      .pluck()
      .get() as number;
  }

  private assertActiveCounts(activeOffloadHandlers: number, activeWorkerHandlers: number): void {
    if (
      !Number.isSafeInteger(activeOffloadHandlers) ||
      activeOffloadHandlers < 0 ||
      !Number.isSafeInteger(activeWorkerHandlers) ||
      activeWorkerHandlers < activeOffloadHandlers
    ) {
      throw new Error('OFFLOAD_ACTIVE_COUNT_INVALID');
    }
  }

  private readControlReceipt(
    idempotencyKey: string,
    scope: ControlScope,
    action: OffloadControlAction,
    jobId: string | null,
  ): ControlReceipt | null {
    const row = this.db
      .prepare(
        `SELECT scope, action, job_id AS jobId, response_json AS responseJson,
                expires_at AS expiresAt
         FROM offload_control_requests WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as
      | {
          scope: ControlScope;
          action: OffloadControlAction;
          jobId: string | null;
          responseJson: string;
          expiresAt: number;
        }
      | undefined;
    if (!row) return null;
    if (row.expiresAt <= this.now()) {
      this.db
        .prepare(
          'DELETE FROM offload_control_requests WHERE idempotency_key = ? AND expires_at <= ?',
        )
        .run(idempotencyKey, this.now());
      return null;
    }
    if (row.scope !== scope || row.action !== action || row.jobId !== jobId) {
      throw new Error('IDEMPOTENCY_KEY_CONFLICT');
    }
    let value: unknown;
    try {
      value = JSON.parse(row.responseJson) as unknown;
    } catch {
      throw new Error('OFFLOAD_CONTROL_RECEIPT_INVALID');
    }
    switch (action) {
      case 'PAUSE':
        return OffloadPauseResultSchema.parse(value);
      case 'RESUME':
        return OffloadResumeResultSchema.parse(value);
      case 'CANCEL':
        return OffloadCancelResultSchema.parse(value);
      case 'PAUSE_ALL':
      case 'RESUME_ALL':
        return OffloadSchedulerStatusSchema.parse(value);
    }
  }

  private storeControlReceipt(
    idempotencyKey: string,
    scope: ControlScope,
    action: OffloadControlAction,
    jobId: string | null,
    response: ControlReceipt,
    timestamp: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO offload_control_requests(
           idempotency_key, scope, action, job_id, response_json, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        idempotencyKey,
        scope,
        action,
        jobId,
        JSON.stringify(response),
        timestamp,
        timestamp + OFFLOAD_CONTROL_RECEIPT_TTL_MS,
      );
  }

  private insertControlEvent(
    jobId: string,
    eventType: OffloadControlEventCode,
    createdAt: number,
    from?: JobState,
    to?: JobState,
    code?: 'OPERATOR_PAUSED',
  ): void {
    const detail = {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(code ? { code } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO job_events(id, job_id, event_type, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), jobId, eventType, JSON.stringify(detail), createdAt);
  }

  private persistAndAssertVerifiedTotals(jobId: string): void {
    const manifest = this.db
      .prepare(
        'SELECT relative_path AS relativePath, CAST(size AS TEXT) AS size FROM offload_files WHERE job_id = ? ORDER BY relative_path',
      )
      .all(jobId) as Array<{ relativePath: string; size: string }>;
    if (manifest.length === 0) throw new Error('VERIFIED_BYTES_MISMATCH');
    const verified = this.db
      .prepare(
        `SELECT f.relative_path AS relativePath, CAST(f.size AS TEXT) AS size
         FROM offload_files f
         WHERE f.job_id = ? AND EXISTS (
           SELECT 1 FROM offload_snapshots s
           JOIN cloud_replicas r
             ON r.instance_id = s.instance_id AND r.torrent_hash = s.torrent_hash
            AND r.relative_path = f.relative_path
           WHERE s.job_id = f.job_id AND r.role = 'PRIMARY' AND r.active = 1
             AND r.verification_status = 'VERIFIED' AND r.sha256 = f.sha256
             AND r.size = f.size
         )
         ORDER BY f.relative_path`,
      )
      .all(jobId) as Array<{ relativePath: string; size: string }>;
    const totalBytes = manifest.reduce((sum, file) => sum + BigInt(file.size), 0n).toString();
    const verifiedBytes = verified.reduce((sum, file) => sum + BigInt(file.size), 0n).toString();
    if (verified.length !== manifest.length || verifiedBytes !== totalBytes) {
      throw new Error('VERIFIED_BYTES_MISMATCH');
    }
    this.db
      .prepare(
        `UPDATE offload_snapshots
         SET verified_bytes = ?, total_bytes = ?, files_done = ?, file_count = ?,
             current_file_alias = NULL, upload_rate_bps = NULL, hash_rate_bps = NULL,
             verify_rate_bps = NULL, eta_seconds = NULL, rates_sampled_at = NULL
         WHERE job_id = ?`,
      )
      .run(verifiedBytes, totalBytes, manifest.length, manifest.length, jobId);
  }

  private insertEvent(
    jobId: string,
    eventType: string,
    createdAt: number,
    from?: OffloadStep,
    to?: OffloadStep,
  ): void {
    const detail = from && to ? { from: jobStateForStep(from), to: jobStateForStep(to) } : {};
    this.db
      .prepare(
        `INSERT INTO job_events(id, job_id, event_type, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), jobId, eventType, JSON.stringify(detail), createdAt);
  }
}

function jobStateForStep(step: OffloadStep): 'QUEUED' | 'RUNNING' | 'COMPLETED' {
  return step === 'PREFLIGHT' ? 'QUEUED' : step === 'COMPLETED' ? 'COMPLETED' : 'RUNNING';
}

function qbPauseProjection(
  step: OffloadStep,
  confirmedAt: number | null,
): {
  state: 'UNKNOWN' | 'CONFIRMING' | 'CONFIRMED_PAUSED';
  confirmed: boolean;
} {
  if (confirmedAt !== null || !['PREFLIGHT', 'PAUSING'].includes(step)) {
    return { state: 'CONFIRMED_PAUSED', confirmed: true };
  }
  return step === 'PAUSING'
    ? { state: 'CONFIRMING', confirmed: false }
    : { state: 'UNKNOWN', confirmed: false };
}

function isActiveIdentityConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: offload_snapshots\.instance_id, offload_snapshots\.torrent_hash/i.test(
      error.message,
    )
  );
}
