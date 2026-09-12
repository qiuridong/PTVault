import { createHash, randomUUID } from 'node:crypto';
import {
  ImportPipelineOptionsSchema,
  type ImportPipelineOptions,
  type ImportPipelineGroup,
  type ImportPipelineSummary,
  type ImportPipelineDetail,
  type CreateImportRequest,
} from '@ptvault/contracts';
import type { AppDatabase } from '../../db/database.js';
import { importInvariant } from '../errors.js';
import type { ImportRepository, CreateJobInput, StoredImportPlan } from '../repository.js';
import { canonicalSourceManifest, sourceManifestDigest } from '../source-manifest.js';
import { readDownloadDiagnostic } from '../data-plane/download-diagnostics.js';
import {
  planImportGroups,
  materializeImportGroupSources,
  type PlannedImportGroup,
} from './planning.js';

type ParentRow = {
  id: string;
  plan_id: string;
  options_json: string;
  paused: number;
  cancel_requested: number;
  revision: number;
  created_at: number;
  source_alias: string;
  total_bytes: string;
};
export type PipelineGroupRow = {
  pipeline_id: string;
  group_key: string;
  ordinal: number;
  group_json: string;
  input_bytes: string;
  required_spool_bytes: string;
  issue: string | null;
  job_id: string | null;
  admission: 'WAITING' | 'ADMITTED' | 'CACHED' | 'EVICTING' | 'COMPLETE';
  resident_bytes: string;
  resident_sampled_at: number | null;
  wait_kind: string | null;
  wait_since: number | null;
  bypass_count: number;
  needs_redownload: number;
  eviction_generation: number;
  eviction_proof_json: string | null;
  cache_probe_after: number;
  parent_paused: number;
  last_error_code: string | null;
  revision: number;
  updated_at: number;
};
export type PipelineAdmissionRow = Pick<
  PipelineGroupRow,
  | 'pipeline_id'
  | 'group_key'
  | 'ordinal'
  | 'job_id'
  | 'admission'
  | 'required_spool_bytes'
  | 'resident_bytes'
  | 'resident_sampled_at'
  | 'wait_kind'
  | 'wait_since'
  | 'bypass_count'
  | 'needs_redownload'
  | 'cache_probe_after'
  | 'last_error_code'
> & { archive_phase: string | null };
type JoinedRow = PipelineGroupRow & {
  state: string | null;
  condition: string | null;
  step: string | null;
  attempt: number | null;
  retry_at: number | null;
  verified_bytes: string | null;
  phase: string | null;
  archive_error: string | null;
  job_paused: number | null;
  parent_cancelled: number;
  pub_state: ImportPipelineGroup['publicationState'] | null;
  failure_code: string | null;
  failure_at: number | null;
  failure_step: string | null;
  failure_detail: string | null;
};
const SELECT = `SELECT g.*,j.state,j.current_condition AS condition,j.current_step AS step,j.attempt,j.retry_at,j.job_bytes_verified AS verified_bytes,
  j.paused AS job_paused,a.phase,a.last_error_code AS archive_error,p.state AS pub_state,parent.cancel_requested AS parent_cancelled,
  failure.error_class AS failure_code,failure.created_at AS failure_at,failure.step AS failure_step,failure.detail_sanitized AS failure_detail
  FROM import_pipeline_groups g LEFT JOIN import_jobs j ON j.id=g.job_id LEFT JOIN archive_imports a ON a.job_id=g.job_id
  LEFT JOIN media_publications p ON p.job_id=g.job_id JOIN import_pipelines parent ON parent.id=g.pipeline_id
  LEFT JOIN import_events failure ON failure.rowid=(SELECT e.rowid FROM import_events e
    WHERE e.job_id=g.job_id AND e.event_code IN ('IMPORT_WORKER_STOPPED','IMPORT_DOWNLOAD_RETRY_SCHEDULED') ORDER BY e.created_at DESC,e.rowid DESC LIMIT 1)`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fingerprint(
  plan: StoredImportPlan,
  destinationId: string,
  publicationPolicy: string,
  publication: unknown,
) {
  return hash({
    version: 1,
    planId: plan.planId,
    sourceDigest: plan.sourceManifestDigest,
    options: pipelinePlanOptions(plan),
    destinationId,
    publicationPolicy,
    publication,
    sourcePolicy: 'KEEP',
  });
}

