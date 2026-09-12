import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  ImportSourceCleanup,
  ImportSourceCleanupGate,
  ImportSourceCleanupGateName,
  ImportSourceCleanupPolicy,
  ImportSourceCleanupPreview,
} from '@ptvault/contracts';

import type { Clock } from '../core/clock.js';
import type { AppDatabase } from '../db/database.js';
import { StorageEligibilityAuthority } from '../cloud-connections/eligibility.js';
import { ImportControlError, importInvariant } from './errors.js';
import { ImportFileIdentitySchema } from '@ptvault/contracts';
import { canonicalSourceManifest, sourceManifestDigest } from './source-manifest.js';
import { isManagedBaiduMutationPath } from './baidu-paths.js';
import {
  matchesSourceDeleteApproval,
  type SourceDeleteApproval,
  type SourceDeleteObject,
} from './source-delete-approvals.js';

export type ImportSourceSnapshot = {
  fsid: string;
  path: string;
  size: string;
  mtime: string;
};

export type ImportSourceCleanupProviderReceipt = {
  providerRequestId: string;
  semantics: 'RECYCLE_BIN';
};

export interface ImportSourceCleanupProvider {
  statSourceObject(fsid: string, signal?: AbortSignal): Promise<ImportSourceSnapshot | null>;
  deleteToRecycleBin(input: {
    fsid: string;
    path: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    /** Synchronous final check after adapter preflight/token awaits, before transport. */
    beforeDelete?: () => void;
    expectedSource?: ImportSourceSnapshot;
  }): Promise<ImportSourceCleanupProviderReceipt>;
  /** Optional provider-side idempotency reconciliation after an ambiguous crash. */
  lookupRecycleBinReceipt?(
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ImportSourceCleanupProviderReceipt | null>;
}

export interface ImportSourceCleanupProviderResolver {
  resolve(binding: {
    connectionId: string;
    externalAccountId: string;
  }): ImportSourceCleanupProvider;
}

export type ImportSourceCleanupSettings = {
  sourceStagingCleanupEnabled: boolean;
  sourceDeleteEnabled: boolean;
  sourceDeleteGraceSeconds: number;
};

export type ImportSourceCleanupFailpoint = 'BEFORE_PROVIDER_CALL' | 'AFTER_PROVIDER_SUCCESS';

export type ImportSourceCleanupServiceOptions = {
  db: AppDatabase;
  featureEnabled: boolean;
  /** Independent high-risk owner-source gate; defaulted off by config. */
  selectedSourceDeleteEnabled: boolean;
  settings: () => ImportSourceCleanupSettings;
  requiredRecoveryAccountIds: readonly string[];
  providers: ImportSourceCleanupProviderResolver;
  /** Narrow operator approval; evaluated fresh at create, preview and each transport fence. */
  sourceDeleteApprovals?: () => readonly SourceDeleteApproval[];
  now?: Clock;
  previewTtlMs?: number;
  executionLeaseMs?: number;
  executionHeartbeatMs?: number;
  failpoint?: (point: ImportSourceCleanupFailpoint, objectId: string) => void;
};

export type ImportSourceCleanupPreviewInput = {
  adminId: string;
  jobId: string;
  policy: Exclude<ImportSourceCleanupPolicy, 'KEEP'>;
  expectedJobRevision: number;
  idempotencyKey: string;
};

export type ImportSourceCleanupExecuteInput = {
  adminId: string;
  jobId: string;
  previewId: string;
  previewRevision: number;
  previewFingerprint: string;
  expectedJobRevision: number;
  idempotencyKey: string;
  signal?: AbortSignal;
};

type JobRow = {
  id: string;
  sourceKind: 'BAIDU_SHARE' | 'BAIDU_APP_DIR' | 'OTHER';
  sourceConnectionId: string | null;
  sourceProvider: 'BAIDU' | null;
  sourceExternalAccountId: string | null;
  sourceManifestRevision: number | null;
  selectionJson: string;
  state: string;
  revision: number;
  objectCount: number;
  jobBytesTotal: string;
  sourceCleanupPolicy: ImportSourceCleanupPolicy;
  sourceCleanupRequiresPublication: number;
  completedAt: number | null;
};

type ConnectionRow = {
  id: string;
  provider: string;
  externalAccountId: string;
  principalMasked: string;
  authState: string;
  capabilitiesJson: string;
};

type ArchiveObjectRow = {
  objectId: string;
  sourceFsid: string;
  relativePath: string;
  sourceSize: string;
  sourceMtime: string;
  localSha256: string | null;
  stagingSha256: string | null;
  committedSha256: string | null;
  destinationAccountId: string | null;
  committedKey: string | null;
  commitState: string | null;
};

type EvaluatedObject = ArchiveObjectRow & {
  sourcePath: string;
  sourceSha256: string;
  preflightFingerprint: string;
  observed: ImportSourceSnapshot | null;
};

type Evaluation = {
  job: JobRow;
  connection: ConnectionRow;
  sourceRoot: string;
  objects: EvaluatedObject[];
  totalBytes: string;
  manifestFingerprint: string;
  fingerprint: string;
  gates: ImportSourceCleanupGate[];
  eligible: boolean;
};

type PreviewRow = {
  id: string;
  jobId: string;
  adminId: string;
  policy: Exclude<ImportSourceCleanupPolicy, 'KEEP'>;
  jobRevision: number;
  previewRevision: number;
  fingerprint: string;
  manifestFingerprint: string;
  sourceConnectionId: string;
  sourceExternalAccountId: string;
  sourceAccountMasked: string;
  exactSourceRoot: string;
  objectCount: number;
  totalBytes: string;
  gatesJson: string;
  eligible: number;
  expiresAt: number;
  consumedAt: number | null;
};

type CleanupRow = {
  id: string;
  previewId: string;
  jobId: string;
  adminId: string;
  policy: Exclude<ImportSourceCleanupPolicy, 'KEEP'>;
  status: ImportSourceCleanup['status'];
  sourceConnectionId: string;
  sourceExternalAccountId: string;
  sourceAccountMasked: string;
  exactSourceRoot: string;
  jobRevision: number;
  previewFingerprint: string;
  providerSemantics: 'RECYCLE_BIN';
  objectCount: number;
  completedObjectCount: number;
  failedObjectCount: number;
  totalBytes: string;
  completedBytes: string;
  followUpRequired: number;
  updatedAt: number;
};

type CleanupObjectRow = {
  cleanupId: string;
  objectId: string;
  sourceConnectionId: string;
  sourceFsid: string;
  sourcePath: string;
  sourceSize: string;
  sourceMtime: string;
  sourceSha256: string;
  preflightFingerprint: string;
  status: ImportSourceCleanup['objects'][number]['status'];
  providerIdempotencyKey: string;
  providerRequestId: string | null;
  providerSemantics: 'RECYCLE_BIN' | null;
  errorCode: string | null;
  followUpRequired: number;
  attempt: number;
  updatedAt: number;
};

type OperationRow = {
  operation: 'PREVIEW' | 'EXECUTE';
  resourceId: string;
  requestFingerprint: string;
  responseJson: string | null;
};

const JOB_SELECT = `
  SELECT id, source_kind AS sourceKind,
         source_connection_id AS sourceConnectionId,
         source_provider AS sourceProvider,
         source_external_account_id AS sourceExternalAccountId,
         source_manifest_revision AS sourceManifestRevision,
         selection_json_sanitized AS selectionJson, state, revision,
         object_count AS objectCount, job_bytes_total AS jobBytesTotal,
         source_cleanup_policy AS sourceCleanupPolicy,
         source_cleanup_requires_publication AS sourceCleanupRequiresPublication,
         completed_at AS completedAt
  FROM import_jobs`;

const PREVIEW_SELECT = `
  SELECT id, job_id AS jobId, admin_id AS adminId, policy,
         job_revision AS jobRevision, preview_revision AS previewRevision,
         fingerprint, manifest_fingerprint AS manifestFingerprint,
         source_connection_id AS sourceConnectionId,
         source_external_account_id AS sourceExternalAccountId,
         source_account_masked AS sourceAccountMasked,
         exact_source_root AS exactSourceRoot,
         object_count AS objectCount, total_bytes AS totalBytes,
         gates_json_sanitized AS gatesJson, eligible,
         expires_at AS expiresAt, consumed_at AS consumedAt
  FROM source_cleanup_previews`;

const CLEANUP_SELECT = `
  SELECT id, preview_id AS previewId, job_id AS jobId, admin_id AS adminId,
         policy, status, source_connection_id AS sourceConnectionId,
         source_external_account_id AS sourceExternalAccountId,
         source_account_masked AS sourceAccountMasked,
         exact_source_root AS exactSourceRoot, job_revision AS jobRevision,
         preview_fingerprint AS previewFingerprint,
         provider_semantics AS providerSemantics,
         object_count AS objectCount,
         completed_object_count AS completedObjectCount,
         failed_object_count AS failedObjectCount,
         total_bytes AS totalBytes, completed_bytes AS completedBytes,
         follow_up_required AS followUpRequired, updated_at AS updatedAt
  FROM source_cleanups`;

const CLEANUP_OBJECT_SELECT = `
  SELECT cleanup_id AS cleanupId, object_id AS objectId,
         source_connection_id AS sourceConnectionId, source_fsid AS sourceFsid,
         source_path AS sourcePath, source_size AS sourceSize,
         source_mtime AS sourceMtime, source_sha256 AS sourceSha256,
         preflight_fingerprint AS preflightFingerprint, status,
         provider_idempotency_key AS providerIdempotencyKey,
         provider_request_id AS providerRequestId,
         provider_semantics AS providerSemantics, error_code AS errorCode,
         follow_up_required AS followUpRequired, attempt,
         updated_at AS updatedAt
  FROM source_cleanup_objects`;

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sumBytes(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}

function archiveFingerprint(objects: readonly ArchiveObjectRow[]): string {
  return digest(
    objects.map((object) => ({
      objectId: object.objectId,
      fsid: object.sourceFsid,
      relativePath: object.relativePath,
      size: object.sourceSize,
      mtime: object.sourceMtime,
      localSha256: object.localSha256,
      stagingSha256: object.stagingSha256,
      committedSha256: object.committedSha256,
      destinationAccountId: object.destinationAccountId,
      committedKey: object.committedKey,
      commitState: object.commitState,
    })),
  );
}

function safeJson<T>(value: string, code: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new ImportControlError(code, 500);
  }
}

