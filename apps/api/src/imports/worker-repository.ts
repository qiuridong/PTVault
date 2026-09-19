import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { DownloadFailureDiagnostic, ImportJobState, ImportStep } from '@ptvault/contracts';

import type { Clock } from '../core/clock.js';
import type { AppDatabase } from '../db/database.js';
import { ImportControlError, importInvariant } from './errors.js';
import { decimalString, sanitizedDetail, sanitizedJson } from './security.js';
import type { ImportResourceKind } from './data-plane/resource-scheduler.js';
import { readSourceManifest, type ImportSourceManifest } from './source-manifest.js';
import { ImportDestinationCapacityGate } from './data-plane/destination-capacity.js';
import { SOURCE_NETWORK_RETRY_CODES } from './data-plane/network-retry.js';
import { encodeDownloadDiagnostic } from './data-plane/download-diagnostics.js';
import type { StagingQuarantineEvent, StagingQuarantineProof } from './data-plane/destination.js';

type QuarantineOwner = {
  jobId: string; jobAttempt: number; objectId: string; objectAttempt: number;
  destinationAccountId: string;
};

const REQUIRED_SCHEMA_VERSION = 17;

export const IMPORT_OBJECT_STATES = [
  'DISCOVERED',
  'SOURCE_PREFLIGHT',
  'DOWNLOADING',
  'LOCAL_LANDING',
  'ACQUIRED',
  'HASHING',
  'HASHED',
  'UPLOADING_STAGING',
  'STAGING_UPLOADED',
  'STAGING_READBACK',
  'STAGING_VERIFIED',
  'COMMITTING',
  'COMMITTED',
  'COMMITTED_READBACK',
  'COMMITTED_VERIFIED',
  'CONTROL_PLANE_BACKED_UP',
  'SPOOL_CLEANED',
  'COMPLETED',
] as const;

export type ImportObjectState = (typeof IMPORT_OBJECT_STATES)[number];

const OBJECT_STATE_RANK = new Map(
  IMPORT_OBJECT_STATES.map((state, index) => [state, index] as const),
);

export type ImportWorkerStage =
  | 'SOURCE_PREFLIGHT'
  | 'DOWNLOADING'
  | 'LOCAL_LANDING'
  | 'HASHING'
  | 'UPLOADING_STAGING'
  | 'STAGING_READBACK'
  | 'COMMITTING'
  | 'COMMITTED_READBACK';

const STAGE_OBJECT_STATE: Readonly<Record<ImportWorkerStage, ImportObjectState>> = {
  SOURCE_PREFLIGHT: 'SOURCE_PREFLIGHT',
  DOWNLOADING: 'DOWNLOADING',
  LOCAL_LANDING: 'LOCAL_LANDING',
  HASHING: 'HASHING',
  UPLOADING_STAGING: 'UPLOADING_STAGING',
  STAGING_READBACK: 'STAGING_READBACK',
  COMMITTING: 'COMMITTING',
  COMMITTED_READBACK: 'COMMITTED_READBACK',
};

export type ImportObjectReceiptKind =
  | 'ACQUIRED'
  | 'HASHED'
  | 'STAGING_UPLOADED'
  | 'STAGING_VERIFIED'
  | 'COMMITTED'
  | 'COMMITTED_VERIFIED';

const RECEIPT_OBJECT_STATE: Readonly<Record<ImportObjectReceiptKind, ImportObjectState>> = {
  ACQUIRED: 'ACQUIRED',
  HASHED: 'HASHED',
  STAGING_UPLOADED: 'STAGING_UPLOADED',
  STAGING_VERIFIED: 'STAGING_VERIFIED',
  COMMITTED: 'COMMITTED',
  COMMITTED_VERIFIED: 'COMMITTED_VERIFIED',
};

const RECEIPT_STEP: Readonly<Record<ImportObjectReceiptKind, ImportStep>> = {
  ACQUIRED: 'LOCAL_LANDING',
  HASHED: 'HASHING',
  STAGING_UPLOADED: 'UPLOADING_STAGING',
  STAGING_VERIFIED: 'STAGING_READBACK',
  COMMITTED: 'COMMITTING',
  COMMITTED_VERIFIED: 'COMMITTED_READBACK',
};

type WorkerJobRow = {
  sourceManifestJson: string | null;
  sourceManifestDigest: string | null;
  id: string;
  sourceKind: ImportWorkerJob['sourceKind'];
  sourceConnectionId: string | null;
  sourceProvider: 'BAIDU' | 'ONEDRIVE' | null;
  sourceExternalAccountId: string | null;
  sourceManifestRevision: number | null;
  selectionJson: string;
  secretRef: string | null;
  destinationId: string;
  destinationKind: ImportWorkerJob['destinationKind'];
  state: ImportJobState;
  currentStep: ImportStep;
  revision: number;
  objectCount: number;
  jobBytesTotal: string;
  attempt: number;
};

type ObjectRow = {
  id: string;
  jobId: string;
  sourceFsid: string;
  relativePath: string;
  sourceSize: string;
  sourceMtime: string;
  sourceReportedMd5: string | null;
  state: string;
  partialBytes: string;
  localSha256: string | null;
  destinationAccountId: string | null;
  stagingKey: string | null;
  committedKey: string | null;
  stagingSha256: string | null;
  committedSha256: string | null;
  attempt: number;
  lastErrorCode: string | null;
};

type ReceiptRow = {
  jobId: string;
  objectId: string | null;
  kind: string;
  size: string | null;
  sha256: string | null;
  providerRequestId: string | null;
  evidenceJson: string;
};

export type ImportWorkerJob = {
  sourceManifest?: ImportSourceManifest | null;
  sourceManifestDigest?: string | null;
  jobId: string;
  sourceKind: 'BAIDU_SHARE' | 'BAIDU_APP_DIR' | 'OTHER';
  sourceConnectionId?: string | null;
  sourceProvider?: 'BAIDU' | 'ONEDRIVE' | null;
  sourceExternalAccountId?: string | null;
  sourceManifestRevision?: number | null;
  selection: unknown;
  secretRef: string | null;
  destinationId: string;
  destinationKind: 'ONEDRIVE_RAW' | 'STANDALONE_CRYPT' | 'PT_VAULT_IMPORT';
  state: ImportJobState;
  currentStep: ImportStep;
  revision: number;
  objectCount: number;
  jobBytesTotal: string;
  attempt: number;
};

export type ImportWorkerObject = {
  originKind?: 'EXTRACTED';
  originDigest?: string;
  objectId: string;
  jobId: string;
  sourceFsid: string;
  relativePath: string;
  sourceSize: string;
  sourceMtime: string;
  sourceReportedMd5: string | null;
  state: ImportObjectState;
  partialBytes: string;
  localSha256: string | null;
  destinationAccountId: string | null;
  stagingKey: string | null;
  committedKey: string | null;
  stagingSha256: string | null;
  committedSha256: string | null;
  attempt: number;
  lastErrorCode: string | null;
};

export type DiscoveredImportObject = {
  objectId?: string;
  jobId: string;
  sourceFsid: string;
  relativePath: string;
  sourceSize: string;
  sourceMtime: string;
  sourceReportedMd5?: string;
};

export type ImportDownloadCheckpoint = {
  jobId: string;
  objectId: string;
  attempt: number;
  completedBytes: string;
  sourceSnapshot: {
    fsid: string;
    size: string;
    mtime: string;
  };
  downloadLeaseId: string;
  downloadLeaseExpiresAt: number;
  partialPath: string;
  partialDevice: string;
  partialInode: string;
};

export type ImportWorkerCheckpoint = {
  objectId: string;
  jobId: string;
  completedBytes: string;
  sourceSnapshot: { fsid: string; size: string; mtime: string };
  downloadLeaseId: string;
  downloadLeaseExpiresAt: number;
  partialPath: string;
  partialDevice: string;
  partialInode: string;
};

export type ImportObjectReceipt = {
  jobId: string;
  objectId: string;
  attempt: number;
  kind: ImportObjectReceiptKind;
  idempotencyKey: string;
  evidence: unknown;
  size?: string;
  sha256?: string;
  destinationAccountId?: string;
  stagingKey?: string;
  committedKey?: string;
  providerRequestId?: string;
};

export type ImportSourceTransferReceipt = {
  transferId: string;
  destinationRoot: string;
  attempt: number;
  state: 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
};

export type ImportRevisionSignal = {
  jobId: string;
  revision: number;
  state: ImportJobState;
  jobBytesVerified: string;
  jobBytesTotal: string;
};

export type ImportWorkerFailureCondition =
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'RETRY_WAIT'
  | 'RESOURCE_WAIT'
  | 'SOURCE_CHANGED'
  | 'DESTINATION_UNAVAILABLE'
  | 'FAILED_SAFE'
  | 'CANCELLED_SAFE';

const WORKER_JOB_SELECT = `
  SELECT id, source_kind AS sourceKind,
         source_connection_id AS sourceConnectionId,
         source_provider AS sourceProvider,
         source_external_account_id AS sourceExternalAccountId,
         source_manifest_revision AS sourceManifestRevision,
         source_manifest_digest AS sourceManifestDigest,
         (SELECT source_manifest_json FROM import_plans WHERE id = import_jobs.plan_id) AS sourceManifestJson,
         selection_json_sanitized AS selectionJson, secret_ref AS secretRef,
         destination_id AS destinationId, destination_kind AS destinationKind,
         state, current_step AS currentStep, revision, object_count AS objectCount,
         job_bytes_total AS jobBytesTotal, attempt
  FROM import_jobs`;

const OBJECT_SELECT = `
  SELECT id, job_id AS jobId, source_fsid AS sourceFsid,
         relative_path AS relativePath, source_size AS sourceSize,
         source_mtime AS sourceMtime, source_reported_md5 AS sourceReportedMd5,
         state, partial_bytes AS partialBytes, local_sha256 AS localSha256,
         destination_account_id AS destinationAccountId, staging_key AS stagingKey,
         committed_key AS committedKey, staging_sha256 AS stagingSha256,
         committed_sha256 AS committedSha256, attempt,
         last_error_code AS lastErrorCode
  FROM import_objects`;

function stateRank(state: string): number {
  const rank = OBJECT_STATE_RANK.get(state as ImportObjectState);
  importInvariant(rank !== undefined, 'IMPORT_OBJECT_STATE_CORRUPT', 500);
  return rank;
}

function validateSha256(value: string | undefined, required: boolean): string | null {
  if (value === undefined) {
    importInvariant(!required, 'IMPORT_WORKER_SHA256_REQUIRED', 409);
    return null;
  }
  importInvariant(/^[0-9a-f]{64}$/.test(value), 'IMPORT_WORKER_SHA256_INVALID', 409);
  return value;
}

function validateRelativePath(value: string): string {
  importInvariant(value.length > 0 && value.length <= 4096, 'IMPORT_OBJECT_PATH_INVALID', 409);
  importInvariant(
    !value.startsWith('/') && !value.startsWith('\\'),
    'IMPORT_OBJECT_PATH_INVALID',
    409,
  );
  importInvariant(!value.includes('\0'), 'IMPORT_OBJECT_PATH_INVALID', 409);
  const segments = value.replaceAll('\\', '/').split('/');
  importInvariant(
    !segments.includes('..') && !segments.includes(''),
    'IMPORT_OBJECT_PATH_INVALID',
    409,
  );
  return value;
}

