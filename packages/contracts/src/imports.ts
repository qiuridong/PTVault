import { z } from 'zod';
import {
  ArchivePlanRequestSchema,
  ArchivePlanSummarySchema,
  ArchiveJobStatusSchema,
} from './archive-imports.js';

import { CloudConnectionRateLimitCodeSchema } from './cloud-connections.js';
import { ImportPipelinePlanSchema } from './group-imports.js';
import { DownloadFailureDiagnosticSchema } from './download-diagnostics.js';

/**
 * Contracts for netdisk → VPS → OneDrive imports, and for the Jellyfin
 * publication that is deliberately *not* part of them.
 *
 * Two decisions from the frozen design are load-bearing here and are enforced by
 * the shapes rather than left to callers:
 *
 * 1. **Bytes and rates travel as decimal strings.** A single 4K remux is already
 *    past 2^53 when counted in bits, and a job total is the sum of hundreds of
 *    them. `number` would round silently — and the number it rounds is the one a
 *    verification decision is made against. Every consumer must widen to BigInt
 *    before arithmetic; there is a BigInt-safe formatter in the web bundle.
 * 2. **An import's success is decided by bytes, receipts and recovery material,
 *    never by Jellyfin.** So the publication is a separate, nullable object with
 *    its own state machine, and a failed publication cannot express itself as a
 *    failed import.
 *
 * A third rule shows up as an absence: no schema on this page has a field for a
 * share passcode except the one that carries it inward, exactly once, in a
 * request body. Nothing the server hands back can hold one, so no snapshot,
 * receipt, event or plan can leak one into a cache, a log or a screen.
 */

/**
 * A non-negative integer that survives being large.
 *
 * Capped at 30 digits — far past any real byte count, tight enough that a
 * malformed body cannot hand a consumer an unbounded string to widen. No sign,
 * no exponent, no leading zeros: one canonical spelling per value, so two
 * snapshots of the same figure compare equal as strings.
 */
export const DecimalBytesSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,29})$/, { message: 'expected a non-negative decimal integer string' });

/** Same encoding, used for instantaneous rates in bytes per second. */
export const DecimalRateSchema = DecimalBytesSchema;

/** ISO 8601 instant. Offsets accepted so a non-UTC worker clock still parses. */
const InstantSchema = z.string().datetime({ offset: true });

/**
 * Worker-level state, shared with the offload pipeline's vocabulary on purpose.
 *
 * `FAILED_SAFE` and `CANCELLED_SAFE` keep the suffix because it is the whole
 * claim: the run stopped without having deleted a sole surviving copy of
 * anything. An import that failed after committing still has its committed
 * object; one that failed during download still has the source on the netdisk.
 */
export const ImportJobStateSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'RETRY_WAIT',
  'BLOCKED',
  'FAILED_SAFE',
  'CANCELLED_SAFE',
  'COMPLETED',
]);

/**
 * Why a job that is not making progress is not making progress.
 *
 * Orthogonal to `state` rather than folded into it, because the operator's next
 * move differs entirely: `AUTH_REQUIRED` wants a fresh passcode typed in,
 * `RATE_LIMITED` wants nothing but patience, `RESOURCE_WAIT` wants spool space,
 * `SOURCE_CHANGED` wants the share re-checked, and `DESTINATION_UNAVAILABLE`
 * wants OneDrive looked at. Collapsing them into `BLOCKED` would send someone
 * to re-enter a passcode that was never the problem.
 */
export const ImportCurrentConditionSchema = z.enum([
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'RESOURCE_WAIT',
  'SOURCE_CHANGED',
  'DESTINATION_UNAVAILABLE',
]);

/**
 * The durable steps of an import, in order.
 *
 * `STAGING_READBACK` and `COMMITTED_READBACK` are both present and neither is
 * optional: staging readback is the gate before committing, and the committed
 * object must be fully re-read *again* after the commit, because a commit that
 * copied a truncated object would pass a size check and fail a hash. That second
 * readback is what `COMMITTED_VERIFIED` means.
 *
 * `MEDIA_PUBLISH` is last and outside the verification chain — a job reaches
 * `COMPLETED` without it whenever the policy is archive-only.
 */
export const ImportStepSchema = z.enum([
  'SHARE_TRANSFER',
  'DISCOVERING',
  'SOURCE_PREFLIGHT',
  'DOWNLOADING',
  'LOCAL_LANDING',
  'HASHING',
  'UPLOADING_STAGING',
  'STAGING_READBACK',
  'COMMITTING',
  'COMMITTED_READBACK',
  'CONTROL_PLANE_BACKUP',
  'SPOOL_CLEANUP',
  'COMPLETED',
  'MEDIA_PUBLISH',
]);

/**
 * Whether this import is only a backup, or also a library entry.
 *
 * `ARCHIVE_ONLY` is the default in every producer. Publishing creates a catalog
 * row and a symlink projection; it copies no second set of bytes, and choosing
 * it must never be a side effect of choosing to back something up.
 */
export const PublicationPolicySchema = z.enum(['ARCHIVE_ONLY', 'PUBLISH_TO_JELLYFIN']);

