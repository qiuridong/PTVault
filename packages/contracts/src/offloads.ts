import { z } from 'zod';

// Borrowed rather than redeclared. These two are the netdisk importer's, but the
// encoding they describe — a byte count as a decimal string, because a job total
// passes 2^53 well inside plausible use — is a property of large byte figures,
// not of that feature. A second local copy of the regex is a second thing to
// keep in step, and the failure when it drifts is a figure that silently stops
// parsing on one page while it still parses on the other.
import { DecimalBytesSchema, DecimalRateSchema } from './imports.js';
import { MfaCodeSchema } from './recovery.js';

export const OffloadStepSchema = z.enum([
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
]);

export const OffloadImportanceSchema = z.enum(['STANDARD', 'IMPORTANT']);

/**
 * What the server says this transfer can be told to do right now.
 *
 * The client renders buttons from this list and from nothing else. Deriving them
 * from `jobState` was the old approach and it was wrong in both directions: it
 * offered actions the server would refuse, and it hid `CANCEL` on a paused job
 * that the server was perfectly willing to cancel — a transfer with no exit holds
 * its torrent's active identity forever, so that omission is what makes a torrent
 * permanently unmigratable. Only the server knows the durable pause markers and
 * the global scheduler gate, so only the server decides.
 */
export const OffloadAvailableActionSchema = z.enum([
  'PAUSE',
  'RESUME',
  'RETRY',
  'CANCEL',
  'CLEANUP',
]);

/** Durable control boundaries, carried on `job.updated` so a client can react to the transition itself. */
export const OffloadControlEventCodeSchema = z.enum([
  'OFFLOAD_PAUSE_REQUESTED',
  'OFFLOAD_PAUSED',
  'OFFLOAD_RESUMED',
]);

export const OffloadSchedulerStateSchema = z.enum(['RUNNING', 'PAUSING', 'PAUSED']);

/** A physical scheduler resource the handler is queued behind, independent of its logical step. */
export const OffloadResourceWaitSchema = z.enum([
  'PREFLIGHT_SLOT',
  'PAUSE_SNAPSHOT_SLOT',
  'HASH_SLOT',
  'UPLOAD_SLOT',
  'READBACK_SLOT',
  'REMOTE_HEAVY_SLOT',
]);

/**
 * How far a pause request has got.
 *
 * `STALLED` is the one that matters for what may be drawn: it means the fixed
 * acknowledgement deadline passed with the handler still unwinding. The job is
 * therefore still `RUNNING` — rclone may still be moving bytes — so a UI must not
 * describe it as paused. It is safe to cancel, and that is the only thing it is
 * safe to offer.
 */
export const OffloadPauseAcknowledgementStateSchema = z.enum([
  'NOT_REQUESTED',
  'PENDING',
  'STALLED',
  'ACKNOWLEDGED',
]);

/**
 * Whether qB is durably known to be paused — three states, not a boolean.
 *
 * A boolean here read as "qB is running" whenever the answer was really "we have
 * no durable evidence yet", which is the more dangerous of the two errors: the
 * operator concludes the torrent is still seeding and goes looking for a problem
 * that does not exist. `UNKNOWN` and `CONFIRMING` are both honest absences and
 * must never be drawn as "running".
 */
export const OffloadQbPauseStateSchema = z.enum(['UNKNOWN', 'CONFIRMING', 'CONFIRMED_PAUSED']);

/** Why the database is not drained. Each entry names one class of active work. */
export const OffloadDeploymentBlockerSchema = z.enum([
  'OFFLOAD_SCHEDULER_NOT_PAUSED',
  'OFFLOAD_JOBS_ACTIVE',
  'OFFLOAD_HANDLERS_ACTIVE',
  'NON_OFFLOAD_JOBS_ACTIVE',
  'IMPORTS_ACTIVE',
  'WORKER_HANDLERS_ACTIVE',
]);

/**
 * Resume granularity, deliberately a literal rather than an enum.
 *
 * `FILE` is the honest answer and the only one: no provider upload-session offset
 * is persisted, so resuming restarts the file that was in flight. Typing it as a
 * literal means a future byte-level resume cannot be introduced without changing
 * this contract and every consumer that promised the operator otherwise.
 */