function gate(
  name: ImportSourceCleanupGateName,
  passed: boolean,
  reason: string,
): ImportSourceCleanupGate {
  return { gate: name, passed, reason: passed ? null : reason };
}

function normalizeRoot(value: string): string {
  if (
    !value.startsWith('/apps/bdpan/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.endsWith('/') ||
    value.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new ImportControlError('SOURCE_CLEANUP_SOURCE_ROOT_INVALID', 409);
  }
  return value.replace(/\/{2,}/g, '/');
}

function sourcePath(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ImportControlError('SOURCE_CLEANUP_MANIFEST_INVALID', 409);
  }
  const result = path.posix.join(root, relativePath);
  if (!result.startsWith(`${root}/`)) {
    throw new ImportControlError('SOURCE_CLEANUP_SOURCE_ESCAPE', 409);
  }
  return result;
}

function matchesSnapshot(
  expected: EvaluatedObject,
  observed: ImportSourceSnapshot | null,
): boolean {
  return (
    observed !== null &&
    observed.fsid === expected.sourceFsid &&
    observed.path === expected.sourcePath &&
    observed.size === expected.sourceSize &&
    observed.mtime === expected.sourceMtime
  );
}

/**
 * Preview/execute/status authority for source cleanup.
 *
 * No method mutates import/archive/publication/recovery rows. Provider success is
 * represented only as recycle-bin semantics in a per-object durable journal.
 */
export class ImportSourceCleanupService {
  private readonly db: AppDatabase;
  private readonly featureEnabled: boolean;
  private readonly selectedSourceDeleteEnabled: boolean;
  private readonly settings: () => ImportSourceCleanupSettings;
  private readonly requiredRecoveryAccountIds: readonly string[];
  private readonly providers: ImportSourceCleanupProviderResolver;
  private readonly sourceDeleteApprovals: () => readonly SourceDeleteApproval[];
  private readonly now: Clock;
  private readonly previewTtlMs: number;
  private readonly executionLeaseMs: number;
  private readonly executionHeartbeatMs: number;
  private readonly failpoint: ImportSourceCleanupServiceOptions['failpoint'];

  constructor(options: ImportSourceCleanupServiceOptions) {
    this.db = options.db;
    this.featureEnabled = options.featureEnabled;
    this.selectedSourceDeleteEnabled = options.selectedSourceDeleteEnabled;
    this.settings = options.settings;
    this.requiredRecoveryAccountIds = [...new Set(options.requiredRecoveryAccountIds)];
    this.providers = options.providers;
    this.sourceDeleteApprovals = options.sourceDeleteApprovals ?? (() => []);
    this.now = options.now ?? (() => new Date());
    this.previewTtlMs = options.previewTtlMs ?? 5 * 60_000;
    this.executionLeaseMs = options.executionLeaseMs ?? 5 * 60_000;
    this.executionHeartbeatMs =
      options.executionHeartbeatMs ?? Math.max(1, Math.floor(this.executionLeaseMs / 3));
    if (
      !Number.isFinite(this.executionLeaseMs) ||
      !Number.isFinite(this.executionHeartbeatMs) ||
      this.executionLeaseMs <= 1 ||
      this.executionHeartbeatMs <= 0 ||
      this.executionHeartbeatMs >= this.executionLeaseMs
    ) {
      throw new Error('INVALID_SOURCE_CLEANUP_EXECUTION_TIMING');
    }
    this.failpoint = options.failpoint;
  }