function validateCheckpointPath(value: string): string {
  importInvariant(
    (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) && !value.includes('\0'),
    'IMPORT_CHECKPOINT_PATH_INVALID',
    409,
  );
  importInvariant(!value.split(/[\\/]/).includes('..'), 'IMPORT_CHECKPOINT_PATH_INVALID', 409);
  return value;
}

function validateDestinationKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  importInvariant(value.length <= 4096, 'IMPORT_DESTINATION_KEY_INVALID', 409);
  validateRelativePath(value);
  sanitizedJson(value, 'destinationKey');
  return value;
}

function objectAlias(relativePath: string): string {
  return `对象 · ${createHash('sha256').update(relativePath).digest('hex').slice(0, 12)}`;
}

export class ImportWorkerRepository {
  private readonly archiveSchema: boolean;
  private readonly groupSchema: boolean;
  destinationCapacity(): ImportDestinationCapacityGate {
    return new ImportDestinationCapacityGate(this.db, () => this.now().getTime());
  }
  constructor(
    private readonly db: AppDatabase,
    private readonly now: Clock = () => new Date(),
  ) {
    const version = Number(
      this.db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() ?? 0,
    );
    importInvariant(version >= REQUIRED_SCHEMA_VERSION, 'IMPORT_SCHEMA_TOO_OLD', 500);
    this.archiveSchema = version >= 41;
    this.groupSchema = version >= 42;
  }

  /** Reconstruct the network failure streak from existing durable progress. */
  networkRetryAttempt(jobId: string): number {
    this.requireJobRow(jobId);
    const progressRow = Number(
      this.db
        .prepare(
          `SELECT COALESCE(MAX(rowid),0) FROM import_events WHERE job_id=? AND event_code IN (
            'IMPORT_DOWNLOAD_CHECKPOINT','IMPORT_ARCHIVE_INPUT_READY',
            'IMPORT_OBJECT_ACQUIRED','IMPORT_OBJECT_HASHED','IMPORT_OBJECT_STAGING_UPLOADED',
            'IMPORT_OBJECT_STAGING_VERIFIED','IMPORT_OBJECT_COMMITTED','IMPORT_OBJECT_COMMITTED_VERIFIED')`,
        )
        .pluck()
        .get(jobId),
    );
    const archiveProgress = this.archiveSchema
      ? Number(
          this.db
            .prepare(
              "SELECT COALESCE(MAX(updated_at),0) FROM archive_inputs WHERE job_id=? AND completed_bytes!='0'",
            )
            .pluck()
            .get(jobId),
        )
      : 0;
    return Number(
      this.db
        .prepare(
          `SELECT count(*) FROM import_events WHERE job_id=? AND event_code IN ('IMPORT_WORKER_STOPPED','IMPORT_DOWNLOAD_RETRY_SCHEDULED')
           AND error_class IN (${SOURCE_NETWORK_RETRY_CODES.map(() => '?').join(',')})
           AND rowid>? AND created_at>=?`,
        )
        .pluck()
        .get(jobId, ...SOURCE_NETWORK_RETRY_CODES, progressRow, archiveProgress),
    );
  }

  /** Local recovery retains this RUNNING owner; the scheduler must not claim it again. */
  recordDownloadRetry(input: {
    jobId: string;
    attempt: number;
    operationKey: string;
    sequence: number;
    retryAt: number;
    errorCode: string;
    downloadDiagnostic?: DownloadFailureDiagnostic;
  }): void {
    this.immediate(() => {
      importInvariant(
        /^(?:manifest-before|manifest-after|[0-9]{1,40})$/.test(input.operationKey) &&
          Number.isSafeInteger(input.sequence) &&
          input.sequence > 0,
        'DOWNLOAD_RETRY_IDENTITY_INVALID',
        409,
      );
      importInvariant(
        SOURCE_NETWORK_RETRY_CODES.some((code) => code === input.errorCode),
        'DOWNLOAD_RETRY_CAUSE_INVALID',
        409,
      );
      const key = `download-retry:${input.jobId}:${input.attempt}:${input.operationKey}:${input.sequence}`;
      const detail = encodeDownloadDiagnostic(input.downloadDiagnostic);
      const prior = this.db
        .prepare(
          'SELECT job_id,event_code,error_class,retry_at,detail_sanitized FROM import_events WHERE idempotency_key=?',
        )
        .get(key) as
        | {
            job_id: string;
            event_code: string;
            error_class: string;
            retry_at: number;
            detail_sanitized: string | null;
          }
        | undefined;
      if (prior) {
        importInvariant(
          prior.job_id === input.jobId &&
            prior.event_code === 'IMPORT_DOWNLOAD_RETRY_SCHEDULED' &&
            prior.error_class === input.errorCode &&
            prior.retry_at === input.retryAt &&
            prior.detail_sanitized === detail,
          'IMPORT_IDEMPOTENCY_CONFLICT',
          409,
        );
        return;
      }
      const row = this.requireJobRow(input.jobId),
        now = this.now().getTime();
      importInvariant(
        this.groupSchema &&
          row.state === 'RUNNING' &&
          row.attempt === input.attempt &&
          this.db
            .prepare('SELECT 1 FROM import_pipeline_groups WHERE job_id=?')
            .get(input.jobId) !== undefined,
        'DOWNLOAD_RETRY_OWNER_INVALID',
        409,
      );
      importInvariant(
        Number.isSafeInteger(input.retryAt) && input.retryAt >= 0 && input.retryAt <= now + 120000,
        'DOWNLOAD_RETRY_TIME_INVALID',
        409,
      );
      this.db
        .prepare(
          `UPDATE import_jobs SET retry_at=?,current_condition=NULL,download_rate_bps=NULL,upload_rate_bps=NULL,verify_rate_bps=NULL,eta_seconds=NULL,rates_sampled_at=NULL,
        revision=revision+1,last_checkpoint_at=?,updated_at=? WHERE id=? AND state='RUNNING' AND attempt=?`,
        )
        .run(input.retryAt, now, now, input.jobId, input.attempt);
      this.db
        .prepare('UPDATE import_pipeline_groups SET wait_kind=NULL,updated_at=? WHERE job_id=?')
        .run(now, input.jobId);
      this.insertEvent({
        jobId: input.jobId,
        code: 'IMPORT_DOWNLOAD_RETRY_SCHEDULED',
        step: row.currentStep,
        detail,
        errorClass: input.errorCode,
        retryAt: input.retryAt,
        idempotencyKey: key,
        createdAt: now,
      });
    });
  }

  pendingStagingQuarantine(owner: QuarantineOwner): StagingQuarantineProof | null {
    this.requireQuarantineOwner(owner);
    const rows = this.db.prepare(`SELECT evidence_json_sanitized AS evidenceJson FROM import_receipts i
      WHERE i.job_id = ? AND i.object_id = ? AND i.kind = 'STAGING_QUARANTINE_INTENT'
      AND NOT EXISTS (SELECT 1 FROM import_receipts d WHERE d.job_id = i.job_id AND d.object_id = i.object_id
        AND d.kind = 'STAGING_QUARANTINED' AND d.evidence_json_sanitized = i.evidence_json_sanitized)`)
      .all(owner.jobId, owner.objectId) as { evidenceJson: string }[];
    importInvariant(rows.length <= 1, 'STAGING_QUARANTINE_MULTIPLE_PENDING', 409);
    if (rows.length === 0) return null;
    const proof = JSON.parse(rows[0]!.evidenceJson) as StagingQuarantineProof;
    this.validateQuarantine(owner, proof);
    return proof;
  }