/** Source cleanup is separate from archive and publication success. */
export const ImportSourceCleanupPolicySchema = z.enum([
  'KEEP',
  'JOB_STAGING_ONLY',
  'SELECTED_SOURCE',
]);

/**
 * Where the publication got to.
 *
 * `NOT_REQUESTED` exists so an archive-only job can say so positively instead of
 * being read as a publication that has not started yet. `UNPUBLISHED` records
 * that the projection was removed — which never implies the cloud object was.
 */
export const PublicationStateSchema = z.enum([
  'NOT_REQUESTED',
  'PENDING',
  'RUNNING',
  'PUBLISHED',
  'FAILED_SAFE',
  'UNPUBLISHED',
]);

/** Kinds of source the importer knows how to read. */
export const ImportSourceKindSchema = z.enum(['BAIDU_SHARE', 'BAIDU_APP_DIR', 'OTHER']);

/** Jellyfin content kinds this console publishes into. */
export const ImportMediaTypeSchema = z.enum(['MOVIE', 'SERIES']);

/**
 * The live progress of one import.
 *
 * Exactly the shape frozen in the design doc. Two things about it are worth
 * stating because they are easy to undo by accident:
 *
 * - **The rates are separate and every one of them is optional.** One blended
 *   "overall speed" hides which leg is the bottleneck, which is the only thing
 *   the number is read for. And a rate the server did not measure is absent, not
 *   zero: `0 B/s` is a claim that nothing is moving.
 * - **`revision` orders snapshots.** Events arrive out of order under
 *   reconnection; a consumer that renders a stale snapshot over a fresh one
 *   walks the progress bar backwards.
 */
export const ImportProgressSnapshotSchema = z.object({
  jobId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  state: ImportJobStateSchema,
  currentStep: ImportStepSchema,
  currentCondition: ImportCurrentConditionSchema.optional(),
  objectIndex: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  /** Masked display name. Real source paths and filenames live only in manifests. */
  currentObjectAlias: z.string().min(1).max(300).optional(),
  objectBytesDone: DecimalBytesSchema,
  objectBytesTotal: DecimalBytesSchema,
  jobBytesVerified: DecimalBytesSchema,
  jobBytesTotal: DecimalBytesSchema,
  downloadRateBps: DecimalRateSchema.optional(),
  uploadRateBps: DecimalRateSchema.optional(),
  verifyRateBps: DecimalRateSchema.optional(),
  etaSeconds: z.number().int().nonnegative().optional(),
  /** Epoch milliseconds for the rate/ETA sample, matching the offload telemetry clock. */
  ratesSampledAt: z.number().int().nonnegative().optional(),
  /** Earliest retry time, including owner-retaining download recovery. */
  retryAt: InstantSchema.optional(),
  /** RUNNING ownership is retained, but there is no transfer during this wait. */
  downloadRetryInPlace: z.boolean().optional(),
  lastCheckpointAt: InstantSchema,
  publicationPolicy: PublicationPolicySchema,
  publicationState: PublicationStateSchema.optional(),
  resourceWait: z
    .object({
      resource: z.enum(['MAX_IN_FLIGHT', 'LOCAL_PREPARATION', 'UPLOAD', 'SPOOL_CAPACITY']),
      queuePosition: z.number().int().positive(),
      since: InstantSchema,
      /** Semaphore occupancy. Capacity waits have no slot occupancy and omit the pair. */
      active: z.number().int().nonnegative().optional(),
      capacity: z.number().int().positive().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.active === undefined) !== (value.capacity === undefined)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Resource active and capacity must be present or absent together',
        });
      }
    })
    .optional(),
});

/** An active provider throttle shared by every import using one source connection. */
export const ImportSourceRateLimitSchema = z
  .object({
    connectionId: z.string().uuid(),
    retryAt: InstantSchema,
    code: CloudConnectionRateLimitCodeSchema,
    updatedAt: InstantSchema,
    affectedActiveJobs: z.number().int().positive(),
  })
  .strict();

/** Why a destination cannot accept work right now. */
export const ImportDestinationUnavailableReasonSchema = z.enum([
  'NOT_CONFIGURED',
  'FEATURE_DISABLED',
  'QUOTA_EXHAUSTED',
  'RATE_LIMITED',
  'CIRCUIT_OPEN',
  'AUTH_REQUIRED',
  'SHADOW_MODE',
]);

/**
 * One place an import can land.
 *
 * `available` is the server's verdict and the only thing a client may gate on —
 * a browser that decides for itself which destinations are enabled will keep
 * offering one after it is switched off server-side.
 *
 * The last four fields are `.optional()` *and* `.nullable()`, and the difference
 * is load-bearing: absent means this API version does not report the field at
 * all, `null` means it reports it and has no value. They render differently —
 * 「该 API 版本未报告」 versus a stated empty — and merging them would answer a
 * question nobody asked.
 */
export const ImportDestinationSchema = z.object({
  destinationId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
  kind: z.enum(['ONEDRIVE_RAW', 'STANDALONE_CRYPT', 'PT_VAULT_IMPORT']),
  available: z.boolean(),
  unavailableReason: ImportDestinationUnavailableReasonSchema.nullable(),
  availableBytes: DecimalBytesSchema.nullable().optional(),
  allowedRoot: z.string().min(1).max(4096).nullable().optional(),
  supportsRestore: z.boolean().optional(),
  supportsJellyfin: z.boolean().optional(),
});

