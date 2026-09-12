import { createHash, randomUUID } from 'node:crypto';
import type { CreateImportRequest } from '@ptvault/contracts';
import { DatabaseImportSourceConnectionCatalog } from './source-connections.js';
import { isManagedBaiduMutationPath } from './baidu-paths.js';
import { ArchiveRepository } from './archive/repository.js';
import { SOURCE_NETWORK_RETRY_CODES } from './data-plane/network-retry.js';
import { readDownloadDiagnostic } from './data-plane/download-diagnostics.js';
import { pipelinePlanOptions } from './groups/repository.js';
import { isArchiveSourceManifest } from './source-manifest.js';

import type { Clock } from '../core/clock.js';
import type { AppDatabase } from '../db/database.js';
import { ImportControlError, importInvariant } from './errors.js';
import { ImportPublicationActionAuthority } from './publication-actions.js';
import type {
  CloudConnectionRateLimitCode,
  ImportAction,
  ImportCondition,
  ImportDestination,
  ImportDetail,
  ImportEvent,
  ImportJobState,
  ImportJobSummary,
  ImportPlan,
  ImportPlanConflict,
  ImportPlanLimitIssue,
  ImportProgressSnapshot,
  ImportPublication,
  ImportPublicationRequest,
  ImportReceipt,
  ImportSourceCleanupPolicy,
  ImportSourceKind,
  ImportStep,
  JellyfinImportLibrary,
  PublicationPolicy,
} from './model.js';
import { decimalString, sanitizedDetail, sanitizedJson } from './security.js';
import {
  canonicalSourceManifest,
  readSourceManifest,
  sourceManifestDigest,
  type ImportSourceManifest,
} from './source-manifest.js';

export type StoredImportPlan = Omit<ImportPlan, 'credentialRef'> & {
  sourceConnectionId: string | null;
  sourceProvider: 'BAIDU' | null;
  sourceExternalAccountId: string | null;
  sourceManifestRevision: number | null;
  sourceManifest: ImportSourceManifest | null;
  sourceManifestDigest: string | null;
  selection: unknown;
  secretRef: string | null;
  destination: ImportDestination;
  createdAt: number;
};

export type CreatePlanInput = Omit<
  StoredImportPlan,
  | 'planId'
  | 'transferStarted'
  | 'expiresAt'
  | 'createdAt'
  | 'sourceConnectionId'
  | 'sourceProvider'
  | 'sourceExternalAccountId'
  | 'sourceManifestRevision'
  | 'sourceManifest'
  | 'sourceManifestDigest'
> & {
  expiresAt: number;
  sourceConnectionId?: string | null;
  sourceProvider?: 'BAIDU' | null;
  sourceExternalAccountId?: string | null;
  sourceManifestRevision?: number | null;
  sourceManifest?: ImportSourceManifest | null;
};

export type CreateJobInput = {
  plan: StoredImportPlan;
  destination: ImportDestination;
  secretRef: string | null;
  publicationPolicy: PublicationPolicy;
  publication?:
    | {
        request: ImportPublicationRequest;
        library: JellyfinImportLibrary;
      }
    | undefined;
  sourceCleanupPolicy?: ImportSourceCleanupPolicy;
  sourceCleanupRequiresPublication?: boolean;
  idempotencyKey: string;
};

// FILE jobs have no historic production rows. Their fingerprint binds request semantics,
// not mutable destination availability or a live Jellyfin library configuration snapshot.
function fileCreateFingerprint(
  plan: StoredImportPlan,
  request: Omit<CreateImportRequest, 'credential' | 'idempotencyKey'>,
): string {
  const publication = request.publication;
  return createHash('sha256')
    .update(
      sanitizedJson(
        {
          version: plan.sourceManifest?.version === 3 ? 3 : 2,
          ...(plan.sourceManifest?.version === 3
            ? { processingMode: request.processingMode ?? 'DIRECT' }
            : {}),
          planId: request.planId,
          destinationId: request.destinationId ?? plan.destinationId,
          publicationPolicy: request.publicationPolicy ?? plan.plannedPolicy,
          publication:
            publication === undefined
              ? null
              : {
                  libraryId: publication.libraryId,
                  mediaType: publication.mediaType,
                  logicalPath: publication.logicalPath,
                },
          sourceCleanupPolicy: request.sourceCleanupPolicy ?? 'KEEP',
          sourceCleanupRequiresPublication: request.sourceCleanupRequiresPublication ?? false,
        },
        'createRequest',
      ),
    )
    .digest('hex');
}

type PlanRow = {
  sourceManifestJson: string | null;
  sourceManifestDigest: string | null;
  id: string;
  sourceKind: ImportSourceKind;
  sourceConnectionId: string | null;
  sourceProvider: 'BAIDU' | null;
  sourceExternalAccountId: string | null;
  sourceManifestRevision: number | null;
  sourceAlias: string;
  sourceRequiresPasscode: number;
  sourceAuthState: ImportPlan['sourceAuthState'];
  selectionJson: string;
  secretRef: string | null;
  destinationId: string;
  destinationDisplayName: string;
  destinationKind: ImportDestination['kind'];
  objectCount: number;
  totalBytes: string;
  largestObjectBytes: string;
  requiredSpoolBytes: string;
  pathConflictsJson: string;
  limitIssuesJson: string;
  plannedPolicy: PublicationPolicy;
  mode: ImportPlan['mode'];
  expiresAt: number;
  createdAt: number;
};

type JobRow = {
  id: string;
  sourceKind: ImportSourceKind;
  sourceConnectionId: string | null;
  sourceAlias: string;
  sourceRequiresPasscode: number;
  destinationId: string;
  destinationDisplayName: string;
  destinationKind: ImportDestination['kind'];
  publicationPolicy: PublicationPolicy;
  sourceCleanupPolicy: ImportSourceCleanupPolicy;
  sourceCleanupRequiresPublication: number;
  state: ImportJobState;
  currentStep: ImportStep;
  currentCondition: ImportCondition | null;
  paused: number;
  pauseRequestedAt: number | null;
  cancelRequestedAt: number | null;
  revision: number;
  requestFingerprint: string;
  objectIndex: number;
  objectCount: number;
  currentObjectAlias: string | null;
  objectBytesDone: string;
  objectBytesTotal: string;
  jobBytesVerified: string;
  jobBytesTotal: string;
  downloadRateBps: string | null;
  uploadRateBps: string | null;
  verifyRateBps: string | null;
  etaSeconds: number | null;
  retryAt: number | null;
  resourceWaitKind: 'MAX_IN_FLIGHT' | 'LOCAL_PREPARATION' | 'UPLOAD' | 'SPOOL_CAPACITY' | null;
  resourceQueuePosition: number | null;
  resourceWaitSince: number | null;
  resourceWaitActive: number | null;
  resourceWaitCapacity: number | null;
  ratesSampledAt: number | null;
  sourceRateLimitConnectionId: string | null;
  sourceRateLimitedUntil: number | null;
  sourceRateLimitCode: CloudConnectionRateLimitCode | null;
  sourceRateLimitUpdatedAt: number | null;
  sourceRateLimitAffectedJobs: number;
  lastCheckpointAt: number;
  createdAt: number;
};