export const OffloadResumeGranularitySchema = z.literal('FILE');

export const OffloadControlIdempotencyKeySchema = z.string().min(8).max(200);

/** Durable receipt identity; CANCEL is job-scoped just like PAUSE and RESUME. */
export const OffloadControlActionSchema = z.enum([
  'PAUSE',
  'RESUME',
  'CANCEL',
  'PAUSE_ALL',
  'RESUME_ALL',
]);

export const CreateOffloadSchema = z.object({
  instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  torrentHash: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/),
  importance: OffloadImportanceSchema.default('STANDARD'),
});

/**
 * How many torrents one step-up code may authorize.
 *
 * The batch is the unit of authorization, not the individual torrent: TOTP emits
 * one code per 30s window and this server spends each code exactly once, so a
 * per-torrent code would cap the operator at two migrations a minute against a
 * library of thousands. Authorizing the batch the operator selected and reviewed
 * keeps the property that matters (a stolen cookie starts nothing, a captured
 * code replays nothing) without that.
 *
 * The cap is what stops "select all" from turning one code into an unbounded
 * commitment. 200 is well above a realistic review-then-confirm batch and far
 * below the ~9.4k-item library, so an operator who misclicks loses one batch,
 * not the whole vault.
 */
export const OFFLOAD_BATCH_LIMIT = 200;

export const OffloadTargetSchema = CreateOffloadSchema.pick({
  instanceId: true,
  torrentHash: true,
});

/**
 * The offload trigger's wire body: the selected batch plus one fresh TOTP code.
 *
 * The code is required per request, never once per session. This action pauses a
 * torrent, uploads its bytes, and eventually deletes the local copy, so a stolen
 * session cookie alone must not be able to start one.
 */
export const OffloadTriggerRequestSchema = z.object({
  targets: z.array(OffloadTargetSchema).min(1).max(OFFLOAD_BATCH_LIMIT),
  importance: OffloadImportanceSchema.default('STANDARD'),
  mfaCode: MfaCodeSchema,
});

/**
 * Why a whole trigger request was refused before any target was examined.
 *
 * `OFFLOAD_SCHEDULER_NOT_RUNNING` is the drain freeze: while a global pause is in
 * force, creating work would break the freeze the operator established in order
 * to deploy. Refused before MFA and preflight, so a rejected attempt does not
 * burn the operator's code.
 */
export const OffloadTriggerConflictCodeSchema = z.enum([
  'MODE_NOT_ACTIVE',
  'OFFLOAD_CREATION_DISABLED',
  'OFFLOAD_SCHEDULER_NOT_RUNNING',
]);

/** Why a single target in an otherwise-accepted batch was refused. */
export const OffloadRejectionCodeSchema = z.enum([
  'TORRENT_NOT_FOUND',
  'INVALID_TORRENT_IDENTITY',
  'PREFLIGHT_INELIGIBLE',
  'OFFLOAD_ALREADY_ACTIVE',
  'DUPLICATE_TARGET',
  'OFFLOAD_CREATION_DISABLED',
  'OFFLOAD_SCHEDULER_NOT_RUNNING',
  'CREATE_FAILED',
]);

export const OffloadRejectionSchema = OffloadTargetSchema.extend({
  code: OffloadRejectionCodeSchema,
  /**
   * Blocking preflight reasons when the code is PREFLIGHT_INELIGIBLE, empty
   * otherwise. Required rather than defaulted: a default would make the schema's
   * input and output types diverge, and every producer already sets it.
   */
  issues: z.array(z.string()),
  /**
   * The job already holding this torrent, when the code is
   * OFFLOAD_ALREADY_ACTIVE. Without it the operator is told "already migrating"
   * with no way to find or clear the job that says so — which is exactly how a
   * torrent becomes permanently unmigratable after one failure.
   */
  conflict: z
    .object({
      jobId: z.string().uuid(),
      currentStep: OffloadStepSchema,
      /** `true` when the holder is finished or cancelled and only needs clearing. */
      resolvable: z.boolean(),
    })
    .nullable(),
});

