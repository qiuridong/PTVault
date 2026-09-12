import { randomUUID } from 'node:crypto';

import { JobKindSchema, JobStateSchema, type JobKind, type JobState } from '@ptvault/contracts';
import { z } from 'zod';

import type { Clock } from '../core/clock.js';
import type { AppDatabase } from '../db/database.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Job<TPayload = unknown> = {
  id: string;
  kind: string;
  state: JobState;
  idempotencyKey: string;
  payload: TPayload;
  progress: number;
  attempt: number;
  runAfter: number;
  createdAt: number;
  updatedAt: number;
  lastErrorCode: string | null;
};

export type JobErrorCode = 'HANDLER_NOT_REGISTERED' | 'HANDLER_FAILED' | 'OPERATOR_PAUSED';

export type JobEventDetail = {
  from?: JobState | undefined;
  to?: JobState | undefined;
  attempt?: number | undefined;
  code?: JobErrorCode | undefined;
};

export type JobEvent = {
  id: string;
  jobId: string;
  eventType: string;
  detail: JobEventDetail;
  createdAt: number;
};

export type InsertJobInput<TPayload extends JsonValue> = {
  id?: string;
  kind: JobKind;
  state?: JobState;
  idempotencyKey: string;
  payload: TPayload;
  progress?: number;
  attempt?: number;
  runAfter?: number;
  lastErrorCode?: JobErrorCode | null;
};

export type JobTransitionInput = {
  id: string;
  from: JobState;
  to: JobState;
  eventType: string;
  detail?: JobEventDetail;
  progress?: number;
  runAfter?: number;
  lastErrorCode?: JobErrorCode | null;
};

type JobRow = {
  id: string;
  kind: string;
  state: string;
  idempotencyKey: string;
  payloadJson: string;
  progress: number;
  attempt: number;
  runAfter: number;
  createdAt: number;
  updatedAt: number;
  lastErrorCode: string | null;
};

type JobEventRow = {
  id: string;
  jobId: string;
  eventType: string;
  detailJson: string;
  createdAt: number;
};

const UUID_SCHEMA = z.string().uuid();
const PROGRESS_SCHEMA = z.number().finite().min(0).max(1);
const NON_NEGATIVE_INTEGER_SCHEMA = z.number().int().nonnegative();
const STABLE_CODE_SCHEMA = z.enum(['HANDLER_NOT_REGISTERED', 'HANDLER_FAILED', 'OPERATOR_PAUSED']);
const JOB_EVENT_DETAIL_SCHEMA = z
  .object({
    from: JobStateSchema.optional(),
    to: JobStateSchema.optional(),
    attempt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    code: STABLE_CODE_SCHEMA.optional(),
  })
  .strict();

function invalidJobJson(): never {
  throw new Error('INVALID_JOB_JSON');
}

function validateJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidJobJson();
    return;
  }
  if (typeof value !== 'object') invalidJobJson();
  if (ancestors.has(value)) invalidJobJson();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalidJobJson();
      if (Object.getOwnPropertySymbols(value).length > 0) invalidJobJson();
      const propertyNames = Object.getOwnPropertyNames(value);
      if (propertyNames.length !== value.length + 1 || !propertyNames.includes('length')) {
        invalidJobJson();
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidJobJson();
        validateJsonValue(descriptor.value, ancestors);
      }
      return;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) invalidJobJson();
    if (Object.getOwnPropertySymbols(value).length > 0) invalidJobJson();
    const propertyNames = Object.getOwnPropertyNames(value);
    if (propertyNames.length !== Object.keys(value).length) invalidJobJson();
    for (const propertyName of propertyNames) {
      const descriptor = Object.getOwnPropertyDescriptor(value, propertyName);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidJobJson();
      validateJsonValue(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function serializeJson(value: unknown): string {
  try {
    validateJsonValue(value);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('not JSON serializable');
    return serialized;
  } catch {
    throw new Error('INVALID_JOB_JSON');
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('INVALID_JOB_JSON');
  }
}

function parsePayload<TPayload>(
  value: unknown,
  schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>,
): TPayload {
  try {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error('invalid payload');
    return parsed.data;
  } catch {
    throw new Error('INVALID_JOB_PAYLOAD');
  }
}

function validateJobEventDetail(value: unknown): JobEventDetail {
  try {
    const parsed = JOB_EVENT_DETAIL_SCHEMA.safeParse(value);
    if (!parsed.success) throw new Error('invalid detail');
    return parsed.data;
  } catch {
    throw new Error('INVALID_JOB_EVENT_DETAIL');
  }
}

function parseDetail(value: string): JobEventDetail {
  try {
    return validateJobEventDetail(parseJson(value));
  } catch {
    throw new Error('INVALID_JOB_EVENT_DETAIL');
  }
}

export class JobRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: Clock = () => new Date(),
  ) {}

  insert<TPayload extends JsonValue>(input: InsertJobInput<TPayload>): Job<TPayload> {
    const timestamp = this.now().getTime();
    const id = UUID_SCHEMA.parse(input.id ?? randomUUID());
    const kind = JobKindSchema.parse(input.kind);
    const state = JobStateSchema.parse(input.state ?? 'QUEUED');
    const progress = PROGRESS_SCHEMA.parse(input.progress ?? 0);
    const attempt = NON_NEGATIVE_INTEGER_SCHEMA.parse(input.attempt ?? 0);
    const runAfter = NON_NEGATIVE_INTEGER_SCHEMA.parse(input.runAfter ?? timestamp);
    if (!input.idempotencyKey) throw new Error('INVALID_JOB_IDEMPOTENCY_KEY');
    const payloadJson = serializeJson(input.payload);
    const lastErrorCode = input.lastErrorCode ?? null;

    this.db
      .prepare(
        `INSERT INTO jobs(
           id, kind, state, idempotency_key, payload_json, progress, attempt,
           run_after, created_at, updated_at, last_error_code
         ) VALUES (
           @id, @kind, @state, @idempotencyKey, @payloadJson, @progress, @attempt,
           @runAfter, @createdAt, @updatedAt, @lastErrorCode
         )`,
      )
      .run({
        id,
        kind,
        state,
        idempotencyKey: input.idempotencyKey,
        payloadJson,
        progress,
        attempt,
        runAfter,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastErrorCode,
      });

    return {
      id,
      kind,
      state,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      progress,
      attempt,
      runAfter,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastErrorCode,
    };
  }

  get(id: string): Job<unknown> | null;
  get<TPayload>(
    id: string,
    schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>,
  ): Job<TPayload> | null;
  get<TPayload>(
    id: string,
    schema?: z.ZodType<TPayload, z.ZodTypeDef, unknown>,
  ): Job<unknown> | Job<TPayload> | null {
    const row = this.db
      .prepare(
        `SELECT id, kind, state, idempotency_key AS idempotencyKey,
                payload_json AS payloadJson, progress, attempt, run_after AS runAfter,
                created_at AS createdAt, updated_at AS updatedAt,
                last_error_code AS lastErrorCode
         FROM jobs WHERE id = ?`,
      )
      .get(id) as JobRow | undefined;
    if (!row) return null;

    const payload = parseJson(row.payloadJson);
    return schema ? this.mapJob(row, parsePayload(payload, schema)) : this.mapJob(row, payload);
  }

  appendEvent(jobId: string, eventType: string, detail: JobEventDetail = {}): JobEvent {
    return this.insertEvent(jobId, eventType, detail, this.now().getTime());
  }

  /**
   * Whether this job has stopped and is not held by a worker.
   *
   * The distinction the operator needs: a stopped job can be cleared or retried,
   * a RUNNING one must be waited out. `QUEUED` counts as running for this purpose
   * — a worker may claim it at any moment, so acting on it would race.
   */
  isStopped(jobId: string): boolean {
    const state = this.db.prepare('SELECT state FROM jobs WHERE id = ?').pluck().get(jobId);
    return (
      state === 'FAILED_SAFE' ||
      state === 'BLOCKED' ||
      state === 'RETRY_WAIT' ||
      state === 'CANCELLED_SAFE'
    );
  }

  listEvents(jobId: string): JobEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, job_id AS jobId, event_type AS eventType,
                detail_json AS detailJson, created_at AS createdAt
         FROM job_events
         WHERE job_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(jobId) as JobEventRow[];
    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      eventType: row.eventType,
      detail: parseDetail(row.detailJson),
      createdAt: row.createdAt,
    }));
  }

  transition(input: JobTransitionInput): Job {
    return this.db.transaction(() => {
      JobStateSchema.parse(input.from);
      JobStateSchema.parse(input.to);
      const timestamp = this.now().getTime();
      const progress = input.progress === undefined ? null : PROGRESS_SCHEMA.parse(input.progress);
      const runAfter =
        input.runAfter === undefined ? null : NON_NEGATIVE_INTEGER_SCHEMA.parse(input.runAfter);
      const result = this.db
        .prepare(
          `UPDATE jobs
           SET state = @toState,
               progress = CASE WHEN @setProgress = 1 THEN @progress ELSE progress END,
               run_after = CASE WHEN @setRunAfter = 1 THEN @runAfter ELSE run_after END,
               last_error_code = CASE
                 WHEN @setLastErrorCode = 1 THEN @lastErrorCode ELSE last_error_code
               END,
               updated_at = @updatedAt
           WHERE id = @id AND state = @fromState`,
        )
        .run({
          id: input.id,
          fromState: input.from,
          toState: input.to,
          setProgress: input.progress === undefined ? 0 : 1,
          progress,
          setRunAfter: input.runAfter === undefined ? 0 : 1,
          runAfter,
          setLastErrorCode: 'lastErrorCode' in input ? 1 : 0,
          lastErrorCode: input.lastErrorCode ?? null,
          updatedAt: timestamp,
        });
      if (result.changes !== 1) throw new Error('JOB_TRANSITION_CONFLICT');

      if (['BLOCKED', 'FAILED_SAFE', 'CANCELLED_SAFE', 'COMPLETED'].includes(input.to)) {
        this.clearActiveOffloadTelemetry(input.id);
      }

      this.insertEvent(
        input.id,
        input.eventType,
        {
          ...input.detail,
          ...(input.lastErrorCode === undefined || input.lastErrorCode === null
            ? {}
            : { code: input.lastErrorCode }),
          from: input.from,
          to: input.to,
        },
        timestamp,
      );
      return this.require(input.id);
    })();
  }

  claimNext(
    options: {
      scope?: 'ANY' | 'OFFLOAD' | 'EXCLUSIVE';
      preferPausedOffload?: boolean;
    } = {},
  ): Job | null {
    return this.db.transaction(() => {
      const timestamp = this.now().getTime();
      const scopeClause =
        options.scope === 'OFFLOAD'
          ? "AND jobs.kind = 'OFFLOAD'"
          : options.scope === 'EXCLUSIVE'
            ? "AND jobs.kind <> 'OFFLOAD'"
            : '';
      const pausedPriority = options.preferPausedOffload
        ? `CASE WHEN jobs.kind = 'OFFLOAD' AND offload_snapshots.current_step IN (
             'PAUSING', 'SNAPSHOTTING', 'HASHING', 'UPLOADING_STAGING',
             'VERIFYING', 'FINALIZING_REMOTE'
           ) THEN 0 ELSE 1 END ASC,`
        : '';
      const candidate = this.db
        .prepare(
          `SELECT jobs.id
           FROM jobs
           LEFT JOIN offload_snapshots ON offload_snapshots.job_id = jobs.id
           WHERE jobs.state = 'QUEUED' AND jobs.run_after <= ? ${scopeClause}
             AND (
               jobs.kind <> 'OFFLOAD' OR EXISTS (
                 SELECT 1 FROM offload_scheduler_control
                 WHERE singleton = 1 AND state = 'RUNNING'
               )
             )
           ORDER BY ${pausedPriority} jobs.run_after ASC, jobs.created_at ASC, jobs.id ASC
           LIMIT 1`,
        )
        .get(timestamp) as { id: string } | undefined;
      if (!candidate) return null;

      const result = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'RUNNING', attempt = attempt + 1, updated_at = ?
           WHERE id = ? AND state = 'QUEUED'`,
        )
        .run(timestamp, candidate.id);
      if (result.changes !== 1) throw new Error('JOB_CLAIM_CONFLICT');

      const job = this.require(candidate.id);
      this.insertEvent(job.id, 'JOB_CLAIMED', { attempt: job.attempt }, timestamp);
      return job;
    })();
  }

  hasDueExclusive(): boolean {
    const timestamp = this.now().getTime();
    return (
      this.db
        .prepare(
          `SELECT 1
           FROM jobs
           WHERE state = 'QUEUED' AND run_after <= ? AND kind <> 'OFFLOAD'
           LIMIT 1`,
        )
        .get(timestamp) !== undefined
    );
  }

  hasDuePausedOffload(): boolean {
    const timestamp = this.now().getTime();
    return (
      this.db
        .prepare(
          `SELECT 1
           FROM jobs
           INNER JOIN offload_snapshots ON offload_snapshots.job_id = jobs.id
           WHERE jobs.state = 'QUEUED'
             AND jobs.run_after <= ?
             AND jobs.kind = 'OFFLOAD'
             AND EXISTS (
               SELECT 1 FROM offload_scheduler_control
               WHERE singleton = 1 AND state = 'RUNNING'
             )
             AND offload_snapshots.paused_at IS NULL
             AND offload_snapshots.current_step IN (
               'PAUSING', 'SNAPSHOTTING', 'HASHING', 'UPLOADING_STAGING',
               'VERIFYING', 'FINALIZING_REMOTE'
             )
           LIMIT 1`,
        )
        .get(timestamp) !== undefined
    );
  }

  countPausedOffloadsAwaitingRetry(): number {
    return this.db
      .prepare(
        `SELECT COUNT(*)
         FROM jobs
         INNER JOIN offload_snapshots ON offload_snapshots.job_id = jobs.id
         WHERE jobs.kind = 'OFFLOAD'
           AND jobs.state IN ('FAILED_SAFE', 'RETRY_WAIT', 'BLOCKED')
           AND jobs.last_error_code IS NOT 'OPERATOR_PAUSED'
           AND offload_snapshots.cancelled_at IS NULL
           AND offload_snapshots.paused_at IS NULL
           AND offload_snapshots.current_step IN (
             'PAUSING', 'SNAPSHOTTING', 'HASHING', 'UPLOADING_STAGING',
             'VERIFYING', 'FINALIZING_REMOTE'
           )`,
      )
      .pluck()
      .get() as number;
  }

  reconcileRunningAfterRestart(): Job[] {
    return this.db.transaction(() => {
      const timestamp = this.now().getTime();
      const schedulerState = this.getOffloadSchedulerState();
      const rows = this.db
        .prepare(
          `SELECT jobs.id, jobs.kind,
                  offload_snapshots.pause_requested_at AS pauseRequestedAt
           FROM jobs
           LEFT JOIN offload_snapshots ON offload_snapshots.job_id = jobs.id
           WHERE jobs.state = 'RUNNING'
           ORDER BY jobs.created_at ASC, jobs.id ASC`,
        )
        .all() as Array<{ id: string; kind: string; pauseRequestedAt: number | null }>;

      const reconciled = rows.map(({ id, kind, pauseRequestedAt }) => {
        const operatorPause =
          kind === 'OFFLOAD' && (pauseRequestedAt !== null || schedulerState !== 'RUNNING');
        if (operatorPause) {
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
            .run(timestamp, timestamp, id);
          const paused = this.db
            .prepare(
              `UPDATE jobs SET state = 'BLOCKED', last_error_code = 'OPERATOR_PAUSED',
                               updated_at = ?
               WHERE id = ? AND state = 'RUNNING'`,
            )
            .run(timestamp, id);
          if (paused.changes !== 1) throw new Error('JOB_RESTART_CONFLICT');
          this.insertEvent(
            id,
            'OFFLOAD_PAUSED',
            { from: 'RUNNING', to: 'BLOCKED', code: 'OPERATOR_PAUSED' },
            timestamp,
          );
          return this.require(id);
        }
        const result = this.db
          .prepare(
            `UPDATE jobs SET state = 'QUEUED', updated_at = ?
             WHERE id = ? AND state = 'RUNNING'`,
          )
          .run(timestamp, id);
        if (result.changes !== 1) throw new Error('JOB_RESTART_CONFLICT');
        this.clearActiveOffloadTelemetry(id);
        this.insertEvent(id, 'PROCESS_RESTART', { from: 'RUNNING', to: 'QUEUED' }, timestamp);
        return this.require(id);
      });

      if (schedulerState !== 'RUNNING') {
        const rowsToPark = this.db
          .prepare(
            `SELECT jobs.id, jobs.state AS fromState
             FROM jobs JOIN offload_snapshots ON offload_snapshots.job_id = jobs.id
             WHERE jobs.kind = 'OFFLOAD' AND jobs.state IN ('QUEUED', 'RETRY_WAIT')
               AND offload_snapshots.cancelled_at IS NULL
               AND offload_snapshots.current_step NOT IN (
                 'CLOUD_COMMITTED', 'LOCAL_CLEANUP', 'COMPLETED'
               )`,
          )
          .all() as Array<{ id: string; fromState: 'QUEUED' | 'RETRY_WAIT' }>;
        for (const { id, fromState } of rowsToPark) {
          this.parkOperatorPaused(id, fromState, timestamp);
          reconciled.push(this.require(id));
        }
      }
      return reconciled;
    })();
  }

  getOffloadSchedulerState(): 'RUNNING' | 'PAUSING' | 'PAUSED' {
    return this.getOffloadSchedulerControl().state;
  }

  getOffloadSchedulerControl(): {
    state: 'RUNNING' | 'PAUSING' | 'PAUSED';
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

  isOperatorPauseRequested(jobId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1
           FROM jobs JOIN offload_snapshots ON offload_snapshots.job_id = jobs.id
           WHERE jobs.id = ? AND jobs.kind = 'OFFLOAD' AND jobs.state = 'RUNNING'
              AND offload_snapshots.pause_requested_at IS NOT NULL
              AND offload_snapshots.cancelled_at IS NULL
              AND offload_snapshots.current_step NOT IN (
                'CLOUD_COMMITTED', 'LOCAL_CLEANUP', 'COMPLETED'
              )`,
        )
        .get(jobId) !== undefined
    );
  }

  /** A durable cloud commit wins an abort/pause race and is safe to finalize. */
  isOffloadCloudCommitted(jobId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1
           FROM jobs JOIN offload_snapshots ON offload_snapshots.job_id = jobs.id
           WHERE jobs.id = ? AND jobs.kind = 'OFFLOAD'
             AND offload_snapshots.cancelled_at IS NULL
             AND offload_snapshots.current_step = 'CLOUD_COMMITTED'`,
        )
        .get(jobId) !== undefined
    );
  }

  acknowledgeOperatorPause(jobId: string): Job {
    return this.db.transaction(() => {
      const current = this.db
        .prepare(
          `SELECT jobs.state, jobs.last_error_code AS lastErrorCode,
                  offload_snapshots.pause_requested_at AS pauseRequestedAt,
                  offload_snapshots.paused_at AS pausedAt
           FROM jobs JOIN offload_snapshots ON offload_snapshots.job_id = jobs.id
           WHERE jobs.id = ? AND jobs.kind = 'OFFLOAD'`,
        )
        .get(jobId) as
        | {
            state: string;
            lastErrorCode: string | null;
            pauseRequestedAt: number | null;
            pausedAt: number | null;
          }
        | undefined;
      if (!current) throw new Error('OFFLOAD_NOT_FOUND');
      if (
        current.state === 'BLOCKED' &&
        current.lastErrorCode === 'OPERATOR_PAUSED' &&
        current.pausedAt !== null
      ) {
        return this.require(jobId);
      }
      if (current.state !== 'RUNNING' || current.pauseRequestedAt === null) {
        throw new Error('OFFLOAD_PAUSE_NOT_REQUESTED');
      }
      const timestamp = this.now().getTime();
      this.db
        .prepare(
          `UPDATE offload_snapshots
           SET pause_requested_at = NULL, pause_ack_deadline_at = NULL,
               paused_at = ?, current_file_alias = NULL,
               upload_rate_bps = NULL, hash_rate_bps = NULL, verify_rate_bps = NULL,
               eta_seconds = NULL, rates_sampled_at = NULL, updated_at = ?
           WHERE job_id = ? AND pause_requested_at IS NOT NULL`,
        )
        .run(timestamp, timestamp, jobId);
      const changed = this.db
        .prepare(
          `UPDATE jobs SET state = 'BLOCKED', last_error_code = 'OPERATOR_PAUSED', updated_at = ?
           WHERE id = ? AND state = 'RUNNING'`,
        )
        .run(timestamp, jobId);
      if (changed.changes !== 1) throw new Error('OFFLOAD_PAUSE_ACK_CONFLICT');
      this.insertEvent(
        jobId,
        'OFFLOAD_PAUSED',
        { from: 'RUNNING', to: 'BLOCKED', code: 'OPERATOR_PAUSED' },
        timestamp,
      );
      return this.require(jobId);
    })();
  }

  settleOffloadSchedulerPause(activeOffloadHandlers: number): boolean {
    if (!Number.isSafeInteger(activeOffloadHandlers) || activeOffloadHandlers < 0) {
      throw new Error('OFFLOAD_ACTIVE_COUNT_INVALID');
    }
    return this.db.transaction(() => {
      const state = this.getOffloadSchedulerState();
      if (state === 'RUNNING') return false;
      if (activeOffloadHandlers !== 0) return false;
      const activeRows = this.db
        .prepare(
          `SELECT COUNT(*) FROM jobs
           WHERE kind = 'OFFLOAD' AND state = 'RUNNING'`,
        )
        .pluck()
        .get() as number;
      if (activeRows !== 0) return false;
      if (state === 'PAUSED') return false;
      const timestamp = this.now().getTime();
      const changed = this.db
        .prepare(
          `UPDATE offload_scheduler_control
           SET state = 'PAUSED', revision = revision + 1, updated_at = ?
           WHERE singleton = 1 AND state = 'PAUSING'`,
        )
        .run(timestamp);
      return changed.changes === 1;
    })();
  }

  private require(id: string): Job<unknown> {
    const job = this.get(id);
    if (!job) throw new Error('JOB_NOT_FOUND');
    return job;
  }

  private parkOperatorPaused(
    jobId: string,
    fromState: 'QUEUED' | 'RETRY_WAIT',
    timestamp: number,
  ): void {
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
      .run(timestamp, timestamp, jobId);
    const changed = this.db
      .prepare(
        `UPDATE jobs SET state = 'BLOCKED', last_error_code = 'OPERATOR_PAUSED', updated_at = ?
         WHERE id = ? AND state IN ('QUEUED', 'RETRY_WAIT')`,
      )
      .run(timestamp, jobId);
    if (changed.changes !== 1) throw new Error('OFFLOAD_PAUSE_CONFLICT');
    this.insertEvent(
      jobId,
      'OFFLOAD_PAUSED',
      { from: fromState, to: 'BLOCKED', code: 'OPERATOR_PAUSED' },
      timestamp,
    );
  }

  private clearActiveOffloadTelemetry(jobId: string): void {
    this.db
      .prepare(
        `UPDATE offload_snapshots
         SET current_file_alias = NULL, upload_rate_bps = NULL, hash_rate_bps = NULL,
             verify_rate_bps = NULL, eta_seconds = NULL, rates_sampled_at = NULL
         WHERE job_id = ?`,
      )
      .run(jobId);
  }

  private mapJob<TPayload>(row: JobRow, payload: TPayload): Job<TPayload> {
    return {
      id: row.id,
      kind: row.kind,
      state: JobStateSchema.parse(row.state),
      idempotencyKey: row.idempotencyKey,
      payload,
      progress: PROGRESS_SCHEMA.parse(row.progress),
      attempt: NON_NEGATIVE_INTEGER_SCHEMA.parse(row.attempt),
      runAfter: NON_NEGATIVE_INTEGER_SCHEMA.parse(row.runAfter),
      createdAt: NON_NEGATIVE_INTEGER_SCHEMA.parse(row.createdAt),
      updatedAt: NON_NEGATIVE_INTEGER_SCHEMA.parse(row.updatedAt),
      lastErrorCode: row.lastErrorCode,
    };
  }

  private insertEvent(
    jobId: string,
    eventType: string,
    detail: JobEventDetail,
    createdAt: number,
  ): JobEvent {
    if (!eventType) throw new Error('INVALID_JOB_EVENT_TYPE');
    const id = randomUUID();
    const validated = validateJobEventDetail(detail);
    this.db
      .prepare(
        `INSERT INTO job_events(id, job_id, event_type, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, jobId, eventType, serializeJson(validated), createdAt);
    return { id, jobId, eventType, detail: validated, createdAt };
  }
}