/**
 * A Jellyfin library discovered by the server, including clearly explained non-video choices.
 *
 * `contentType` is here so the browser can refuse a mismatch (a series into a
 * Movies library) before submitting, and `containerPath` so the operator can see
 * where it will appear. Neither is a path the client may choose: the client
 * submits `libraryId` and the server resolves everything else, which is what
 * keeps an arbitrary host directory from becoming a library root.
 */
export const JellyfinImportLibrarySchema = z.object({
  libraryId: z.string().min(1).max(64),
  libraryKey: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
  contentType: z.enum(['Movies', 'Shows', 'HomeVideos', 'Mixed', 'Photos', 'Collections', 'Other']),
  containerPath: z.string().min(1).max(4096),
  managedRoot: z.boolean().optional(),
  unavailableReason: z
    .enum([
      'PHOTOS_ONLY',
      'COLLECTION_ONLY',
      'TYPE_UNSUPPORTED',
      'PATH_UNMAPPED',
      'DISCOVERY_UNAVAILABLE',
    ])
    .nullable()
    .optional(),
});

export const JellyfinLibraryDiscoveryErrorSchema = z.enum([
  'JELLYFIN_UNREACHABLE',
  'JELLYFIN_AUTH_FAILED',
  'LIBRARY_RESPONSE_INVALID',
]);
export type JellyfinLibraryDiscoveryError = z.infer<typeof JellyfinLibraryDiscoveryErrorSchema>;

/** MOVIE is the legacy standalone-video tag; existing database values stay intact. */
export function importLibraryAcceptsMediaType(
  mediaType: ImportMediaType,
  contentType: JellyfinImportLibrary['contentType'],
): boolean {
  return (
    contentType === 'Mixed' ||
    (mediaType === 'MOVIE' && (contentType === 'Movies' || contentType === 'HomeVideos')) ||
    (mediaType === 'SERIES' && contentType === 'Shows')
  );
}

/** Actions the server says it will accept for a job right now. */
export const ImportActionSchema = z.enum([
  'PAUSE',
  'RESUME',
  'CANCEL',
  'RETRY',
  'PROVIDE_CREDENTIALS',
  'REPUBLISH',
  'UNPUBLISH',
]);

/** Why publishing is not on offer, when it is not. */
export const ImportPublishDisabledReasonSchema = z.enum([
  'IMPORT_RUNTIME_NOT_CONFIGURED',
  'PUBLICATION_RUNTIME_NOT_CONFIGURED',
  'SHADOW_MODE',
  'FEATURE_DISABLED',
  'JELLYFIN_NOT_CONFIGURED',
  'NO_ALLOWLISTED_LIBRARY',
  'DESTINATION_UNSUPPORTED',
]);

/** One source kind and whether this deployment can actually use it. */
export const ImportSourceCapabilitySchema = z.object({
  kind: ImportSourceKindSchema,
  enabled: z.boolean(),
  disabledReason: z
    .enum(['NOT_CONFIGURED', 'FEATURE_DISABLED', 'SHADOW_MODE', 'CAPABILITY_UNAVAILABLE'])
    .nullable(),
});

/**
 * What this deployment will and will not do — the page's single gate.
 *
 * `mode` and `createEnabled` are separate because they are separate facts: an
 * `ACTIVE` deployment can still have its durable creation gate off, and a
 * `SHADOW` one exposes the whole read surface while accepting no writes. A page
 * that inferred one from the other would either hide a working surface or offer
 * a button that 404s.
 */
export const ImportCapabilitiesSchema = z.object({
  mode: z.enum(['SHADOW', 'ACTIVE']),
  /** The server will accept `POST /api/imports`. False in SHADOW. */
  createEnabled: z.boolean(),
  /** True only when the separate recursive extractor is operational. */
  archiveExtractionEnabled: z.boolean().optional(),
  groupedPipelinesEnabled: z.boolean().optional(),
  /** Absent on older APIs. FILE selection is offered only when explicitly enabled. */
  fileSelectionEnabled: z.boolean().optional(),
  /** Deployment supports guarded FILE cleanup; per-object admission remains server-side. */
  fileSourceCleanupEnabled: z.boolean().optional(),
  sources: z.array(ImportSourceCapabilitySchema).max(16),
  publishToJellyfinEnabled: z.boolean(),
  publishDisabledReason: ImportPublishDisabledReasonSchema.nullable(),
  libraries: z.array(JellyfinImportLibrarySchema).max(64),
  libraryDiscoveryError: JellyfinLibraryDiscoveryErrorSchema.nullable().optional(),
  /** Actions this API version implements at all, regardless of any one job. */
  supportedActions: z.array(ImportActionSchema).max(16),
});

export const ImportDestinationsResponseSchema = z.object({
  capabilities: ImportCapabilitiesSchema,
  destinations: z.array(ImportDestinationSchema).max(64),
});

/** Two source objects that would land on the same destination path. */
export const ImportPlanConflictSchema = z.object({
  /** Masked relative path. Never the real source path. */
  pathAlias: z.string().min(1).max(300),
  kind: z.enum(['DUPLICATE_PATH', 'EXISTING_OBJECT', 'CASE_COLLISION']),
});

