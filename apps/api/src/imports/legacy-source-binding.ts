import { createHash, randomUUID } from 'node:crypto';
import type { LegacyImportSourceBinding } from '@ptvault/contracts';
import type { AppDatabase } from '../db/database.js';
import { ImportControlError, importInvariant } from './errors.js';
import {
  buildSourceManifest,
  canonicalSourceManifest,
  type BaiduDirectorySnapshot,
  type ImportSourceManifest,
} from './source-manifest.js';
import type { ImportWorkerJob } from './worker-repository.js';

type LegacyJob = {
  id: string;
  planId: string;
  sourceKind: string;
  sourceConnectionId: string | null;
  sourceProvider: string | null;
  sourceExternalAccountId: string | null;
  sourceManifestRevision: number | null;
  selectionJson: string;
  revision: number;
  state: string;
  count: number;
  bytes: string;
};
type LegacyObject = {
  fsid: string;
  relativePath: string;
  size: string;
  mtime: string;
  md5: string | null;
};
type BindingRow = {
  planId: string;
  connectionId: string;
  externalAccountId: string;
  bindingRevision: number;
  proofJson: string;
  proofDigest: string;
};
const BINDING = `SELECT plan_id AS planId,connection_id AS connectionId,external_account_id AS externalAccountId,binding_revision AS bindingRevision,
  proof_json AS proofJson,proof_digest AS proofDigest FROM legacy_import_source_bindings WHERE job_id=?`;

function objects(db: AppDatabase, jobId: string): LegacyObject[] {
  return db
    .prepare(
      `SELECT source_fsid AS fsid,relative_path AS relativePath,source_size AS size,source_mtime AS mtime,
    source_reported_md5 AS md5 FROM import_objects WHERE job_id=? ORDER BY source_fsid`,
    )
    .all(jobId) as LegacyObject[];
}

function matches(snapshot: ImportSourceManifest, frozen: LegacyObject[]): boolean {
  const byFsid = new Map(snapshot.objects.map((object) => [object.fsid, object]));
  return (
    snapshot.objects.length === frozen.length &&
    frozen.every((entry) => {
      const object = byFsid.get(entry.fsid);
      return (
        object !== undefined &&
        object.relativePath === entry.relativePath &&
        object.size === entry.size &&
        object.mtime === entry.mtime &&
        (entry.md5 === null || object.md5 === entry.md5.toLowerCase())
      );
    })
  );
}

export type LegacyImportSourceBindInput = {
  jobId: string;
  sourceConnectionId: string;
  expectedRevision: number;
  confirmSameSourceIdentity: true;
  operation?: { adminId: string; idempotencyKey: string };
};

function requestFingerprint(input: LegacyImportSourceBindInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.jobId,
        input.sourceConnectionId,
        input.expectedRevision,
        input.confirmSameSourceIdentity,
      ]),
    )
    .digest('hex');
}

export type LegacyImportSourceBindingOptions = {
  db: AppDatabase;
  providers: {
    resolve(binding: { sourceConnectionId: string; sourceExternalAccountId: string }): {
      snapshotAppDirectory(input: { sourcePath: string }): Promise<BaiduDirectorySnapshot>;
    };
  };
  now?: () => number;
};