export function pipelinePlanOptions(plan: StoredImportPlan): ImportPipelineOptions | null {
  if (
    typeof plan.selection !== 'object' ||
    plan.selection === null ||
    !('groupPipeline' in plan.selection)
  )
    return null;
  const parsed = ImportPipelineOptionsSchema.safeParse(plan.selection.groupPipeline);
  importInvariant(parsed.success, 'GROUP_PLAN_INVALID', 409);
  return parsed.data;
}

/** Parent control only. Child jobs keep the existing receipts, recovery and publication chain. */
export class ImportPipelineRepository {
  readonly enabled: boolean;
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {
    this.enabled =
      Number(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() ?? 0) >= 42;
  }

  replayCreate(plan: StoredImportPlan, request: CreateImportRequest): ImportPipelineSummary | null {
    if (!this.enabled) return null;
    const row = this.db
      .prepare('SELECT id,request_fingerprint FROM import_pipelines WHERE idempotency_key=?')
      .get(request.idempotencyKey) as { id: string; request_fingerprint: string } | undefined;
    if (!row) return null;
    importInvariant(
      row.request_fingerprint ===
        fingerprint(
          plan,
          request.destinationId ?? plan.destinationId,
          request.publicationPolicy ?? plan.plannedPolicy,
          request.publication ?? null,
        ),
      'IMPORT_IDEMPOTENCY_CONFLICT',
      409,
    );
    return this.summary(row.id);
  }

  childAction(
    imports: ImportRepository,
    jobId: string,
    action: 'PAUSE' | 'RESUME' | 'CANCEL' | 'RETRY',
    key: string,
  ) {
    if (!this.enabled) return imports.mutateAction(jobId, action, key);
    return this.db
      .transaction(() => {
        const group = this.db
          .prepare('SELECT pipeline_id FROM import_pipeline_groups WHERE job_id=?')
          .get(jobId) as { pipeline_id: string } | undefined;
        if (group !== undefined && (action === 'RESUME' || action === 'RETRY')) {
          const parent = this.parent(group.pipeline_id);
          importInvariant(!parent.paused && !parent.cancel_requested, 'GROUP_PARENT_PAUSED', 409);
        }
        const result = imports.mutateAction(jobId, action, key);
        if (group !== undefined)
          this.db
            .prepare(
              'UPDATE import_pipeline_groups SET parent_paused=0,updated_at=? WHERE job_id=?',
            )
            .run(this.now(), jobId);
        return result;
      })
      .immediate();
  }

  action(
    imports: ImportRepository,
    id: string,
    action: 'PAUSE' | 'RESUME' | 'CANCEL' | 'RETRY',
    key: string,
  ): ImportPipelineSummary {
    return this.db
      .transaction(() => {
        const parent = this.parent(id),
          intent = hash({ id, action });
        const replay = this.db
          .prepare(
            'SELECT request_fingerprint FROM import_pipeline_operations WHERE pipeline_id=? AND idempotency_key=?',
          )
          .pluck()
          .get(id, key);
        if (replay !== undefined) {
          importInvariant(replay === intent, 'IMPORT_IDEMPOTENCY_CONFLICT', 409);
          return this.summary(id);
        }
        importInvariant(
          !parent.cancel_requested || action === 'CANCEL',
          'GROUP_PIPELINE_CANCELLED',
          409,
        );
        const summary = this.summary(id);
        importInvariant(
          summary.availableActions.includes(action) ||
            (action === 'CANCEL' && parent.cancel_requested === 1) ||
            (action === 'PAUSE' && parent.paused === 1),
          'IMPORT_ACTION_CONFLICT',
          409,
        );
        const timestamp = this.now();
        if (action === 'PAUSE')
          this.db.prepare('UPDATE import_pipelines SET paused=1 WHERE id=?').run(id);
        if (action === 'RESUME')
          this.db.prepare('UPDATE import_pipelines SET paused=0 WHERE id=?').run(id);
        if (action === 'CANCEL')
          this.db.prepare('UPDATE import_pipelines SET cancel_requested=1 WHERE id=?').run(id);
        for (const row of this.rows(id)) {
          if (row.job_id === null) continue;
          const child = imports.requireSummary(row.job_id),
            available = child.availableActions;
          const childKey = `parent:${id}:${hash({ key, action, job: row.job_id })}`;
          if (action === 'PAUSE' && available.includes('PAUSE')) {
            imports.mutateAction(row.job_id, 'PAUSE', childKey);
            this.db
              .prepare('UPDATE import_pipeline_groups SET parent_paused=1 WHERE job_id=?')
              .run(row.job_id);
          } else if (action === 'RESUME' && row.parent_paused === 1) {
            if (available.includes('RESUME')) imports.mutateAction(row.job_id, 'RESUME', childKey);
            else {
              // Undo a parent-owned request that the worker has not acknowledged yet.
              this.db
                .prepare(
                  `UPDATE import_jobs SET pause_requested_at=NULL,revision=revision+1,updated_at=?,last_checkpoint_at=?
              WHERE id=? AND state='RUNNING' AND pause_requested_at IS NOT NULL AND cancel_requested_at IS NULL`,
                )
                .run(timestamp, timestamp, row.job_id);
            }
            this.db
              .prepare('UPDATE import_pipeline_groups SET parent_paused=0 WHERE job_id=?')
              .run(row.job_id);
          } else if ((action === 'CANCEL' || action === 'RETRY') && available.includes(action))
            imports.mutateAction(row.job_id, action, childKey);
        }
        this.db
          .prepare('UPDATE import_pipelines SET revision=revision+1,updated_at=? WHERE id=?')
          .run(timestamp, id);
        this.db
          .prepare(
            'INSERT INTO import_pipeline_operations(pipeline_id,idempotency_key,request_fingerprint,created_at) VALUES (?,?,?,?)',
          )
          .run(id, key, intent, timestamp);
        return this.summary(id);
      })
      .immediate();
  }