/**
 * A destination limit this object would breach, found before any byte moves.
 *
 * Encrypted destinations are why this cannot wait: crypt filename encoding
 * inflates every path segment, so a plaintext path well inside OneDrive's limit
 * can produce a ciphertext path past it. Discovering that mid-upload means
 * discovering it after spending the transfer.
 */
export const ImportPlanLimitIssueSchema = z.object({
  pathAlias: z.string().min(1).max(300),
  kind: z.enum([
    'PATH_TOO_LONG',
    'SEGMENT_TOO_LONG',
    'ILLEGAL_CHARACTER',
    'OBJECT_TOO_LARGE',
    'CRYPT_NAME_TOO_LONG',
  ]),
  /** Server-computed limit and actual, as strings for the same reason bytes are. */
  limit: DecimalBytesSchema.nullable(),
  actual: DecimalBytesSchema.nullable(),
});

/** Whether the source can be read at all, before anything is planned against it. */
export const ImportSourceAuthStateSchema = z.enum([
  'AUTHORIZED',
  'PASSCODE_REQUIRED',
  'UNAUTHORIZED',
  'UNKNOWN',
]);

/**
 * A read-only plan: what an import *would* do.
 *
 * `transferStarted` is a literal `false` rather than a comment. Planning walks a
 * share listing and touches no bytes, and the one misreading that costs real
 * money is believing the transfer has begun and closing the page. A field the
 * schema will not let the server set to `true` lets the UI say so without
 * hedging.
 *
 * Nothing here can carry a passcode: `sourceRequiresPasscode` is a boolean about
 * the share, and `sourceAlias` is masked.
 */
export const ImportFileIdentitySchema = z
  .object({
    fsid: z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/),
    size: DecimalBytesSchema,
    mtime: z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/),
  })
  .strict();
export type ImportFileIdentity = z.infer<typeof ImportFileIdentitySchema>;

export const ImportPlanSchema = z.object({
  planId: z.string().uuid(),
  archive: ArchivePlanSummarySchema.optional(),
  pipeline: ImportPipelinePlanSchema.optional(),
  sourceKind: ImportSourceKindSchema,
  /** Exact source authority frozen by the server; absent only on legacy rows. */
  sourceConnectionId: z.string().uuid().nullable().optional(),
  /** Actual stored FILE manifest proof; absence on old APIs is not proof of file scope. */
  sourceFileProof: ImportFileIdentitySchema.extend({
    scope: z.literal('FILE'),
    path: z.string().min(1).max(4096),
  }).optional(),
  /** Actual validated stored directory root; absent on old servers, null without a directory manifest. */
  sourceRootFsid: z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,39})$/)
    .nullable()
    .optional(),
  /** Masked source label, safe to render and to log. */
  sourceAlias: z.string().min(1).max(300),
  sourceRequiresPasscode: z.boolean(),
  sourceAuthState: ImportSourceAuthStateSchema,
  destinationId: z.string().min(1).max(64),
  objectCount: z.number().int().nonnegative(),
  totalBytes: DecimalBytesSchema,
  largestObjectBytes: DecimalBytesSchema,
  /** Peak bounded spool this job needs on the VPS, not the sum of all objects. */
  requiredSpoolBytes: DecimalBytesSchema,
  pathConflicts: z.array(ImportPlanConflictSchema).max(500),
  destinationLimitIssues: z.array(ImportPlanLimitIssueSchema).max(500),
  plannedPolicy: PublicationPolicySchema,
  mode: z.enum(['SHADOW', 'ACTIVE']),
  /** Always false. Planning moves nothing; the schema refuses to say otherwise. */
  transferStarted: z.literal(false),
  /**
   * Server-side handle to the passcode this plan was built with, or null when the
   * share needed none.
   *
   * This is what lets the browser forget the plaintext the moment planning
   * returns: creating the job references the handle instead of re-sending the
   * secret. A reference is not a secret — it is scoped to this plan, expires with
   * it, and is useless without the session that minted it.
   */
  credentialRef: z.string().min(1).max(200).nullable(),
  expiresAt: InstantSchema,
});

export const ImportPlanResponseSchema = z.object({ plan: ImportPlanSchema });

/**
 * The passcode, on its way in, once.
 *
 * A discriminated union rather than an optional string so "this share has no
 * passcode" and "reuse the one the server still holds" are statements a caller
 * makes on purpose, not the accidental meaning of a missing field.
 *
 * `INLINE` is the only member that carries plaintext, it appears only in request
 * bodies, and no response schema references this union at all. The server is
 * expected to consume it through a dedicated secret ingress and persist a
 * reference; a client must additionally drop its own copy the moment the request
 * settles, because a value kept in a mutation cache is a value that survives the
 * request that needed it.
 */
export const SharePasscodeSchema = z.string().min(1).max(64);

export const ImportShareCredentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('NONE') }),
  z.object({ kind: z.literal('INLINE'), passcode: SharePasscodeSchema }),
  z.object({ kind: z.literal('REF'), secretRef: z.string().min(1).max(200) }),
]);