/** Explicit repair of a known complete historical snapshot, never a provider default. */
export class LegacyImportSourceBindingService {
  private readonly now: () => number;
  constructor(private readonly options: LegacyImportSourceBindingOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  status(jobId: string): LegacyImportSourceBinding {
    const job = this.job(jobId);
    const binding = this.options.db.prepare(BINDING).get(jobId) as BindingRow | undefined;
    const frozen = objects(this.options.db, jobId);
    const complete =
      job.count > 0 &&
      frozen.length === job.count &&
      frozen.reduce((sum, object) => sum + BigInt(object.size), 0n).toString() === job.bytes;
    const identity = [
      job.sourceConnectionId,
      job.sourceProvider,
      job.sourceExternalAccountId,
      job.sourceManifestRevision,
    ];
    const state =
      identity.every((value) => value !== null) || job.sourceKind === 'OTHER'
        ? 'NOT_REQUIRED'
        : identity.some((value) => value !== null)
          ? 'REPLAN_REQUIRED'
          : binding !== undefined
            ? 'VERIFIED'
            : complete
              ? 'IDENTITY_REQUIRED'
              : 'REPLAN_REQUIRED';
    return {
      jobId,
      planId: job.planId,
      state,
      sourceConnectionId: job.sourceConnectionId ?? binding?.connectionId ?? null,
      replanRequired: state === 'REPLAN_REQUIRED',
      nextStep:
        state === 'NOT_REQUIRED'
          ? 'NONE'
          : state === 'VERIFIED'
            ? 'RETRY_OR_RESUME'
            : state === 'REPLAN_REQUIRED'
              ? 'REPLAN_PRESERVE_ARCHIVE'
              : 'SELECT_ENV_CONNECTION',
    };
  }

  replay(input: LegacyImportSourceBindInput): LegacyImportSourceBinding | null {
    if (input.operation === undefined) return null;
    const row = this.options.db
      .prepare(
        `SELECT job_id AS jobId,request_fingerprint AS fingerprint
      FROM legacy_import_binding_operations WHERE admin_id=? AND idempotency_key=?`,
      )
      .get(input.operation.adminId, input.operation.idempotencyKey) as
      { jobId: string; fingerprint: string } | undefined;
    if (row === undefined) return null;
    importInvariant(
      row.jobId === input.jobId && row.fingerprint === requestFingerprint(input),
      'IMPORT_IDEMPOTENCY_CONFLICT',
      409,
    );
    return this.status(input.jobId);
  }

  async bind(input: LegacyImportSourceBindInput): Promise<LegacyImportSourceBinding> {
    importInvariant(
      input.confirmSameSourceIdentity === true,
      'AUTH_LEGACY_CONFIRMATION_REQUIRED',
      409,
    );
    const replay = this.replay(input);
    if (replay !== null) return replay;
    const db = this.options.db;
    const job = this.job(input.jobId);
    const prior = db.prepare(BINDING).get(job.id) as BindingRow | undefined;
    if (prior !== undefined) {
      importInvariant(
        prior.connectionId === input.sourceConnectionId,
        'AUTH_LEGACY_BINDING_CONFLICT',
        409,
      );
      db.transaction(() => this.recordOperation(input)).immediate();
      return this.status(job.id);
    }
    importInvariant(
      job.sourceConnectionId === null && ['BAIDU_SHARE', 'BAIDU_APP_DIR'].includes(job.sourceKind),
      'AUTH_LEGACY_BINDING_NOT_APPLICABLE',
      409,
    );
    importInvariant(
      job.state !== 'RUNNING' && job.revision === input.expectedRevision,
      'IMPORT_REVISION_CONFLICT',
      409,
    );
    importInvariant(!this.status(job.id).replanRequired, 'AUTH_LEGACY_REPLAN_REQUIRED', 409);
    const frozen = objects(db, job.id);
    const connection = this.connection(input.sourceConnectionId);
    const selection = JSON.parse(job.selectionJson) as { sourcePath?: string };
    let root = selection.sourcePath;
    if (job.sourceKind === 'BAIDU_SHARE') {
      const receipt = db
        .prepare(
          `SELECT evidence_json_sanitized AS evidence FROM import_receipts WHERE job_id=? AND kind='SOURCE_TRANSFER_CONFIRMED' AND object_id IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        )
        .get(job.id) as { evidence: string } | undefined;
      importInvariant(receipt !== undefined, 'AUTH_LEGACY_REPLAN_REQUIRED', 409);
      const evidence = JSON.parse(receipt.evidence) as { destinationRoot?: string };
      root = evidence.destinationRoot;
      importInvariant(
        root === `/apps/bdpan/ptvault-imports/${job.id}`,
        'AUTH_LEGACY_REPLAN_REQUIRED',
        409,
      );
    }
    importInvariant(
      typeof root === 'string' && root.startsWith('/apps/bdpan/'),
      'AUTH_LEGACY_REPLAN_REQUIRED',
      409,
    );
    const gateway = this.options.providers.resolve({
      sourceConnectionId: input.sourceConnectionId,
      sourceExternalAccountId: connection.externalAccountId,
    });
    const snapshot = await gateway.snapshotAppDirectory({ sourcePath: root });
    const directory = snapshot.directories.find((entry) => entry.path === root);
    importInvariant(directory !== undefined, 'SOURCE_CHANGED', 409);
    const manifest = buildSourceManifest('BAIDU_APP_DIR', root, directory.fsid, snapshot);
    importInvariant(matches(manifest, frozen), 'SOURCE_CHANGED', 409);
    const proofJson = JSON.stringify(manifest);
    db.transaction(() => {
      if (this.replay(input) !== null) return;
      const liveJob = this.job(job.id);
      const live = this.connection(input.sourceConnectionId);
      importInvariant(
        liveJob.state !== 'RUNNING' && liveJob.revision === job.revision,
        'IMPORT_REVISION_CONFLICT',
        409,
      );
      importInvariant(
        live.revision === connection.revision &&
          live.externalAccountId === connection.externalAccountId &&
          live.secretRef === connection.secretRef,
        'AUTH_REQUIRED',
        409,
      );
      importInvariant(
        JSON.stringify(objects(db, job.id)) === JSON.stringify(frozen),
        'SOURCE_CHANGED',
        409,
      );
      db.prepare(
        `INSERT INTO legacy_import_source_bindings(job_id,plan_id,connection_id,external_account_id,binding_revision,proof_json,proof_digest,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        job.id,
        job.planId,
        input.sourceConnectionId,
        connection.externalAccountId,
        connection.revision,
        proofJson,
        createHash('sha256').update(proofJson).digest('hex'),
        this.now(),
      );
      db.prepare(
        `UPDATE import_jobs SET current_condition=CASE WHEN current_condition='AUTH_REQUIRED' THEN NULL ELSE current_condition END,
        revision=revision+1,updated_at=? WHERE id=? AND revision=?`,
      ).run(this.now(), job.id, job.revision);
      db.prepare(
        `INSERT INTO import_events(id,job_id,event_code,detail_sanitized,created_at) VALUES (?,?,'IMPORT_LEGACY_SOURCE_BOUND',?,?)`,
      ).run(
        randomUUID(),
        job.id,
        'Explicit identity confirmation; complete source snapshot revalidated; historical journals preserved',
        this.now(),
      );
      this.recordOperation(input);
    }).immediate();
    return this.status(job.id);
  }

  private recordOperation(input: LegacyImportSourceBindInput): void {
    if (input.operation === undefined || this.replay(input) !== null) return;
    this.options.db
      .prepare(
        `INSERT INTO legacy_import_binding_operations(admin_id,idempotency_key,job_id,request_fingerprint,created_at)
      VALUES (?,?,?,?,?)`,
      )
      .run(
        input.operation.adminId,
        input.operation.idempotencyKey,
        input.jobId,
        requestFingerprint(input),
        this.now(),
      );
  }

  private connection(id: string) {
    const row = this.options.db
      .prepare(
        `SELECT connection.external_account_id AS externalAccountId,connection.revision,connection.secret_ref AS secretRef
      FROM cloud_connections AS connection JOIN legacy_environment_connections AS legacy ON legacy.connection_id=connection.id
      LEFT JOIN cloud_connection_runtime AS runtime ON runtime.connection_id=connection.id
      WHERE connection.id=? AND connection.provider='BAIDU' AND connection.auth_state='CONNECTED' AND connection.secret_ref IS NOT NULL
        AND (runtime.rate_limited_until IS NULL OR runtime.rate_limited_until<=?)`,
      )
      .get(id, this.now()) as
      { externalAccountId: string; revision: number; secretRef: string } | undefined;
    importInvariant(row !== undefined, 'AUTH_REQUIRED', 409);
    return row;
  }

  private job(id: string): LegacyJob {
    const row = this.options.db
      .prepare(
        `SELECT id,plan_id AS planId,source_kind AS sourceKind,source_connection_id AS sourceConnectionId,
      source_provider AS sourceProvider,source_external_account_id AS sourceExternalAccountId,source_manifest_revision AS sourceManifestRevision,
      selection_json_sanitized AS selectionJson,revision,state,object_count AS count,job_bytes_total AS bytes FROM import_jobs WHERE id=?`,
      )
      .get(id) as LegacyJob | undefined;
    if (row === undefined) throw new ImportControlError('IMPORT_NOT_FOUND', 404);
    return row;
  }
}

export function legacyBoundSourceJob(
  db: AppDatabase,
  job: ImportWorkerJob,
): { job: ImportWorkerJob; manifest: ImportSourceManifest | null } {
  if (
    job.sourceConnectionId != null ||
    job.sourceProvider != null ||
    job.sourceExternalAccountId != null ||
    job.sourceManifestRevision != null
  )
    return { job, manifest: null };
  const row = db.prepare(BINDING).get(job.jobId) as BindingRow | undefined;
  if (row === undefined) throw new ImportControlError('AUTH_LEGACY_BINDING_REQUIRED', 409);
  importInvariant(
    row.planId === db.prepare('SELECT plan_id FROM import_jobs WHERE id=?').pluck().get(job.jobId),
    'SOURCE_CHANGED',
    409,
  );
  importInvariant(
    createHash('sha256').update(row.proofJson).digest('hex') === row.proofDigest,
    'SOURCE_CHANGED',
    409,
  );
  const manifest = canonicalSourceManifest(JSON.parse(row.proofJson));
  importInvariant(matches(manifest, objects(db, job.jobId)), 'SOURCE_CHANGED', 409);
  return {
    job: {
      ...job,
      sourceConnectionId: row.connectionId,
      sourceProvider: 'BAIDU',
      sourceExternalAccountId: row.externalAccountId,
      sourceManifestRevision: row.bindingRevision,
    },
    manifest,
  };
}