export const OffloadSnapshotSchema = z.object({
  jobId: z.string().uuid(),
  instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  torrentHash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  importance: OffloadImportanceSchema,
  currentStep: OffloadStepSchema,
  jobState: z.enum([
    'QUEUED',
    'RUNNING',
    'RETRY_WAIT',
    'BLOCKED',
    'FAILED_SAFE',
    'CANCELLED_SAFE',
    'COMPLETED',
  ]),
  recoveryVersion: z.number().int().positive().nullable(),
  cancelledAt: z.number().int().nonnegative().nullable(),
  cleanupCompletedAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),

  /** Durable scheduler wait marker; absent whenever the handler owns a permit or is not queued. */
  resourceWait: OffloadResourceWaitSchema.optional(),
  /** One-based FIFO position, omitted when no reliable position is available. */
  resourceQueuePosition: z.number().int().positive().optional(),
  /** Live semaphore occupancy captured with the wait observation. */
  resourceActive: z.number().int().nonnegative().optional(),
  /** Live semaphore capacity captured with the wait observation. */
  resourceCapacity: z.number().int().positive().optional(),

  /*
   * Live telemetry. Every field is optional, and that is the compatibility
   * boundary rather than an oversight: an API build that does not measure a leg
   * omits it, an older build omits all of them, and both keep parsing. A default
   * of `0` would have been the cheaper schema and the wrong one — it makes "not
   * measured" indistinguishable from "stalled", and those two send an operator to
   * different places.
   *
   * Byte counts are decimal strings for the reason set out in `imports.ts`: the
   * sum over a multi-file torrent passes 2^53, and `number` would round the very
   * figure a deletion decision is made against. Consumers widen to BigInt.
   */

  /**
   * Progress of the leg currently running, against that leg's own total.
   *
   * One step-relative pair rather than one field per leg. Hashing, uploading and
   * verifying each walk the same bytes in turn, so three separate counters would
   * put two finished bars and one moving bar on screen and leave the reader to
   * work out which is live. `currentStep` already says which leg this is.
   */
  stepBytesDone: DecimalBytesSchema.optional(),
  stepBytesTotal: DecimalBytesSchema.optional(),

  /**
   * Bytes whose decrypted read-back digest has matched, against the job total.
   *
   * Kept separate from the step pair because this is the figure the deletion
   * decision is made against, and it must stay readable after the active leg is
   * over. `stepBytes*` is gone once a transfer reaches `CLOUD_COMMITTED`; this is
   * not.
   */
  verifiedBytes: DecimalBytesSchema.optional(),
  totalBytes: DecimalBytesSchema.optional(),

  /** Files finished, and the manifest's file count. */
  filesDone: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),

  /**
   * Masked display name of the file currently moving.
   *
   * Present so a stalled-looking transfer can be attributed to one file. Real
   * paths stay in the manifest; this is for reading, not for addressing.
   */
  currentFileAlias: z.string().min(1).max(300).optional(),

  /**
   * Instantaneous rates, per leg, never summed into one figure.
   *
   * Separate because identifying the bottleneck is the only thing the number is
   * read for: 8 MiB/s hashing against 40 MiB/s upload is a local disk problem,
   * and the reverse is OneDrive throttling. A blended "overall speed" answers
   * neither.
   */
  uploadRateBps: DecimalRateSchema.optional(),
  hashRateBps: DecimalRateSchema.optional(),
  verifyRateBps: DecimalRateSchema.optional(),

  /** Seconds remaining for the phase in flight. Absent when no honest estimate exists. */
  etaSeconds: z.number().int().nonnegative().optional(),

  /**
   * When the rates were last sampled.
   *
   * Without it a rate has no shelf life: a worker that died mid-upload leaves its
   * last sample in the row, and a page reading it two hours later would report
   * 30 MiB/s for a transfer that stopped. The client ages the figure out.
   */
  ratesSampledAt: z.number().int().nonnegative().optional(),

  /*
   * Durable pause state. Optional for the same compatibility reason as the
   * telemetry above, and read together rather than one at a time: the pair
   * (`pauseRequestedAt`, `pausedAt`) is what separates "asked to stop" from
   * "stopped", and only the second one licenses the word "paused" on screen.
   */

  /** Present while a RUNNING handler is unwinding in response to operator pause. */
  pauseRequestedAt: z.number().int().nonnegative().nullable().optional(),

  /** Present only after the handler/subprocess/stream has fully stopped. */
  pausedAt: z.number().int().nonnegative().nullable().optional(),

  /** Fixed when pause is first requested; retries never extend this deadline. */
  pauseAcknowledgementDeadlineAt: z.number().int().nonnegative().optional(),

  /** Server-derived state; STALLED still means RUNNING and is safe to cancel. */
  pauseAcknowledgementState: OffloadPauseAcknowledgementStateSchema.optional(),

  /**
   * Explicit marker: BLOCKED alone never means operator pause.
   *
   * A job can be BLOCKED because preflight refused it, because a provider quota
   * closed, or because the operator asked it to stop, and offering `RESUME` for
   * the first two would be offering something the server refuses.
   */
  operatorPaused: z.boolean().optional(),

  /** Computed by the server from durable state and the global scheduler gate. */
  availableActions: z.array(OffloadAvailableActionSchema).optional(),

  /** No provider upload-session offset is persisted; the current file may restart. */
  resumeGranularity: OffloadResumeGranularitySchema.optional(),
  currentFileMayRestart: z.literal(true).optional(),

  /** Durable qB evidence; false means "not confirmed", never "qB is running". */
  qbTorrentRemainsPaused: z.boolean().optional(),
  qbPauseState: OffloadQbPauseStateSchema.optional(),

  /**
   * Exact durable confirmation time when v20 evidence exists; old later steps may
   * omit it. A `CONFIRMED_PAUSED` with no timestamp is therefore normal and must
   * not be downgraded to "unknown" by a client that insists on the pair.
   */
  qbPauseConfirmedAt: z.number().int().nonnegative().optional(),

  /** Operator pause/resume never issues an automatic qB resume command. */
  qbTorrentAutoResume: z.literal(false).optional(),
});