/**
 * Ask for a plan.
 *
 * `shareUrl` must already have had any `pwd` query parameter removed — the
 * passcode belongs in `credential`, not in a URL that ends up in a request log.
 * The server is expected to strip it again: a browser is not a security
 * boundary, and this field is validated on both sides for that reason.
 */
export const ImportPlanRequestSchema = z
  .object({
    archive: ArchivePlanRequestSchema.optional(),
    grouped: z.boolean().optional(),
    sourceKind: ImportSourceKindSchema,
    /** Omit to use the independently configured default source connection. */
    sourceConnectionId: z.string().uuid().optional(),
    shareUrl: z.string().url().max(2048).optional(),
    sourcePath: z.string().min(1).max(4096).optional(),
    /** Absent remains the legacy directory request; FILE never implies its parent. */
    sourceScope: z.enum(['DIRECTORY', 'FILE']).optional(),
    expectedFile: ImportFileIdentitySchema.optional(),
    /** Optional selection identity fence; never a multi-root manifest or an echoed proof. */
    expectedSourceRootFsid: z
      .string()
      .regex(/^(?:0|[1-9][0-9]{0,39})$/)
      .optional(),
    credential: ImportShareCredentialSchema,
    /** Omit to use the independently configured default destination account. */
    destinationId: z.string().min(1).max(64).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.grouped === true &&
      (value.sourceKind !== 'BAIDU_APP_DIR' ||
        value.sourceScope === 'FILE' ||
        value.archive === undefined)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['grouped'],
        message: 'Grouped video processing requires a directory archive plan',
      });
    if (value.sourceScope === 'FILE') {
      if (
        value.sourceKind !== 'BAIDU_APP_DIR' ||
        value.sourcePath === undefined ||
        value.expectedFile === undefined ||
        value.expectedSourceRootFsid !== undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceScope'],
          message: 'FILE requires an exact account file identity and path, not a directory root',
        });
      }
    } else if (
      value.expectedFile !== undefined ||
      (value.sourceScope !== undefined && value.sourceKind !== 'BAIDU_APP_DIR')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedFile'],
        message: 'File identity applies only to explicit FILE scope',
      });
    }
    if (value.expectedSourceRootFsid !== undefined && value.sourceKind !== 'BAIDU_APP_DIR') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedSourceRootFsid'],
        message: 'Directory root identity is only applicable to BAIDU_APP_DIR',
      });
    }
  });

/**
 * Where a published import should appear.
 *
 * `logicalPath` is the stable path a viewer sees whether the bytes are cached or
 * streamed; `libraryId` must come from the server allowlist. There is no field
 * for a farm path or a host directory, by design.
 */
export const ImportPublicationRequestSchema = z.object({
  mediaType: ImportMediaTypeSchema,
  libraryId: z.string().min(1).max(64),
  logicalPath: z.string().min(1).max(4096),
});

/**
 * Create the job.
 *
 * The publication block is required exactly when the policy asks for one, and
 * refused otherwise — a stale block left behind after switching back to
 * archive-only is how a job gets published that nobody asked to publish.
 */
export const CreateImportRequestSchema = z
  .object({
    /** Client acknowledgement of the returned, immutable processing proof. */
    processingMode: z.enum(['DIRECT', 'RECURSIVE_VIDEO', 'GROUPED_VIDEO']).optional(),
    planId: z.string().uuid(),
    /** Omit to keep the destination frozen by the plan. */
    destinationId: z.string().min(1).max(64).optional(),
    /** Omit to keep the publication policy frozen by the plan. */
    publicationPolicy: PublicationPolicySchema.optional(),
    publication: ImportPublicationRequestSchema.optional(),
    /** Frozen task policy. KEEP is the server default when omitted. */
    sourceCleanupPolicy: ImportSourceCleanupPolicySchema.optional(),
    /** Optional policy gate: require a successful publication before cleanup. */
    sourceCleanupRequiresPublication: z.boolean().optional(),
    credential: ImportShareCredentialSchema,
    /** Retrying a submission must not create a second job for the same plan. */
    idempotencyKey: z.string().min(8).max(200),
  })
  .superRefine((value, ctx) => {
    if (value.publicationPolicy === 'PUBLISH_TO_JELLYFIN' && value.publication === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publication'],
        message: 'publication is required when publicationPolicy is PUBLISH_TO_JELLYFIN',
      });
    }
    if (value.publicationPolicy === 'ARCHIVE_ONLY' && value.publication !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publication'],
        message: 'publication must be omitted when publicationPolicy is ARCHIVE_ONLY',
      });
    }
    if (value.sourceCleanupPolicy === 'KEEP' && value.sourceCleanupRequiresPublication === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceCleanupRequiresPublication'],
        message: 'publication cannot gate a KEEP cleanup policy',
      });
    }
  });

/** Which destination a job is writing to, enough to name it in a table. */
export const ImportDestinationRefSchema = ImportDestinationSchema.pick({
  destinationId: true,
  displayName: true,
  kind: true,
});