  create(imports: ImportRepository, input: CreateJobInput): ImportPipelineSummary {
    importInvariant(this.enabled, 'GROUP_SCHEMA_REQUIRED', 503);
    const plan = imports.requirePlan(input.plan.planId),
      options = pipelinePlanOptions(plan);
    importInvariant(
      options !== null &&
        plan.sourceManifest !== null &&
        plan.sourceKind === 'BAIDU_APP_DIR' &&
        (input.sourceCleanupPolicy ?? 'KEEP') === 'KEEP' &&
        input.sourceCleanupRequiresPublication !== true,
      'GROUP_PLAN_INVALID',
      409,
    );
    importInvariant(
      (input.publicationPolicy === 'PUBLISH_TO_JELLYFIN') === (input.publication !== undefined),
      'IMPORT_PUBLICATION_REQUIRED',
      409,
    );
    importInvariant(
      input.plan.sourceManifestDigest === plan.sourceManifestDigest &&
        JSON.stringify(input.plan.selection) === JSON.stringify(plan.selection),
      'IMPORT_PLAN_MANIFEST_MISMATCH',
      409,
    );
    const requestFingerprint = fingerprint(
      plan,
      input.destination.destinationId,
      input.publicationPolicy,
      input.publication?.request ?? null,
    );
    return this.db
      .transaction(() => {
        const previous = this.db
          .prepare('SELECT id,request_fingerprint FROM import_pipelines WHERE idempotency_key=?')
          .get(input.idempotencyKey) as { id: string; request_fingerprint: string } | undefined;
        if (previous) {
          importInvariant(
            previous.request_fingerprint === requestFingerprint,
            'IMPORT_IDEMPOTENCY_CONFLICT',
            409,
          );
          return this.summary(previous.id);
        }
        const base = canonicalSourceManifest(plan.sourceManifest);
        const groups = planImportGroups(base, options.processing, options.residentMaxBytes);
        importInvariant(groups.length > 0 && groups.length <= 10000, 'GROUP_COUNT_LIMIT', 409);
        const manifests = materializeImportGroupSources(
          base,
          options.processing,
          options.residentMaxBytes,
        );
        const pipelineId = randomUUID(),
          timestamp = this.now();
        this.db
          .prepare(
            `INSERT INTO import_pipelines(id,version,plan_id,source_manifest_digest,options_json,source_policy,idempotency_key,request_fingerprint,created_at,updated_at)
        VALUES (?,1,?,?,?,'KEEP',?,?,?,?)`,
          )
          .run(
            pipelineId,
            plan.planId,
            sourceManifestDigest(base),
            JSON.stringify(options),
            input.idempotencyKey,
            requestFingerprint,
            timestamp,
            timestamp,
          );
        for (const [ordinal, group] of groups.entries()) {
          let jobId: string | null = null;
          if (group.issue !== 'ARCHIVE_VOLUME_SET_INVALID') {
            // An over-budget group still has a complete identity. It stays out of the
            // worker queue until capacity admits it; there is no partial-volume workaround.
            const manifest = manifests.get(group.key)!;
            const ingress = (
              plan.selection as { archiveIngress: { ref: string | null; count: number } }
            ).archiveIngress;
            const child = imports.createPlan({
              ...plan,
              sourceManifest: manifest,
              sourceAlias: `分组 ${ordinal + 1} · ${group.key.slice(0, 12)}`,
              objectCount: manifest.objects.length,
              totalBytes: group.inputBytes,
              largestObjectBytes: manifest.objects.reduce(
                (max, x) => (BigInt(x.size) > BigInt(max) ? x.size : max),
                '0',
              ),
              requiredSpoolBytes: group.requiredSpoolBytes,
              expiresAt: Date.parse(plan.expiresAt),
              selection: {
                sourceKind: 'BAIDU_APP_DIR',
                sourcePath: base.rootPath,
                sourceScope: 'GROUP',
                archiveIngress: ingress,
                pipelineId,
                groupKey: group.key,
              },
              secretRef: null,
            });
            const publication =
              input.publication === undefined
                ? undefined
                : {
                    ...input.publication,
                    request: {
                      ...input.publication.request,
                      logicalPath: `${input.publication.request.logicalPath}/${String(ordinal + 1).padStart(4, '0')} - ${Array.from(
                        group.entry.split('/').at(-1)!,
                      )
                        .slice(0, 32)
                        .join('')
                        .replace(/[. ]+$/, '')}`,
                    },
                  };
            jobId = imports.createJob({
              ...input,
              plan: child,
              sourceCleanupPolicy: 'KEEP',
              secretRef: null,
              idempotencyKey: `pipeline:${pipelineId}:${group.key}`,
              ...(publication === undefined ? {} : { publication }),
            }).jobId;
          }
          this.db
            .prepare(
              `INSERT INTO import_pipeline_groups(pipeline_id,group_key,ordinal,group_json,input_bytes,required_spool_bytes,issue,job_id,wait_since,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              pipelineId,
              group.key,
              ordinal,
              JSON.stringify(group),
              group.inputBytes,
              group.requiredSpoolBytes,
              group.issue,
              jobId,
              timestamp,
              timestamp,
            );
        }
        return this.summary(pipelineId);
      })
      .immediate();
  }

  admissionRows(): PipelineAdmissionRow[] {
    if (!this.enabled) return [];
    return this.db
      .prepare(
        `SELECT g.pipeline_id,g.group_key,g.ordinal,g.job_id,g.admission,g.required_spool_bytes,
      g.resident_bytes,g.resident_sampled_at,g.wait_kind,g.wait_since,g.bypass_count,g.needs_redownload,g.cache_probe_after,g.last_error_code,
      a.phase AS archive_phase FROM import_pipeline_groups g LEFT JOIN archive_imports a ON a.job_id=g.job_id
      WHERE g.admission<>'COMPLETE' AND g.job_id IS NOT NULL ORDER BY g.pipeline_id,g.ordinal`,
      )
      .all() as PipelineAdmissionRow[];
  }
  rows(pipelineId?: string): PipelineGroupRow[] {
    if (!this.enabled) return [];
    return this.db
      .prepare(
        'SELECT * FROM import_pipeline_groups' +
          (pipelineId === undefined ? '' : ' WHERE pipeline_id=?') +
          ' ORDER BY pipeline_id,ordinal',
      )
      .all(...(pipelineId === undefined ? [] : [pipelineId])) as PipelineGroupRow[];
  }
  summary(id: string, now = this.now()): ImportPipelineSummary {
    const parent = this.parent(id),
      rows = this.joined(id),
      groups = rows.map((row) => this.mapGroup(row, now));
    const counts = {
      total: groups.length,
      completed: 0,
      running: 0,
      queued: 0,
      waitingPassword: 0,
      retryWait: 0,
      needsAttention: 0,
      cancelled: 0,
    };
    for (const group of groups) {
      if (group.stage === 'COMPLETED') counts.completed++;
      else if (group.stage === 'CANCELLED') counts.cancelled++;
      else if (group.stage === 'WAITING_PASSWORD') counts.waitingPassword++;
      else if (group.stage === 'RETRY_WAIT') counts.retryWait++;
      else if (group.stage === 'NEEDS_ATTENTION') counts.needsAttention++;
      else if (
        ['QUEUED', 'ADMISSION_WAIT', 'DOWNLOAD_WAIT', 'EXTRACTION_WAIT', 'UPLOAD_WAIT'].includes(
          group.stage,
        )
      )
        counts.queued++;
      else counts.running++;
    }
    let state: ImportPipelineSummary['state'];
    if (counts.completed === counts.total) state = 'COMPLETED';
    else if (counts.cancelled + counts.completed === counts.total && counts.cancelled > 0)
      state = 'CANCELLED';
    else if (counts.running > 0) state = 'RUNNING';
    else if (counts.completed > 0) state = 'PARTIAL';
    else if (parent.paused || counts.waitingPassword + counts.retryWait + counts.needsAttention > 0)
      state = 'WAITING';
    else state = 'QUEUED';
    const availableActions: ImportPipelineSummary['availableActions'] = [];
    if (state !== 'COMPLETED' && state !== 'CANCELLED' && !parent.cancel_requested) {
      availableActions.push(parent.paused ? 'RESUME' : 'PAUSE', 'CANCEL');
      if (
        !parent.paused &&
        rows.some(
          (row) =>
            row.state === 'FAILED_SAFE' ||
            row.state === 'RETRY_WAIT' ||
            (row.state === 'BLOCKED' && !row.job_paused && row.condition !== 'AUTH_REQUIRED'),
        )
      )
        availableActions.push('RETRY');
    }
    const reservations = this.db
      .prepare(
        `SELECT r.reserved_bytes FROM import_spool_reservations r JOIN import_pipeline_groups g ON g.job_id=r.job_id WHERE g.pipeline_id=?`,
      )
      .all(id) as { reserved_bytes: string }[];
    return {
      pipelineId: id,
      version: 1,
      sourceAlias: parent.source_alias,
      sourcePolicy: 'KEEP',
      state,
      paused: parent.paused === 1,
      revision: parent.revision,
      createdAt: parent.created_at,
      availableActions,
      counts,
      inputBytes: parent.total_bytes,
      verifiedBytes: groups.reduce((s, g) => s + BigInt(g.verifiedBytes), 0n).toString(),
      residentBytes: groups.reduce((s, g) => s + BigInt(g.residentBytes), 0n).toString(),
      reservedBytes: reservations.reduce((s, r) => s + BigInt(r.reserved_bytes), 0n).toString(),
    };
  }
  detail(id: string, offset = 0, limit = 100): ImportPipelineDetail {
    importInvariant(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 500,
      'GROUP_PAGE_INVALID',
      400,
    );
    const now = this.now();
    const rows = this.joined(id),
      parent = this.parent(id);
    return {
      ...this.summary(id, now),
      options: ImportPipelineOptionsSchema.parse(JSON.parse(parent.options_json)),
      groups: rows.slice(offset, offset + limit).map((row) => this.mapGroup(row, now)),
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    };
  }
  list(): ImportPipelineSummary[] {
    if (!this.enabled) return [];
    const rows = this.db
      .prepare('SELECT id FROM import_pipelines ORDER BY created_at DESC,id LIMIT 100')
      .all() as { id: string }[];
    return rows.map((x) => this.summary(x.id));
  }
  private parent(id: string): ParentRow {
    importInvariant(this.enabled, 'GROUP_SCHEMA_REQUIRED', 503);
    const row = this.db
      .prepare(
        `SELECT p.*,s.source_alias,s.total_bytes FROM import_pipelines p JOIN import_plans s ON s.id=p.plan_id WHERE p.id=?`,
      )
      .get(id) as ParentRow | undefined;
    importInvariant(row !== undefined, 'GROUP_PIPELINE_NOT_FOUND', 404);
    return row;
  }
  private joined(id: string): JoinedRow[] {
    return this.db
      .prepare(SELECT + ' WHERE g.pipeline_id=? ORDER BY g.ordinal')
      .all(id) as JoinedRow[];
  }
  private mapGroup(row: JoinedRow, now = this.now()): ImportPipelineGroup {
    const planned = JSON.parse(row.group_json) as PlannedImportGroup;
    const retryInPlace = row.state === 'RUNNING' && row.retry_at !== null;
    let stage: ImportPipelineGroup['stage'] = 'QUEUED';
    if (row.state === 'COMPLETED') stage = 'COMPLETED';
    else if (row.parent_cancelled && row.state !== 'RUNNING') stage = 'CANCELLED';
    else if (row.issue !== null && row.job_id === null) stage = 'NEEDS_ATTENTION';
    else if (row.state === 'CANCELLED_SAFE') stage = 'CANCELLED';
    else if (row.phase === 'WAITING_PASSWORD' || row.condition === 'AUTH_REQUIRED')
      stage = 'WAITING_PASSWORD';
    else if (row.state === 'FAILED_SAFE' || (row.state === 'BLOCKED' && !row.job_paused))
      stage = 'NEEDS_ATTENTION';
    else if (row.job_paused) stage = 'QUEUED';
    else if (retryInPlace) stage = row.retry_at! > now ? 'RETRY_WAIT' : 'DOWNLOAD_WAIT';
    else if (row.state === 'RETRY_WAIT' && (row.retry_at === null || row.retry_at > now))
      stage = 'RETRY_WAIT';
    else if (row.state === 'RETRY_WAIT')
      stage = row.wait_kind === null ? 'QUEUED' : 'ADMISSION_WAIT';
    else if (row.admission !== 'ADMITTED' || row.job_paused)
      stage = row.wait_kind === null ? 'QUEUED' : 'ADMISSION_WAIT';
    else if (row.wait_kind === 'DOWNLOAD') stage = 'DOWNLOAD_WAIT';
    else if (row.wait_kind === 'EXTRACTION') stage = 'EXTRACTION_WAIT';
    else if (row.wait_kind === 'UPLOAD') stage = 'UPLOAD_WAIT';
    else if (row.wait_kind !== null) stage = 'ADMISSION_WAIT';
    else if (row.phase === 'DOWNLOADING_INPUTS' || row.phase === 'PENDING') stage = 'DOWNLOADING';
    else if (row.phase === 'EXTRACTING' || row.phase === 'PREPARING_VIDEOS') stage = 'EXTRACTING';
    else if (row.step === 'UPLOADING_STAGING' || row.step === 'COMMITTING') stage = 'UPLOADING';
    else if (row.step === 'CONTROL_PLANE_BACKUP') stage = 'RECOVERY';
    else if (row.step === 'SPOOL_CLEANUP') stage = 'CLEANUP';
    else if (row.state === 'RUNNING') stage = 'VERIFYING';
    const waitKind = ['CAPACITY', 'DISK', 'PRESSURE', 'DOWNLOAD', 'EXTRACTION', 'UPLOAD'].includes(
      row.wait_kind ?? '',
    )
      ? (row.wait_kind as NonNullable<ImportPipelineGroup['waitKind']>)
      : null;
    const downloadDiagnostic = readDownloadDiagnostic(row.failure_detail);
    const lastFailure =
      row.failure_code !== null &&
      /^[A-Z0-9_]{1,100}$/.test(row.failure_code) &&
      row.failure_at !== null
        ? {
            code: row.failure_code,
            at: row.failure_at,
            step:
              row.failure_step !== null && /^[A-Z0-9_]{1,100}$/.test(row.failure_step)
                ? row.failure_step
                : null,
            ...(downloadDiagnostic === undefined ? {} : { downloadDiagnostic }),
          }
        : undefined;
    return {
      key: row.group_key,
      ordinal: row.ordinal,
      entry: planned.entry,
      jobId: row.job_id,
      inputCount: planned.members.length,
      inputBytes: row.input_bytes,
      requiredSpoolBytes: row.required_spool_bytes,
      residentBytes: row.resident_bytes,
      residentSampledAt: row.resident_sampled_at,
      stage,
      paused: row.job_paused === 1,
      waitKind: row.wait_kind === 'FAIRNESS' ? 'CAPACITY' : waitKind,
      ...(row.wait_kind === 'FAIRNESS' ? { fairnessWait: true } : {}),
      ...(retryInPlace ? { retryInPlace: true } : {}),
      ...(lastFailure === undefined ? {} : { lastFailure }),
      errorCode: row.last_error_code ?? row.archive_error ?? row.issue,
      retryAt: row.retry_at,
      attempt: row.attempt ?? 0,
      needsRedownload: row.needs_redownload === 1,
      cacheState:
        row.admission === 'EVICTING'
          ? 'EVICTING'
          : row.needs_redownload
            ? 'RELEASED'
            : row.resident_bytes !== '0'
              ? 'HELD'
              : 'NONE',
      verifiedBytes: row.verified_bytes ?? '0',
      publicationState: row.pub_state ?? 'NOT_REQUESTED',
      availableActions: [],
    };
  }
}