export type OffloadStep = z.infer<typeof OffloadStepSchema>;
export type OffloadImportance = z.infer<typeof OffloadImportanceSchema>;
export type CreateOffload = z.infer<typeof CreateOffloadSchema>;
export type OffloadTarget = z.infer<typeof OffloadTargetSchema>;

/**
 * Asks one running transfer to stop where it is, keeping every local byte.
 *
 * No MFA code, unlike cancel and resume. Pausing destroys nothing and starts
 * nothing — it is the safe direction — and requiring a fresh TOTP code to stop a
 * runaway transfer would mean the operator with a code already spent this window
 * has to watch it keep uploading for thirty seconds.
 */
export const OffloadPauseRequestSchema = z.object({ jobId: z.string().uuid() }).strict();

/**
 * The pause receipt: what was asked, and how far it has actually got.
 *
 * `pauseRequested` distinguishes the request that took effect from the replay of
 * one already recorded, and `operatorPaused` says whether the handler has in fact
 * stopped. They are separate because the gap between them is real — the handler
 * has to finish unwinding an rclone child — and a client that treats the 202 as
 * "paused" tells the operator bytes have stopped moving while they have not.
 */
export const OffloadPauseResultSchema = z
  .object({
    jobId: z.string().uuid(),
    pauseRequested: z.boolean(),
    operatorPaused: z.boolean(),
    jobState: OffloadSnapshotSchema.shape.jobState,
    currentStep: OffloadStepSchema,
    /** Always true. Pausing abandons no cloud work and no local bytes. */
    localPreserved: z.literal(true),
    resumeGranularity: OffloadResumeGranularitySchema,
    currentFileMayRestart: z.literal(true),
    pauseAcknowledgementDeadlineAt: z.number().int().nonnegative().optional(),
    pauseAcknowledgementState: OffloadPauseAcknowledgementStateSchema.optional(),
    qbPauseState: OffloadQbPauseStateSchema.optional(),
    qbPauseConfirmedAt: z.number().int().nonnegative().optional(),
    /** false means confirmation is absent/ongoing, not that qB resumed. */
    qbTorrentRemainsPaused: z.boolean(),
    qbTorrentAutoResume: z.literal(false),
  })
  .strict();

/**
 * Re-queues a paused transfer. Carries a fresh code because resuming restarts
 * uploads and moves back toward the eventual local deletion.
 */