/** Stable publication failures the UI can turn into an operator action. */
export const ImportPublicationErrorSchema = z.enum([
  'ARCHIVE_NOT_VERIFIED',
  'DESTINATION_UNMOUNTABLE',
  'JELLYFIN_UNREACHABLE',
  'JELLYFIN_AUTH_FAILED',
  'NOTIFICATION_REJECTED',
  'LIBRARY_NOT_ALLOWLISTED',
  'MEDIA_TYPE_MISMATCH',
  'PUBLICATION_PATH_CONFLICT',
  'FARM_LINK_FAILED',
  'VFS_REFRESH_FAILED',
  'READ_PROBE_FAILED',
]);

/**
 * The publication half, reported separately from the import that fed it.
 *
 * `readProbe` is its own field rather than folded into `state` because the two
 * fail independently and mean different things: the link can be readable through
 * the mount while Jellyfin still refuses the refresh call, which looks healthy
 * and quietly leaves the title invisible until someone scans by hand.
 */
export const ImportPublicationSchema = z.object({
  publicationId: z.string().uuid(),
  state: PublicationStateSchema,
  /** Monotonic publication attempt/reconciliation revision, independent of the import job. */
  revision: z.number().int().nonnegative(),
  /** Number of verified manifest objects represented by the projection. */
  objectCount: z.number().int().nonnegative(),
  mediaType: ImportMediaTypeSchema,
  libraryId: z.string().min(1).max(64),
  libraryDisplayName: z.string().min(1).max(120),
  containerPath: z.string().min(1).max(4096),
  logicalPath: z.string().min(1).max(4096),
  /** Which storage account's mount backs the link. Null before one is chosen. */
  mountAccountLabel: z.string().min(1).max(120).nullable(),
  readProbe: z.enum(['PASSED', 'FAILED', 'NOT_RUN']),
  /** Null while the call has not been attempted; the state says which. */
  jellyfinNotified: z.boolean().nullable(),
  error: ImportPublicationErrorSchema.nullable(),
  updatedAt: InstantSchema,
});

/**
 * One verification receipt, reduced to what a screen should show.
 *
 * `digestPreview` is a prefix/suffix of the SHA-256, not the digest: the full
 * value belongs in the manifest, and an operator comparing two receipts by eye
 * compares the ends anyway.
 */
export const ImportReceiptSchema = z.object({
  at: InstantSchema,
  objectCount: z.number().int().nonnegative(),
  bytes: DecimalBytesSchema,
  digestPreview: z.string().min(1).max(80).nullable(),
});

/**
 * The three receipts that together mean "this is really there".
 *
 * Each is independently nullable because they are reached in order and a job in
 * flight legitimately has one, two, or none of them.
 */
export const ImportReceiptsSchema = z.object({
  staging: ImportReceiptSchema.nullable(),
  committed: ImportReceiptSchema.nullable(),
  verify: ImportReceiptSchema.nullable(),
});

/**
 * A timeline entry, already redacted at the source.
 *
 * `code` is a stable identifier and `detail` is an optional sanitized phrase.
 * Neither may carry a passcode, a token, a dlink, or a raw provider response —
 * the timeline is the surface most likely to be screenshotted into a chat.
 */
export const ImportEventSchema = z.object({
  id: z.string().min(1).max(120),
  at: InstantSchema,
  code: z.string().min(1).max(80),
  step: ImportStepSchema.nullable(),
  detail: z.string().max(300).nullable(),
  downloadDiagnostic: DownloadFailureDiagnosticSchema.optional(),
});

/** A job as the list needs it: identity, routing, and the live snapshot. */
export const ImportJobSummarySchema = z.object({
  archive: ArchiveJobStatusSchema.optional(),
  jobId: z.string().uuid(),
  sourceKind: ImportSourceKindSchema,
  sourceConnectionId: z.string().uuid().nullable().optional(),
  sourceAlias: z.string().min(1).max(300),
  sourceRequiresPasscode: z.boolean(),
  /** Frozen at job creation; omitted only by older API versions. */
  sourceCleanupPolicy: ImportSourceCleanupPolicySchema.optional(),
  sourceCleanupRequiresPublication: z.boolean().optional(),
  destination: ImportDestinationRefSchema,
  createdAt: InstantSchema,
  progress: ImportProgressSnapshotSchema,
  publication: ImportPublicationSchema.nullable(),
  /** Active account-level provider throttle, absent when this job is unaffected. */
  sourceRateLimit: ImportSourceRateLimitSchema.optional(),
  /** Server authority for list-row controls; clients must never infer this from state. */
  availableActions: z.array(ImportActionSchema).max(16),
});

export const ImportsResponseSchema = z.object({
  jobs: z.array(ImportJobSummarySchema).max(500),
});

/**
 * Everything the detail panel renders.
 *
 * `availableActions` is the server's list, and it is the only thing the UI may
 * enable a button from. Deriving actionability from `state` in the browser is
 * how a page ends up offering "pause" to a worker that has already claimed the
 * job — the guess and the truth diverge under exactly the conditions that make
 * someone reach for the button.
 */
export const ImportDetailSchema = ImportJobSummarySchema.extend({
  receipts: ImportReceiptsSchema,
  events: z.array(ImportEventSchema).max(500),
});

export const ImportDetailResponseSchema = z.object({ job: ImportDetailSchema });

