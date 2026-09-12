import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  ArchiveJobStatusSchema,
  ArchiveProcessingOptionsSchema,
  type ArchiveJobStatus,
  type ArchiveProcessingOptions,
  type ArchiveRetryImpact,
} from '@ptvault/contracts';
import type { AppDatabase } from '../../db/database.js';
import type { ImportSourceManifest } from '../source-manifest.js';
import { isArchiveSourceManifest, readSourceManifest } from '../source-manifest.js';
import { projectArchiveRetryImpact, unknownRetryImpact, type RetryOutput } from './retry-impact.js';
import type { ImportWorkerJob } from '../worker-repository.js';
import type { ReadyEvidence } from '../data-plane/spool.js';
import type { ArchiveProgress } from './engine.js';
import { archiveAssert, normalizeArchiveMember } from './inspection.js';
import { sanitizedDetail, sanitizedJson } from '../security.js';

const decimal = z.string().regex(/^(?:0|[1-9]\d{0,29})$/);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const OutputSchema = z
  .object({
    objectId: z.string().uuid(),
    localId: z.string().regex(/^[1-9]\d{0,9}$/),
    absolutePath: z
      .string()
      .max(8192)
      .refine((value) => path.isAbsolute(value)),
    relativePath: z.string().min(1).max(4096),
    size: decimal.refine((value) => BigInt(value) > 0n),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PreparedArchiveOutput = z.infer<typeof OutputSchema>;
const PreparedSchema = z
  .object({
    version: z.literal(1),
    sourceManifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    inputs: z
      .array(
        z
          .object({
            fsid: decimal,
            size: decimal,
            mtime: decimal,
            relativePath: z.string(),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .min(1),
    outputs: z.array(OutputSchema).min(1).max(100000),
  })
  .strict();
export type PreparedArchive = z.infer<typeof PreparedSchema>;
export type ArchiveInput = {
  jobId: string;
  sourceFsid: string;
  objectId: string;
  relativePath: string;
  sourceSize: string;
  sourceMtime: string;
  state: 'PENDING' | 'DOWNLOADING' | 'READY' | 'CLEANED';
  completedBytes: string;
  partialDevice: string | null;
  partialInode: string | null;
  readyDevice: string | null;
  readyInode: string | null;
  localSha256: string | null;
  updatedAt: number;
};
type ArchiveRow = {
  jobId: string;
  phase: ArchiveJobStatus['phase'];
  optionsJson: string;
  secretRef: string | null;
  candidateCount: number;
  inputCount: number;
  inputBytes: string;
  inputBytesDone: string;
  expandedBytes: string;
  videoCount: number;
  videoBytes: string;
  depth: number;
  archiveCount: number;
  candidateIndex: number | null;
  preparedJson: string | null;
  preparedDigest: string | null;
  lastErrorCode: string | null;
};
const SELECT = `SELECT job_id AS jobId,phase,options_json AS optionsJson,secret_ref AS secretRef,candidate_count AS candidateCount,
  input_count AS inputCount,input_bytes AS inputBytes,input_bytes_done AS inputBytesDone,expanded_bytes AS expandedBytes,
  video_count AS videoCount,video_bytes AS videoBytes,depth,archive_count AS archiveCount,candidate_index AS candidateIndex,
  prepared_json AS preparedJson,prepared_digest AS preparedDigest,last_error_code AS lastErrorCode FROM archive_imports`;
const INPUTS = `SELECT job_id AS jobId,source_fsid AS sourceFsid,object_id AS objectId,relative_path AS relativePath,source_size AS sourceSize,
  source_mtime AS sourceMtime,state,completed_bytes AS completedBytes,partial_device AS partialDevice,partial_inode AS partialInode,
  ready_device AS readyDevice,ready_inode AS readyInode,local_sha256 AS localSha256,updated_at AS updatedAt FROM archive_inputs`;

/** Original compressed objects and locally derived upload objects have separate identities. */
export class ArchiveRepository {
  private readonly enabled: boolean;
  private readonly groupsEnabled: boolean;
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {
    this.enabled =
      Number(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() ?? 0) >= 41;
    this.groupsEnabled = Number(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() ?? 0) >= 42;
  }

  initialize(jobId: string, manifest: ImportSourceManifest, selection: unknown): void {
    archiveAssert(this.enabled && isArchiveSourceManifest(manifest), 'ARCHIVE_SCHEMA_REQUIRED');
    archiveAssert(
      typeof selection === 'object' && selection !== null && 'archiveIngress' in selection,
      'ARCHIVE_CREDENTIAL_INVALID',
    );
    const ingress = z
      .object({
        ref: z
          .string()
          .regex(/^archive-secret:[0-9a-f-]{36}$/)
          .nullable(),
        count: z.number().int().min(0).max(32),
      })
      .strict()
      .safeParse(selection.archiveIngress);
    archiveAssert(
      ingress.success && (ingress.data.ref === null) === (ingress.data.count === 0),
      'ARCHIVE_CREDENTIAL_INVALID',
    );
    const options: ArchiveProcessingOptions = {
      mode: manifest.archive.mode,
      maxDepth: manifest.archive.maxDepth,
      maxFiles: manifest.archive.maxFiles,
      maxExpandedBytes: manifest.archive.maxExpandedBytes,
    };
    const inputBytes = manifest.objects
        .reduce((sum, object) => sum + BigInt(object.size), 0n)
        .toString(),
      timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO archive_imports(job_id,phase,options_json,secret_ref,candidate_count,input_count,input_bytes,created_at,updated_at)
      VALUES (?,'PENDING',?,?,?,?,?,?,?)`,
      )
      .run(
        jobId,
        JSON.stringify(options),
        ingress.data.ref,
        ingress.data.count,
        manifest.objects.length,
        inputBytes,
        timestamp,
        timestamp,
      );
    const insert = this.db.prepare(
      `INSERT INTO archive_inputs(job_id,source_fsid,object_id,relative_path,source_size,source_mtime,updated_at) VALUES (?,?,?,?,?,?,?)`,
    );
    for (const object of manifest.objects)
      insert.run(
        jobId,
        object.fsid,
        randomUUID(),
        object.relativePath,
        object.size,
        object.mtime,
        timestamp,
      );
  }

  status(jobId: string, includeRetryImpact = false): ArchiveJobStatus | null {
    if (!this.enabled) return null;
    return this.db.transaction(() => {
    const row = this.find(jobId);
    if (row === null) return null;
    const options = ArchiveProcessingOptionsSchema.parse(JSON.parse(row.optionsJson));
    return ArchiveJobStatusSchema.parse({
      mode: 'RECURSIVE_VIDEO',
      phase: row.phase,
      inputCount: row.inputCount,
      inputBytes: row.inputBytes,
      inputBytesDone: row.inputBytesDone,
      videoCount: row.videoCount,
      videoBytes: row.videoBytes,
      depth: row.depth,
      archiveCount: row.archiveCount,
      expandedBytes: row.expandedBytes,
      candidateIndex: row.candidateIndex,
      candidateCount: row.candidateCount,
      maxDepth: options.maxDepth,
      maxExpandedBytes: options.maxExpandedBytes,
      lastErrorCode: row.lastErrorCode,
      ...(includeRetryImpact ? { retryImpact: this.retryImpact(jobId) ?? undefined } : {}),
    });
    })();
  }
  retryImpact(jobId: string): ArchiveRetryImpact | null {
    if (!this.enabled) return null;
    return this.db.transaction(() => {
      const row = this.find(jobId);
      if (row === null) return null;
      const sampledAt = this.now();
      try {
        const job = this.db.prepare('SELECT plan.source_manifest_json AS json,job.source_manifest_digest AS digest FROM import_jobs AS job JOIN import_plans AS plan ON plan.id=job.plan_id WHERE job.id=?').get(jobId) as { json: string; digest: string };
        const manifest = readSourceManifest(job.json, job.digest);
        if (manifest === null) return unknownRetryImpact(sampledAt);
        const evicting = this.groupsEnabled && this.db.prepare("SELECT 1 FROM import_pipeline_groups WHERE job_id=? AND admission='EVICTING'").get(jobId) !== undefined;
        const outputs = this.db.prepare(`SELECT id,source_fsid AS sourceFsid,relative_path AS relativePath,source_size AS sourceSize,source_mtime AS sourceMtime,state,local_sha256 AS localSha256,origin_kind AS originKind,origin_digest AS originDigest FROM import_objects WHERE job_id=?`).all(jobId) as RetryOutput[];
        return projectArchiveRetryImpact({ ...row, sourceDigest: job.digest, manifest, prepared: this.prepared(jobId), inputs: this.inputs(jobId), outputs, evicting, sampledAt });
      } catch {
        // A damaged checkpoint must not break the read-only task page or weaken worker checks.
        return unknownRetryImpact(sampledAt);
      }
    })();
  }
  inputs(jobId: string): ArchiveInput[] {
    this.require(jobId);
    return this.db
      .prepare(`${INPUTS} WHERE job_id=? ORDER BY relative_path,source_fsid`)
      .all(jobId) as ArchiveInput[];
  }
  completedInputBytes(jobId: string): string {
    return this.require(jobId).inputBytesDone;
  }
  options(jobId: string): ArchiveProcessingOptions {
    return ArchiveProcessingOptionsSchema.parse(JSON.parse(this.require(jobId).optionsJson));
  }
  secretRef(jobId: string): string | null {
    return this.require(jobId).secretRef;
  }
  requiredSpoolBytes(jobId: string): string {
    const row = this.require(jobId);
    return (BigInt(row.inputBytes) + BigInt(this.options(jobId).maxExpandedBytes)).toString();
  }

  credentialReplay(input: {
    jobId: string;
    adminId: string;
    idempotencyKey: string;
    fingerprint: string;
  }): boolean {
    const existing = this.db
      .prepare(
        'SELECT job_id AS jobId,request_fingerprint AS fingerprint FROM archive_credential_operations WHERE admin_id=? AND idempotency_key=?',
      )
      .get(input.adminId, input.idempotencyKey) as
      { jobId: string; fingerprint: string } | undefined;
    if (existing === undefined) return false;
    archiveAssert(
      existing.jobId === input.jobId && existing.fingerprint === input.fingerprint,
      'IMPORT_IDEMPOTENCY_CONFLICT',
    );
    return true;
  }
  assertCredentialUpdate(jobId: string, expectedRevision: number): void {
    const row = this.require(jobId),
      job = this.db
        .prepare('SELECT state,current_condition AS condition,revision FROM import_jobs WHERE id=?')
        .get(jobId) as { state: string; condition: string | null; revision: number };
    archiveAssert(job.revision === expectedRevision, 'IMPORT_REVISION_CONFLICT');
    archiveAssert(
      job.state === 'BLOCKED' &&
        job.condition === 'AUTH_REQUIRED' &&
        row.phase === 'WAITING_PASSWORD' &&
        row.preparedJson === null,
      'IMPORT_ACTION_CONFLICT',
    );
  }
  updateCredentials(input: {
    jobId: string;
    adminId: string;
    idempotencyKey: string;
    fingerprint: string;
    expectedRevision: number;
    ref: string;
    count: number;
  }): void {
    this.db
      .transaction(() => {
        if (this.credentialReplay(input)) return;
        this.assertCredentialUpdate(input.jobId, input.expectedRevision);
        archiveAssert(
          /^archive-secret:[0-9a-f-]{36}$/.test(input.ref) && input.count > 0 && input.count <= 32,
          'ARCHIVE_CREDENTIAL_INVALID',
        );
        const now = this.now();
        this.db
          .prepare(
            `UPDATE archive_imports SET secret_ref=?,candidate_count=?,candidate_index=NULL,phase='PENDING',last_error_code=NULL,updated_at=? WHERE job_id=?`,
          )
          .run(input.ref, input.count, now, input.jobId);
        // Password ingress is not implicit permission to start network work.
        this.db
          .prepare(
            `UPDATE import_jobs SET paused=1,pause_requested_at=NULL,current_condition=NULL,revision=revision+1,last_checkpoint_at=?,updated_at=? WHERE id=?`,
          )
          .run(now, now, input.jobId);
        this.db
          .prepare(
            'INSERT INTO archive_credential_operations(admin_id,idempotency_key,job_id,request_fingerprint,created_at) VALUES (?,?,?,?,?)',
          )
          .run(input.adminId, input.idempotencyKey, input.jobId, input.fingerprint, now);
        this.event(input.jobId, 'IMPORT_ARCHIVE_CANDIDATES_UPDATED', 'LOCAL_LANDING');
      })
      .immediate();
  }

  checkpoint(
    job: ImportWorkerJob,
    fsid: string,
    checkpoint: {
      completedBytes: string;
      partialDevice: string;
      partialInode: string;
      downloadRateBps?: string | null;
    },
  ): void {
    this.db
      .transaction(() => {
        this.assertRunning(job);
        const input = this.input(job.jobId, fsid);
        archiveAssert(
          decimal.safeParse(checkpoint.completedBytes).success &&
            (checkpoint.downloadRateBps === undefined ||
              checkpoint.downloadRateBps === null ||
              decimal.safeParse(checkpoint.downloadRateBps).success) &&
            BigInt(checkpoint.completedBytes) >= BigInt(input.completedBytes) &&
            BigInt(checkpoint.completedBytes) <= BigInt(input.sourceSize) &&
            ['PENDING', 'DOWNLOADING'].includes(input.state) &&
            (input.partialDevice === null ||
              (input.partialDevice === checkpoint.partialDevice &&
                input.partialInode === checkpoint.partialInode)),
          'ARCHIVE_CHECKPOINT_CONFLICT',
        );
        const timestamp = this.now(),
          elapsed = timestamp - input.updatedAt,
          delta = BigInt(checkpoint.completedBytes) - BigInt(input.completedBytes);
        this.db
          .prepare(
            `UPDATE archive_inputs SET state='DOWNLOADING',completed_bytes=?,partial_device=?,partial_inode=?,updated_at=? WHERE job_id=? AND source_fsid=?`,
          )
          .run(
            checkpoint.completedBytes,
            checkpoint.partialDevice,
            checkpoint.partialInode,
            timestamp,
            job.jobId,
            fsid,
          );
        const total = this.inputs(job.jobId)
          .reduce((sum, x) => sum + BigInt(x.completedBytes), 0n)
          .toString();
        this.db
          .prepare(
            `UPDATE archive_imports SET phase='DOWNLOADING_INPUTS',input_bytes_done=?,last_error_code=NULL,updated_at=? WHERE job_id=?`,
          )
          .run(total, timestamp, job.jobId);
        this.db
          .prepare(
            `UPDATE import_jobs SET current_step='DOWNLOADING',current_object_alias=?,object_bytes_done=?,object_bytes_total=?,
        download_rate_bps=?,upload_rate_bps=NULL,verify_rate_bps=NULL,eta_seconds=NULL,rates_sampled_at=?,revision=revision+1,last_checkpoint_at=?,updated_at=? WHERE id=?`,
          )
          .run(
            `压缩分卷 · ${sha(input.relativePath).slice(0, 12)}`,
            checkpoint.completedBytes,
            input.sourceSize,
            checkpoint.downloadRateBps !== undefined
              ? checkpoint.downloadRateBps
              : elapsed > 0
                ? ((delta * 1000n) / BigInt(elapsed)).toString()
                : null,
            timestamp,
            timestamp,
            timestamp,
            job.jobId,
          );
      })
      .immediate();
  }

  inputReady(
    job: ImportWorkerJob,
    fsid: string,
    evidence: { sha256: string; device: string; inode: string },
  ): void {
    this.db
      .transaction(() => {
        this.assertRunning(job);
        const input = this.input(job.jobId, fsid);
        archiveAssert(/^[0-9a-f]{64}$/.test(evidence.sha256), 'ARCHIVE_INPUT_HASH_INVALID');
        if (input.state === 'READY') {
          archiveAssert(
            input.localSha256 === evidence.sha256 &&
              input.readyDevice === evidence.device &&
              input.readyInode === evidence.inode,
            'ARCHIVE_INPUT_CHANGED',
          );
          return;
        }
        archiveAssert(
          input.state === 'PENDING' || input.state === 'DOWNLOADING',
          'ARCHIVE_INPUT_STATE_INVALID',
        );
        const timestamp = this.now();
        this.db
          .prepare(
            `UPDATE archive_inputs SET state='READY',completed_bytes=source_size,ready_device=?,ready_inode=?,local_sha256=?,updated_at=? WHERE job_id=? AND source_fsid=?`,
          )
          .run(evidence.device, evidence.inode, evidence.sha256, timestamp, job.jobId, fsid);
        const total = this.inputs(job.jobId)
          .reduce((sum, x) => sum + BigInt(x.completedBytes), 0n)
          .toString();
        this.db
          .prepare(`UPDATE archive_imports SET input_bytes_done=?,updated_at=? WHERE job_id=?`)
          .run(total, timestamp, job.jobId);
        this.bump(job.jobId);
        this.event(job.jobId, 'IMPORT_ARCHIVE_INPUT_READY', 'LOCAL_LANDING', input.sourceSize);
      })
      .immediate();
  }

  progress(job: ImportWorkerJob, event: ArchiveProgress): void {
    this.db
      .transaction(() => {
        this.assertRunning(job);
        const row = this.require(job.jobId);
        archiveAssert(row.preparedJson === null, 'ARCHIVE_OUTPUT_MANIFEST_IMMUTABLE');
        const timestamp = this.now();
        this.db
          .prepare(
            `UPDATE archive_imports SET phase='EXTRACTING',depth=?,archive_count=?,video_count=?,expanded_bytes=?,candidate_index=?,last_error_code=NULL,updated_at=? WHERE job_id=?`,
          )
          .run(
            event.depth,
            event.archiveCount,
            event.videoCount,
            event.expandedBytes,
            event.candidateIndex ?? null,
            timestamp,
            job.jobId,
          );
        this.db
          .prepare(
            `UPDATE import_jobs SET current_step='LOCAL_LANDING',current_object_alias=?,object_bytes_done='0',object_bytes_total='0',download_rate_bps=NULL,upload_rate_bps=NULL,
        verify_rate_bps=NULL,eta_seconds=NULL,rates_sampled_at=NULL,revision=revision+1,last_checkpoint_at=?,updated_at=? WHERE id=?`,
          )
          .run(event.archiveAlias ?? null, timestamp, timestamp, job.jobId);
        if (row.phase !== 'EXTRACTING')
          this.event(job.jobId, 'IMPORT_ARCHIVE_EXTRACTING', 'LOCAL_LANDING');
        if (event.renamedMember !== undefined) {
          const { originalPath, localPath } = event.renamedMember;
          normalizeArchiveMember(localPath);
          let detail = `长文件名已缩短；原名 SHA256：${sha(originalPath)}`;
          try {
            detail = sanitizedDetail(`原名：${originalPath}；本地名：${localPath}`) ?? detail;
          } catch {
            /* Do not expose token-like names or exceed the bounded event contract. */
          }
          this.db
            .prepare(
              `INSERT INTO import_events(id,job_id,event_code,step,detail_sanitized,created_at)
            VALUES (?,?,'IMPORT_ARCHIVE_MEMBER_RENAMED','LOCAL_LANDING',?,?)`,
            )
            .run(randomUUID(), job.jobId, detail, timestamp);
        }
      })
      .immediate();
  }

  prepared(jobId: string): PreparedArchive | null {
    const row = this.require(jobId);
    if (row.preparedJson === null) return null;
    archiveAssert(sha(row.preparedJson) === row.preparedDigest, 'ARCHIVE_OUTPUT_PROOF_INVALID');
    const parsed = PreparedSchema.safeParse(JSON.parse(row.preparedJson));
    archiveAssert(parsed.success, 'ARCHIVE_OUTPUT_PROOF_INVALID');
    return parsed.data;
  }

  freezePrepared(job: ImportWorkerJob, outputs: readonly PreparedArchiveOutput[]): void {
    this.db
      .transaction(() => {
        this.assertRunning(job);
        const row = this.require(job.jobId),
          inputs = this.inputs(job.jobId);
        archiveAssert(
          inputs.length === row.inputCount &&
            inputs.every((item) => item.state === 'READY' && item.localSha256 !== null),
          'ARCHIVE_INPUTS_NOT_READY',
        );
        const proof = PreparedSchema.safeParse({
          version: 1,
          sourceManifestDigest: job.sourceManifestDigest,
          inputs: inputs.map((x) => ({
            fsid: x.sourceFsid,
            size: x.sourceSize,
            mtime: x.sourceMtime,
            relativePath: x.relativePath,
            sha256: x.localSha256,
          })),
          outputs,
        });
        archiveAssert(proof.success, 'ARCHIVE_OUTPUT_PROOF_INVALID');
        const ids = new Set<string>(),
          names = new Set<string>(),
          localIds = new Set<string>();
        for (const output of proof.data.outputs) {
          normalizeArchiveMember(output.relativePath);
          const name = output.relativePath.normalize('NFC').toLowerCase();
          archiveAssert(
            !ids.has(output.objectId) && !names.has(name) && !localIds.has(output.localId),
            'ARCHIVE_PATH_COLLISION',
          );
          ids.add(output.objectId);
          names.add(name);
          localIds.add(output.localId);
        }
        const bytes = outputs.reduce((sum, x) => sum + BigInt(x.size), 0n);
        const options = this.options(job.jobId);
        archiveAssert(
          outputs.length <= options.maxFiles && bytes <= BigInt(options.maxExpandedBytes),
          'ARCHIVE_EXPANSION_LIMIT',
        );
        const json = sanitizedJson(proof.data, 'archiveOutputProof'),
          digest = sha(json);
        if (row.preparedJson !== null) {
          archiveAssert(
            row.preparedJson === json && row.preparedDigest === digest,
            'ARCHIVE_OUTPUT_MANIFEST_IMMUTABLE',
          );
          return;
        }
        this.db
          .prepare(
            `UPDATE archive_imports SET phase='PREPARING_VIDEOS',prepared_json=?,prepared_digest=?,video_count=?,video_bytes=?,candidate_index=NULL,updated_at=? WHERE job_id=?`,
          )
          .run(json, digest, outputs.length, bytes.toString(), this.now(), job.jobId);
        this.bump(job.jobId);
        this.event(job.jobId, 'IMPORT_ARCHIVE_OUTPUTS_FROZEN', 'LOCAL_LANDING', bytes.toString());
      })
      .immediate();
  }

  installPrepared(
    job: ImportWorkerJob,
    evidence: readonly { objectId: string; ready: ReadyEvidence }[],
  ): void {
    this.db
      .transaction(() => {
        this.assertRunning(job);
        const row = this.require(job.jobId),
          proof = this.prepared(job.jobId);
        archiveAssert(
          proof !== null && proof.sourceManifestDigest === job.sourceManifestDigest,
          'ARCHIVE_OUTPUT_PROOF_INVALID',
        );
        if (row.phase === 'READY' || row.phase === 'CLEANED') return;
        const byId = new Map(evidence.map((item) => [item.objectId, item.ready]));
        archiveAssert(
          row.phase === 'PREPARING_VIDEOS' &&
            byId.size === proof.outputs.length &&
            evidence.length === byId.size &&
            this.db
              .prepare('SELECT count(*) FROM import_objects WHERE job_id=?')
              .pluck()
              .get(job.jobId) === 0,
          'ARCHIVE_OUTPUT_INSTALL_CONFLICT',
        );
        const timestamp = this.now();
        for (const output of proof.outputs) {
          const ready = byId.get(output.objectId);
          archiveAssert(
            ready !== undefined && ready.objectId === output.objectId && ready.size === output.size,
            'ARCHIVE_OUTPUT_PROOF_INVALID',
          );
          this.db
            .prepare(
              `INSERT INTO import_objects(id,job_id,source_fsid,relative_path,source_size,source_mtime,state,partial_bytes,local_sha256,origin_kind,origin_digest,created_at,updated_at)
          VALUES (?,?,?,?,?,'0','HASHED',?,?,'EXTRACTED',?,?,?)`,
            )
            .run(
              output.objectId,
              job.jobId,
              output.localId,
              output.relativePath,
              output.size,
              output.size,
              output.sha256,
              row.preparedDigest,
              timestamp,
              timestamp,
            );
          for (const kind of ['ACQUIRED', 'HASHED']) {
            const receipt =
              kind === 'ACQUIRED'
                ? ready
                : {
                    readyPath: ready.readyPath,
                    device: ready.device,
                    inode: ready.inode,
                    mtimeNs: ready.mtimeNs,
                    hashedAt: new Date(timestamp).toISOString(),
                    origin: 'EXTRACTED',
                    preparedDigest: row.preparedDigest,
                  };
            this.db
              .prepare(
                `INSERT INTO import_receipts(id,job_id,object_id,kind,idempotency_key,size,sha256,evidence_json_sanitized,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                randomUUID(),
                job.jobId,
                output.objectId,
                kind,
                `import-receipt:${output.objectId}:${kind}`,
                output.size,
                kind === 'HASHED' ? output.sha256 : null,
                sanitizedJson(receipt, 'archiveReady'),
                timestamp,
              );
          }
        }
        this.db
          .prepare(
            `UPDATE archive_imports SET phase='READY',last_error_code=NULL,updated_at=? WHERE job_id=?`,
          )
          .run(timestamp, job.jobId);
        this.db
          .prepare(
            `UPDATE import_jobs SET object_count=?,job_bytes_total=?,object_index=0,object_bytes_done='0',object_bytes_total='0',current_object_alias=NULL,
        current_step='HASHING',current_condition=NULL,download_rate_bps=NULL,eta_seconds=NULL,rates_sampled_at=NULL,revision=revision+1,last_checkpoint_at=?,updated_at=? WHERE id=?`,
          )
          .run(proof.outputs.length, row.videoBytes, timestamp, timestamp, job.jobId);
        this.event(job.jobId, 'IMPORT_ARCHIVE_VIDEOS_READY', 'HASHING', row.videoBytes);
      })
      .immediate();
  }

  failure(job: ImportWorkerJob, code: string): void {
    if (!/^[A-Z0-9_]+$/.test(code)) return;
    this.db
      .transaction(() => {
        this.assertRunning(job);
        const waiting = [
          'ARCHIVE_PASSWORDS_EXHAUSTED',
          'ARCHIVE_CREDENTIAL_EXPIRED',
          'ARCHIVE_CREDENTIAL_MISSING',
          'ARCHIVE_CREDENTIAL_INVALID',
        ].includes(code);
        this.db
          .prepare(
            `UPDATE archive_imports SET phase=CASE WHEN ? AND prepared_json IS NULL THEN 'WAITING_PASSWORD' ELSE phase END,last_error_code=?,updated_at=? WHERE job_id=?`,
          )
          .run(waiting ? 1 : 0, code, this.now(), job.jobId);
        this.bump(job.jobId);
      })
      .immediate();
  }

  retireSecret(job: ImportWorkerJob, ref: string): void {
    this.db
      .transaction(() => {
        this.assertRunning(job);
        const row = this.require(job.jobId);
        archiveAssert(
          ['READY', 'CLEANED'].includes(row.phase) && row.secretRef === ref,
          'ARCHIVE_CREDENTIAL_INVALID',
        );
        this.db
          .prepare(
            'UPDATE archive_imports SET secret_ref=NULL,updated_at=? WHERE job_id=? AND secret_ref=?',
          )
          .run(this.now(), job.jobId, ref);
      })
      .immediate();
  }

  hasSecretReference(ref: string): boolean {
    return (
      this.enabled &&
      this.db.prepare('SELECT 1 FROM archive_imports WHERE secret_ref=? LIMIT 1').get(ref) !==
        undefined
    );
  }

  assertCleanupReady(jobId: string, generationId: string): void {
    const row = this.require(jobId),
      proof = this.prepared(jobId);
    archiveAssert(
      proof !== null && ['READY', 'CLEANED'].includes(row.phase),
      'ARCHIVE_BACKUP_REQUIRED',
    );
    const receipt = this.db
      .prepare(
        `SELECT evidence_json_sanitized AS evidence FROM import_receipts WHERE job_id=? AND kind='CONTROL_PLANE_BACKUP' AND object_id IS NULL`,
      )
      .get(jobId) as { evidence: string } | undefined;
    archiveAssert(
      receipt !== undefined &&
        (JSON.parse(receipt.evidence) as { generationId?: unknown }).generationId === generationId,
      'ARCHIVE_BACKUP_REQUIRED',
    );
    const files = this.db
      .prepare(
        `SELECT state,source_size AS size,local_sha256 AS localSha,committed_sha256 AS remoteSha,origin_digest AS digest FROM import_objects WHERE job_id=?`,
      )
      .all(jobId) as {
      state: string;
      size: string;
      localSha: string | null;
      remoteSha: string | null;
      digest: string | null;
    }[];
    archiveAssert(
      files.length === proof.outputs.length &&
        files.every(
          (x) =>
            ['CONTROL_PLANE_BACKED_UP', 'SPOOL_CLEANED', 'COMPLETED'].includes(x.state) &&
            x.localSha !== null &&
            x.localSha === x.remoteSha &&
            x.digest === row.preparedDigest,
        ),
      'ARCHIVE_BACKUP_REQUIRED',
    );
  }
  markCleaned(jobId: string, generationId: string): void {
    this.db
      .transaction(() => {
        this.assertCleanupReady(jobId, generationId);
        const timestamp = this.now();
        this.db
          .prepare(`UPDATE archive_inputs SET state='CLEANED',updated_at=? WHERE job_id=?`)
          .run(timestamp, jobId);
        this.db
          .prepare(
            `UPDATE archive_imports SET phase='CLEANED',secret_ref=NULL,updated_at=? WHERE job_id=?`,
          )
          .run(timestamp, jobId);
        this.bump(jobId);
        this.event(jobId, 'IMPORT_ARCHIVE_SPOOL_CLEANED', 'SPOOL_CLEANUP');
      })
      .immediate();
  }

  cleanupStarted(jobId: string): boolean {
    this.require(jobId);
    return (
      this.db
        .prepare('SELECT cleanup_started FROM archive_imports WHERE job_id=?')
        .pluck()
        .get(jobId) === 1
    );
  }
  authorizeSpoolCleanup(jobId: string, generationId: string): void {
    this.db
      .transaction(() => {
        this.assertCleanupReady(jobId, generationId);
        this.db
          .prepare('UPDATE archive_imports SET cleanup_started=1,updated_at=? WHERE job_id=?')
          .run(this.now(), jobId);
      })
      .immediate();
  }

  private find(jobId: string): ArchiveRow | null {
    return (
      (this.db.prepare(`${SELECT} WHERE job_id=?`).get(jobId) as ArchiveRow | undefined) ?? null
    );
  }
  private require(jobId: string): ArchiveRow {
    archiveAssert(this.enabled, 'ARCHIVE_SCHEMA_REQUIRED');
    const row = this.find(jobId);
    archiveAssert(row !== null, 'ARCHIVE_JOB_NOT_FOUND');
    return row;
  }
  input(jobId: string, fsid: string): ArchiveInput {
    this.require(jobId);
    const row = this.db.prepare(`${INPUTS} WHERE job_id=? AND source_fsid=?`).get(jobId, fsid) as
      ArchiveInput | undefined;
    archiveAssert(row !== undefined, 'ARCHIVE_INPUT_NOT_FOUND');
    return row;
  }
  private assertRunning(job: ImportWorkerJob): void {
    const row = this.db
      .prepare(
        'SELECT state,attempt,source_manifest_digest AS digest,source_cleanup_policy AS cleanup FROM import_jobs WHERE id=?',
      )
      .get(job.jobId) as
      { state: string; attempt: number; digest: string | null; cleanup: string } | undefined;
    archiveAssert(
      row !== undefined &&
        row.state === 'RUNNING' &&
        row.attempt === job.attempt &&
        row.digest === job.sourceManifestDigest &&
        row.cleanup === 'KEEP',
      'IMPORT_WORKER_ATTEMPT_STALE',
    );
  }
  private bump(jobId: string): void {
    const at = this.now();
    this.db
      .prepare(
        'UPDATE import_jobs SET revision=revision+1,last_checkpoint_at=?,updated_at=? WHERE id=?',
      )
      .run(at, at, jobId);
  }
  private event(jobId: string, code: string, step: string, bytes: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO import_events(id,job_id,event_code,step,bytes,created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(randomUUID(), jobId, code, step, bytes, this.now());
  }
}