type PublicationRow = {
  id: string;
  state: ImportPublication['state'];
  revision: number;
  objectCount: number;
  mediaType: ImportPublication['mediaType'];
  libraryId: string;
  libraryDisplayName: string;
  containerPath: string;
  logicalPath: string;
  mountAccountLabel: string | null;
  readProbe: ImportPublication['readProbe'];
  jellyfinNotified: number | null;
  lastError: ImportPublication['error'];
  updatedAt: number;
};

type EventRow = {
  id: string;
  createdAt: number;
  code: string;
  step: ImportStep | null;
  detail: string | null;
  downloadDiagnosticJson: string | null;
};

type ReceiptRow = {
  kind: string;
  createdAt: number;
  size: string | null;
  sha256: string | null;
  objectId: string | null;
};

const JOB_BASE_SELECT = `
  SELECT id, source_kind AS sourceKind, source_alias AS sourceAlias,
         source_connection_id AS sourceConnectionId,
         source_requires_passcode AS sourceRequiresPasscode,
         destination_id AS destinationId,
         destination_display_name AS destinationDisplayName,
         destination_kind AS destinationKind,
         publication_policy AS publicationPolicy,
         source_cleanup_policy AS sourceCleanupPolicy,
         source_cleanup_requires_publication AS sourceCleanupRequiresPublication,
         state,
         current_step AS currentStep, current_condition AS currentCondition,
         paused, pause_requested_at AS pauseRequestedAt,
         cancel_requested_at AS cancelRequestedAt, revision,
         idempotency_key AS idempotencyKey,
         request_fingerprint AS requestFingerprint,
         object_index AS objectIndex, object_count AS objectCount,
         current_object_alias AS currentObjectAlias,
         object_bytes_done AS objectBytesDone,
         object_bytes_total AS objectBytesTotal,
         job_bytes_verified AS jobBytesVerified,
         job_bytes_total AS jobBytesTotal,
         download_rate_bps AS downloadRateBps,
         upload_rate_bps AS uploadRateBps,
         verify_rate_bps AS verifyRateBps,
         eta_seconds AS etaSeconds, rates_sampled_at AS ratesSampledAt,
         retry_at AS retryAt,
         resource_wait_kind AS resourceWaitKind,
         resource_queue_position AS resourceQueuePosition,
         resource_wait_since AS resourceWaitSince,
         resource_wait_active AS resourceWaitActive,
         resource_wait_capacity AS resourceWaitCapacity,
         last_checkpoint_at AS lastCheckpointAt, created_at AS createdAt
  FROM import_jobs`;

const JOB_SELECT = `
  SELECT job.*,
         COALESCE(job.sourceConnectionId, legacy.connection_id) AS sourceRateLimitConnectionId,
         runtime.rate_limited_until AS sourceRateLimitedUntil,
         runtime.rate_limit_code AS sourceRateLimitCode,
         runtime.rate_limit_updated_at AS sourceRateLimitUpdatedAt,
         COALESCE((
           SELECT COUNT(*)
           FROM import_jobs AS affected
           LEFT JOIN legacy_import_source_bindings AS affected_legacy
             ON affected_legacy.job_id = affected.id
           WHERE COALESCE(affected.source_connection_id, affected_legacy.connection_id) =
                 COALESCE(job.sourceConnectionId, legacy.connection_id)
             AND affected.state IN ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'BLOCKED', 'FAILED_SAFE')
         ), 0) AS sourceRateLimitAffectedJobs
  FROM (${JOB_BASE_SELECT}) AS job
  LEFT JOIN legacy_import_source_bindings AS legacy ON legacy.job_id = job.id
  LEFT JOIN cloud_connection_runtime AS runtime
    ON runtime.connection_id = COALESCE(job.sourceConnectionId, legacy.connection_id)`;

type SummaryOptions = {
  /** Only interactive detail needs the linear proof projection, never worker/create polling. */
  includeRetryImpact?: boolean;
  publicationActionsEnabled?: boolean;
  publicationLibraryIds?: readonly string[];
};

const ACTIVE_IMPORT_STATES: ReadonlySet<ImportJobState> = new Set([
  'QUEUED',
  'RUNNING',
  'RETRY_WAIT',
  'BLOCKED',
  'FAILED_SAFE',
]);

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function digestPreview(digest: string | null): string | null {
  return digest === null ? null : `${digest.slice(0, 8)}…${digest.slice(-8)}`;
}

function normalizeSourceBinding(input: CreatePlanInput): {
  sourceConnectionId: string | null;
  sourceProvider: 'BAIDU' | null;
  sourceExternalAccountId: string | null;
  sourceManifestRevision: number | null;
} {
  const binding = {
    sourceConnectionId: input.sourceConnectionId ?? null,
    sourceProvider: input.sourceProvider ?? null,
    sourceExternalAccountId: input.sourceExternalAccountId ?? null,
    sourceManifestRevision: input.sourceManifestRevision ?? null,
  };
  const values = Object.values(binding);
  const allNull = values.every((value) => value === null);
  const allPresent = values.every((value) => value !== null);
  importInvariant(allNull || allPresent, 'IMPORT_SOURCE_BINDING_INCOMPLETE', 409);
  if (!allPresent) return binding;
  importInvariant(
    /^[0-9a-f-]{36}$/i.test(binding.sourceConnectionId!) &&
      binding.sourceProvider === 'BAIDU' &&
      binding.sourceExternalAccountId!.length > 0 &&
      binding.sourceExternalAccountId!.length <= 256 &&
      Number.isSafeInteger(binding.sourceManifestRevision) &&
      binding.sourceManifestRevision! >= 0,
    'IMPORT_SOURCE_BINDING_INVALID',
    409,
  );
  return binding;
}