export const LegacyImportSourceBindingSchema = z
  .object({
    jobId: z.string().uuid(),
    planId: z.string().uuid(),
    state: z.enum(['NOT_REQUIRED', 'IDENTITY_REQUIRED', 'REPLAN_REQUIRED', 'VERIFIED']),
    sourceConnectionId: z.string().uuid().nullable(),
    replanRequired: z.boolean(),
    nextStep: z.enum([
      'NONE',
      'SELECT_ENV_CONNECTION',
      'REPLAN_PRESERVE_ARCHIVE',
      'RETRY_OR_RESUME',
    ]),
  })
  .strict();
export const LegacyImportSourceBindRequestSchema = z
  .object({
    sourceConnectionId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    confirmSameSourceIdentity: z.literal(true),
    stepUpCode: z.string().regex(/^\d{6}$/),
  })
  .strict();
export type LegacyImportSourceBinding = z.infer<typeof LegacyImportSourceBindingSchema>;
export const CreateImportResponseSchema = z.object({ job: ImportJobSummarySchema });

/** Hand the worker a fresh passcode for a job parked on `AUTH_REQUIRED`. */
export const ImportCredentialsRequestSchema = z.object({
  credential: ImportShareCredentialSchema,
});

export const MediaPublicationRequestSchema = z.object({
  jobId: z.string().uuid(),
  publication: ImportPublicationRequestSchema,
});

export const MediaPublicationResponseSchema = z.object({
  publication: ImportPublicationSchema,
});

/**
 * Removing a publication removes a projection, never bytes.
 *
 * The literal is the contract: unpublishing drops the catalog row, the farm link
 * and the Jellyfin entry. Deleting a cloud object is a different operation with
 * its own MFA gate, and no response on this page may imply it happened.
 */
export const MediaUnpublishResponseSchema = z.object({
  publicationId: z.string().uuid(),
  state: z.literal('UNPUBLISHED'),
  cloudObjectsDeleted: z.literal(false),
});

export const ImportSourceCleanupGateNameSchema = z.enum([
  'GLOBAL_FEATURE_ENABLED',
  'TASK_POLICY_MATCH',
  'SOURCE_SCOPE_MATCH',
  'SHARE_OWNER_BOUNDARY',
  'MODE_FEATURE_ENABLED',
  'MANIFEST_FROZEN',
  'COMMITTED_VERIFIED',
  'HASH_CHAIN_MATCH',
  'RECOVERY_GENERATION_VERIFIED',
  'SOURCE_UNCHANGED',
  'NO_ACTIVE_REFERENCES',
  'SAME_ACCOUNT_DELETE_CAPABLE',
  'GRACE_PERIOD_ELAPSED',
  'PUBLICATION_READY',
]);

export const ImportSourceCleanupGateSchema = z.object({
  gate: ImportSourceCleanupGateNameSchema,
  passed: z.boolean(),
  /** Stable sanitized reason; never a provider message or path. */
  reason: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{2,79}$/)
    .nullable(),
});

export const ImportSourceCleanupPreviewRequestSchema = z.object({
  policy: ImportSourceCleanupPolicySchema.exclude(['KEEP']),
  expectedJobRevision: z.number().int().nonnegative(),
});

export const ImportSourceCleanupPreviewSchema = z.object({
  previewId: z.string().uuid(),
  previewRevision: z.number().int().positive(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  jobId: z.string().uuid(),
  jobRevision: z.number().int().nonnegative(),
  policy: ImportSourceCleanupPolicySchema.exclude(['KEEP']),
  objectCount: z.number().int().nonnegative(),
  totalBytes: DecimalBytesSchema,
  sourceAccountMasked: z.string().min(1).max(256),
  exactSourceRoot: z.string().min(1).max(4096),
  providerSemantics: z.literal('RECYCLE_BIN'),
  gates: z.array(ImportSourceCleanupGateSchema).max(32),
  eligible: z.boolean(),
  expiresAt: InstantSchema,
});

export const ImportSourceCleanupPreviewResponseSchema = z.object({
  preview: ImportSourceCleanupPreviewSchema,
});

export const ImportSourceCleanupExecuteRequestSchema = z.object({
  previewId: z.string().uuid(),
  previewRevision: z.number().int().positive(),
  previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  expectedJobRevision: z.number().int().nonnegative(),
  /** Fresh single-use proof, consumed by the route before execution. */
  mfaCode: z.string().regex(/^[0-9]{6}$/),
});

export const ImportSourceCleanupStatusSchema = z.enum([
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'FOLLOW_UP_REQUIRED',
  'FAILED_SAFE',
]);

export const ImportSourceCleanupObjectStatusSchema = z.object({
  objectId: z.string().min(1).max(128),
  status: z.enum([
    'PENDING',
    'PREFLIGHT_VERIFIED',
    'PROVIDER_REQUESTED',
    'COMPLETED',
    'FOLLOW_UP_REQUIRED',
  ]),
  providerRequestId: z.string().min(1).max(256).nullable(),
  providerSemantics: z.literal('RECYCLE_BIN').nullable(),
  /** An enumerated failure, including SOURCE_CLEANUP_OUTCOME_UNKNOWN. */
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{2,79}$/)
    .nullable()
    .optional(),
  followUpRequired: z.boolean(),
  updatedAt: InstantSchema,
});