export const OffloadResumeRequestSchema = z
  .object({ jobId: z.string().uuid(), mfaCode: MfaCodeSchema })
  .strict();

export const OffloadResumeResultSchema = z
  .object({
    jobId: z.string().uuid(),
    requeued: z.literal(true),
    /** The step the resume picks up from. */
    resumingFrom: OffloadStepSchema,
    /**
     * `FILE`, and the client must say so. The operator who paused a 40 GiB file
     * at 90% is entitled to know that resuming re-sends it rather than finding
     * out from the transfer rate.
     */
    resumeGranularity: OffloadResumeGranularitySchema,
    currentFileMayRestart: z.literal(true),
    qbPauseState: OffloadQbPauseStateSchema.optional(),
    qbPauseConfirmedAt: z.number().int().nonnegative().optional(),
    qbTorrentRemainsPaused: z.boolean(),
    /** Resuming the transfer does not resume the torrent. Never true. */
    qbTorrentAutoResume: z.literal(false),
  })
  .strict();

/** The global drain switch takes no arguments: it pauses every OFFLOAD there is. */
export const OffloadPauseAllRequestSchema = z.object({}).strict();

/** Lifting the freeze restarts uploads in bulk, so it takes a code. */
export const OffloadResumeAllRequestSchema = z.object({ mfaCode: MfaCodeSchema }).strict();

/**
 * The global scheduler and drain picture, read before a restart is considered.
 *
 * Three layers, deliberately not collapsed into one "can I deploy?" boolean:
 * `offloadDrained` covers this feature's own work, `databaseDrained` adds every
 * other durable job and import, and `deploymentReadiness` stops even at its best
 * value on `DB_DRAINED_RCLONE_CHECK_REQUIRED` — because an rclone process holding
 * a transfer open is invisible to this database, and only an OS-level check
 * (`data-rclone=0`) settles it. There is no value of this field that means
 * "deployable".
 */
export const OffloadSchedulerStatusSchema = z
  .object({
    schedulerState: OffloadSchedulerStateSchema,
    /** Monotonic durable scheduler-control revision; SSE carries the same value. */
    revision: z.number().int().nonnegative(),
    requestedCount: z.number().int().nonnegative(),
    runningCount: z.number().int().nonnegative(),
    pausedCount: z.number().int().nonnegative(),
    /** Requested pauses whose fixed acknowledgement deadline has elapsed. */
    stalledCount: z.number().int().nonnegative().optional(),
    queuedCount: z.number().int().nonnegative(),
    activeOffloadHandlers: z.number().int().nonnegative(),
    /** All handlers still owned by the in-process Worker, regardless of job kind. */
    activeWorkerHandlers: z.number().int().nonnegative(),
    /** Durable jobs in RUNNING/QUEUED/RETRY_WAIT, split by data plane. */
    offloadJobs: z.number().int().nonnegative(),
    nonOffloadJobs: z.number().int().nonnegative(),
    imports: z.number().int().nonnegative(),
    /** OFFLOAD-only drain result; pause-all does not stop import or recovery jobs. */
    offloadDrained: z.boolean(),
    /** Whole-database restart gate, before the separate OS-level rclone check. */
    databaseDrained: z.boolean(),
    deploymentBlockers: z.array(OffloadDeploymentBlockerSchema),
    deploymentReadiness: z.enum(['NOT_DRAINED', 'DB_DRAINED_RCLONE_CHECK_REQUIRED']),
    resumeGranularity: OffloadResumeGranularitySchema,
    currentFileMayRestart: z.literal(true),
  })
  .strict();

/**
 * Clears a transfer that is not yet cloud-committed, releasing the torrent so it
 * can be migrated again. Carries an MFA code for the same reason the trigger
 * does: a live session alone must not be able to abandon a transfer in flight.
 *
 * Local files are never touched by a cancel — the response says so explicitly so
 * the operator does not have to infer it.
 */
export const OffloadCancelRequestSchema = z.object({
  jobId: z.string().uuid(),
  mfaCode: MfaCodeSchema,
});

export const OffloadCancelResultSchema = z.object({
  jobId: z.string().uuid(),
  cancelled: z.literal(true),
  /** Always true. Cancelling abandons cloud work, never local bytes. */
  localPreserved: z.literal(true),
});