function destinationAccountId(destination: ImportDestination): string | null {
  const prefix =
    destination.kind === 'ONEDRIVE_RAW'
      ? 'onedrive-raw:'
      : destination.kind === 'STANDALONE_CRYPT'
        ? 'onedrive-crypt:'
        : null;
  if (prefix === null) return null;
  importInvariant(
    destination.destinationId.startsWith(prefix),
    'IMPORT_DESTINATION_ID_INVALID',
    409,
  );
  const accountId = destination.destinationId.slice(prefix.length);
  importInvariant(
    accountId.length > 0 && accountId.length <= 256,
    'IMPORT_DESTINATION_ID_INVALID',
    409,
  );
  return accountId;
}

export class ImportRepository {
  private readonly groupSchema: boolean;
  private readonly publicationActions: ImportPublicationActionAuthority;
  readonly archives: ArchiveRepository;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: Clock = () => new Date(),
  ) {
    this.publicationActions = new ImportPublicationActionAuthority(db, now);
    this.archives = new ArchiveRepository(db, () => now().getTime());
    this.groupSchema =
      Number(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() ?? 0) >= 42;
  }

  createPlan(input: CreatePlanInput): StoredImportPlan {
    const id = randomUUID();
    const createdAt = this.now().getTime();
    const selectionJson = sanitizedJson(input.selection, 'selection');
    const pathConflictsJson = sanitizedJson(input.pathConflicts, 'pathConflicts');
    const limitIssuesJson = sanitizedJson(input.destinationLimitIssues, 'destinationLimitIssues');
    decimalString(input.totalBytes, 'totalBytes');
    decimalString(input.largestObjectBytes, 'largestObjectBytes');
    decimalString(input.requiredSpoolBytes, 'requiredSpoolBytes');
    importInvariant(
      Number.isSafeInteger(input.objectCount) && input.objectCount >= 0,
      'IMPORT_PLAN_INVALID',
      500,
    );

    const sourceBinding = normalizeSourceBinding(input);
    const manifest =
      input.sourceManifest == null ? null : canonicalSourceManifest(input.sourceManifest);
    if (manifest !== null) {
      const selection = input.selection as { sourcePath?: string; sanitizedShareUrl?: string };
      importInvariant(
        manifest.sourceKind === input.sourceKind &&
          manifest.objects.length === input.objectCount &&
          manifest.objects.reduce((sum, object) => sum + BigInt(object.size), 0n).toString() ===
            input.totalBytes &&
          (manifest.sourceKind === 'BAIDU_APP_DIR'
            ? manifest.rootPath === selection.sourcePath
            : typeof selection.sanitizedShareUrl === 'string' &&
              manifest.sourceIdentity ===
                createHash('sha256').update(selection.sanitizedShareUrl).digest('hex')),
        'IMPORT_PLAN_MANIFEST_MISMATCH',
        409,
      );
    }
    this.db
      .prepare(
        `INSERT INTO import_plans(
           id, source_kind, source_alias, source_requires_passcode,
           source_auth_state, selection_json_sanitized, secret_ref,
           source_connection_id, source_provider, source_external_account_id,
           source_manifest_revision, source_manifest_json, source_manifest_digest,
           destination_id, destination_display_name, destination_kind,
           object_count, total_bytes, largest_object_bytes, required_spool_bytes,
           path_conflicts_json_sanitized, limit_issues_json_sanitized,
           planned_policy, mode, expires_at, created_at
         ) VALUES (
           @id, @sourceKind, @sourceAlias, @sourceRequiresPasscode,
            @sourceAuthState, @selectionJson, @secretRef,
            @sourceConnectionId, @sourceProvider, @sourceExternalAccountId,
            @sourceManifestRevision, @sourceManifestJson, @sourceManifestDigest,
           @destinationId, @destinationDisplayName, @destinationKind,
           @objectCount, @totalBytes, @largestObjectBytes, @requiredSpoolBytes,
           @pathConflictsJson, @limitIssuesJson, @plannedPolicy, @mode,
           @expiresAt, @createdAt
         )`,
      )
      .run({
        id,
        sourceKind: input.sourceKind,
        ...sourceBinding,
        sourceManifestJson: manifest === null ? null : JSON.stringify(manifest),
        sourceManifestDigest: manifest === null ? null : sourceManifestDigest(manifest),
        sourceAlias: input.sourceAlias,
        sourceRequiresPasscode: input.sourceRequiresPasscode ? 1 : 0,
        sourceAuthState: input.sourceAuthState,
        selectionJson,
        secretRef: input.secretRef,
        destinationId: input.destination.destinationId,
        destinationDisplayName: input.destination.displayName,
        destinationKind: input.destination.kind,
        objectCount: input.objectCount,
        totalBytes: input.totalBytes,
        largestObjectBytes: input.largestObjectBytes,
        requiredSpoolBytes: input.requiredSpoolBytes,
        pathConflictsJson,
        limitIssuesJson,
        plannedPolicy: input.plannedPolicy,
        mode: input.mode,
        expiresAt: input.expiresAt,
        createdAt,
      });
    return this.requirePlan(id);
  }

  requirePlan(id: string): StoredImportPlan {
    const row = this.db
      .prepare(
        `SELECT id, source_kind AS sourceKind, source_alias AS sourceAlias,
                source_connection_id AS sourceConnectionId,
                source_provider AS sourceProvider,
                source_external_account_id AS sourceExternalAccountId,
                source_manifest_revision AS sourceManifestRevision,
                source_manifest_json AS sourceManifestJson,
                source_manifest_digest AS sourceManifestDigest,
                source_requires_passcode AS sourceRequiresPasscode,
                source_auth_state AS sourceAuthState,
                selection_json_sanitized AS selectionJson, secret_ref AS secretRef,
                destination_id AS destinationId,
                destination_display_name AS destinationDisplayName,
                destination_kind AS destinationKind, object_count AS objectCount,
                total_bytes AS totalBytes, largest_object_bytes AS largestObjectBytes,
                required_spool_bytes AS requiredSpoolBytes,
                path_conflicts_json_sanitized AS pathConflictsJson,
                limit_issues_json_sanitized AS limitIssuesJson,
                planned_policy AS plannedPolicy, mode, expires_at AS expiresAt,
                created_at AS createdAt
         FROM import_plans WHERE id = ?`,
      )
      .get(id) as PlanRow | undefined;
    if (!row) throw new ImportControlError('IMPORT_PLAN_NOT_FOUND', 404);
    return this.mapPlan(row);
  }

  isFileJob(jobId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT plan_id AS planId, selection_json_sanitized AS selectionJson FROM import_jobs WHERE id = ?',
      )
      .get(jobId) as { planId: string; selectionJson: string } | undefined;
    importInvariant(row !== undefined, 'IMPORT_NOT_FOUND', 404);
    const selection: unknown = JSON.parse(row.selectionJson);
    return (
      this.requirePlan(row.planId).sourceManifest?.version === 2 ||
      (typeof selection === 'object' &&
        selection !== null &&
        'sourceScope' in selection &&
        selection.sourceScope === 'FILE')
    );
  }

  publicationJobId(publicationId: string): string {
    const row = this.db
      .prepare('SELECT job_id AS jobId FROM media_publications WHERE id = ?')
      .get(publicationId) as { jobId: string } | undefined;
    importInvariant(row !== undefined, 'IMPORT_PUBLICATION_NOT_FOUND', 404);
    return row.jobId;
  }

  replayFileCreate(request: CreateImportRequest, plan: StoredImportPlan): ImportJobSummary | null {
    importInvariant(
      plan.sourceManifest?.version === 3 || request.processingMode !== 'RECURSIVE_VIDEO',
      'ARCHIVE_PROCESSING_ACK_REQUIRED',
      409,
    );
    importInvariant(
      plan.sourceManifest?.version === 2 || plan.sourceManifest?.version === 3,
      'IMPORT_SOURCE_MANIFEST_REQUIRED',
      409,
    );
    const existing = this.db
      .prepare(`${JOB_SELECT} WHERE job.idempotencyKey = ?`)
      .get(request.idempotencyKey) as JobRow | undefined;
    if (existing === undefined) return null;
    importInvariant(
      existing.requestFingerprint === fileCreateFingerprint(plan, request),
      'IMPORT_IDEMPOTENCY_CONFLICT',
      409,
    );
    return this.mapSummary(existing);
  }

  createJob(input: CreateJobInput): ImportJobSummary {
    importInvariant(
      pipelinePlanOptions(input.plan) === null,
      'GROUP_PARENT_REQUIRES_PIPELINE',
      409,
    );
    const requestFingerprint =
      input.plan.sourceManifest?.version === 2 || input.plan.sourceManifest?.version === 3
        ? fileCreateFingerprint(input.plan, {
            ...(input.plan.sourceManifest?.version === 3
              ? { processingMode: 'RECURSIVE_VIDEO' as const }
              : {}),
            planId: input.plan.planId,
            destinationId: input.destination.destinationId,
            publicationPolicy: input.publicationPolicy,
            ...(input.publication === undefined ? {} : { publication: input.publication.request }),
            ...(input.sourceCleanupPolicy === undefined
              ? {}
              : { sourceCleanupPolicy: input.sourceCleanupPolicy }),
            ...(input.sourceCleanupRequiresPublication === undefined
              ? {}
              : { sourceCleanupRequiresPublication: input.sourceCleanupRequiresPublication }),
          })
        : createHash('sha256')
            .update(
              sanitizedJson(
                {
                  planId: input.plan.planId,
                  destinationId: input.destination.destinationId,
                  publicationPolicy: input.publicationPolicy,
                  publication: input.publication ?? null,
                  sourceCleanupPolicy: input.sourceCleanupPolicy ?? 'KEEP',
                  sourceCleanupRequiresPublication: input.sourceCleanupRequiresPublication ?? false,
                },
                'createRequest',
              ),
            )
            .digest('hex');
    const existing = this.db
      .prepare(`${JOB_SELECT} WHERE job.idempotencyKey = ?`)
      .get(input.idempotencyKey) as JobRow | undefined;
    if (existing) {
      importInvariant(
        existing.requestFingerprint === requestFingerprint,
        'IMPORT_IDEMPOTENCY_CONFLICT',
        409,
      );
      return this.mapSummary(existing);
    }

    const frozen = this.requirePlan(input.plan.planId);
    importInvariant(
      input.plan.sourceManifestDigest === frozen.sourceManifestDigest &&
        JSON.stringify(input.plan.sourceManifest) === JSON.stringify(frozen.sourceManifest) &&
        JSON.stringify(input.plan.selection) === JSON.stringify(frozen.selection) &&
        input.plan.objectCount === frozen.objectCount &&
        input.plan.totalBytes === frozen.totalBytes &&
        input.plan.sourceConnectionId === frozen.sourceConnectionId &&
        input.plan.sourceProvider === frozen.sourceProvider &&
        input.plan.sourceExternalAccountId === frozen.sourceExternalAccountId,
      'IMPORT_PLAN_MANIFEST_MISMATCH',
      409,
    );
    const id = randomUUID();
    const timestamp = this.now().getTime();
    const sourceCleanupPolicy = input.sourceCleanupPolicy ?? 'KEEP';
    if (sourceCleanupPolicy === 'SELECTED_SOURCE' && frozen.sourceKind === 'BAIDU_APP_DIR') {
      const selection = frozen.selection as { sourcePath?: unknown };
      importInvariant(
        typeof selection.sourcePath === 'string' &&
          isManagedBaiduMutationPath(selection.sourcePath),
        'IMPORT_SOURCE_CLEANUP_SCOPE_UNSUPPORTED',
        409,
      );
    }
    importInvariant(
      input.plan.sourceKind !== 'BAIDU_SHARE' || sourceCleanupPolicy !== 'SELECTED_SOURCE',
      'IMPORT_SHARE_SOURCE_DELETE_FORBIDDEN',
      409,
    );
    importInvariant(
      sourceCleanupPolicy === 'KEEP' ||
        (input.plan.sourceKind === 'BAIDU_SHARE' && sourceCleanupPolicy === 'JOB_STAGING_ONLY') ||
        (input.plan.sourceKind === 'BAIDU_APP_DIR' && sourceCleanupPolicy === 'SELECTED_SOURCE'),
      'IMPORT_SOURCE_CLEANUP_POLICY_INVALID',
      409,
    );
    importInvariant(
      input.sourceCleanupRequiresPublication !== true ||
        (sourceCleanupPolicy !== 'KEEP' &&
          input.publicationPolicy === 'PUBLISH_TO_JELLYFIN' &&
          input.publication !== undefined),
      'IMPORT_SOURCE_CLEANUP_POLICY_INVALID',
      409,
    );
    const currentStep: ImportStep =
      input.plan.sourceKind === 'BAIDU_SHARE' ? 'SHARE_TRANSFER' : 'DISCOVERING';
    try {
      this.db.transaction(() => {
        if (frozen.sourceConnectionId !== null) {
          const live = new DatabaseImportSourceConnectionCatalog(this.db).requireBaiduSource(
            frozen.sourceConnectionId,
            frozen.sourceKind,
          );
          importInvariant(
            live.sourceExternalAccountId === frozen.sourceExternalAccountId,
            'IMPORT_SOURCE_IDENTITY_DRIFT',
            409,
          );
        }
        this.db
          .prepare(
            `INSERT INTO import_jobs(
               id, plan_id, source_kind, source_alias, source_requires_passcode,
               selection_json_sanitized, secret_ref,
               source_connection_id, source_provider, source_external_account_id,
               source_manifest_revision, source_manifest_digest, destination_account_id,
               destination_id, destination_display_name, destination_kind,
               publication_policy, source_cleanup_policy,
               source_cleanup_requires_publication,
               state, current_step, current_condition,
               revision, idempotency_key, request_fingerprint,
               object_count, job_bytes_total,
               last_checkpoint_at, created_at, updated_at
             ) VALUES (
               @id, @planId, @sourceKind, @sourceAlias, @sourceRequiresPasscode,
                @selectionJson, @secretRef,
                @sourceConnectionId, @sourceProvider, @sourceExternalAccountId,
                @sourceManifestRevision, @sourceManifestDigest, @destinationAccountId,
               @destinationId, @destinationDisplayName, @destinationKind,
               @publicationPolicy, @sourceCleanupPolicy,
               @sourceCleanupRequiresPublication, 'QUEUED', @currentStep, NULL,
               0, @idempotencyKey, @requestFingerprint, @objectCount, @jobBytesTotal,
               @timestamp, @timestamp, @timestamp
             )`,
          )
          .run({
            id,
            planId: input.plan.planId,
            sourceKind: input.plan.sourceKind,
            sourceConnectionId: input.plan.sourceConnectionId,
            sourceProvider: input.plan.sourceProvider,
            sourceExternalAccountId: input.plan.sourceExternalAccountId,
            sourceManifestRevision: input.plan.sourceManifestRevision,
            sourceManifestDigest: frozen.sourceManifestDigest,
            destinationAccountId: this.frozenDestinationAccountId(input.destination),
            sourceAlias: input.plan.sourceAlias,
            sourceRequiresPasscode: input.plan.sourceRequiresPasscode ? 1 : 0,
            selectionJson: sanitizedJson(input.plan.selection, 'selection'),
            secretRef: input.secretRef,
            destinationId: input.destination.destinationId,
            destinationDisplayName: input.destination.displayName,
            destinationKind: input.destination.kind,
            publicationPolicy: input.publicationPolicy,
            sourceCleanupPolicy,
            sourceCleanupRequiresPublication: input.sourceCleanupRequiresPublication ? 1 : 0,
            currentStep,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint,
            objectCount: input.plan.objectCount,
            jobBytesTotal: input.plan.totalBytes,
            timestamp,
          });
        this.insertEvent(
          id,
          'IMPORT_QUEUED',
          currentStep,
          null,
          `create:${input.idempotencyKey}`,
          timestamp,
        );
        if (isArchiveSourceManifest(frozen.sourceManifest))
          this.archives.initialize(id, frozen.sourceManifest, frozen.selection);
        if (input.publication) {
          this.insertPublication(id, input.publication, timestamp);
        }
      })();
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        const repeated = this.db
          .prepare(`${JOB_SELECT} WHERE job.idempotencyKey = ?`)
          .get(input.idempotencyKey) as JobRow | undefined;
        if (repeated) return this.mapSummary(repeated);
      }
      throw error;
    }
    return this.requireSummary(id);
  }

  list(options: SummaryOptions = {}, limit = 100): ImportJobSummary[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.db
      .prepare(
        `${JOB_SELECT} ${this.groupSchema ? 'WHERE NOT EXISTS(SELECT 1 FROM import_pipeline_groups WHERE job_id=job.id)' : ''} ORDER BY job.createdAt DESC, job.id DESC LIMIT ?`,
      )
      .all(bounded) as JobRow[];
    return rows.map((row) => this.mapSummary(row, options));
  }

  requireSummary(jobId: string, options: SummaryOptions = {}): ImportJobSummary {
    const row = this.db.prepare(`${JOB_SELECT} WHERE job.id = ?`).get(jobId) as JobRow | undefined;
    if (!row) throw new ImportControlError('IMPORT_NOT_FOUND', 404);
    return this.mapSummary(row, options);
  }

  requireDetail(
    jobId: string,
    options: {
      publicationActionsEnabled?: boolean;
      publicationLibraryIds?: readonly string[];
    } = {},
  ): ImportDetail {
    const row = this.db.prepare(`${JOB_SELECT} WHERE job.id = ?`).get(jobId) as JobRow | undefined;
    if (!row) throw new ImportControlError('IMPORT_NOT_FOUND', 404);
    const events = this.db
      .prepare(
        `SELECT id, created_at AS createdAt, event_code AS code, step,
                CASE WHEN event_code IN ('IMPORT_WORKER_STOPPED','IMPORT_DOWNLOAD_RETRY_SCHEDULED') THEN
                  CASE WHEN error_class = 'DESTINATION_CAPACITY_WAIT'
                    THEN 'DESTINATION_CAPACITY_WAIT'
                    WHEN error_class IN (${SOURCE_NETWORK_RETRY_CODES.map(() => '?').join(',')})
                    THEN error_class ELSE NULL END
                  ELSE detail_sanitized END AS detail,
                CASE WHEN event_code IN ('IMPORT_WORKER_STOPPED','IMPORT_DOWNLOAD_RETRY_SCHEDULED') THEN detail_sanitized ELSE NULL END AS downloadDiagnosticJson
         FROM import_events WHERE job_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 500`,
      )
      .all(...SOURCE_NETWORK_RETRY_CODES, jobId) as EventRow[];
    const receipts = this.db
      .prepare(
        `SELECT kind, created_at AS createdAt, size, sha256,
                object_id AS objectId
         FROM import_receipts WHERE job_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(jobId) as ReceiptRow[];
    return {
      ...this.mapSummary(row, { ...options, includeRetryImpact: true }),
      receipts: {
        staging: this.mapReceipt(receipts, 'STAGING_VERIFIED'),
        committed: this.mapReceipt(receipts, 'COMMITTED'),
        verify: this.mapReceipt(receipts, 'COMMITTED_VERIFIED'),
      },
      // Bound the newest tail, then present it chronologically. Taking the first
      // 500 forever hides the current stop reason on long-running imports.
      // Only fixed allowlisted diagnostics are projected from error_class;
      // raw provider failures and historical untrusted detail never cross here.
      events: events.reverse().map((event): ImportEvent => {
        const downloadDiagnostic = readDownloadDiagnostic(event.downloadDiagnosticJson);
        return {
          id: event.id,
          at: iso(event.createdAt),
          code: event.code,
          step: event.step,
          detail: event.detail,
          ...(downloadDiagnostic === undefined ? {} : { downloadDiagnostic }),
        };
      }),
    };
  }

  mutateAction(
    jobId: string,
    action: 'PAUSE' | 'RESUME' | 'CANCEL' | 'RETRY',
    idempotencyKey: string,
  ): ImportJobSummary {
    const eventCode = {
      PAUSE: 'IMPORT_PAUSED',
      RESUME: 'IMPORT_RESUMED',
      CANCEL: 'IMPORT_CANCELLED',
      RETRY: 'IMPORT_RETRIED',
    }[action];
    return this.db.transaction(() => {
      const repeated = this.db
        .prepare(
          'SELECT job_id AS jobId, event_code AS eventCode FROM import_events WHERE idempotency_key = ?',
        )
        .get(idempotencyKey) as { jobId: string; eventCode: string } | undefined;
      if (repeated) {
        importInvariant(
          repeated.jobId === jobId && repeated.eventCode === eventCode,
          'IMPORT_IDEMPOTENCY_CONFLICT',
          409,
        );
        return this.requireSummary(jobId);
      }

      const row = this.db.prepare(`${JOB_SELECT} WHERE job.id = ?`).get(jobId) as
        JobRow | undefined;
      if (!row) throw new ImportControlError('IMPORT_NOT_FOUND', 404);
      const lastAction = this.db
        .prepare(
          `SELECT event_code FROM import_events
           WHERE job_id = ? AND event_code IN (
             'IMPORT_PAUSED', 'IMPORT_RESUMED', 'IMPORT_CANCELLED', 'IMPORT_RETRIED'
           ) ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .pluck()
        .get(jobId);
      if (
        (action === 'PAUSE' && row.state === 'BLOCKED' && row.paused === 1) ||
        (action === 'RESUME' && row.state === 'QUEUED' && lastAction === 'IMPORT_RESUMED') ||
        (action === 'CANCEL' && row.state === 'CANCELLED_SAFE') ||
        (action === 'RETRY' && row.state === 'QUEUED' && lastAction === 'IMPORT_RETRIED')
      ) {
        return this.mapSummary(row);
      }
      const timestamp = this.now().getTime();
      let nextState = row.state;
      let paused = row.paused;
      let pauseRequestedAt = row.pauseRequestedAt;
      let cancelRequestedAt = row.cancelRequestedAt;
      let currentCondition = row.currentCondition;
      let retryAt = row.retryAt;

      if (action === 'PAUSE') {
        importInvariant(
          row.state === 'QUEUED' || row.state === 'RUNNING',
          'IMPORT_ACTION_CONFLICT',
          409,
        );
        if (row.state === 'QUEUED') {
          nextState = 'BLOCKED';
          paused = 1;
        } else {
          pauseRequestedAt = timestamp;
        }
      } else if (action === 'RESUME') {
        importInvariant(row.state === 'BLOCKED' && row.paused === 1, 'IMPORT_ACTION_CONFLICT', 409);
        nextState = 'QUEUED';
        paused = 0;
        pauseRequestedAt = null;
        currentCondition = null;
      } else if (action === 'CANCEL') {
        importInvariant(
          ['QUEUED', 'RUNNING', 'RETRY_WAIT', 'BLOCKED', 'FAILED_SAFE'].includes(row.state),
          'IMPORT_ACTION_CONFLICT',
          409,
        );
        if (row.state === 'RUNNING') cancelRequestedAt = timestamp;
        else nextState = 'CANCELLED_SAFE';
      } else {
        importInvariant(
          row.state === 'RETRY_WAIT' ||
            row.state === 'FAILED_SAFE' ||
            (row.state === 'BLOCKED' &&
              row.paused === 0 &&
              row.currentCondition !== 'AUTH_REQUIRED'),
          'IMPORT_ACTION_CONFLICT',
          409,
        );
        nextState = 'QUEUED';
        currentCondition = null;
        retryAt = null;
      }

      const changed = this.db
        .prepare(
          `UPDATE import_jobs SET
             state = @state, current_condition = @currentCondition,
             paused = @paused, pause_requested_at = @pauseRequestedAt,
             cancel_requested_at = @cancelRequestedAt, retry_at = @retryAt,
             revision = revision + 1, updated_at = @timestamp,
             last_checkpoint_at = @timestamp
           WHERE id = @jobId AND revision = @revision`,
        )
        .run({
          state: nextState,
          currentCondition,
          paused,
          pauseRequestedAt,
          cancelRequestedAt,
          retryAt,
          timestamp,
          jobId,
          revision: row.revision,
        });
      importInvariant(changed.changes === 1, 'IMPORT_REVISION_CONFLICT', 409);
      this.insertEvent(jobId, eventCode, row.currentStep, null, idempotencyKey, timestamp);
      return this.requireSummary(jobId);
    })();
  }

  provideCredentials(jobId: string, secretRef: string, idempotencyKey: string): ImportJobSummary {
    const eventCode = 'IMPORT_CREDENTIALS_PROVIDED';
    return this.db.transaction(() => {
      const repeated = this.db
        .prepare(
          'SELECT job_id AS jobId, event_code AS eventCode FROM import_events WHERE idempotency_key = ?',
        )
        .get(idempotencyKey) as { jobId: string; eventCode: string } | undefined;
      if (repeated) {
        importInvariant(
          repeated.jobId === jobId && repeated.eventCode === eventCode,
          'IMPORT_IDEMPOTENCY_CONFLICT',
          409,
        );
        return this.requireSummary(jobId);
      }
      const row = this.db.prepare(`${JOB_SELECT} WHERE job.id = ?`).get(jobId) as
        JobRow | undefined;
      if (!row) throw new ImportControlError('IMPORT_NOT_FOUND', 404);
      importInvariant(
        row.state === 'BLOCKED' && row.currentCondition === 'AUTH_REQUIRED',
        'IMPORT_ACTION_CONFLICT',
        409,
      );
      const timestamp = this.now().getTime();
      const changed = this.db
        .prepare(
          `UPDATE import_jobs SET secret_ref = ?, state = 'QUEUED', current_condition = NULL,
                  revision = revision + 1, updated_at = ?, last_checkpoint_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(secretRef, timestamp, timestamp, jobId, row.revision);
      importInvariant(changed.changes === 1, 'IMPORT_REVISION_CONFLICT', 409);
      this.insertEvent(jobId, eventCode, row.currentStep, null, idempotencyKey, timestamp);
      return this.requireSummary(jobId);
    })();
  }

  secretRef(jobId: string): string | null {
    const value = this.db
      .prepare('SELECT secret_ref FROM import_jobs WHERE id = ?')
      .pluck()
      .get(jobId);
    if (value === undefined) throw new ImportControlError('IMPORT_NOT_FOUND', 404);
    if (value === null) return null;
    importInvariant(typeof value === 'string', 'IMPORT_SECRET_REF_CORRUPT', 500);
    return value;
  }

  requirePublication(publicationId: string): ImportPublication {
    const row = this.db
      .prepare(
        `SELECT id, state, media_type AS mediaType, library_id AS libraryId,
                library_display_name AS libraryDisplayName,
                container_path AS containerPath, logical_path AS logicalPath,
                mount_account_label AS mountAccountLabel, read_probe AS readProbe,
                jellyfin_notified AS jellyfinNotified, last_error AS lastError,
                publication_revision AS revision, object_count AS objectCount,
                updated_at AS updatedAt
         FROM media_publications WHERE id = ?`,
      )
      .get(publicationId) as PublicationRow | undefined;
    if (!row) throw new ImportControlError('IMPORT_PUBLICATION_NOT_FOUND', 404);
    return this.mapPublication(row);
  }

  rawSecretMatches(secret: string): number {
    const tables = [
      'import_plans',
      'import_jobs',
      'import_events',
      'import_receipts',
      'media_publications',
      'import_publication_objects',
      'media_publication_operations',
      'source_cleanup_previews',
      'source_cleanup_preview_objects',
      'source_cleanups',
      'source_cleanup_objects',
      'source_cleanup_operations',
    ];
    return tables.reduce((total, table) => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
      }>;
      return (
        total +
        columns
          .filter((column) => column.type.toUpperCase().includes('TEXT'))
          .reduce((count, column) => {
            const matches = this.db
              .prepare(
                `SELECT COUNT(*) FROM ${table} WHERE instr(COALESCE(${column.name}, ''), ?) > 0`,
              )
              .pluck()
              .get(secret);
            return count + Number(matches);
          }, 0)
      );
    }, 0);
  }

  private mapPlan(row: PlanRow): StoredImportPlan {
    return {
      planId: row.id,
      sourceKind: row.sourceKind,
      sourceConnectionId: row.sourceConnectionId,
      sourceProvider: row.sourceProvider,
      sourceExternalAccountId: row.sourceExternalAccountId,
      sourceManifestRevision: row.sourceManifestRevision,
      sourceManifest: readSourceManifest(row.sourceManifestJson, row.sourceManifestDigest),
      sourceManifestDigest: row.sourceManifestDigest,
      sourceAlias: row.sourceAlias,
      sourceRequiresPasscode: row.sourceRequiresPasscode === 1,
      sourceAuthState: row.sourceAuthState,
      destinationId: row.destinationId,
      objectCount: row.objectCount,
      totalBytes: row.totalBytes,
      largestObjectBytes: row.largestObjectBytes,
      requiredSpoolBytes: row.requiredSpoolBytes,
      pathConflicts: JSON.parse(row.pathConflictsJson) as ImportPlanConflict[],
      destinationLimitIssues: JSON.parse(row.limitIssuesJson) as ImportPlanLimitIssue[],
      plannedPolicy: row.plannedPolicy,
      mode: row.mode,
      transferStarted: false,
      expiresAt: iso(row.expiresAt),
      selection: JSON.parse(row.selectionJson) as unknown,
      secretRef: row.secretRef,
      destination: {
        destinationId: row.destinationId,
        displayName: row.destinationDisplayName,
        kind: row.destinationKind,
        available: true,
        unavailableReason: null,
      },
      createdAt: row.createdAt,
    };
  }

  private frozenDestinationAccountId(destination: ImportDestination): string | null {
    const candidate = destinationAccountId(destination);
    if (candidate === null) return null;
    return this.db.prepare('SELECT 1 FROM storage_accounts WHERE id = ?').get(candidate) ===
      undefined
      ? null
      : candidate;
  }

  private mapSummary(row: JobRow, options: SummaryOptions = {}): ImportJobSummary {
    const sourceRateLimit = this.sourceRateLimit(row);
    const archive = this.archives.status(row.id, options.includeRetryImpact === true);
    const progress: ImportProgressSnapshot = {
      jobId: row.id,
      revision: row.revision,
      state: row.state,
      currentStep: row.currentStep,
      ...(row.currentCondition === null ? {} : { currentCondition: row.currentCondition }),
      objectIndex: row.objectIndex,
      objectCount: row.objectCount,
      ...(row.currentObjectAlias === null ? {} : { currentObjectAlias: row.currentObjectAlias }),
      objectBytesDone: row.objectBytesDone,
      objectBytesTotal: row.objectBytesTotal,
      jobBytesVerified: row.jobBytesVerified,
      jobBytesTotal: row.jobBytesTotal,
      ...(row.downloadRateBps === null ? {} : { downloadRateBps: row.downloadRateBps }),
      ...(row.uploadRateBps === null ? {} : { uploadRateBps: row.uploadRateBps }),
      ...(row.verifyRateBps === null ? {} : { verifyRateBps: row.verifyRateBps }),
      ...(row.etaSeconds === null ? {} : { etaSeconds: row.etaSeconds }),
      ...(row.ratesSampledAt === null ? {} : { ratesSampledAt: row.ratesSampledAt }),
      ...(row.retryAt === null ? {} : { retryAt: iso(row.retryAt) }),
      ...(row.state === 'RUNNING' && row.retryAt !== null ? { downloadRetryInPlace: true } : {}),
      ...(row.resourceWaitKind === null ||
      row.resourceQueuePosition === null ||
      row.resourceWaitSince === null
        ? {}
        : {
            resourceWait: {
              resource: row.resourceWaitKind,
              queuePosition: row.resourceQueuePosition,
              since: iso(row.resourceWaitSince),
              ...(row.resourceWaitActive === null || row.resourceWaitCapacity === null
                ? {}
                : {
                    active: row.resourceWaitActive,
                    capacity: row.resourceWaitCapacity,
                  }),
            },
          }),
      lastCheckpointAt: iso(row.lastCheckpointAt),
      publicationPolicy: row.publicationPolicy,
      publicationState:
        row.publicationPolicy === 'ARCHIVE_ONLY'
          ? 'NOT_REQUESTED'
          : (this.publicationForJob(row.id)?.state ?? 'PENDING'),
    };
    return {
      jobId: row.id,
      ...(archive === null ? {} : { archive }),
      sourceKind: row.sourceKind,
      sourceConnectionId: row.sourceConnectionId,
      sourceAlias: row.sourceAlias,
      sourceRequiresPasscode: row.sourceRequiresPasscode === 1,
      sourceCleanupPolicy: row.sourceCleanupPolicy,
      sourceCleanupRequiresPublication: row.sourceCleanupRequiresPublication === 1,
      destination: {
        destinationId: row.destinationId,
        displayName: row.destinationDisplayName,
        kind: row.destinationKind,
      },
      createdAt: iso(row.createdAt),
      progress,
      publication: this.publicationForJob(row.id),
      ...(sourceRateLimit === null ? {} : { sourceRateLimit }),
      availableActions: this.availableActions(
        row,
        options.publicationActionsEnabled ?? false,
        new Set(options.publicationLibraryIds ?? []),
      ),
    };
  }

  private sourceRateLimit(row: JobRow): ImportJobSummary['sourceRateLimit'] | null {
    if (
      !ACTIVE_IMPORT_STATES.has(row.state) ||
      row.sourceRateLimitConnectionId === null ||
      row.sourceRateLimitedUntil === null ||
      row.sourceRateLimitCode === null ||
      row.sourceRateLimitUpdatedAt === null ||
      row.sourceRateLimitedUntil <= this.now().getTime() ||
      row.sourceRateLimitAffectedJobs < 1
    ) {
      return null;
    }
    return {
      connectionId: row.sourceRateLimitConnectionId,
      retryAt: iso(row.sourceRateLimitedUntil),
      code: row.sourceRateLimitCode,
      updatedAt: iso(row.sourceRateLimitUpdatedAt),
      affectedActiveJobs: row.sourceRateLimitAffectedJobs,
    };
  }

  private publicationForJob(jobId: string): ImportPublication | null {
    const row = this.db
      .prepare(
        `SELECT id, state, media_type AS mediaType, library_id AS libraryId,
                library_display_name AS libraryDisplayName,
                container_path AS containerPath, logical_path AS logicalPath,
                mount_account_label AS mountAccountLabel, read_probe AS readProbe,
                jellyfin_notified AS jellyfinNotified, last_error AS lastError,
                publication_revision AS revision, object_count AS objectCount,
                updated_at AS updatedAt
         FROM media_publications WHERE job_id = ?`,
      )
      .get(jobId) as PublicationRow | undefined;
    if (!row) return null;
    return this.mapPublication(row);
  }

  private mapPublication(row: PublicationRow): ImportPublication {
    return {
      publicationId: row.id,
      state: row.state,
      revision: row.revision,
      objectCount: row.objectCount,
      mediaType: row.mediaType,
      libraryId: row.libraryId,
      libraryDisplayName: row.libraryDisplayName,
      containerPath: row.containerPath,
      logicalPath: row.logicalPath,
      mountAccountLabel: row.mountAccountLabel,
      readProbe: row.readProbe,
      jellyfinNotified: row.jellyfinNotified === null ? null : row.jellyfinNotified === 1,
      error: row.lastError,
      updatedAt: iso(row.updatedAt),
    };
  }

  private insertPublication(
    jobId: string,
    publication: NonNullable<CreateJobInput['publication']>,
    timestamp: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO media_publications(
           id, job_id, state, media_type, library_id, library_key, library_display_name,
           container_path, logical_path, created_at, updated_at
         ) VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        jobId,
        publication.request.mediaType,
        publication.library.libraryId,
        publication.library.libraryKey,
        publication.library.displayName,
        publication.library.containerPath,
        publication.request.logicalPath,
        timestamp,
        timestamp,
      );
  }

  private insertEvent(
    jobId: string,
    code: string,
    step: ImportStep | null,
    detail: string | null,
    idempotencyKey: string | null,
    createdAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO import_events(
           id, job_id, event_code, idempotency_key, step, detail_sanitized, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), jobId, code, idempotencyKey, step, sanitizedDetail(detail), createdAt);
  }

  private mapReceipt(rows: ReceiptRow[], kind: string): ImportReceipt | null {
    const selected = rows.filter((row) => row.kind === kind);
    if (selected.length === 0) return null;
    const objectIds = new Set(
      selected.flatMap((row) => (row.objectId === null ? [] : [row.objectId])),
    );
    const bytes = selected.reduce((total, row) => total + BigInt(row.size ?? '0'), 0n).toString();
    const digests = [
      ...new Set(selected.map((row) => row.sha256).filter((value) => value !== null)),
    ];
    const latestAt = selected.reduce(
      (latest, row) => Math.max(latest, row.createdAt),
      selected[0]?.createdAt ?? 0,
    );
    return {
      at: iso(latestAt),
      objectCount: objectIds.size,
      bytes,
      digestPreview: digests.length === 1 ? digestPreview(digests[0] ?? null) : null,
    };
  }

  private availableActions(
    row: JobRow,
    publicationActionsEnabled: boolean,
    publicationLibraryIds: ReadonlySet<string>,
  ): ImportAction[] {
    if (row.pauseRequestedAt !== null || row.cancelRequestedAt !== null) return [];
    if (row.state === 'QUEUED') return ['PAUSE', 'CANCEL'];
    if (row.state === 'RUNNING') return ['PAUSE', 'CANCEL'];
    if (row.state === 'BLOCKED' && row.paused === 1) return ['RESUME', 'CANCEL'];
    if (row.state === 'BLOCKED' && row.currentCondition === 'AUTH_REQUIRED') {
      return ['PROVIDE_CREDENTIALS', 'CANCEL'];
    }
    if (row.state === 'BLOCKED') return ['RETRY', 'CANCEL'];
    if (row.state === 'RETRY_WAIT' || row.state === 'FAILED_SAFE') return ['RETRY', 'CANCEL'];
    return this.publicationActions.forJob(row.id, publicationActionsEnabled, publicationLibraryIds);
  }
}