  recordStagingQuarantine(owner: QuarantineOwner, event: StagingQuarantineEvent): void {
    this.immediate(() => {
      this.validateQuarantine(owner, event);
      // A fixed order makes INTENT and DONE comparable across process/attempt handoff.
      const proof: StagingQuarantineProof = {
        operationId: event.operationId, stagingKey: event.stagingKey, quarantineKey: event.quarantineKey,
        observedSize: event.observedSize, observedSha256: event.observedSha256,
        expectedSize: event.expectedSize, expectedSha256: event.expectedSha256,
      };
      const evidence = sanitizedJson(proof, 'stagingQuarantine.evidence');
      const base = `staging-quarantine:${owner.objectId}:${proof.operationId}`;
      const kind = event.phase === 'INTENT' ? 'STAGING_QUARANTINE_INTENT' : 'STAGING_QUARANTINED';
      if (event.phase === 'DONE') {
        const intent = this.db.prepare(`SELECT evidence_json_sanitized AS evidenceJson FROM import_receipts
          WHERE job_id = ? AND object_id = ? AND idempotency_key = ? AND kind = 'STAGING_QUARANTINE_INTENT'`)
          .get(owner.jobId, owner.objectId, `${base}:INTENT`) as { evidenceJson: string } | undefined;
        importInvariant(intent?.evidenceJson === evidence, 'STAGING_QUARANTINE_INTENT_MISSING', 409);
      } else {
        const pending = this.pendingStagingQuarantine(owner);
        importInvariant(pending === null || pending.operationId === proof.operationId, 'STAGING_QUARANTINE_PENDING', 409);
      }
      const existing = this.db.prepare(`SELECT evidence_json_sanitized AS evidenceJson FROM import_receipts
        WHERE idempotency_key = ?`).get(`${base}:${event.phase}`) as { evidenceJson: string } | undefined;
      if (existing) {
        importInvariant(existing.evidenceJson === evidence, 'STAGING_QUARANTINE_CONFLICT', 409);
        return;
      }
      this.db.prepare(`INSERT INTO import_receipts(id, job_id, object_id, kind, idempotency_key,
        size, sha256, provider_request_id, evidence_json_sanitized, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
        .run(randomUUID(), owner.jobId, owner.objectId, kind, `${base}:${event.phase}`,
          proof.observedSize, proof.observedSha256, evidence, this.now().getTime());
    });
  }

  private requireQuarantineOwner(owner: QuarantineOwner): ImportWorkerObject {
    const job = this.requireRunningJob(owner.jobId);
    importInvariant(job.attempt === owner.jobAttempt, 'IMPORT_WORKER_ATTEMPT_STALE', 409);
    const object = this.requireObjectForAttempt(owner.jobId, owner.objectId, owner.objectAttempt);
    importInvariant(job.destinationId === `onedrive-raw:${owner.destinationAccountId}` ||
      job.destinationId === `onedrive-crypt:${owner.destinationAccountId}`, 'STAGING_QUARANTINE_ACCOUNT_MISMATCH', 409);
    importInvariant(object.destinationAccountId === null || object.destinationAccountId === owner.destinationAccountId,
      'STAGING_QUARANTINE_ACCOUNT_MISMATCH', 409);
    return object;
  }

  private validateQuarantine(owner: QuarantineOwner, proof: StagingQuarantineProof): void {
    const object = this.requireQuarantineOwner(owner);
    importInvariant(typeof proof.operationId === 'string' && /^[a-f0-9-]{36}$/.test(proof.operationId) &&
      /^(?:0|[1-9]\d*)$/.test(proof.observedSize) && /^[a-f0-9]{64}$/.test(proof.observedSha256) &&
      proof.expectedSize === object.sourceSize && proof.expectedSha256 === object.localSha256 &&
      (proof.observedSize !== proof.expectedSize || proof.observedSha256 !== proof.expectedSha256) &&
      (proof.stagingKey === `staging/${owner.jobId}/${owner.objectId}` ||
        proof.stagingKey === `imports/staging/${owner.jobId}/${owner.objectId}`) &&
      (object.stagingKey === null || object.stagingKey === proof.stagingKey) &&
      proof.quarantineKey === `quarantine/${proof.stagingKey}/${proof.observedSize}-${proof.observedSha256}`,
      'STAGING_QUARANTINE_PROOF_INVALID', 409);
  }

  beginDownloadRetry(input: {
    jobId: string;
    attempt: number;
    operationKey: string;
    sequence: number;
  }): void {
    this.immediate(() => {
      importInvariant(
        /^(?:manifest-before|manifest-after|[0-9]{1,40})$/.test(input.operationKey) &&
          Number.isSafeInteger(input.sequence) &&
          input.sequence > 0,
        'DOWNLOAD_RETRY_IDENTITY_INVALID',
        409,
      );
      const key = `download-retry-start:${input.jobId}:${input.attempt}:${input.operationKey}:${input.sequence}`;
      const repeated = this.db
        .prepare('SELECT job_id,event_code FROM import_events WHERE idempotency_key=?')
        .get(key) as { job_id: string; event_code: string } | undefined;
      if (repeated) {
        importInvariant(
          repeated.job_id === input.jobId &&
            repeated.event_code === 'IMPORT_DOWNLOAD_RETRY_STARTED',
          'IMPORT_IDEMPOTENCY_CONFLICT',
          409,
        );
        return;
      }
      const row = this.requireJobRow(input.jobId),
        now = this.now().getTime();
      const activeRetryAt = this.db
        .prepare('SELECT retry_at FROM import_jobs WHERE id=?')
        .pluck()
        .get(input.jobId);
      const scheduled = this.db
        .prepare(
          "SELECT retry_at FROM import_events WHERE idempotency_key=? AND event_code='IMPORT_DOWNLOAD_RETRY_SCHEDULED'",
        )
        .pluck()
        .get(
          `download-retry:${input.jobId}:${input.attempt}:${input.operationKey}:${input.sequence}`,
        );
      importInvariant(
        row.state === 'RUNNING' &&
          row.attempt === input.attempt &&
          typeof scheduled === 'number' &&
          scheduled === activeRetryAt,
        'DOWNLOAD_RETRY_OWNER_INVALID',
        409,
      );
      this.db
        .prepare(
          "UPDATE import_jobs SET retry_at=NULL,revision=revision+1,last_checkpoint_at=?,updated_at=? WHERE id=? AND state='RUNNING' AND attempt=?",
        )
        .run(now, now, input.jobId, input.attempt);
      this.insertEvent({
        jobId: input.jobId,
        code: 'IMPORT_DOWNLOAD_RETRY_STARTED',
        step: row.currentStep,
        detail: null,
        idempotencyKey: key,
        createdAt: now,
      });
    });
  }

  claimNextJob(limits?: { legacy: number; grouped: number }): ImportWorkerJob | null {
    return this.immediate(() => {
      const timestamp = this.now().getTime();
      let limitClause = '';
      if (limits && this.groupSchema) {
        importInvariant(
          [limits.legacy, limits.grouped].every(
            (value) => Number.isInteger(value) && value >= 0 && value <= 8,
          ),
          'IMPORT_CLAIM_LIMIT_INVALID',
          409,
        );
        const counts = this.db
          .prepare(
            `SELECT count(*) AS total,coalesce(sum(CASE WHEN g.job_id IS NOT NULL THEN 1 ELSE 0 END),0) AS grouped FROM import_jobs j LEFT JOIN import_pipeline_groups g ON g.job_id=j.id WHERE j.state='RUNNING'`,
          )
          .get() as { total: number; grouped: number };
        const legacyRoom = counts.total - counts.grouped < limits.legacy,
          groupRoom = counts.grouped < limits.grouped;
        if (!legacyRoom && !groupRoom) return null;
        if (!legacyRoom)
          limitClause =
            'AND EXISTS(SELECT 1 FROM import_pipeline_groups WHERE job_id=import_jobs.id)';
        if (!groupRoom)
          limitClause =
            'AND NOT EXISTS(SELECT 1 FROM import_pipeline_groups WHERE job_id=import_jobs.id)';
      }
      const candidate = this.db
        .prepare(
          `SELECT id FROM import_jobs
           WHERE paused = 0 AND pause_requested_at IS NULL AND cancel_requested_at IS NULL
             AND (
               state = 'QUEUED' OR
               (state = 'RETRY_WAIT' AND retry_at IS NOT NULL AND retry_at <= ?)
             )
             ${
               this.groupSchema
                 ? `AND (NOT EXISTS(SELECT 1 FROM import_pipeline_groups WHERE job_id=import_jobs.id)
               OR EXISTS(SELECT 1 FROM import_pipeline_groups g JOIN import_pipelines p ON p.id=g.pipeline_id
                 WHERE g.job_id=import_jobs.id AND g.admission='ADMITTED' AND p.paused=0 AND p.cancel_requested=0))`
                 : ''
             }
           ${limitClause}
           ORDER BY CASE WHEN state = 'RETRY_WAIT' THEN retry_at ELSE created_at END,
                    created_at, id
           LIMIT 1`,
        )
        .get(timestamp) as { id: string } | undefined;
      if (!candidate) return null;

      const row = this.requireJobRow(candidate.id);
      const changed = this.db
        .prepare(
          `UPDATE import_jobs SET
              state = 'RUNNING', current_condition = NULL, retry_at = NULL,
              resource_wait_kind = NULL, resource_queue_position = NULL,
              resource_wait_since = NULL,
             attempt = attempt + 1, revision = revision + 1,
             started_at = COALESCE(started_at, @timestamp),
             last_checkpoint_at = @timestamp, updated_at = @timestamp
           WHERE id = @jobId AND revision = @revision
             AND state = @state AND paused = 0
             AND pause_requested_at IS NULL AND cancel_requested_at IS NULL`,
        )
        .run({
          timestamp,
          jobId: row.id,
          revision: row.revision,
          state: row.state,
        });
      importInvariant(changed.changes === 1, 'IMPORT_WORKER_CLAIM_CONFLICT', 409);
      const claimed = this.requireJobRow(row.id);
      this.insertEvent({
        jobId: row.id,
        code: 'IMPORT_WORKER_CLAIMED',
        step: claimed.currentStep,
        detail: `attempt:${claimed.attempt}`,
        idempotencyKey: `worker-claim:${row.id}:${claimed.attempt}`,
        createdAt: timestamp,
      });
      return this.mapJob(claimed);
    });
  }

  reconcileInterruptedJobs(): number {
    return this.immediate(() => {
      const rows = this.db
        .prepare(
          `SELECT id, revision, current_step AS currentStep,
                  pause_requested_at AS pauseRequestedAt,
                  cancel_requested_at AS cancelRequestedAt
           FROM import_jobs WHERE state = 'RUNNING'
           ORDER BY created_at, id`,
        )
        .all() as Array<{
        id: string;
        revision: number;
        currentStep: ImportStep;
        pauseRequestedAt: number | null;
        cancelRequestedAt: number | null;
      }>;
      const timestamp = this.now().getTime();
      for (const row of rows) {
        const state: ImportJobState =
          row.cancelRequestedAt !== null
            ? 'CANCELLED_SAFE'
            : row.pauseRequestedAt !== null
              ? 'BLOCKED'
              : 'QUEUED';
        const code =
          state === 'CANCELLED_SAFE'
            ? 'IMPORT_CANCEL_ACKNOWLEDGED'
            : state === 'BLOCKED'
              ? 'IMPORT_PAUSE_ACKNOWLEDGED'
              : 'IMPORT_WORKER_REQUEUED_AFTER_RESTART';
        const changed = this.db
          .prepare(
            `UPDATE import_jobs SET
               state = @state, paused = @paused,
               pause_requested_at = NULL, cancel_requested_at = NULL,
               current_condition = NULL, retry_at = NULL,
               resource_wait_kind = NULL, resource_queue_position = NULL,
               resource_wait_since = NULL,
               revision = revision + 1, last_checkpoint_at = @timestamp,
               updated_at = @timestamp
             WHERE id = @jobId AND revision = @revision AND state = 'RUNNING'`,
          )
          .run({
            state,
            paused: state === 'BLOCKED' ? 1 : 0,
            timestamp,
            jobId: row.id,
            revision: row.revision,
          });
        importInvariant(changed.changes === 1, 'IMPORT_WORKER_RECONCILE_CONFLICT', 409);
        this.insertEvent({
          jobId: row.id,
          code,
          step: row.currentStep,
          detail: null,
          idempotencyKey: `worker-restart:${row.id}:${row.revision}`,
          createdAt: timestamp,
        });
      }
      return rows.length;
    });
  }

  recordResourceWait(
    input: {
      jobId: string;
      position: number;
    } & (
      | { kind: ImportResourceKind; active: number; capacity: number }
      | { kind: 'SPOOL_CAPACITY'; capacity: string }
    ),
  ): void {
    importInvariant(
      Number.isSafeInteger(input.position) && input.position > 0,
      'IMPORT_RESOURCE_WAIT_INVALID',
      409,
    );
    const active = input.kind === 'SPOOL_CAPACITY' ? null : input.active;
    const capacity = input.kind === 'SPOOL_CAPACITY' ? null : input.capacity;
    importInvariant(
      input.kind === 'SPOOL_CAPACITY'
        ? /^(?:0|[1-9][0-9]{0,29})$/.test(input.capacity)
        : Number.isSafeInteger(input.active) &&
            input.active >= 0 &&
            Number.isSafeInteger(input.capacity) &&
            input.capacity > 0,
      'IMPORT_RESOURCE_WAIT_INVALID',
      409,
    );
    this.immediate(() => {
      const current = this.db
        .prepare('SELECT state, resource_wait_kind AS kind FROM import_jobs WHERE id = ?')
        .get(input.jobId) as { state: ImportJobState; kind: string | null } | undefined;
      importInvariant(current !== undefined, 'IMPORT_NOT_FOUND', 404);
      importInvariant(current.state === 'RUNNING', 'IMPORT_WORKER_JOB_NOT_RUNNING', 409);
      const timestamp = this.now().getTime();
      this.db
        .prepare(
          `UPDATE import_jobs SET current_condition = 'RESOURCE_WAIT',
                   resource_wait_kind = ?, resource_queue_position = ?,
                   resource_wait_since = CASE
                     WHEN resource_wait_kind IS ? THEN COALESCE(resource_wait_since, ?)
                     ELSE ? END,
                   resource_wait_active = ?, resource_wait_capacity = ?,
                   download_rate_bps = NULL, upload_rate_bps = NULL,
                   verify_rate_bps = NULL, eta_seconds = NULL, rates_sampled_at = NULL,
                   revision = revision + 1, updated_at = ?
           WHERE id = ? AND state = 'RUNNING'
              AND (resource_wait_kind IS NOT ? OR resource_queue_position IS NOT ?
                OR resource_wait_active IS NOT ? OR resource_wait_capacity IS NOT ?
                OR download_rate_bps IS NOT NULL OR upload_rate_bps IS NOT NULL
                OR verify_rate_bps IS NOT NULL OR eta_seconds IS NOT NULL
                OR rates_sampled_at IS NOT NULL)`,
        )
        .run(
          input.kind,
          input.position,
          input.kind,
          timestamp,
          timestamp,
          active,
          capacity,
          timestamp,
          input.jobId,
          input.kind,
          input.position,
          active,
          capacity,
        );
      if (current.kind === null) {
        this.insertEvent({
          jobId: input.jobId,
          code: 'IMPORT_RESOURCE_WAIT',
          step: this.requireJobRow(input.jobId).currentStep,
          detail: `${input.kind}:position:${input.position}:capacity:${input.capacity}`,
          idempotencyKey: null,
          createdAt: timestamp,
        });
      }
    });
  }

  clearResourceWait(jobId: string, kind: ImportResourceKind | 'SPOOL_CAPACITY'): void {
    this.immediate(() => {
      const timestamp = this.now().getTime();
      const changed = this.db
        .prepare(
          `UPDATE import_jobs SET
             current_condition = CASE WHEN current_condition = 'RESOURCE_WAIT' THEN NULL ELSE current_condition END,
             resource_wait_kind = NULL, resource_queue_position = NULL,
             resource_wait_since = NULL, resource_wait_active = NULL,
             resource_wait_capacity = NULL, revision = revision + 1, updated_at = ?
           WHERE id = ? AND state = 'RUNNING' AND resource_wait_kind = ?`,
        )
        .run(timestamp, jobId, kind);
      if (changed.changes === 1) {
        this.insertEvent({
          jobId,
          code: 'IMPORT_RESOURCE_ACQUIRED',
          step: this.requireJobRow(jobId).currentStep,
          detail: kind,
          idempotencyKey: null,
          createdAt: timestamp,
        });
      }
    });
  }

  addDiscoveredObject(input: DiscoveredImportObject): ImportWorkerObject {
    decimalString(input.sourceFsid, 'sourceFsid');
    decimalString(input.sourceSize, 'sourceSize');
    validateRelativePath(input.relativePath);
    importInvariant(input.sourceMtime.length > 0, 'IMPORT_OBJECT_MTIME_INVALID', 409);
    if (input.sourceReportedMd5 !== undefined) {
      importInvariant(
        /^[0-9a-f]{32}$/i.test(input.sourceReportedMd5),
        'IMPORT_OBJECT_MD5_INVALID',
        409,
      );
    }

    return this.immediate(() => {
      const job = this.requireRunningJob(input.jobId);
      const manifest = readSourceManifest(job.sourceManifestJson, job.sourceManifestDigest);
      if (manifest !== null && job.sourceKind === 'BAIDU_APP_DIR') {
        const expected = manifest.objects.find((object) => object.fsid === input.sourceFsid);
        importInvariant(
          expected !== undefined &&
            expected.relativePath === input.relativePath &&
            expected.size === input.sourceSize &&
            expected.mtime === input.sourceMtime &&
            (expected.md5 ?? null) === (input.sourceReportedMd5?.toLowerCase() ?? null),
          'SOURCE_CHANGED',
          409,
        );
      }
      const existing = this.db
        .prepare(`${OBJECT_SELECT} WHERE job_id = ? AND source_fsid = ?`)
        .get(input.jobId, input.sourceFsid) as ObjectRow | undefined;
      if (existing) {
        importInvariant(
          existing.relativePath === input.relativePath &&
            existing.sourceSize === input.sourceSize &&
            existing.sourceMtime === input.sourceMtime &&
            existing.sourceReportedMd5 === (input.sourceReportedMd5 ?? null),
          'IMPORT_SOURCE_SNAPSHOT_CONFLICT',
          409,
        );
        return this.mapObject(existing);
      }

      const current = this.db
        .prepare('SELECT source_size AS sourceSize FROM import_objects WHERE job_id = ?')
        .all(input.jobId) as Array<{ sourceSize: string }>;
      importInvariant(current.length < job.objectCount, 'IMPORT_DISCOVERY_COUNT_EXCEEDED', 409);
      const discoveredBytes = current.reduce(
        (total, row) => total + BigInt(row.sourceSize),
        BigInt(input.sourceSize),
      );
      importInvariant(
        discoveredBytes <= BigInt(job.jobBytesTotal),
        'IMPORT_DISCOVERY_BYTES_EXCEEDED',
        409,
      );

      const objectId = input.objectId ?? randomUUID();
      const timestamp = this.now().getTime();
      this.db
        .prepare(
          `INSERT INTO import_objects(
             id, job_id, source_fsid, relative_path, source_size, source_mtime,
             source_reported_md5, state, partial_bytes, attempt, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', '0', 0, ?, ?)`,
        )
        .run(
          objectId,
          input.jobId,
          input.sourceFsid,
          input.relativePath,
          input.sourceSize,
          input.sourceMtime,
          input.sourceReportedMd5 ?? null,
          timestamp,
          timestamp,
        );
      this.bumpJob(input.jobId, timestamp, 'DISCOVERING');
      this.insertEvent({
        jobId: input.jobId,
        objectId,
        code: 'IMPORT_OBJECT_DISCOVERED',
        step: 'DISCOVERING',
        detail: null,
        bytes: input.sourceSize,
        idempotencyKey: `worker-discover:${input.jobId}:${input.sourceFsid}`,
        createdAt: timestamp,
      });
      return this.requireObject(objectId);
    });
  }

  finishDiscovery(jobId: string): ImportWorkerJob {
    return this.immediate(() => {
      const job = this.requireRunningJob(jobId);
      const objects = this.db
        .prepare('SELECT source_size AS sourceSize FROM import_objects WHERE job_id = ?')
        .all(jobId) as Array<{ sourceSize: string }>;
      const total = objects.reduce((sum, object) => sum + BigInt(object.sourceSize), 0n);
      importInvariant(objects.length === job.objectCount, 'IMPORT_DISCOVERY_COUNT_MISMATCH', 409);
      importInvariant(total === BigInt(job.jobBytesTotal), 'IMPORT_DISCOVERY_BYTES_MISMATCH', 409);
      if (job.currentStep !== 'SHARE_TRANSFER' && job.currentStep !== 'DISCOVERING') {
        return this.mapJob(job);
      }
      const timestamp = this.now().getTime();
      const changed = this.db
        .prepare(
          `UPDATE import_jobs SET current_step = 'SOURCE_PREFLIGHT',
                  revision = revision + 1, last_checkpoint_at = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND state = 'RUNNING'`,
        )
        .run(timestamp, timestamp, jobId, job.revision);
      importInvariant(changed.changes === 1, 'IMPORT_REVISION_CONFLICT', 409);
      this.insertEvent({
        jobId,
        code: 'IMPORT_DISCOVERY_COMPLETED',
        step: 'SOURCE_PREFLIGHT',
        detail: null,
        bytes: job.jobBytesTotal,
        idempotencyKey: `worker-discovery-complete:${jobId}:${job.revision}`,
        createdAt: timestamp,
      });
      return this.mapJob(this.requireJobRow(jobId));
    });
  }

  claimNextObject(jobId: string): ImportWorkerObject | null {
    return this.immediate(() => {
      this.requireRunningJob(jobId);
      const row = this.db
        .prepare(
          `${OBJECT_SELECT}
           WHERE job_id = ? AND state NOT IN (
             'COMMITTED_VERIFIED', 'CONTROL_PLANE_BACKED_UP', 'SPOOL_CLEANED', 'COMPLETED'
           )
           ORDER BY relative_path, id LIMIT 1`,
        )
        .get(jobId) as ObjectRow | undefined;
      if (!row) return null;
      const timestamp = this.now().getTime();
      const changed = this.db
        .prepare(
          `UPDATE import_objects SET attempt = attempt + 1, updated_at = ?
           WHERE id = ? AND job_id = ? AND attempt = ? AND state = ?`,
        )
        .run(timestamp, row.id, jobId, row.attempt, row.state);
      importInvariant(changed.changes === 1, 'IMPORT_OBJECT_CLAIM_CONFLICT', 409);
      const claimed = this.requireObject(row.id);
      this.db
        .prepare(
          `UPDATE import_jobs SET
             current_object_alias = ?, object_bytes_done = ?, object_bytes_total = ?,
             revision = revision + 1, last_checkpoint_at = ?, updated_at = ?
           WHERE id = ? AND state = 'RUNNING'`,
        )
        .run(
          objectAlias(claimed.relativePath),
          claimed.partialBytes,
          claimed.sourceSize,
          timestamp,
          timestamp,
          jobId,
        );
      this.insertEvent({
        jobId,
        objectId: row.id,
        code: 'IMPORT_OBJECT_CLAIMED',
        step: this.requireJobRow(jobId).currentStep,
        detail: `attempt:${claimed.attempt}`,
        idempotencyKey: `worker-object-claim:${row.id}:${claimed.attempt}`,
        createdAt: timestamp,
      });
      return claimed;
    });
  }

  recordStage(input: {
    jobId: string;
    objectId: string;
    attempt: number;
    stage: ImportWorkerStage;
    evidence?: unknown;
  }): ImportWorkerObject {
    return this.immediate(() => {
      this.requireRunningJob(input.jobId);
      const object = this.requireObjectForAttempt(input.jobId, input.objectId, input.attempt);
      const targetState = STAGE_OBJECT_STATE[input.stage];
      const currentRank = stateRank(object.state);
      const targetRank = stateRank(targetState);
      if (targetRank <= currentRank) return object;
      importInvariant(targetRank === currentRank + 1, 'IMPORT_OBJECT_TRANSITION_INVALID', 409);
      const timestamp = this.now().getTime();
      const changed = this.db
        .prepare(
          `UPDATE import_objects SET state = ?, last_error_code = NULL, updated_at = ?
           WHERE id = ? AND job_id = ? AND attempt = ? AND state = ?`,
        )
        .run(targetState, timestamp, input.objectId, input.jobId, input.attempt, object.state);
      importInvariant(changed.changes === 1, 'IMPORT_OBJECT_TRANSITION_CONFLICT', 409);
      if (input.evidence !== undefined) sanitizedJson(input.evidence, 'stage');
      this.updateJobProgress(input.jobId, input.stage, object, timestamp);
      this.insertEvent({
        jobId: input.jobId,
        objectId: input.objectId,
        code: `IMPORT_STAGE_${input.stage}`,
        step: input.stage,
        detail: null,
        idempotencyKey: `worker-stage:${input.objectId}:${input.stage}:${input.attempt}`,
        createdAt: timestamp,
      });
      return this.requireObject(input.objectId);
    });
  }

  saveCheckpoint(input: ImportDownloadCheckpoint): ImportWorkerObject {
    decimalString(input.completedBytes, 'completedBytes');
    validateCheckpointPath(input.partialPath);
    importInvariant(input.downloadLeaseId.length > 0, 'IMPORT_DOWNLOAD_LEASE_INVALID', 409);
    importInvariant(
      Number.isSafeInteger(input.downloadLeaseExpiresAt) && input.downloadLeaseExpiresAt >= 0,
      'IMPORT_DOWNLOAD_LEASE_INVALID',
      409,
    );
    importInvariant(input.partialDevice.length > 0, 'IMPORT_CHECKPOINT_IDENTITY_INVALID', 409);
    importInvariant(input.partialInode.length > 0, 'IMPORT_CHECKPOINT_IDENTITY_INVALID', 409);

    return this.immediate(() => {
      this.requireRunningJob(input.jobId);
      const object = this.requireObjectForAttempt(input.jobId, input.objectId, input.attempt);
      importInvariant(
        input.sourceSnapshot.fsid === object.sourceFsid &&
          input.sourceSnapshot.size === object.sourceSize &&
          input.sourceSnapshot.mtime === object.sourceMtime,
        'IMPORT_SOURCE_SNAPSHOT_CONFLICT',
        409,
      );
      importInvariant(
        BigInt(input.completedBytes) <= BigInt(object.sourceSize),
        'IMPORT_CHECKPOINT_EXCEEDS_SOURCE',
        409,
      );
      const existing = this.db
        .prepare(
          `SELECT completed_bytes AS completedBytes,
                  source_snapshot_json_sanitized AS sourceSnapshotJson,
                  download_lease_id AS downloadLeaseId,
                  download_lease_expires_at AS downloadLeaseExpiresAt,
                  partial_path AS partialPath, partial_device AS partialDevice,
                  partial_inode AS partialInode
           FROM import_checkpoints WHERE object_id = ?`,
        )
        .get(input.objectId) as
        | {
            completedBytes: string;
            sourceSnapshotJson: string;
            downloadLeaseId: string;
            downloadLeaseExpiresAt: number;
            partialPath: string;
            partialDevice: string;
            partialInode: string;
          }
        | undefined;
      const snapshotJson = sanitizedJson(input.sourceSnapshot, 'sourceSnapshot');
      if (existing) {
        importInvariant(
          BigInt(input.completedBytes) >= BigInt(existing.completedBytes),
          'IMPORT_CHECKPOINT_REGRESSION',
          409,
        );
        if (input.completedBytes === existing.completedBytes) {
          importInvariant(
            existing.sourceSnapshotJson === snapshotJson &&
              existing.partialPath === input.partialPath &&
              existing.partialDevice === input.partialDevice &&
              existing.partialInode === input.partialInode,
            'IMPORT_CHECKPOINT_REPLAY_CONFLICT',
            409,
          );
          if (
            existing.downloadLeaseId !== input.downloadLeaseId ||
            existing.downloadLeaseExpiresAt !== input.downloadLeaseExpiresAt
          ) {
            this.db
              .prepare(
                `UPDATE import_checkpoints SET
                   download_lease_id = ?, download_lease_expires_at = ?, updated_at = ?
                 WHERE object_id = ? AND job_id = ? AND completed_bytes = ?`,
              )
              .run(
                input.downloadLeaseId,
                input.downloadLeaseExpiresAt,
                this.now().getTime(),
                input.objectId,
                input.jobId,
                input.completedBytes,
              );
          }
          return object;
        }
      }

      importInvariant(
        stateRank(object.state) === stateRank('DOWNLOADING'),
        'IMPORT_CHECKPOINT_STATE_INVALID',
        409,
      );
      const timestamp = this.now().getTime();
      this.db
        .prepare(
          `INSERT INTO import_checkpoints(
             object_id, job_id, completed_bytes, source_snapshot_json_sanitized,
             download_lease_id, download_lease_expires_at, partial_path,
             partial_device, partial_inode, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(object_id) DO UPDATE SET
             completed_bytes = excluded.completed_bytes,
             source_snapshot_json_sanitized = excluded.source_snapshot_json_sanitized,
             download_lease_id = excluded.download_lease_id,
             download_lease_expires_at = excluded.download_lease_expires_at,
             partial_path = excluded.partial_path,
             partial_device = excluded.partial_device,
             partial_inode = excluded.partial_inode,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.objectId,
          input.jobId,
          input.completedBytes,
          snapshotJson,
          input.downloadLeaseId,
          input.downloadLeaseExpiresAt,
          input.partialPath,
          input.partialDevice,
          input.partialInode,
          timestamp,
        );
      this.db
        .prepare(
          `UPDATE import_objects SET partial_bytes = ?, updated_at = ?
           WHERE id = ? AND job_id = ? AND attempt = ?`,
        )
        .run(input.completedBytes, timestamp, input.objectId, input.jobId, input.attempt);
      this.db
        .prepare(
          `UPDATE import_jobs SET
             current_step = 'DOWNLOADING', object_bytes_done = ?,
             object_bytes_total = ?, revision = revision + 1,
             last_checkpoint_at = ?, updated_at = ?
           WHERE id = ? AND state = 'RUNNING'`,
        )
        .run(input.completedBytes, object.sourceSize, timestamp, timestamp, input.jobId);
      this.insertEvent({
        jobId: input.jobId,
        objectId: input.objectId,
        code: 'IMPORT_DOWNLOAD_CHECKPOINT',
        step: 'DOWNLOADING',
        detail: null,
        bytes: input.completedBytes,
        idempotencyKey: null,
        createdAt: timestamp,
      });
      return this.requireObject(input.objectId);
    });
  }

  acknowledgeControl(jobId: string, attempt: number): 'CONTINUE' | 'PAUSED' | 'CANCELLED' {
    return this.immediate(() => {
      const row = this.db
        .prepare(
          `SELECT revision, attempt, current_step AS currentStep,
                  pause_requested_at AS pauseRequestedAt,
                  cancel_requested_at AS cancelRequestedAt
           FROM import_jobs WHERE id = ? AND state = 'RUNNING'`,
        )
        .get(jobId) as
        | {
            revision: number;
            attempt: number;
            currentStep: ImportStep;
            pauseRequestedAt: number | null;
            cancelRequestedAt: number | null;
          }
        | undefined;
      importInvariant(row !== undefined, 'IMPORT_WORKER_JOB_NOT_RUNNING', 409);
      importInvariant(row.attempt === attempt, 'IMPORT_WORKER_ATTEMPT_STALE', 409);
      if (row.cancelRequestedAt === null && row.pauseRequestedAt === null) return 'CONTINUE';

      const cancelled = row.cancelRequestedAt !== null;
      const timestamp = this.now().getTime();
      const changed = this.db
        .prepare(
          `UPDATE import_jobs SET
             state = @state, paused = @paused,
             pause_requested_at = NULL, cancel_requested_at = NULL,
             current_condition = NULL, revision = revision + 1,
             last_checkpoint_at = @timestamp, updated_at = @timestamp
           WHERE id = @jobId AND revision = @revision AND state = 'RUNNING'`,
        )
        .run({
          state: cancelled ? 'CANCELLED_SAFE' : 'BLOCKED',
          paused: cancelled ? 0 : 1,
          timestamp,
          jobId,
          revision: row.revision,
        });
      importInvariant(changed.changes === 1, 'IMPORT_REVISION_CONFLICT', 409);
      this.insertEvent({
        jobId,
        code: cancelled ? 'IMPORT_CANCEL_ACKNOWLEDGED' : 'IMPORT_PAUSE_ACKNOWLEDGED',
        step: row.currentStep,
        detail: null,
        idempotencyKey: `worker-control:${jobId}:${row.revision}`,
        createdAt: timestamp,
      });
      return cancelled ? 'CANCELLED' : 'PAUSED';
    });
  }

  /**
   * Latest durable provider task for a share import. A terminal failed task is
   * deliberately returned as null so an explicit worker retry may submit a new
   * task; submitted/confirmed ids survive ordinary process restarts.
   */
  sourceTransfer(jobId: string): ImportSourceTransferReceipt | null {
    this.requireJobRow(jobId);
    const row = this.db
      .prepare(
        `SELECT kind, provider_request_id AS providerRequestId,
                evidence_json_sanitized AS evidenceJson
         FROM import_receipts
         WHERE job_id = ? AND object_id IS NULL
           AND kind IN (
             'SOURCE_TRANSFER_SUBMITTED',
             'SOURCE_TRANSFER_CONFIRMED',
             'SOURCE_TRANSFER_FAILED'
           )
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(jobId) as
      { kind: string; providerRequestId: string | null; evidenceJson: string } | undefined;
    if (row === undefined || row.kind === 'SOURCE_TRANSFER_FAILED') return null;
    let evidence: unknown;
    try {
      evidence = JSON.parse(row.evidenceJson) as unknown;
    } catch {
      throw new ImportControlError('IMPORT_SOURCE_TRANSFER_CORRUPT', 500);
    }
    importInvariant(
      row.providerRequestId !== null &&
        /^(?:0|[1-9][0-9]{0,29})$/.test(row.providerRequestId) &&
        typeof evidence === 'object' &&
        evidence !== null &&
        'destinationRoot' in evidence &&
        typeof evidence.destinationRoot === 'string' &&
        'attempt' in evidence &&
        typeof evidence.attempt === 'number' &&
        Number.isSafeInteger(evidence.attempt) &&
        evidence.attempt >= 1,
      'IMPORT_SOURCE_TRANSFER_CORRUPT',
      500,
    );
    return {
      transferId: row.providerRequestId,
      destinationRoot: evidence.destinationRoot,
      attempt: evidence.attempt,
      state: row.kind === 'SOURCE_TRANSFER_CONFIRMED' ? 'CONFIRMED' : 'SUBMITTED',
    };
  }

  recordSourceTransfer(
    input: ImportSourceTransferReceipt & { jobId: string },
  ): ImportSourceTransferReceipt {
    decimalString(input.transferId, 'sourceTransfer.transferId');
    importInvariant(
      Number.isSafeInteger(input.attempt) && input.attempt >= 1,
      'IMPORT_WORKER_ATTEMPT_INVALID',
      409,
    );
    importInvariant(
      input.destinationRoot.startsWith('/apps/bdpan/') &&
        !input.destinationRoot.endsWith('/') &&
        !input.destinationRoot.includes('\\') &&
        !input.destinationRoot.includes('\0') &&
        !input.destinationRoot.split('/').includes('..'),
      'IMPORT_SOURCE_TRANSFER_PATH_INVALID',
      409,
    );
    const kind = `SOURCE_TRANSFER_${input.state}`;
    const providerRequestId = sanitizedDetail(input.transferId);
    const evidenceJson = sanitizedJson(
      { destinationRoot: input.destinationRoot, attempt: input.attempt },
      'sourceTransfer.evidence',
    );
    const idempotencyKey = [
      'source-transfer',
      input.jobId,
      input.attempt,
      input.transferId,
      input.state,
    ].join(':');

    return this.immediate(() => {
      const repeated = this.db
        .prepare(
          `SELECT job_id AS jobId, object_id AS objectId, kind,
                  provider_request_id AS providerRequestId,
                  evidence_json_sanitized AS evidenceJson
           FROM import_receipts WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as ReceiptRow | undefined;
      if (repeated !== undefined) {
        importInvariant(
          repeated.jobId === input.jobId &&
            repeated.objectId === null &&
            repeated.kind === kind &&
            repeated.providerRequestId === providerRequestId &&
            repeated.evidenceJson === evidenceJson,
          'IMPORT_IDEMPOTENCY_CONFLICT',
          409,
        );
        return { ...input };
      }

      const job = this.requireRunningJob(input.jobId);
      importInvariant(job.attempt === input.attempt, 'IMPORT_WORKER_ATTEMPT_STALE', 409);
      if (input.state !== 'SUBMITTED') {
        const submitted = this.db
          .prepare(
            `SELECT 1 FROM import_receipts
             WHERE job_id = ? AND object_id IS NULL
               AND kind = 'SOURCE_TRANSFER_SUBMITTED' AND provider_request_id = ?`,
          )
          .get(input.jobId, providerRequestId);
        importInvariant(submitted !== undefined, 'IMPORT_SOURCE_TRANSFER_NOT_SUBMITTED', 409);
      }
      const timestamp = this.now().getTime();
      this.db
        .prepare(
          `INSERT INTO import_receipts(
             id, job_id, object_id, kind, idempotency_key, size, sha256,
             provider_request_id, evidence_json_sanitized, created_at
           ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.jobId,
          kind,
          idempotencyKey,
          providerRequestId,
          evidenceJson,
          timestamp,
        );
      this.bumpJob(input.jobId, timestamp, 'SHARE_TRANSFER');
      this.insertEvent({
        jobId: input.jobId,
        code: `IMPORT_${kind}`,
        step: 'SHARE_TRANSFER',
        detail: null,
        providerRequestId,
        idempotencyKey: null,
        createdAt: timestamp,
      });
      return { ...input };
    });
  }

  recordReceipt(input: ImportObjectReceipt): ImportWorkerObject {
    importInvariant(input.idempotencyKey.length >= 8, 'IMPORT_IDEMPOTENCY_INVALID', 409);
    const size = input.size === undefined ? null : decimalString(input.size, 'receipt.size');
    importInvariant(size !== null, 'IMPORT_RECEIPT_SIZE_REQUIRED', 409);
    const requiresHash =
      input.kind === 'HASHED' ||
      input.kind === 'STAGING_VERIFIED' ||
      input.kind === 'COMMITTED_VERIFIED';
    const sha256 = validateSha256(input.sha256, requiresHash);
    const evidenceJson = sanitizedJson(input.evidence, 'receipt.evidence');
    const providerRequestId = sanitizedDetail(input.providerRequestId);
    const inputStagingKey = validateDestinationKey(input.stagingKey);
    const inputCommittedKey = validateDestinationKey(input.committedKey);

    return this.immediate(() => {
      const repeated = this.db
        .prepare(
          `SELECT job_id AS jobId, object_id AS objectId, kind, size, sha256,
                  provider_request_id AS providerRequestId,
                  evidence_json_sanitized AS evidenceJson
           FROM import_receipts WHERE idempotency_key = ?`,
        )
        .get(input.idempotencyKey) as ReceiptRow | undefined;
      if (repeated) {
        importInvariant(
          repeated.jobId === input.jobId &&
            repeated.objectId === input.objectId &&
            repeated.kind === input.kind &&
            repeated.size === size &&
            repeated.sha256 === sha256 &&
            repeated.providerRequestId === providerRequestId &&
            repeated.evidenceJson === evidenceJson,
          'IMPORT_IDEMPOTENCY_CONFLICT',
          409,
        );
        return this.requireObject(input.objectId);
      }

      this.requireRunningJob(input.jobId);
      const object = this.requireObjectForAttempt(input.jobId, input.objectId, input.attempt);
      const targetState = RECEIPT_OBJECT_STATE[input.kind];
      importInvariant(
        stateRank(targetState) === stateRank(object.state) + 1,
        'IMPORT_OBJECT_TRANSITION_INVALID',
        409,
      );
      if (size !== null) {
        importInvariant(size === object.sourceSize, 'IMPORT_RECEIPT_SIZE_MISMATCH', 409);
      }
      if (requiresHash && object.localSha256 !== null) {
        importInvariant(sha256 === object.localSha256, 'IMPORT_RECEIPT_HASH_MISMATCH', 409);
      }
      if (input.kind === 'STAGING_VERIFIED' && object.stagingKey !== null) {
        importInvariant(inputStagingKey === object.stagingKey, 'IMPORT_STAGING_KEY_MISMATCH', 409);
      }
      if (
        (input.kind === 'COMMITTED' || input.kind === 'COMMITTED_VERIFIED') &&
        object.committedKey !== null
      ) {
        importInvariant(
          inputCommittedKey === object.committedKey,
          'IMPORT_COMMIT_KEY_MISMATCH',
          409,
        );
      }

      const timestamp = this.now().getTime();
      const destinationAccountId = input.destinationAccountId ?? object.destinationAccountId;
      const stagingKey = inputStagingKey ?? object.stagingKey;
      const committedKey = inputCommittedKey ?? object.committedKey;
      if (
        input.kind === 'STAGING_UPLOADED' ||
        input.kind === 'STAGING_VERIFIED' ||
        input.kind === 'COMMITTED' ||
        input.kind === 'COMMITTED_VERIFIED'
      ) {
        importInvariant(
          destinationAccountId !== null && stagingKey !== null,
          'IMPORT_DESTINATION_EVIDENCE_REQUIRED',
          409,
        );
      }
      if (input.kind === 'COMMITTED' || input.kind === 'COMMITTED_VERIFIED') {
        importInvariant(committedKey !== null, 'IMPORT_DESTINATION_EVIDENCE_REQUIRED', 409);
      }

      const changed = this.db
        .prepare(
          `UPDATE import_objects SET
             state = @state,
             partial_bytes = CASE WHEN @size IS NULL THEN partial_bytes ELSE @size END,
             local_sha256 = CASE WHEN @kind = 'HASHED' THEN @sha256 ELSE local_sha256 END,
             destination_account_id = COALESCE(@destinationAccountId, destination_account_id),
             staging_key = COALESCE(@stagingKey, staging_key),
             committed_key = COALESCE(@committedKey, committed_key),
             staging_sha256 = CASE
               WHEN @kind = 'STAGING_VERIFIED' THEN @sha256 ELSE staging_sha256 END,
             committed_sha256 = CASE
               WHEN @kind = 'COMMITTED_VERIFIED' THEN @sha256 ELSE committed_sha256 END,
             last_error_code = NULL, updated_at = @timestamp
           WHERE id = @objectId AND job_id = @jobId AND attempt = @attempt AND state = @fromState`,
        )
        .run({
          state: targetState,
          size,
          kind: input.kind,
          sha256,
          destinationAccountId,
          stagingKey,
          committedKey,
          timestamp,
          objectId: input.objectId,
          jobId: input.jobId,
          attempt: input.attempt,
          fromState: object.state,
        });
      importInvariant(changed.changes === 1, 'IMPORT_OBJECT_TRANSITION_CONFLICT', 409);
      this.db
        .prepare(
          `INSERT INTO import_receipts(
             id, job_id, object_id, kind, idempotency_key, size, sha256,
             provider_request_id, evidence_json_sanitized, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.jobId,
          input.objectId,
          input.kind,
          input.idempotencyKey,
          size,
          sha256,
          providerRequestId,
          evidenceJson,
          timestamp,
        );
      this.updateDestinationCommit({
        jobId: input.jobId,
        objectId: input.objectId,
        kind: input.kind,
        ...(providerRequestId === null ? {} : { providerRequestId }),
        destinationAccountId,
        stagingKey,
        committedKey,
        evidenceJson,
        timestamp,
      });
      const updated = this.requireObject(input.objectId);
      this.updateJobProgress(input.jobId, RECEIPT_STEP[input.kind], updated, timestamp);
      this.insertEvent({
        jobId: input.jobId,
        objectId: input.objectId,
        code: `IMPORT_OBJECT_${targetState}`,
        step: RECEIPT_STEP[input.kind],
        detail: null,
        bytes: size,
        providerRequestId,
        idempotencyKey: null,
        createdAt: timestamp,
      });
      return updated;
    });
  }

  recordControlPlaneBackup(input: {
    jobId: string;
    idempotencyKey: string;
    size: string;
    sha256: string;
    evidence: unknown;
  }): ImportWorkerJob {
    decimalString(input.size, 'backup.size');
    validateSha256(input.sha256, true);
    const evidenceJson = sanitizedJson(input.evidence, 'backup.evidence');
    return this.immediate(() => {
      const repeated = this.db
        .prepare(
          `SELECT job_id AS jobId, object_id AS objectId, kind, size, sha256,
                  provider_request_id AS providerRequestId,
                  evidence_json_sanitized AS evidenceJson
           FROM import_receipts WHERE idempotency_key = ?`,
        )
        .get(input.idempotencyKey) as ReceiptRow | undefined;
      if (repeated) {
        importInvariant(
          repeated.jobId === input.jobId &&
            repeated.objectId === null &&
            repeated.kind === 'CONTROL_PLANE_BACKUP' &&
            repeated.size === input.size &&
            repeated.sha256 === input.sha256 &&
            repeated.evidenceJson === evidenceJson,
          'IMPORT_IDEMPOTENCY_CONFLICT',
          409,
        );
        return this.mapJob(this.requireJobRow(input.jobId));
      }

      const job = this.requireRunningJob(input.jobId);
      const objects = this.listObjectRows(input.jobId);
      importInvariant(
        objects.length === job.objectCount,
        'IMPORT_BACKUP_OBJECT_COUNT_MISMATCH',
        409,
      );
      importInvariant(
        objects.every((object) => object.state === 'COMMITTED_VERIFIED'),
        'IMPORT_COMMITTED_VERIFY_REQUIRED',
        409,
      );
      importInvariant(input.size === job.jobBytesTotal, 'IMPORT_BACKUP_SIZE_MISMATCH', 409);
      const timestamp = this.now().getTime();
      this.db
        .prepare(
          `INSERT INTO import_receipts(
             id, job_id, object_id, kind, idempotency_key, size, sha256,
             provider_request_id, evidence_json_sanitized, created_at
           ) VALUES (?, ?, NULL, 'CONTROL_PLANE_BACKUP', ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.jobId,
          input.idempotencyKey,
          input.size,
          input.sha256,
          evidenceJson,
          timestamp,
        );
      this.db
        .prepare(
          `UPDATE import_objects SET state = 'CONTROL_PLANE_BACKED_UP', updated_at = ?
           WHERE job_id = ? AND state = 'COMMITTED_VERIFIED'`,
        )
        .run(timestamp, input.jobId);
      const changed = this.db
        .prepare(
          `UPDATE import_jobs SET
             current_step = 'SPOOL_CLEANUP', job_bytes_verified = job_bytes_total,
             object_index = object_count, object_bytes_done = object_bytes_total,
             revision = revision + 1, last_checkpoint_at = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND state = 'RUNNING'`,
        )
        .run(timestamp, timestamp, input.jobId, job.revision);
      importInvariant(changed.changes === 1, 'IMPORT_REVISION_CONFLICT', 409);
      this.insertEvent({
        jobId: input.jobId,
        code: 'IMPORT_CONTROL_PLANE_BACKED_UP',
        step: 'CONTROL_PLANE_BACKUP',
        detail: null,
        bytes: input.size,
        idempotencyKey: null,
        createdAt: timestamp,
      });
      return this.mapJob(this.requireJobRow(input.jobId));
    });
  }

  markControlPlaneBackupPending(jobId: string, attempt: number): ImportWorkerJob {
    return this.immediate(() => {
      const job = this.requireRunningJob(jobId);
      importInvariant(job.attempt === attempt, 'IMPORT_WORKER_ATTEMPT_STALE', 409);
      if (job.currentStep === 'CONTROL_PLANE_BACKUP') return this.mapJob(job);
      const objects = this.listObjectRows(jobId);
      importInvariant(
        objects.length === job.objectCount &&
          objects.every((object) => object.state === 'COMMITTED_VERIFIED'),
        'IMPORT_COMMITTED_VERIFY_REQUIRED',
        409,
      );
      const timestamp = this.now().getTime();
      const changed = this.db
        .prepare(
          `UPDATE import_jobs SET current_step = 'CONTROL_PLANE_BACKUP',
                  revision = revision + 1, last_checkpoint_at = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND attempt = ? AND state = 'RUNNING'`,
        )
        .run(timestamp, timestamp, jobId, job.revision, attempt);
      importInvariant(changed.changes === 1, 'IMPORT_REVISION_CONFLICT', 409);
      this.insertEvent({
        jobId,
        code: 'IMPORT_CONTROL_PLANE_BACKUP_PENDING',
        step: 'CONTROL_PLANE_BACKUP',
        detail: null,
        idempotencyKey: `worker-control-plane-pending:${jobId}`,
        createdAt: timestamp,
      });
      return this.mapJob(this.requireJobRow(jobId));
    });
  }

  recordSpoolCleaned(input: {
    jobId: string;
    objectId: string;
    attempt: number;
    idempotencyKey: string;
    evidence: unknown;
  }): ImportWorkerObject {
    const evidenceJson = sanitizedJson(input.evidence, 'spoolCleanup.evidence');
    return this.immediate(() => {
      const repeated = this.db
        .prepare(
          `SELECT job_id AS jobId, object_id AS objectId, kind, size, sha256,
                  provider_request_id AS providerRequestId,
                  evidence_json_sanitized AS evidenceJson
           FROM import_receipts WHERE idempotency_key = ?`,
        )
        .get(input.idempotencyKey) as ReceiptRow | undefined;
      if (repeated) {
        importInvariant(
          repeated.jobId === input.jobId &&
            repeated.objectId === input.objectId &&
            repeated.kind === 'SPOOL_CLEANED' &&
            repeated.evidenceJson === evidenceJson,
          'IMPORT_IDEMPOTENCY_CONFLICT',
          409,
        );
        return this.requireObject(input.objectId);
      }
      this.requireRunningJob(input.jobId);
      const object = this.requireObjectForAttempt(input.jobId, input.objectId, input.attempt);
      importInvariant(object.state === 'CONTROL_PLANE_BACKED_UP', 'IMPORT_BACKUP_REQUIRED', 409);
      const timestamp = this.now().getTime();
      const changed = this.db
        .prepare(
          `UPDATE import_objects SET state = 'SPOOL_CLEANED', updated_at = ?
           WHERE id = ? AND job_id = ? AND attempt = ? AND state = 'CONTROL_PLANE_BACKED_UP'`,
        )
        .run(timestamp, input.objectId, input.jobId, input.attempt);
      importInvariant(changed.changes === 1, 'IMPORT_OBJECT_TRANSITION_CONFLICT', 409);
      this.db
        .prepare(
          `INSERT INTO import_receipts(
             id, job_id, object_id, kind, idempotency_key, size, sha256,
             provider_request_id, evidence_json_sanitized, created_at
           ) VALUES (?, ?, ?, 'SPOOL_CLEANED', ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.jobId,
          input.objectId,
          input.idempotencyKey,
          object.sourceSize,
          object.localSha256,
          evidenceJson,
          timestamp,
        );
      this.bumpJob(input.jobId, timestamp, 'SPOOL_CLEANUP');
      this.insertEvent({
        jobId: input.jobId,
        objectId: input.objectId,
        code: 'IMPORT_SPOOL_CLEANED',
        step: 'SPOOL_CLEANUP',
        detail: null,
        bytes: object.sourceSize,
        idempotencyKey: null,
        createdAt: timestamp,
      });
      return this.requireObject(input.objectId);
    });
  }

  completeJob(jobId: string): ImportWorkerJob {
    return this.immediate(() => {
      const row = this.requireJobRow(jobId);
      if (row.state === 'COMPLETED') return this.mapJob(row);
      const job = this.requireRunningJob(jobId);
      const backup = this.db
        .prepare("SELECT 1 FROM import_receipts WHERE job_id = ? AND kind = 'CONTROL_PLANE_BACKUP'")
        .get(jobId);
      importInvariant(backup !== undefined, 'IMPORT_BACKUP_REQUIRED', 409);
      const objects = this.listObjectRows(jobId);
      importInvariant(objects.length === job.objectCount, 'IMPORT_OBJECT_COUNT_MISMATCH', 409);
      importInvariant(
        objects.every((object) => object.state === 'SPOOL_CLEANED'),
        'IMPORT_SPOOL_CLEANUP_REQUIRED',
        409,
      );
      const timestamp = this.now().getTime();
      this.db
        .prepare(
          `UPDATE import_objects SET state = 'COMPLETED', updated_at = ?
           WHERE job_id = ? AND state = 'SPOOL_CLEANED'`,
        )
        .run(timestamp, jobId);
      const changed = this.db
        .prepare(
          `UPDATE import_jobs SET
             state = 'COMPLETED', current_step = 'COMPLETED', current_condition = NULL,
             retry_at = NULL, current_object_alias = NULL,
             object_index = object_count, object_bytes_done = object_bytes_total,
             job_bytes_verified = job_bytes_total, revision = revision + 1,
             completed_at = ?, last_checkpoint_at = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND state = 'RUNNING'`,
        )
        .run(timestamp, timestamp, timestamp, jobId, job.revision);
      importInvariant(changed.changes === 1, 'IMPORT_REVISION_CONFLICT', 409);
      this.insertEvent({
        jobId,
        code: 'IMPORT_COMPLETED',
        step: 'COMPLETED',
        detail: null,
        bytes: job.jobBytesTotal,
        idempotencyKey: `worker-completed:${jobId}`,
        createdAt: timestamp,
      });
      return this.mapJob(this.requireJobRow(jobId));
    });
  }

  recordFailure(input: {
    jobId: string;
    jobAttempt: number;
    objectId?: string;
    objectAttempt?: number;
    condition: ImportWorkerFailureCondition;
    errorCode: string;
    retryAt?: number;
    downloadDiagnostic?: DownloadFailureDiagnostic;
  }): ImportWorkerJob {
    importInvariant(
      /^[A-Z][A-Z0-9_]{2,79}$/.test(input.errorCode),
      'IMPORT_WORKER_ERROR_CODE_INVALID',
      409,
    );
    if (input.retryAt !== undefined) {
      importInvariant(
        Number.isSafeInteger(input.retryAt) && input.retryAt >= 0,
        'IMPORT_RETRY_AT_INVALID',
        409,
      );
    }
    if (input.condition === 'RATE_LIMITED' || input.condition === 'RETRY_WAIT') {
      importInvariant(input.retryAt !== undefined, 'IMPORT_RETRY_AT_REQUIRED', 409);
    }
    if (input.objectId !== undefined) {
      importInvariant(input.objectAttempt !== undefined, 'IMPORT_WORKER_ATTEMPT_REQUIRED', 409);
    }

    const diagnosticDetail = encodeDownloadDiagnostic(input.downloadDiagnostic);
    const detail =
      diagnosticDetail ??
      (input.errorCode === 'DESTINATION_CAPACITY_WAIT' ? 'DESTINATION_CAPACITY_WAIT' : null);
    const idempotencyKey = [
      'worker-failure',
      input.jobId,
      input.jobAttempt,
      input.objectId ?? 'job',
      input.condition,
    ].join(':');
    return this.immediate(() => {
      const repeated = this.db
        .prepare(
          `SELECT job_id AS jobId, event_code AS eventCode,
                  error_class AS errorClass, retry_at AS retryAt, detail_sanitized AS detail
           FROM import_events WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as
        | {
            jobId: string;
            eventCode: string;
            errorClass: string | null;
            retryAt: number | null;
            detail: string | null;
          }
        | undefined;
      if (repeated) {
        importInvariant(
          repeated.jobId === input.jobId &&
            repeated.eventCode === 'IMPORT_WORKER_STOPPED' &&
            repeated.errorClass === input.errorCode &&
            repeated.retryAt === (input.retryAt ?? null) &&
            repeated.detail === detail,
          'IMPORT_IDEMPOTENCY_CONFLICT',
          409,
        );
        return this.mapJob(this.requireJobRow(input.jobId));
      }

      const job = this.requireRunningJob(input.jobId);
      importInvariant(job.attempt === input.jobAttempt, 'IMPORT_WORKER_ATTEMPT_STALE', 409);
      if (input.objectId !== undefined) {
        this.requireObjectForAttempt(input.jobId, input.objectId, input.objectAttempt!);
      }
      const retryable =
        input.condition === 'RATE_LIMITED' ||
        input.condition === 'RETRY_WAIT' ||
        (input.condition === 'RESOURCE_WAIT' && input.retryAt !== undefined) ||
        (input.condition === 'DESTINATION_UNAVAILABLE' && input.retryAt !== undefined);
      const state: ImportJobState =
        input.condition === 'FAILED_SAFE'
          ? 'FAILED_SAFE'
          : input.condition === 'CANCELLED_SAFE'
            ? 'CANCELLED_SAFE'
            : retryable
              ? 'RETRY_WAIT'
              : 'BLOCKED';
      const currentCondition =
        input.condition === 'FAILED_SAFE' || input.condition === 'CANCELLED_SAFE'
          ? null
          : input.condition === 'RETRY_WAIT'
            ? null
            : input.condition;
      const timestamp = this.now().getTime();
      const changed = this.db
        .prepare(
          `UPDATE import_jobs SET
             state = @state, current_condition = @currentCondition,
             retry_at = @retryAt, revision = revision + 1,
             download_rate_bps = NULL, upload_rate_bps = NULL, verify_rate_bps = NULL,
             eta_seconds = NULL, rates_sampled_at = NULL,
             last_checkpoint_at = @timestamp, updated_at = @timestamp
           WHERE id = @jobId AND revision = @revision
             AND attempt = @attempt AND state = 'RUNNING'`,
        )
        .run({
          state,
          currentCondition,
          retryAt: input.retryAt ?? null,
          timestamp,
          jobId: input.jobId,
          revision: job.revision,
          attempt: input.jobAttempt,
        });
      importInvariant(changed.changes === 1, 'IMPORT_REVISION_CONFLICT', 409);
      if (input.objectId !== undefined) {
        this.db
          .prepare(
            `UPDATE import_objects SET last_error_code = ?, updated_at = ?
             WHERE id = ? AND job_id = ? AND attempt = ?`,
          )
          .run(input.errorCode, timestamp, input.objectId, input.jobId, input.objectAttempt!);
      }
      this.db
        .prepare(
          `INSERT INTO import_attempts(
             id, job_id, object_id, stage, started_at, ended_at,
             outcome, error_class, retry_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.jobId,
          input.objectId ?? null,
          job.currentStep,
          timestamp,
          timestamp,
          state,
          input.errorCode,
          input.retryAt ?? null,
        );
      this.insertEvent({
        jobId: input.jobId,
        ...(input.objectId === undefined ? {} : { objectId: input.objectId }),
        code: 'IMPORT_WORKER_STOPPED',
        step: job.currentStep,
        detail,
        errorClass: input.errorCode,
        retryAt: input.retryAt ?? null,
        idempotencyKey,
        createdAt: timestamp,
      });
      return this.mapJob(this.requireJobRow(input.jobId));
    });
  }

  revisionSignals(): ImportRevisionSignal[] {
    return this.db
      .prepare(
        `SELECT id AS jobId, revision, state,
                job_bytes_verified AS jobBytesVerified,
                job_bytes_total AS jobBytesTotal
         FROM import_jobs ORDER BY created_at, id`,
      )
      .all() as ImportRevisionSignal[];
  }

  controlPlaneBackup(jobId: string): {
    size: string;
    sha256: string;
    evidence: unknown;
  } | null {
    this.requireJobRow(jobId);
    const row = this.db
      .prepare(
        `SELECT size, sha256, evidence_json_sanitized AS evidenceJson
         FROM import_receipts
         WHERE job_id = ? AND object_id IS NULL AND kind = 'CONTROL_PLANE_BACKUP'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(jobId) as
      { size: string | null; sha256: string | null; evidenceJson: string } | undefined;
    if (row === undefined) return null;
    importInvariant(row.size !== null && row.sha256 !== null, 'IMPORT_BACKUP_CORRUPT', 500);
    let evidence: unknown;
    try {
      evidence = JSON.parse(row.evidenceJson) as unknown;
    } catch {
      throw new ImportControlError('IMPORT_BACKUP_CORRUPT', 500);
    }
    return { size: row.size, sha256: row.sha256, evidence };
  }

  requireJob(jobId: string): ImportWorkerJob {
    return this.mapJob(this.requireJobRow(jobId));
  }

  listObjects(jobId: string): ImportWorkerObject[] {
    this.requireJobRow(jobId);
    return this.listObjectRows(jobId).map((row) => this.mapObject(row));
  }

  checkpoint(objectId: string): ImportWorkerCheckpoint | null {
    const object = this.requireObject(objectId);
    const row = this.db
      .prepare(
        `SELECT object_id AS objectId, job_id AS jobId,
                completed_bytes AS completedBytes,
                source_snapshot_json_sanitized AS sourceSnapshotJson,
                download_lease_id AS downloadLeaseId,
                download_lease_expires_at AS downloadLeaseExpiresAt,
                partial_path AS partialPath, partial_device AS partialDevice,
                partial_inode AS partialInode
         FROM import_checkpoints WHERE object_id = ?`,
      )
      .get(objectId) as
      | {
          objectId: string;
          jobId: string;
          completedBytes: string;
          sourceSnapshotJson: string;
          downloadLeaseId: string | null;
          downloadLeaseExpiresAt: number | null;
          partialPath: string;
          partialDevice: string | null;
          partialInode: string | null;
        }
      | undefined;
    if (row === undefined) return null;
    let sourceSnapshot: unknown;
    try {
      sourceSnapshot = JSON.parse(row.sourceSnapshotJson) as unknown;
    } catch {
      throw new ImportControlError('IMPORT_SOURCE_SNAPSHOT_CORRUPT', 500);
    }
    importInvariant(
      typeof sourceSnapshot === 'object' &&
        sourceSnapshot !== null &&
        'fsid' in sourceSnapshot &&
        'size' in sourceSnapshot &&
        'mtime' in sourceSnapshot &&
        typeof sourceSnapshot.fsid === 'string' &&
        typeof sourceSnapshot.size === 'string' &&
        typeof sourceSnapshot.mtime === 'string' &&
        row.jobId === object.jobId &&
        row.completedBytes === object.partialBytes &&
        sourceSnapshot.fsid === object.sourceFsid &&
        sourceSnapshot.size === object.sourceSize &&
        sourceSnapshot.mtime === object.sourceMtime &&
        row.downloadLeaseId !== null &&
        row.downloadLeaseExpiresAt !== null &&
        row.partialDevice !== null &&
        row.partialInode !== null,
      'IMPORT_CHECKPOINT_CORRUPT',
      500,
    );
    return {
      objectId: row.objectId,
      jobId: row.jobId,
      completedBytes: row.completedBytes,
      sourceSnapshot: {
        fsid: sourceSnapshot.fsid,
        size: sourceSnapshot.size,
        mtime: sourceSnapshot.mtime,
      },
      downloadLeaseId: row.downloadLeaseId,
      downloadLeaseExpiresAt: row.downloadLeaseExpiresAt,
      partialPath: row.partialPath,
      partialDevice: row.partialDevice,
      partialInode: row.partialInode,
    };
  }

  requireObject(objectId: string): ImportWorkerObject {
    const row = this.db.prepare(`${OBJECT_SELECT} WHERE id = ?`).get(objectId) as
      ObjectRow | undefined;
    importInvariant(row !== undefined, 'IMPORT_OBJECT_NOT_FOUND', 404);
    return this.mapObject(row);
  }

  private requireJobRow(jobId: string): WorkerJobRow {
    const row = this.db.prepare(`${WORKER_JOB_SELECT} WHERE id = ?`).get(jobId) as
      WorkerJobRow | undefined;
    importInvariant(row !== undefined, 'IMPORT_NOT_FOUND', 404);
    return row;
  }

  private requireRunningJob(jobId: string): WorkerJobRow {
    const row = this.requireJobRow(jobId);
    importInvariant(row.state === 'RUNNING', 'IMPORT_WORKER_JOB_NOT_RUNNING', 409);
    return row;
  }

  private requireObjectForAttempt(
    jobId: string,
    objectId: string,
    attempt: number,
  ): ImportWorkerObject {
    const object = this.requireObject(objectId);
    importInvariant(object.jobId === jobId, 'IMPORT_OBJECT_JOB_MISMATCH', 409);
    importInvariant(object.attempt === attempt, 'IMPORT_WORKER_ATTEMPT_STALE', 409);
    return object;
  }

  private listObjectRows(jobId: string): ObjectRow[] {
    return this.db
      .prepare(`${OBJECT_SELECT} WHERE job_id = ? ORDER BY relative_path, id`)
      .all(jobId) as ObjectRow[];
  }

  private mapJob(row: WorkerJobRow): ImportWorkerJob {
    let selection: unknown;
    try {
      selection = JSON.parse(row.selectionJson) as unknown;
    } catch {
      throw new ImportControlError('IMPORT_SELECTION_CORRUPT', 500);
    }
    return {
      jobId: row.id,
      sourceKind: row.sourceKind,
      sourceConnectionId: row.sourceConnectionId,
      sourceProvider: row.sourceProvider,
      sourceExternalAccountId: row.sourceExternalAccountId,
      sourceManifestRevision: row.sourceManifestRevision,
      sourceManifest: readSourceManifest(row.sourceManifestJson, row.sourceManifestDigest),
      sourceManifestDigest: row.sourceManifestDigest,
      selection,
      secretRef: row.secretRef,
      destinationId: row.destinationId,
      destinationKind: row.destinationKind,
      state: row.state,
      currentStep: row.currentStep,
      revision: row.revision,
      objectCount: row.objectCount,
      jobBytesTotal: row.jobBytesTotal,
      attempt: row.attempt,
    };
  }

  private mapObject(row: ObjectRow): ImportWorkerObject {
    stateRank(row.state);
    const origin = this.archiveSchema
      ? (this.db
          .prepare(
            'SELECT origin_kind AS kind,origin_digest AS digest FROM import_objects WHERE id=?',
          )
          .get(row.id) as { kind: string; digest: string | null } | undefined)
      : undefined;
    return {
      objectId: row.id,
      ...(origin?.kind === 'EXTRACTED' && origin.digest !== null
        ? { originKind: 'EXTRACTED' as const, originDigest: origin.digest }
        : {}),
      jobId: row.jobId,
      sourceFsid: row.sourceFsid,
      relativePath: row.relativePath,
      sourceSize: row.sourceSize,
      sourceMtime: row.sourceMtime,
      sourceReportedMd5: row.sourceReportedMd5,
      state: row.state as ImportObjectState,
      partialBytes: row.partialBytes,
      localSha256: row.localSha256,
      destinationAccountId: row.destinationAccountId,
      stagingKey: row.stagingKey,
      committedKey: row.committedKey,
      stagingSha256: row.stagingSha256,
      committedSha256: row.committedSha256,
      attempt: row.attempt,
      lastErrorCode: row.lastErrorCode,
    };
  }

  private updateJobProgress(
    jobId: string,
    step: ImportStep,
    object: ImportWorkerObject,
    timestamp: number,
  ): void {
    const objects = this.listObjectRows(jobId);
    const verifiedRank = stateRank('COMMITTED_VERIFIED');
    const verified = objects
      .filter((item) => stateRank(item.state) >= verifiedRank)
      .reduce((total, item) => total + BigInt(item.sourceSize), 0n)
      .toString();
    const verifiedCount = objects.filter((item) => stateRank(item.state) >= verifiedRank).length;
    const current = this.requireObject(object.objectId);
    const changed = this.db
      .prepare(
        `UPDATE import_jobs SET
           current_step = ?, object_index = ?, current_object_alias = ?,
           object_bytes_done = ?, object_bytes_total = ?, job_bytes_verified = ?,
           revision = revision + 1, last_checkpoint_at = ?, updated_at = ?
         WHERE id = ? AND state = 'RUNNING'`,
      )
      .run(
        step,
        verifiedCount,
        objectAlias(current.relativePath),
        current.partialBytes,
        current.sourceSize,
        verified,
        timestamp,
        timestamp,
        jobId,
      );
    importInvariant(changed.changes === 1, 'IMPORT_WORKER_JOB_NOT_RUNNING', 409);
  }

  private updateDestinationCommit(input: {
    jobId: string;
    objectId: string;
    kind: ImportObjectReceiptKind;
    providerRequestId?: string;
    destinationAccountId: string | null;
    stagingKey: string | null;
    committedKey: string | null;
    evidenceJson: string;
    timestamp: number;
  }): void {
    if (
      input.kind !== 'STAGING_UPLOADED' &&
      input.kind !== 'STAGING_VERIFIED' &&
      input.kind !== 'COMMITTED' &&
      input.kind !== 'COMMITTED_VERIFIED'
    ) {
      return;
    }
    importInvariant(
      input.destinationAccountId !== null && input.stagingKey !== null,
      'IMPORT_DESTINATION_EVIDENCE_REQUIRED',
      409,
    );
    const committedKey = input.committedKey ?? input.stagingKey;
    this.db
      .prepare(
        `INSERT INTO destination_commits(
           job_id, object_id, destination_account_id, staging_key, committed_key,
           commit_state, provider_request_id, committed_at, committed_stat_json_sanitized
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, object_id, destination_account_id) DO UPDATE SET
           staging_key = excluded.staging_key,
           committed_key = excluded.committed_key,
           commit_state = excluded.commit_state,
           provider_request_id = COALESCE(excluded.provider_request_id, provider_request_id),
           committed_at = COALESCE(excluded.committed_at, committed_at),
           committed_stat_json_sanitized = COALESCE(
             excluded.committed_stat_json_sanitized,
             committed_stat_json_sanitized
           )`,
      )
      .run(
        input.jobId,
        input.objectId,
        input.destinationAccountId,
        input.stagingKey,
        committedKey,
        input.kind,
        input.providerRequestId ?? null,
        input.kind === 'COMMITTED' || input.kind === 'COMMITTED_VERIFIED' ? input.timestamp : null,
        input.kind === 'COMMITTED_VERIFIED' ? input.evidenceJson : null,
      );
  }

  private bumpJob(jobId: string, timestamp: number, step: ImportStep): void {
    const changed = this.db
      .prepare(
        `UPDATE import_jobs SET current_step = ?, revision = revision + 1,
                last_checkpoint_at = ?, updated_at = ?
         WHERE id = ? AND state = 'RUNNING'`,
      )
      .run(step, timestamp, timestamp, jobId);
    importInvariant(changed.changes === 1, 'IMPORT_WORKER_JOB_NOT_RUNNING', 409);
  }

  private insertEvent(input: {
    jobId: string;
    objectId?: string;
    code: string;
    step: ImportStep | null;
    detail: string | null;
    bytes?: string | null;
    providerRequestId?: string | null;
    errorClass?: string | null;
    retryAt?: number | null;
    idempotencyKey: string | null;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO import_events(
           id, job_id, object_id, event_code, idempotency_key, step,
           detail_sanitized, bytes, error_class, provider_request_id, retry_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.jobId,
        input.objectId ?? null,
        input.code,
        input.idempotencyKey,
        input.step,
        sanitizedDetail(input.detail),
        input.bytes ?? null,
        input.errorClass ?? null,
        input.providerRequestId ?? null,
        input.retryAt ?? null,
        input.createdAt,
      );
  }

  private immediate<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }
}