/**
 * Re-queues a transfer that stopped safely, reusing the snapshot it already has.
 *
 * Preferred over cancel-then-start for a failed job: the snapshot may already
 * hold the exported .torrent and per-file hashes, and `pauseAndSnapshot` is
 * idempotent, so a retry resumes rather than redoing that work.
 */
export const OffloadRetryRequestSchema = z.object({
  jobId: z.string().uuid(),
  mfaCode: MfaCodeSchema,
});

export const OffloadRetryResultSchema = z.object({
  jobId: z.string().uuid(),
  requeued: z.literal(true),
  /** The step the retry will resume from, so the UI can say where it picks up. */
  resumingFrom: OffloadStepSchema,
});

/**
 * Starts the separate, operator-authorized local cleanup phase.
 *
 * Cleanup is deliberately not part of the upload request: reaching
 * `CLOUD_COMMITTED` proves the cloud copy, but removing the local source is a
 * second decision with its own fresh MFA code and recovery-material re-check.
 */
export const OffloadCleanupRequestSchema = z.object({
  jobId: z.string().uuid(),
  mfaCode: MfaCodeSchema,
});

const OffloadCleanupResultBaseSchema = z.object({
  jobId: z.string().uuid(),
  /** The deletion phase has begun; callers must not describe the source as intact. */
  localDeletionStarted: z.literal(true),
  deleted: z.number().int().nonnegative(),
});

export const OffloadCleanupResultSchema = z.discriminatedUnion('warningCode', [
  OffloadCleanupResultBaseSchema.extend({
    localDeleted: z.literal(true),
    completed: z.literal(true),
    followUpPending: z.literal(false),
    warningCode: z.null(),
  }),
  OffloadCleanupResultBaseSchema.extend({
    localDeleted: z.literal(true),
    completed: z.literal(false),
    followUpPending: z.literal(true),
    warningCode: z.literal('CLEANUP_FOLLOW_UP_PENDING'),
  }),
  OffloadCleanupResultBaseSchema.extend({
    localDeleted: z.literal(false),
    completed: z.literal(false),
    followUpPending: z.literal(true),
    warningCode: z.literal('CLEANUP_PARTIAL_LOCAL_DELETION'),
  }),
]);

export type OffloadCancelRequest = z.infer<typeof OffloadCancelRequestSchema>;
export type OffloadCancelResult = z.infer<typeof OffloadCancelResultSchema>;
export type OffloadRetryRequest = z.infer<typeof OffloadRetryRequestSchema>;
export type OffloadRetryResult = z.infer<typeof OffloadRetryResultSchema>;
export type OffloadCleanupRequest = z.infer<typeof OffloadCleanupRequestSchema>;
export type OffloadCleanupResult = z.infer<typeof OffloadCleanupResultSchema>;
export type OffloadRejection = z.infer<typeof OffloadRejectionSchema>;
export type OffloadTriggerRequest = z.infer<typeof OffloadTriggerRequestSchema>;
export type OffloadSnapshot = z.infer<typeof OffloadSnapshotSchema>;
export type OffloadAvailableAction = z.infer<typeof OffloadAvailableActionSchema>;
export type OffloadControlEventCode = z.infer<typeof OffloadControlEventCodeSchema>;
export type OffloadControlAction = z.infer<typeof OffloadControlActionSchema>;
export type OffloadSchedulerState = z.infer<typeof OffloadSchedulerStateSchema>;
export type OffloadResourceWait = z.infer<typeof OffloadResourceWaitSchema>;
export type OffloadDeploymentBlocker = z.infer<typeof OffloadDeploymentBlockerSchema>;
export type OffloadPauseRequest = z.infer<typeof OffloadPauseRequestSchema>;
export type OffloadPauseResult = z.infer<typeof OffloadPauseResultSchema>;
export type OffloadResumeRequest = z.infer<typeof OffloadResumeRequestSchema>;
export type OffloadResumeResult = z.infer<typeof OffloadResumeResultSchema>;
export type OffloadSchedulerStatus = z.infer<typeof OffloadSchedulerStatusSchema>;