export const ImportSourceCleanupSchema = z.object({
  cleanupId: z.string().uuid(),
  jobId: z.string().uuid(),
  policy: ImportSourceCleanupPolicySchema.exclude(['KEEP']),
  status: ImportSourceCleanupStatusSchema,
  /** Actual confirmed outcome; null while no object has a provider receipt. */
  providerSemantics: z.literal('RECYCLE_BIN').nullable(),
  objectCount: z.number().int().nonnegative(),
  completedObjectCount: z.number().int().nonnegative(),
  failedObjectCount: z.number().int().nonnegative(),
  totalBytes: DecimalBytesSchema,
  completedBytes: DecimalBytesSchema,
  sourceAccountMasked: z.string().min(1).max(256),
  exactSourceRoot: z.string().min(1).max(4096),
  followUpRequired: z.boolean(),
  /** Recycle-bin placement is not a claim of physical erasure. */
  physicalErasureClaimed: z.literal(false),
  objects: z.array(ImportSourceCleanupObjectStatusSchema).max(10_000),
  updatedAt: InstantSchema,
});

export const ImportSourceCleanupResponseSchema = z.object({
  cleanup: ImportSourceCleanupSchema,
});

export type DecimalBytes = z.infer<typeof DecimalBytesSchema>;
export type ImportJobState = z.infer<typeof ImportJobStateSchema>;
export type ImportCurrentCondition = z.infer<typeof ImportCurrentConditionSchema>;
export type ImportStep = z.infer<typeof ImportStepSchema>;
export type PublicationPolicy = z.infer<typeof PublicationPolicySchema>;
export type ImportSourceCleanupPolicy = z.infer<typeof ImportSourceCleanupPolicySchema>;
export type PublicationState = z.infer<typeof PublicationStateSchema>;
export type ImportSourceKind = z.infer<typeof ImportSourceKindSchema>;
export type ImportMediaType = z.infer<typeof ImportMediaTypeSchema>;
export type ImportProgressSnapshot = z.infer<typeof ImportProgressSnapshotSchema>;
export type ImportSourceRateLimit = z.infer<typeof ImportSourceRateLimitSchema>;
export type ImportDestinationUnavailableReason = z.infer<
  typeof ImportDestinationUnavailableReasonSchema
>;
export type ImportDestination = z.infer<typeof ImportDestinationSchema>;
export type ImportDestinationRef = z.infer<typeof ImportDestinationRefSchema>;
export type JellyfinImportLibrary = z.infer<typeof JellyfinImportLibrarySchema>;
export type ImportAction = z.infer<typeof ImportActionSchema>;
export type ImportPublishDisabledReason = z.infer<typeof ImportPublishDisabledReasonSchema>;
export type ImportSourceCapability = z.infer<typeof ImportSourceCapabilitySchema>;
export type ImportCapabilities = z.infer<typeof ImportCapabilitiesSchema>;
export type ImportDestinationsResponse = z.infer<typeof ImportDestinationsResponseSchema>;
export type ImportPlanConflict = z.infer<typeof ImportPlanConflictSchema>;
export type ImportPlanLimitIssue = z.infer<typeof ImportPlanLimitIssueSchema>;
export type ImportSourceAuthState = z.infer<typeof ImportSourceAuthStateSchema>;
export type ImportPlan = z.infer<typeof ImportPlanSchema>;
export type ImportPlanRequest = z.infer<typeof ImportPlanRequestSchema>;
export type ImportShareCredential = z.infer<typeof ImportShareCredentialSchema>;
export type ImportPublicationRequest = z.infer<typeof ImportPublicationRequestSchema>;
export type CreateImportRequest = z.infer<typeof CreateImportRequestSchema>;
export type ImportPublicationError = z.infer<typeof ImportPublicationErrorSchema>;
export type ImportPublication = z.infer<typeof ImportPublicationSchema>;
export type ImportReceipt = z.infer<typeof ImportReceiptSchema>;
export type ImportReceipts = z.infer<typeof ImportReceiptsSchema>;
export type ImportEvent = z.infer<typeof ImportEventSchema>;
export type ImportJobSummary = z.infer<typeof ImportJobSummarySchema>;
export type ImportDetail = z.infer<typeof ImportDetailSchema>;
export type ImportCredentialsRequest = z.infer<typeof ImportCredentialsRequestSchema>;
export type MediaPublicationRequest = z.infer<typeof MediaPublicationRequestSchema>;
export type ImportSourceCleanupGateName = z.infer<typeof ImportSourceCleanupGateNameSchema>;
export type ImportSourceCleanupGate = z.infer<typeof ImportSourceCleanupGateSchema>;
export type ImportSourceCleanupPreviewRequest = z.infer<
  typeof ImportSourceCleanupPreviewRequestSchema
>;
export type ImportSourceCleanupPreview = z.infer<typeof ImportSourceCleanupPreviewSchema>;
export type ImportSourceCleanupPreviewResponse = z.infer<
  typeof ImportSourceCleanupPreviewResponseSchema
>;
export type ImportSourceCleanupExecuteRequest = z.infer<
  typeof ImportSourceCleanupExecuteRequestSchema
>;
export type ImportSourceCleanup = z.infer<typeof ImportSourceCleanupSchema>;