  async preview(input: ImportSourceCleanupPreviewInput): Promise<ImportSourceCleanupPreview> {
    const intent = {
      jobId: input.jobId,
      policy: input.policy,
      expectedJobRevision: input.expectedJobRevision,
    };
    const replay = this.beginOperation<ImportSourceCleanupPreview>(
      input.adminId,
      input.idempotencyKey,
      'PREVIEW',
      input.jobId,
      intent,
    );
    if (replay !== null) return replay;

    const evaluation = await this.evaluate(input.jobId, input.policy, input.expectedJobRevision);
    const previewId = randomUUID();
    const previewRevision = 1;
    const timestamp = this.now().getTime();
    const expiresAt = timestamp + this.previewTtlMs;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO source_cleanup_previews(
             id, job_id, admin_id, policy, job_revision, preview_revision,
             fingerprint, manifest_fingerprint, source_connection_id,
             source_external_account_id, source_account_masked,
             exact_source_root, object_count, total_bytes,
             gates_json_sanitized, eligible, created_at, expires_at, consumed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          previewId,
          input.jobId,
          input.adminId,
          input.policy,
          evaluation.job.revision,
          previewRevision,
          evaluation.fingerprint,
          evaluation.manifestFingerprint,
          evaluation.connection.id,
          evaluation.connection.externalAccountId,
          evaluation.connection.principalMasked,
          evaluation.sourceRoot,
          evaluation.objects.length,
          evaluation.totalBytes,
          JSON.stringify(evaluation.gates),
          evaluation.eligible ? 1 : 0,
          timestamp,
          expiresAt,
        );
      for (const object of evaluation.objects) {
        this.db
          .prepare(
            `INSERT INTO source_cleanup_preview_objects(
               preview_id, object_id, source_fsid, source_path, source_size,
               source_mtime, source_sha256, preflight_fingerprint
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            previewId,
            object.objectId,
            object.sourceFsid,
            object.sourcePath,
            object.sourceSize,
            object.sourceMtime,
            object.sourceSha256,
            object.preflightFingerprint,
          );
      }
    })();
    const response: ImportSourceCleanupPreview = {
      previewId,
      previewRevision,
      fingerprint: evaluation.fingerprint,
      jobId: input.jobId,
      jobRevision: evaluation.job.revision,
      policy: input.policy,
      objectCount: evaluation.objects.length,
      totalBytes: evaluation.totalBytes,
      sourceAccountMasked: evaluation.connection.principalMasked,
      exactSourceRoot: evaluation.sourceRoot,
      providerSemantics: 'RECYCLE_BIN',
      gates: evaluation.gates,
      eligible: evaluation.eligible,
      expiresAt: iso(expiresAt),
    };
    this.completeOperation(
      input.adminId,
      input.idempotencyKey,
      'PREVIEW',
      input.jobId,
      intent,
      response,
    );
    return response;
  }

  async execute(input: ImportSourceCleanupExecuteInput): Promise<ImportSourceCleanup> {
    const intent = {
      jobId: input.jobId,
      previewId: input.previewId,
      previewRevision: input.previewRevision,
      previewFingerprint: input.previewFingerprint,
      expectedJobRevision: input.expectedJobRevision,
    };
    const replay = this.beginOperation<ImportSourceCleanup>(
      input.adminId,
      input.idempotencyKey,
      'EXECUTE',
      input.previewId,
      intent,
    );
    if (replay !== null) return replay;

    const preview = this.requirePreview(input.previewId);
    this.assertPreviewBinding(preview, input);
    let cleanup = this.cleanupForPreview(preview.id);
    if (cleanup === null) {
      importInvariant(preview.eligible === 1, 'SOURCE_CLEANUP_PREVIEW_INELIGIBLE', 409);
      const evaluation = await this.evaluate(
        input.jobId,
        preview.policy,
        input.expectedJobRevision,
      );
      if (!evaluation.eligible) this.throwGateFailure(evaluation.gates);
      importInvariant(
        evaluation.fingerprint === preview.fingerprint &&
          evaluation.manifestFingerprint === preview.manifestFingerprint,
        'SOURCE_CLEANUP_PREVIEW_STALE',
        409,
      );
      cleanup = this.createCleanup(preview, evaluation);
    }

    if (cleanup.status !== 'COMPLETED') await this.runCleanup(cleanup, input.signal);
    const response = this.status(input.jobId);
    importInvariant(response !== null, 'SOURCE_CLEANUP_NOT_FOUND', 500);
    this.completeOperation(
      input.adminId,
      input.idempotencyKey,
      'EXECUTE',
      input.previewId,
      intent,
      response,
    );
    return response;
  }

  /** Completed durable replay checked by the route before spending a new TOTP. */
  replayExecute(input: ImportSourceCleanupExecuteInput): ImportSourceCleanup | null {
    const intent = {
      jobId: input.jobId,
      previewId: input.previewId,
      previewRevision: input.previewRevision,
      previewFingerprint: input.previewFingerprint,
      expectedJobRevision: input.expectedJobRevision,
    };
    const requestFingerprint = digest(intent);
    const existing = this.db
      .prepare(
        `SELECT operation, resource_id AS resourceId,
                request_fingerprint AS requestFingerprint,
                response_json AS responseJson
         FROM source_cleanup_operations
         WHERE admin_id = ? AND idempotency_key = ?`,
      )
      .get(input.adminId, input.idempotencyKey) as OperationRow | undefined;
    if (existing === undefined) return null;
    importInvariant(
      existing.operation === 'EXECUTE' &&
        existing.resourceId === input.previewId &&
        existing.requestFingerprint === requestFingerprint,
      'SOURCE_CLEANUP_IDEMPOTENCY_CONFLICT',
      409,
    );
    return existing.responseJson === null
      ? null
      : safeJson<ImportSourceCleanup>(existing.responseJson, 'SOURCE_CLEANUP_RECEIPT_CORRUPT');
  }

  status(jobId: string): ImportSourceCleanup | null {
    const row = this.db
      .prepare(`${CLEANUP_SELECT} WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(jobId) as CleanupRow | undefined;
    return row === undefined ? null : this.mapCleanup(row);
  }

  private async evaluate(
    jobId: string,
    policy: Exclude<ImportSourceCleanupPolicy, 'KEEP'>,
    expectedRevision: number,
  ): Promise<Evaluation> {
    const job = this.requireJob(jobId);
    importInvariant(job.revision === expectedRevision, 'SOURCE_CLEANUP_REVISION_CONFLICT', 409);
    importInvariant(
      job.sourceConnectionId !== null &&
        job.sourceProvider === 'BAIDU' &&
        job.sourceExternalAccountId !== null &&
        job.sourceManifestRevision !== null,
      'SOURCE_CLEANUP_SOURCE_BINDING_REQUIRED',
      409,
    );
    const connection = this.requireConnection(job.sourceConnectionId);
    const sourceRoot = this.sourceRoot(job, policy);
    const archiveObjects = this.archiveObjects(job.id);
    const provider = this.providers.resolve({
      connectionId: job.sourceConnectionId,
      externalAccountId: job.sourceExternalAccountId,
    });
    const objects: EvaluatedObject[] = [];
    for (const object of archiveObjects) {
      const expectedPath = this.objectSourcePath(job, sourceRoot, object.relativePath);
      let observed: ImportSourceSnapshot | null = null;
      try {
        observed = await provider.statSourceObject(object.sourceFsid);
      } catch {
        observed = null;
      }
      const sourceSha256 = object.localSha256 ?? '0'.repeat(64);
      objects.push({
        ...object,
        sourcePath: expectedPath,
        sourceSha256,
        observed,
        preflightFingerprint: digest({
          fsid: object.sourceFsid,
          path: expectedPath,
          size: object.sourceSize,
          mtime: object.sourceMtime,
          sha256: sourceSha256,
          observed,
        }),
      });
    }

    const settings = this.settings();
    const taskPolicyMatches = job.sourceCleanupPolicy === policy;
    const sourceScopeMatches =
      (job.sourceKind === 'BAIDU_SHARE' && policy === 'JOB_STAGING_ONLY') ||
      (job.sourceKind === 'BAIDU_APP_DIR' && policy === 'SELECTED_SOURCE');
    const shareBoundary = !(job.sourceKind === 'BAIDU_SHARE' && policy === 'SELECTED_SOURCE');
    const modeEnabled =
      policy === 'JOB_STAGING_ONLY'
        ? settings.sourceStagingCleanupEnabled
        : settings.sourceDeleteEnabled && this.selectedSourceDeleteEnabled;
    const manifestFrozen =
      job.state === 'COMPLETED' &&
      job.objectCount > 0 &&
      archiveObjects.length === job.objectCount &&
      job.sourceManifestRevision !== null;
    const committedVerified =
      archiveObjects.length === job.objectCount &&
      archiveObjects.every(
        (object) =>
          object.commitState === 'COMMITTED_VERIFIED' &&
          object.destinationAccountId !== null &&
          object.committedKey !== null,
      );
    const hashChainMatches =
      archiveObjects.length === job.objectCount &&
      archiveObjects.every(
        (object) =>
          object.localSha256 !== null &&
          object.stagingSha256 === object.localSha256 &&
          object.committedSha256 === object.localSha256,
      );
    const recoveryVerified = this.recoveryVerified(job.id);
    const unchanged =
      objects.length === job.objectCount &&
      objects.every((object) => matchesSnapshot(object, object.observed));
    const noReferences =
      this.hasOtherActiveReferences(
        job.id,
        job.sourceConnectionId,
        objects.map((object) => object.sourceFsid),
      ) === false;
    const deleteCapable = this.isFileJob(job)
      ? objects.length === 1 &&
        objects.every((object) =>
          this.connectionDeleteCapable(connection, job.sourceExternalAccountId!, {
            connectionId: connection.id,
            externalAccountId: job.sourceExternalAccountId!,
            fsid: object.sourceFsid,
            path: object.sourcePath,
            size: object.sourceSize,
            mtime: object.sourceMtime,
            sha256: object.sourceSha256,
          }),
        )
      : this.connectionDeleteCapable(connection, job.sourceExternalAccountId);
    const graceElapsed =
      job.completedAt !== null &&
      this.now().getTime() >= job.completedAt + settings.sourceDeleteGraceSeconds * 1_000;
    const publicationReady =
      job.sourceCleanupRequiresPublication === 0 || this.publicationPublished(job.id);
    const gates: ImportSourceCleanupGate[] = [
      gate('GLOBAL_FEATURE_ENABLED', this.featureEnabled, 'SOURCE_CLEANUP_FEATURE_DISABLED'),
      gate('TASK_POLICY_MATCH', taskPolicyMatches, 'SOURCE_CLEANUP_TASK_POLICY_MISMATCH'),
      gate('SOURCE_SCOPE_MATCH', sourceScopeMatches, 'SOURCE_CLEANUP_SOURCE_SCOPE_MISMATCH'),
      gate('SHARE_OWNER_BOUNDARY', shareBoundary, 'SOURCE_CLEANUP_SHARE_OWNER_FORBIDDEN'),
      gate('MODE_FEATURE_ENABLED', modeEnabled, 'SOURCE_CLEANUP_MODE_DISABLED'),
      gate('MANIFEST_FROZEN', manifestFrozen, 'SOURCE_CLEANUP_MANIFEST_NOT_FROZEN'),
      gate('COMMITTED_VERIFIED', committedVerified, 'SOURCE_CLEANUP_COMMITTED_VERIFY_REQUIRED'),
      gate('HASH_CHAIN_MATCH', hashChainMatches, 'SOURCE_CLEANUP_HASH_MISMATCH'),
      gate('RECOVERY_GENERATION_VERIFIED', recoveryVerified, 'SOURCE_CLEANUP_RECOVERY_REQUIRED'),
      gate('SOURCE_UNCHANGED', unchanged, 'SOURCE_CLEANUP_SOURCE_CHANGED'),
      gate('NO_ACTIVE_REFERENCES', noReferences, 'SOURCE_CLEANUP_ACTIVE_REFERENCE'),
      gate(
        'SAME_ACCOUNT_DELETE_CAPABLE',
        deleteCapable,
        'SOURCE_CLEANUP_DELETE_CAPABILITY_REQUIRED',
      ),
      gate('GRACE_PERIOD_ELAPSED', graceElapsed, 'SOURCE_CLEANUP_GRACE_ACTIVE'),
      gate('PUBLICATION_READY', publicationReady, 'SOURCE_CLEANUP_PUBLICATION_REQUIRED'),
    ];
    const manifestFingerprint = archiveFingerprint(archiveObjects);
    const evaluationFingerprint = digest({
      jobId,
      jobRevision: job.revision,
      policy,
      sourceConnectionId: job.sourceConnectionId,
      sourceExternalAccountId: job.sourceExternalAccountId,
      sourceRoot,
      manifestFingerprint,
      objects: objects.map((object) => ({
        objectId: object.objectId,
        preflightFingerprint: object.preflightFingerprint,
      })),
      gates,
    });
    return {
      job,
      connection,
      sourceRoot,
      objects,
      totalBytes: sumBytes(archiveObjects.map((object) => object.sourceSize)),
      manifestFingerprint,
      fingerprint: evaluationFingerprint,
      gates,
      eligible: gates.every((entry) => entry.passed),
    };
  }

  private createCleanup(preview: PreviewRow, evaluation: Evaluation): CleanupRow {
    const cleanupId = randomUUID();
    const timestamp = this.now().getTime();
    try {
      this.db
        .transaction(() => {
          importInvariant(
            evaluation.job.sourceCleanupRequiresPublication === 0 ||
              this.publicationPublished(preview.jobId),
            'SOURCE_CLEANUP_PUBLICATION_REQUIRED',
            409,
          );
          importInvariant(
            this.hasOtherActiveReferences(
              preview.jobId,
              preview.sourceConnectionId,
              evaluation.objects.map((object) => object.sourceFsid),
            ) === false,
            'SOURCE_CLEANUP_ACTIVE_REFERENCE',
            409,
          );
          this.db
            .prepare(
              `INSERT INTO source_cleanups(
               id, preview_id, job_id, admin_id, policy, status,
               source_connection_id, source_external_account_id,
               source_account_masked, exact_source_root, job_revision,
               preview_fingerprint, provider_semantics, object_count,
               completed_object_count, failed_object_count, total_bytes,
               completed_bytes, follow_up_required, receipt_json_sanitized,
               created_at, updated_at, completed_at
             ) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, 'RECYCLE_BIN',
                       ?, 0, 0, ?, '0', 0, '{}', ?, ?, NULL)`,
            )
            .run(
              cleanupId,
              preview.id,
              preview.jobId,
              preview.adminId,
              preview.policy,
              preview.sourceConnectionId,
              preview.sourceExternalAccountId,
              preview.sourceAccountMasked,
              preview.exactSourceRoot,
              preview.jobRevision,
              preview.fingerprint,
              preview.objectCount,
              preview.totalBytes,
              timestamp,
              timestamp,
            );
          for (const object of evaluation.objects) {
            this.db
              .prepare(
                `INSERT INTO source_cleanup_locks(
                 source_connection_id, source_fsid, cleanup_id, created_at
               ) VALUES (?, ?, ?, ?)`,
              )
              .run(preview.sourceConnectionId, object.sourceFsid, cleanupId, timestamp);
            this.db
              .prepare(
                `INSERT INTO source_cleanup_objects(
                 cleanup_id, object_id, source_connection_id, source_fsid,
                 source_path, source_size, source_mtime, source_sha256,
                 preflight_fingerprint, status, provider_idempotency_key,
                 provider_request_id, provider_semantics, error_code,
                 follow_up_required, attempt, created_at, updated_at, completed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?,
                         NULL, NULL, NULL, 0, 0, ?, ?, NULL)`,
              )
              .run(
                cleanupId,
                object.objectId,
                preview.sourceConnectionId,
                object.sourceFsid,
                object.sourcePath,
                object.sourceSize,
                object.sourceMtime,
                object.sourceSha256,
                object.preflightFingerprint,
                `source-cleanup:${cleanupId}:${object.objectId}`,
                timestamp,
                timestamp,
              );
          }
          this.db
            .prepare('UPDATE source_cleanup_previews SET consumed_at = ? WHERE id = ?')
            .run(timestamp, preview.id);
        })
        .immediate();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed: source_cleanups.preview_id')
      ) {
        const existing = this.cleanupForPreview(preview.id);
        importInvariant(existing !== null, 'SOURCE_CLEANUP_NOT_FOUND', 500);
        return existing;
      }
      if (
        error instanceof Error &&
        (error.message.includes('source_cleanup_locks') ||
          error.message.includes('SOURCE_CLEANUP_LOCKED'))
      ) {
        throw new ImportControlError('SOURCE_CLEANUP_ACTIVE_REFERENCE', 409);
      }
      throw error;
    }
    return this.requireCleanup(cleanupId);
  }

  private async runCleanup(cleanup: CleanupRow, signal?: AbortSignal): Promise<void> {
    const ownerToken = this.claimExecution(cleanup.id);
    const leaseAbort = new AbortController();
    let leaseFailure: ImportControlError | null = null;
    const heartbeat = setInterval(() => {
      try {
        this.renewExecution(cleanup.id, ownerToken);
      } catch (error) {
        leaseFailure =
          error instanceof ImportControlError
            ? error
            : new ImportControlError('SOURCE_CLEANUP_EXECUTION_LEASE_LOST', 409);
        leaseAbort.abort(leaseFailure);
        clearInterval(heartbeat);
      }
    }, this.executionHeartbeatMs);
    heartbeat.unref();
    const operationSignal =
      signal === undefined ? leaseAbort.signal : AbortSignal.any([signal, leaseAbort.signal]);
    const assertLease = (): void => {
      if (leaseFailure !== null) throw leaseFailure;
      this.assertExecutionOwner(cleanup.id, ownerToken);
    };
    try {
      const provider = this.providers.resolve({
        connectionId: cleanup.sourceConnectionId,
        externalAccountId: cleanup.sourceExternalAccountId,
      });
      for (const initial of this.cleanupObjects(cleanup.id)) {
        if (initial.status === 'COMPLETED') continue;
        this.renewExecution(cleanup.id, ownerToken);
        assertLease();
        let object = initial;
        try {
          // Reconciliation is read-only. A confirmed provider receipt is a fact
          // even after feature/recovery gates close; it never authorizes a new delete.
          if (object.attempt > 0) {
            const recovered = await provider.lookupRecycleBinReceipt?.(
              object.providerIdempotencyKey,
              operationSignal,
            );
            assertLease();
            if (recovered !== undefined && recovered !== null) {
              this.completeObject(object, recovered, ownerToken);
              continue;
            }
            const ambiguous = await provider.statSourceObject(object.sourceFsid, operationSignal);
            assertLease();
            if (ambiguous === null) {
              throw new ImportControlError('SOURCE_CLEANUP_OUTCOME_UNKNOWN', 409);
            }
            if (!this.matchesJournal(object, ambiguous)) {
              throw new ImportControlError('SOURCE_CLEANUP_SOURCE_CHANGED', 409);
            }
          } else {
            const current = await provider.statSourceObject(object.sourceFsid, operationSignal);
            assertLease();
            if (!this.matchesJournal(object, current)) {
              throw new ImportControlError('SOURCE_CLEANUP_SOURCE_CHANGED', 409);
            }
            this.markPreflightVerified(object, ownerToken);
          }

          this.markProviderRequested(object, ownerToken);
          this.failpoint?.('BEFORE_PROVIDER_CALL', object.objectId);
          const beforeDelete = (): void => {
            operationSignal.throwIfAborted();
            this.withExecutionFence(cleanup.id, ownerToken, () =>
              this.assertLiveDeleteAuthority(cleanup, object),
            );
          };
          beforeDelete();
          const receipt = await provider.deleteToRecycleBin({
            fsid: object.sourceFsid,
            path: object.sourcePath,
            idempotencyKey: object.providerIdempotencyKey,
            signal: operationSignal,
            beforeDelete,
            expectedSource: {
              fsid: object.sourceFsid,
              path: object.sourcePath,
              size: object.sourceSize,
              mtime: object.sourceMtime,
            },
          });
          assertLease();
          this.failpoint?.('AFTER_PROVIDER_SUCCESS', object.objectId);
          object = this.requireCleanupObject(object.cleanupId, object.objectId);
          this.completeObject(object, receipt, ownerToken);
        } catch (error) {
          assertLease();
          if (
            error instanceof ImportControlError &&
            error.code === 'SOURCE_CLEANUP_EXECUTION_LEASE_LOST'
          ) {
            throw error;
          }
          // Failpoints model process death and must leave the in-progress journal
          // untouched for a restarted service to reconcile.
          if (error instanceof Error && error.message.startsWith('simulated ')) throw error;
          this.markFollowUp(
            object,
            error instanceof ImportControlError ? error.code : 'SOURCE_CLEANUP_PROVIDER_FAILED',
            ownerToken,
          );
        }
      }
      assertLease();
      this.finishCleanup(cleanup.id, ownerToken);
    } finally {
      clearInterval(heartbeat);
      this.releaseExecution(cleanup.id, ownerToken);
    }
  }

  private claimExecution(cleanupId: string): string {
    const ownerToken = randomUUID();
    const now = this.now().getTime();
    const changed = this.db
      .prepare(
        `UPDATE source_cleanups
         SET execution_owner_token = ?, execution_lease_expires_at = ?
         WHERE id = ? AND (
           execution_owner_token IS NULL OR execution_lease_expires_at <= ?
         )`,
      )
      .run(ownerToken, now + this.executionLeaseMs, cleanupId, now);
    importInvariant(changed.changes === 1, 'SOURCE_CLEANUP_IN_PROGRESS', 409);
    return ownerToken;
  }

  private renewExecution(cleanupId: string, ownerToken: string): void {
    const changed = this.db
      .prepare(
        `UPDATE source_cleanups SET execution_lease_expires_at = ?
         WHERE id = ? AND execution_owner_token = ?`,
      )
      .run(this.now().getTime() + this.executionLeaseMs, cleanupId, ownerToken);
    importInvariant(changed.changes === 1, 'SOURCE_CLEANUP_EXECUTION_LEASE_LOST', 409);
  }

  private assertExecutionOwner(cleanupId: string, ownerToken: string): void {
    const owned = this.db
      .prepare(
        `SELECT 1 FROM source_cleanups
         WHERE id = ? AND execution_owner_token = ?
           AND execution_lease_expires_at > ?`,
      )
      .get(cleanupId, ownerToken, this.now().getTime());
    importInvariant(owned !== undefined, 'SOURCE_CLEANUP_EXECUTION_LEASE_LOST', 409);
  }

  private withExecutionFence(cleanupId: string, ownerToken: string, action: () => void): void {
    this.db
      .transaction(() => {
        this.assertExecutionOwner(cleanupId, ownerToken);
        action();
      })
      .immediate();
  }

  private releaseExecution(cleanupId: string, ownerToken: string): void {
    this.db
      .prepare(
        `UPDATE source_cleanups
         SET execution_owner_token = NULL, execution_lease_expires_at = NULL
         WHERE id = ? AND execution_owner_token = ?`,
      )
      .run(cleanupId, ownerToken);
  }

  private markPreflightVerified(object: CleanupObjectRow, ownerToken: string): void {
    this.withExecutionFence(object.cleanupId, ownerToken, () => {
      this.db
        .prepare(
          `UPDATE source_cleanup_objects
           SET status = 'PREFLIGHT_VERIFIED', error_code = NULL,
               follow_up_required = 0, updated_at = ?
           WHERE cleanup_id = ? AND object_id = ?`,
        )
        .run(this.now().getTime(), object.cleanupId, object.objectId);
    });
  }

  private markProviderRequested(object: CleanupObjectRow, ownerToken: string): void {
    this.withExecutionFence(object.cleanupId, ownerToken, () => {
      this.db
        .prepare(
          `UPDATE source_cleanup_objects
           SET status = 'PROVIDER_REQUESTED', provider_request_id = NULL,
               provider_semantics = NULL,
               attempt = attempt + 1, updated_at = ?
           WHERE cleanup_id = ? AND object_id = ?`,
        )
        .run(this.now().getTime(), object.cleanupId, object.objectId);
    });
  }

  private completeObject(
    object: CleanupObjectRow,
    receipt: ImportSourceCleanupProviderReceipt,
    ownerToken: string,
  ): void {
    importInvariant(
      receipt.semantics === 'RECYCLE_BIN' &&
        receipt.providerRequestId.length > 0 &&
        receipt.providerRequestId.length <= 256,
      'SOURCE_CLEANUP_PROVIDER_RECEIPT_INVALID',
      502,
    );
    this.withExecutionFence(object.cleanupId, ownerToken, () => {
      const timestamp = this.now().getTime();
      this.db
        .prepare(
          `UPDATE source_cleanup_objects
           SET status = 'COMPLETED', provider_request_id = ?,
               provider_semantics = 'RECYCLE_BIN', error_code = NULL,
               follow_up_required = 0, completed_at = ?, updated_at = ?
           WHERE cleanup_id = ? AND object_id = ?`,
        )
        .run(receipt.providerRequestId, timestamp, timestamp, object.cleanupId, object.objectId);
    });
  }

  private markFollowUp(object: CleanupObjectRow, code: string, ownerToken: string): void {
    this.withExecutionFence(object.cleanupId, ownerToken, () => {
      this.db
        .prepare(
          `UPDATE source_cleanup_objects
           SET status = 'FOLLOW_UP_REQUIRED', error_code = ?,
               follow_up_required = 1, updated_at = ?
           WHERE cleanup_id = ? AND object_id = ?`,
        )
        .run(code, this.now().getTime(), object.cleanupId, object.objectId);
    });
  }

  private finishCleanup(cleanupId: string, ownerToken: string): void {
    this.withExecutionFence(cleanupId, ownerToken, () => {
      const objects = this.cleanupObjects(cleanupId);
      const completed = objects.filter((object) => object.status === 'COMPLETED');
      const failed = objects.filter((object) => object.status === 'FOLLOW_UP_REQUIRED');
      const status: CleanupRow['status'] =
        failed.length === 0 ? 'COMPLETED' : completed.length > 0 ? 'PARTIAL' : 'FOLLOW_UP_REQUIRED';
      const timestamp = this.now().getTime();
      this.db
        .prepare(
          `UPDATE source_cleanups
           SET status = ?, completed_object_count = ?, failed_object_count = ?,
               completed_bytes = ?, follow_up_required = ?,
               receipt_json_sanitized = ?, updated_at = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(
          status,
          completed.length,
          failed.length,
          sumBytes(completed.map((object) => object.sourceSize)),
          failed.length > 0 ? 1 : 0,
          JSON.stringify({
            semantics: completed.length > 0 ? 'RECYCLE_BIN' : null,
            completedObjectCount: completed.length,
            failedObjectCount: failed.length,
            followUpRequired: failed.length > 0,
            physicalErasureClaimed: false,
            completedAt: status === 'COMPLETED' ? iso(timestamp) : null,
          }),
          timestamp,
          status === 'COMPLETED' ? timestamp : null,
          cleanupId,
        );
    });
  }

  private assertLiveDeleteAuthority(cleanup: CleanupRow, object: CleanupObjectRow): void {
    const settings = this.settings();
    importInvariant(this.featureEnabled, 'SOURCE_CLEANUP_FEATURE_DISABLED', 409);
    if (cleanup.policy === 'JOB_STAGING_ONLY') {
      importInvariant(settings.sourceStagingCleanupEnabled, 'SOURCE_CLEANUP_MODE_DISABLED', 409);
    } else {
      importInvariant(
        settings.sourceDeleteEnabled && this.selectedSourceDeleteEnabled,
        'SOURCE_CLEANUP_MODE_DISABLED',
        409,
      );
    }
    const connection = this.requireConnection(cleanup.sourceConnectionId);
    const job = this.requireJob(cleanup.jobId);
    importInvariant(
      this.connectionDeleteCapable(
        connection,
        cleanup.sourceExternalAccountId,
        this.isFileJob(job)
          ? {
              connectionId: connection.id,
              externalAccountId: cleanup.sourceExternalAccountId,
              fsid: object.sourceFsid,
              path: object.sourcePath,
              size: object.sourceSize,
              mtime: object.sourceMtime,
              sha256: object.sourceSha256,
            }
          : undefined,
      ),
      'SOURCE_CLEANUP_DELETE_CAPABILITY_REQUIRED',
      409,
    );
    importInvariant(job.revision === cleanup.jobRevision, 'SOURCE_CLEANUP_REVISION_CONFLICT', 409);
    importInvariant(
      job.sourceCleanupPolicy === cleanup.policy,
      'SOURCE_CLEANUP_TASK_POLICY_MISMATCH',
      409,
    );
    importInvariant(
      job.sourceConnectionId === cleanup.sourceConnectionId &&
        job.sourceProvider === 'BAIDU' &&
        job.sourceExternalAccountId === cleanup.sourceExternalAccountId,
      'SOURCE_CLEANUP_SOURCE_BINDING_REQUIRED',
      409,
    );
    importInvariant(
      (job.sourceKind === 'BAIDU_SHARE' && cleanup.policy === 'JOB_STAGING_ONLY') ||
        (job.sourceKind === 'BAIDU_APP_DIR' && cleanup.policy === 'SELECTED_SOURCE'),
      'SOURCE_CLEANUP_SOURCE_SCOPE_MISMATCH',
      409,
    );
    const archive = this.archiveObjects(job.id);
    importInvariant(
      job.state === 'COMPLETED' &&
        job.objectCount > 0 &&
        archive.length === job.objectCount &&
        job.sourceManifestRevision !== null &&
        sumBytes(archive.map((entry) => entry.sourceSize)) === job.jobBytesTotal,
      'SOURCE_CLEANUP_MANIFEST_NOT_FROZEN',
      409,
    );
    importInvariant(
      archive.every(
        (entry) =>
          entry.commitState === 'COMMITTED_VERIFIED' &&
          entry.destinationAccountId !== null &&
          entry.committedKey !== null,
      ),
      'SOURCE_CLEANUP_COMMITTED_VERIFY_REQUIRED',
      409,
    );
    importInvariant(
      archive.every(
        (entry) =>
          entry.localSha256 !== null &&
          /^[0-9a-f]{64}$/.test(entry.localSha256) &&
          entry.stagingSha256 === entry.localSha256 &&
          entry.committedSha256 === entry.localSha256,
      ),
      'SOURCE_CLEANUP_HASH_MISMATCH',
      409,
    );
    importInvariant(this.recoveryVerified(job.id), 'SOURCE_CLEANUP_RECOVERY_REQUIRED', 409);
    const preview = this.requirePreview(cleanup.previewId);
    importInvariant(
      archiveFingerprint(archive) === preview.manifestFingerprint,
      'SOURCE_CLEANUP_PREVIEW_STALE',
      409,
    );
    const root = this.sourceRoot(job, cleanup.policy);
    const frozen = archive.find((entry) => entry.objectId === object.objectId);
    importInvariant(
      root === cleanup.exactSourceRoot &&
        frozen !== undefined &&
        frozen.sourceFsid === object.sourceFsid &&
        frozen.sourceSize === object.sourceSize &&
        frozen.sourceMtime === object.sourceMtime &&
        frozen.localSha256 === object.sourceSha256 &&
        this.objectSourcePath(job, root, frozen.relativePath) === object.sourcePath,
      'SOURCE_CLEANUP_SOURCE_CHANGED',
      409,
    );
    importInvariant(
      !this.hasOtherActiveReferences(
        job.id,
        cleanup.sourceConnectionId,
        archive.map((entry) => entry.sourceFsid),
      ),
      'SOURCE_CLEANUP_ACTIVE_REFERENCE',
      409,
    );
    importInvariant(
      job.completedAt !== null &&
        this.now().getTime() >= job.completedAt + settings.sourceDeleteGraceSeconds * 1_000,
      'SOURCE_CLEANUP_GRACE_ACTIVE',
      409,
    );
    importInvariant(
      job.sourceCleanupRequiresPublication === 0 || this.publicationPublished(job.id),
      'SOURCE_CLEANUP_PUBLICATION_REQUIRED',
      409,
    );
  }

  private matchesJournal(object: CleanupObjectRow, snapshot: ImportSourceSnapshot | null): boolean {
    return (
      snapshot !== null &&
      snapshot.fsid === object.sourceFsid &&
      snapshot.path === object.sourcePath &&
      snapshot.size === object.sourceSize &&
      snapshot.mtime === object.sourceMtime
    );
  }

  private sourceRoot(job: JobRow, policy: Exclude<ImportSourceCleanupPolicy, 'KEEP'>): string {
    const selection = safeJson<Record<string, unknown>>(
      job.selectionJson,
      'SOURCE_CLEANUP_SELECTION_CORRUPT',
    );
    if (selection.sourceScope === 'FILE') {
      const expected = ImportFileIdentitySchema.safeParse(selection.expectedFile);
      importInvariant(
        job.sourceKind === 'BAIDU_APP_DIR' &&
          policy === 'SELECTED_SOURCE' &&
          typeof selection.sourcePath === 'string' &&
          isManagedBaiduMutationPath(selection.sourcePath) &&
          expected.success,
        'SOURCE_CLEANUP_SOURCE_SCOPE_MISMATCH',
        409,
      );
      const stored = this.db
        .prepare(
          `SELECT plan.source_manifest_json AS manifest, job.source_manifest_digest AS digest
        FROM import_jobs job JOIN import_plans plan ON plan.id = job.plan_id WHERE job.id = ?`,
        )
        .get(job.id) as { manifest: string; digest: string };
      const manifest = canonicalSourceManifest(
        safeJson<unknown>(stored.manifest, 'SOURCE_CLEANUP_MANIFEST_INVALID'),
      );
      const archive = this.archiveObjects(job.id);
      const object = archive[0];
      const source = manifest.objects[0];
      importInvariant(
        manifest.version === 2 &&
          sourceManifestDigest(manifest) === stored.digest &&
          manifest.rootPath === selection.sourcePath &&
          job.objectCount === 1 &&
          archive.length === 1 &&
          object !== undefined &&
          object.sourceFsid === expected.data.fsid &&
          object.sourceSize === expected.data.size &&
          object.sourceMtime === expected.data.mtime &&
          object.sourceFsid === source?.fsid &&
          object.sourceSize === source.size &&
          object.sourceMtime === source.mtime &&
          object.relativePath === source.relativePath &&
          job.jobBytesTotal === object.sourceSize,
        'SOURCE_CLEANUP_MANIFEST_INVALID',
        409,
      );
      return selection.sourcePath;
    }
    if (job.sourceKind === 'BAIDU_SHARE') {
      const evidence = this.db
        .prepare(
          `SELECT evidence_json_sanitized
           FROM import_receipts
           WHERE job_id = ? AND object_id IS NULL
             AND kind = 'SOURCE_TRANSFER_CONFIRMED'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .pluck()
        .get(job.id) as string | undefined;
      if (evidence !== undefined) {
        const parsed = safeJson<{ destinationRoot?: unknown }>(
          evidence,
          'SOURCE_CLEANUP_TRANSFER_RECEIPT_CORRUPT',
        );
        if (typeof parsed.destinationRoot === 'string') {
          const actual = normalizeRoot(parsed.destinationRoot);
          importInvariant(
            actual === `/apps/bdpan/ptvault-imports/${job.id}`,
            'SOURCE_CLEANUP_STAGING_ROOT_MISMATCH',
            409,
          );
          return actual;
        }
      }
      throw new ImportControlError('SOURCE_CLEANUP_STAGING_RECEIPT_REQUIRED', 409);
    }
    if (typeof selection.sourcePath !== 'string') {
      throw new ImportControlError('SOURCE_CLEANUP_SOURCE_ROOT_REQUIRED', 409);
    }
    // A JOB_STAGING_ONLY request against an owner directory still returns a
    // preview, but TASK_POLICY_MATCH/MODE boundary deny execution.
    void policy;
    return normalizeRoot(selection.sourcePath);
  }

  private archiveObjects(jobId: string): ArchiveObjectRow[] {
    return this.db
      .prepare(
        `SELECT object.id AS objectId, object.source_fsid AS sourceFsid,
                object.relative_path AS relativePath,
                object.source_size AS sourceSize, object.source_mtime AS sourceMtime,
                object.local_sha256 AS localSha256,
                object.staging_sha256 AS stagingSha256,
                object.committed_sha256 AS committedSha256,
                destination_commit.destination_account_id AS destinationAccountId,
                destination_commit.committed_key AS committedKey,
                destination_commit.commit_state AS commitState
         FROM import_objects AS object
         LEFT JOIN destination_commits AS destination_commit
           ON destination_commit.job_id = object.job_id
          AND destination_commit.object_id = object.id
          AND destination_commit.destination_account_id = object.destination_account_id
         WHERE object.job_id = ? ORDER BY object.relative_path, object.id`,
      )
      .all(jobId) as ArchiveObjectRow[];
  }

  private recoveryVerified(jobId: string): boolean {
    if (this.requiredRecoveryAccountIds.length < 2) return false;
    const generation = this.db
      .prepare(
        `SELECT evidence_json_sanitized FROM import_receipts
         WHERE job_id = ? AND object_id IS NULL AND kind = 'CONTROL_PLANE_BACKUP'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .pluck()
      .get(jobId) as string | undefined;
    if (generation === undefined) return false;
    const evidence = safeJson<{ generationId?: unknown }>(
      generation,
      'SOURCE_CLEANUP_RECOVERY_RECEIPT_CORRUPT',
    );
    if (typeof evidence.generationId !== 'string') return false;
    const match = /^recovery-v([1-9][0-9]*)$/.exec(evidence.generationId);
    if (match === null) return false;
    const version = Number(match[1]);
    const current = this.db
      .prepare(
        `SELECT version, bundle_sha256 AS bundleSha256, escrow_sha256 AS escrowSha256
         FROM recovery_exports
         WHERE bundle_sha256 IS NOT NULL AND completed_at IS NOT NULL
         ORDER BY version DESC LIMIT 1`,
      )
      .get() as { version: number; bundleSha256: string; escrowSha256: string } | undefined;
    if (current === undefined || current.version !== version) return false;
    const verified = this.db
      .prepare(
        `SELECT copy.account_id AS accountId
         FROM recovery_cloud_copies AS copy
         JOIN storage_accounts AS account ON account.id = copy.account_id
         WHERE copy.version = ? AND copy.verification_status = 'VERIFIED'
           AND copy.bundle_sha256 = ? AND copy.escrow_sha256 = ?
           AND account.health = 'HEALTHY'
           AND (account.circuit_open_until IS NULL OR account.circuit_open_until <= ?)`,
      )
      .all(version, current.bundleSha256, current.escrowSha256, this.now().getTime()) as Array<{
      accountId: string;
    }>;
    const authority = new StorageEligibilityAuthority(this.db, {
      now: () => this.now().getTime(),
      webOAuthRuntimeConfigured: true,
    });
    const accountIds = new Set(
      verified
        .filter((row) => authority.evaluate(row.accountId, 'EXISTING_WORK').eligible)
        .map((row) => row.accountId),
    );
    return this.requiredRecoveryAccountIds.every((accountId) => accountIds.has(accountId));
  }

  private hasOtherActiveReferences(
    jobId: string,
    sourceConnectionId: string,
    fsids: readonly string[],
  ): boolean {
    if (fsids.length === 0) return false;
    const placeholders = fsids.map(() => '?').join(',');
    const count = this.db
      .prepare(
        `SELECT COUNT(*)
         FROM import_objects AS object
         JOIN import_jobs AS job ON job.id = object.job_id
         WHERE job.id <> ? AND job.source_connection_id = ?
           AND object.source_fsid IN (${placeholders})
           AND job.state IN ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'BLOCKED')`,
      )
      .pluck()
      .get(jobId, sourceConnectionId, ...fsids);
    return Number(count) > 0;
  }

  private connectionDeleteCapable(
    connection: ConnectionRow,
    expectedExternalAccountId: string,
    scopedObject?: SourceDeleteObject,
  ): boolean {
    const capabilities = safeJson<unknown[]>(
      connection.capabilitiesJson,
      'SOURCE_CLEANUP_CONNECTION_CORRUPT',
    );
    return (
      connection.provider === 'BAIDU' &&
      connection.externalAccountId === expectedExternalAccountId &&
      connection.authState === 'CONNECTED' &&
      (capabilities.includes('SOURCE_DELETE') ||
        (scopedObject !== undefined &&
          matchesSourceDeleteApproval(
            this.sourceDeleteApprovals(),
            scopedObject,
            this.now().getTime(),
          ))) &&
      this.db
        .prepare(
          'SELECT 1 FROM cloud_connection_runtime WHERE connection_id = ? AND rate_limited_until > ?',
        )
        .get(connection.id, this.now().getTime()) === undefined
    );
  }

  fileSourceCleanupEnabled(): boolean {
    return (
      this.featureEnabled && this.selectedSourceDeleteEnabled && this.settings().sourceDeleteEnabled
    );
  }

  canCreateFileCleanup(object: SourceDeleteObject): boolean {
    if (!this.fileSourceCleanupEnabled() || !isManagedBaiduMutationPath(object.path)) return false;
    return this.connectionDeleteCapable(
      this.requireConnection(object.connectionId),
      object.externalAccountId,
      object,
    );
  }

  private isFileJob(job: JobRow): boolean {
    return (
      safeJson<{ sourceScope?: unknown }>(job.selectionJson, 'SOURCE_CLEANUP_SELECTION_CORRUPT')
        .sourceScope === 'FILE'
    );
  }

  private objectSourcePath(job: JobRow, root: string, relativePath: string): string {
    if (!this.isFileJob(job)) return sourcePath(root, relativePath);
    importInvariant(
      relativePath === path.posix.basename(root),
      'SOURCE_CLEANUP_MANIFEST_INVALID',
      409,
    );
    return root;
  }

  private publicationPublished(jobId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM media_publications WHERE job_id = ? AND state = 'PUBLISHED'")
        .get(jobId) !== undefined
    );
  }

  private assertPreviewBinding(preview: PreviewRow, input: ImportSourceCleanupExecuteInput): void {
    importInvariant(
      preview.adminId === input.adminId && preview.jobId === input.jobId,
      'SOURCE_CLEANUP_PREVIEW_SCOPE_MISMATCH',
      403,
    );
    importInvariant(
      preview.previewRevision === input.previewRevision &&
        preview.fingerprint === input.previewFingerprint,
      'SOURCE_CLEANUP_PREVIEW_MISMATCH',
      409,
    );
    importInvariant(
      preview.jobRevision === input.expectedJobRevision,
      'SOURCE_CLEANUP_REVISION_CONFLICT',
      409,
    );
    const existing = this.cleanupForPreview(preview.id);
    importInvariant(
      preview.expiresAt > this.now().getTime() || existing !== null,
      'SOURCE_CLEANUP_PREVIEW_EXPIRED',
      409,
    );
    const job = this.requireJob(input.jobId);
    importInvariant(
      existing !== null || job.revision === input.expectedJobRevision,
      'SOURCE_CLEANUP_REVISION_CONFLICT',
      409,
    );
  }

  private throwGateFailure(gates: readonly ImportSourceCleanupGate[]): never {
    const failed = gates.find((entry) => !entry.passed);
    throw new ImportControlError(failed?.reason ?? 'SOURCE_CLEANUP_GATE_CLOSED', 409);
  }

  private requireJob(jobId: string): JobRow {
    const row = this.db.prepare(`${JOB_SELECT} WHERE id = ?`).get(jobId) as JobRow | undefined;
    if (row === undefined) throw new ImportControlError('IMPORT_NOT_FOUND', 404);
    return row;
  }

  private requireConnection(connectionId: string): ConnectionRow {
    const row = this.db
      .prepare(
        `SELECT id, provider, external_account_id AS externalAccountId,
                principal_masked AS principalMasked, auth_state AS authState,
                capabilities_json AS capabilitiesJson
         FROM cloud_connections WHERE id = ?`,
      )
      .get(connectionId) as ConnectionRow | undefined;
    if (row === undefined) {
      throw new ImportControlError('SOURCE_CLEANUP_CONNECTION_NOT_FOUND', 409);
    }
    return row;
  }

  private requirePreview(previewId: string): PreviewRow {
    const row = this.db.prepare(`${PREVIEW_SELECT} WHERE id = ?`).get(previewId) as
      PreviewRow | undefined;
    if (row === undefined) throw new ImportControlError('SOURCE_CLEANUP_PREVIEW_NOT_FOUND', 404);
    return row;
  }

  private cleanupForPreview(previewId: string): CleanupRow | null {
    const row = this.db.prepare(`${CLEANUP_SELECT} WHERE preview_id = ?`).get(previewId) as
      CleanupRow | undefined;
    return row ?? null;
  }

  private requireCleanup(cleanupId: string): CleanupRow {
    const row = this.db.prepare(`${CLEANUP_SELECT} WHERE id = ?`).get(cleanupId) as
      CleanupRow | undefined;
    if (row === undefined) throw new ImportControlError('SOURCE_CLEANUP_NOT_FOUND', 404);
    return row;
  }

  private cleanupObjects(cleanupId: string): CleanupObjectRow[] {
    return this.db
      .prepare(`${CLEANUP_OBJECT_SELECT} WHERE cleanup_id = ? ORDER BY source_fsid, object_id`)
      .all(cleanupId) as CleanupObjectRow[];
  }

  private requireCleanupObject(cleanupId: string, objectId: string): CleanupObjectRow {
    const row = this.db
      .prepare(`${CLEANUP_OBJECT_SELECT} WHERE cleanup_id = ? AND object_id = ?`)
      .get(cleanupId, objectId) as CleanupObjectRow | undefined;
    if (row === undefined) throw new ImportControlError('SOURCE_CLEANUP_OBJECT_NOT_FOUND', 500);
    return row;
  }

  private mapCleanup(row: CleanupRow): ImportSourceCleanup {
    const objects = this.cleanupObjects(row.id);
    return {
      cleanupId: row.id,
      jobId: row.jobId,
      policy: row.policy,
      status: row.status,
      providerSemantics: row.completedObjectCount > 0 ? 'RECYCLE_BIN' : null,
      objectCount: row.objectCount,
      completedObjectCount: row.completedObjectCount,
      failedObjectCount: row.failedObjectCount,
      totalBytes: row.totalBytes,
      completedBytes: row.completedBytes,
      sourceAccountMasked: row.sourceAccountMasked,
      exactSourceRoot: row.exactSourceRoot,
      followUpRequired: row.followUpRequired === 1,
      physicalErasureClaimed: false,
      objects: objects.map((object) => ({
        objectId: object.objectId,
        status: object.status,
        providerRequestId: object.providerRequestId,
        providerSemantics: object.providerSemantics,
        followUpRequired: object.followUpRequired === 1,
        errorCode: object.errorCode,
        updatedAt: iso(object.updatedAt),
      })),
      updatedAt: iso(row.updatedAt),
    };
  }

  private beginOperation<T>(
    adminId: string,
    idempotencyKey: string,
    operation: OperationRow['operation'],
    resourceId: string,
    intent: unknown,
  ): T | null {
    const requestFingerprint = digest(intent);
    const existing = this.db
      .prepare(
        `SELECT operation, resource_id AS resourceId,
                request_fingerprint AS requestFingerprint,
                response_json AS responseJson
         FROM source_cleanup_operations
         WHERE admin_id = ? AND idempotency_key = ?`,
      )
      .get(adminId, idempotencyKey) as OperationRow | undefined;
    if (existing !== undefined) {
      importInvariant(
        existing.operation === operation &&
          existing.resourceId === resourceId &&
          existing.requestFingerprint === requestFingerprint,
        'SOURCE_CLEANUP_IDEMPOTENCY_CONFLICT',
        409,
      );
      return existing.responseJson === null
        ? null
        : safeJson<T>(existing.responseJson, 'SOURCE_CLEANUP_RECEIPT_CORRUPT');
    }
    const timestamp = this.now().getTime();
    this.db
      .prepare(
        `INSERT INTO source_cleanup_operations(
           admin_id, idempotency_key, operation, resource_id,
           request_fingerprint, response_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        adminId,
        idempotencyKey,
        operation,
        resourceId,
        requestFingerprint,
        timestamp,
        timestamp,
      );
    return null;
  }

  private completeOperation(
    adminId: string,
    idempotencyKey: string,
    operation: OperationRow['operation'],
    resourceId: string,
    intent: unknown,
    response: unknown,
  ): void {
    const requestFingerprint = digest(intent);
    const changed = this.db
      .prepare(
        `UPDATE source_cleanup_operations SET response_json = ?, updated_at = ?
         WHERE admin_id = ? AND idempotency_key = ? AND operation = ?
           AND resource_id = ? AND request_fingerprint = ? AND response_json IS NULL`,
      )
      .run(
        JSON.stringify(response),
        this.now().getTime(),
        adminId,
        idempotencyKey,
        operation,
        resourceId,
        requestFingerprint,
      );
    if (changed.changes === 0) {
      const replay = this.beginOperation<unknown>(
        adminId,
        idempotencyKey,
        operation,
        resourceId,
        intent,
      );
      importInvariant(
        JSON.stringify(replay) === JSON.stringify(response),
        'SOURCE_CLEANUP_IDEMPOTENCY_CONFLICT',
        409,
      );
    }
  }
}

export type ImportSourceCleanupController = Pick<
  ImportSourceCleanupService,
  'preview' | 'replayExecute' | 'execute' | 'status'
> &
  Partial<Pick<ImportSourceCleanupService, 'canCreateFileCleanup' | 'fileSourceCleanupEnabled'>>;
