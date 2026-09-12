import { lstat, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../../db/database.js';
import type { ArchiveImportProcessor } from '../archive/processor.js';
import type { ImportWorkerRepository, ImportWorkerJob } from '../worker-repository.js';
import type { SpoolManager } from '../data-plane/spool.js';
import type { ImportDataPlaneSourceResolver, ImportObjectTask } from '../data-plane/types.js';
import type { RangeDownloader } from '../data-plane/range-downloader.js';
import type { ImportSpoolCapacityGate } from '../data-plane/spool-capacity.js';
import { archiveAssert } from '../archive/inspection.js';
import type { PipelineGroupRow } from './repository.js';
import type { GroupSourceManifest } from '../source-manifest.js';

type Options = {
  db: AppDatabase;
  worker: ImportWorkerRepository;
  archive: ArchiveImportProcessor;
  spool: SpoolManager;
  sources: ImportDataPlaneSourceResolver;
  downloader: RangeDownloader;
  capacity: ImportSpoolCapacityGate;
  now?: () => number;
  removeTree?: (root: string) => Promise<void>;
};
const decimal = z.string().regex(/^(0|[1-9]\d{0,29})$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const Proof = z
  .object({
    version: z.literal(1),
    jobId: z.string().uuid(),
    groupKey: digest,
    sourceManifestDigest: digest,
    generation: z.number().int().positive(),
    rootDevice: decimal,
    rootInode: decimal,
    sourceVerifiedAt: z.number().int().nonnegative(),
    inputs: z
      .array(z.object({ fsid: decimal, size: decimal, mtime: decimal }).strict())
      .min(1)
      .max(10000),
  })
  .strict();
type ProofValue = z.infer<typeof Proof>;
async function info(filename: string) {
  try {
    return await lstat(filename, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function syncDirectory(root: string) {
  let handle;
  try {
    handle = await open(root, 'r');
    await handle.sync();
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error;
  } finally {
    await handle?.close();
  }
}

/** Sole-owner cache reclamation. Frozen outputs stay with the normal recovery cleanup path. */
export class GroupSpoolManager {
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  /** Actual data file sizes, not planned bytes. Filesystem headroom is sampled separately. */
  async measure(jobId: string): Promise<string> {
    const job = this.job(jobId),
      workspace = await this.options.archive.workspace(jobId, false);
    await this.assertRoot();
    let bytes = 0n,
      count = 0;
    const maximum =
      job.sourceManifest.archive.maxFiles * 3 + job.sourceManifest.objects.length + 32;
    const walk = async (root: string, relative: string, depth: number): Promise<void> => {
      archiveAssert(depth <= 2048, 'GROUP_WORKSPACE_UNSAFE');
      const stat = await info(root);
      if (stat === null) return;
      archiveAssert(stat.isDirectory() && !stat.isSymbolicLink(), 'GROUP_WORKSPACE_UNSAFE');
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const filename = path.join(root, entry.name),
          data = await lstat(filename, { bigint: true });
        archiveAssert(
          ++count <= maximum &&
            !data.isSymbolicLink() &&
            (data.isDirectory() || (data.isFile() && data.nlink === 1n)),
          'GROUP_WORKSPACE_UNSAFE',
        );
        if (data.isDirectory()) await walk(filename, relative + '/' + entry.name, depth + 1);
        else if (root === workspace.jobRoot && entry.name === 'owner.json') {
          archiveAssert(data.size <= 1024n, 'GROUP_WORKSPACE_UNSAFE');
          await this.assertOwner(job, workspace.jobRoot);
        } else bytes += data.size;
      }
    };
    await walk(workspace.jobRoot, '', 0);
    await walk(path.join(this.options.spool.root, jobId), '', 0);
    return bytes.toString();
  }

  async evict(jobId: string, signal?: AbortSignal): Promise<boolean> {
    const { db, archive, spool, worker, capacity } = this.options;
    const job = this.job(jobId),
      workspace = await archive.workspace(jobId, false);
    await this.assertRoot();
    const outputRoot = path.join(spool.root, jobId),
      outputInfo = await info(outputRoot);
    if (outputInfo !== null) {
      if (
        !outputInfo.isDirectory() ||
        outputInfo.isSymbolicLink() ||
        (await readdir(outputRoot)).length > 0
      ) {
        this.refuse(jobId, 'GROUP_UNVERIFIED_OUTPUT_RETAINED');
        return false;
      }
    }
    // Partial inner extraction can already hold the only materialized video even
    // before freezePrepared. Its extension need not identify it. Keep every work
    // payload, not just those already recognized as videos.
    if (await this.hasPayload(workspace.work)) {
      this.refuse(jobId, 'GROUP_UNVERIFIED_OUTPUT_RETAINED');
      return false;
    }
    let row = this.group(jobId);
    if (!this.eligible(row, jobId)) {
      this.refuse(jobId, 'GROUP_UNVERIFIED_OUTPUT_RETAINED');
      return false;
    }
    let proof: ProofValue | null =
      row.eviction_proof_json === null ? null : Proof.parse(JSON.parse(row.eviction_proof_json));
    if (row.admission !== 'EVICTING') proof = null;
    const rootInfo = await info(workspace.jobRoot);
    if (rootInfo !== null) {
      archiveAssert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'GROUP_WORKSPACE_UNSAFE');
      if (proof === null) await this.assertOwner(job, workspace.jobRoot);
    } else if (proof === null) {
      this.refuse(jobId, 'GROUP_CACHE_MISSING_WITHOUT_PROOF');
      return false;
    }
    if (proof !== null) {
      this.assertProof(proof, job, row);
      if (rootInfo !== null)
        archiveAssert(
          rootInfo.dev.toString() === proof.rootDevice &&
            rootInfo.ino.toString() === proof.rootInode,
          'GROUP_WORKSPACE_UNSAFE',
        );
    }
    if (row.admission !== 'EVICTING') {
      const started = db
        .transaction(() => {
          if (!this.eligible(this.group(jobId), jobId)) return false;
          db.prepare(
            `UPDATE import_pipeline_groups SET admission='EVICTING',eviction_generation=eviction_generation+1,
          eviction_proof_json=NULL,revision=revision+1,updated_at=? WHERE job_id=?`,
          ).run(this.now(), jobId);
          return true;
        })
        .immediate();
      if (!started) return false;
      row = this.group(jobId);
    }
    if (
      proof === null ||
      (rootInfo !== null && this.now() - proof.sourceVerifiedAt > 30 * 60_000)
    ) {
      archiveAssert(rootInfo !== null, 'GROUP_CACHE_MISSING_WITHOUT_PROOF');
      try {
        const manifest = job.sourceManifest;
        archiveAssert(manifest.version === 4, 'GROUP_SOURCE_REQUIRED');
        const original = {
          ...job,
          objectCount: manifest.objects.length,
          jobBytesTotal: manifest.objects.reduce((sum, x) => sum + BigInt(x.size), 0n).toString(),
        };
        const source = await this.options.sources.resolve(original);
        await source.discover(original, signal);
        for (const expected of manifest.objects) {
          signal?.throwIfAborted();
          const task: ImportObjectTask = {
            jobId,
            jobAttempt: job.attempt,
            objectId: randomUUID(),
            objectAttempt: job.attempt,
            sourceFsid: expected.fsid,
            sourcePath: expected.path,
            sourceScope: 'FILE',
            sourceSize: expected.size,
            sourceMtime: expected.mtime,
            state: 'DISCOVERED',
            secretRef: null,
            destinationAccountId: job.destinationId,
            completedBytes: '0',
            localSha256: null,
            stagingKey: null,
            committedKey: null,
            stagingPrefix: 'unused',
            committedPrefix: 'unused',
            resumeCheckpoint: null,
          };
          const current = await source.preflight(task, signal);
          archiveAssert(
            current.sourceSnapshot.fsid === expected.fsid &&
              current.sourceSnapshot.size === expected.size &&
              current.sourceSnapshot.mtime === expected.mtime &&
              current.lease.expectedSize === expected.size,
            'SOURCE_CHANGED',
          );
          await this.options.downloader.probe(current.lease, signal);
        }
        await source.discover(original, signal);
        proof = {
          version: 1,
          jobId,
          groupKey: row.group_key,
          sourceManifestDigest: job.sourceManifestDigest!,
          generation: row.eviction_generation,
          rootDevice: rootInfo.dev.toString(),
          rootInode: rootInfo.ino.toString(),
          sourceVerifiedAt: this.now(),
          inputs: manifest.objects.map((x) => ({ fsid: x.fsid, size: x.size, mtime: x.mtime })),
        };
        db.transaction(() => {
          archiveAssert(this.eligible(this.group(jobId), jobId), 'GROUP_EVICTION_CONFLICT');
          db.prepare(
            "UPDATE import_pipeline_groups SET eviction_proof_json=?,updated_at=? WHERE job_id=? AND admission='EVICTING'",
          ).run(JSON.stringify(proof), this.now(), jobId);
        }).immediate();
      } catch (error) {
        // Before a durable proof no unlink has been attempted. A prior interrupted
        // deletion remains EVICTING even if its live recheck fails.
        if (row.eviction_proof_json === null)
          db.prepare(
            "UPDATE import_pipeline_groups SET admission='CACHED',last_error_code='GROUP_CACHE_SOURCE_NOT_VERIFIED',cache_probe_after=?,updated_at=? WHERE job_id=?",
          ).run(this.now() + 60000, this.now(), jobId);
        if (signal?.aborted) throw error;
        return false;
      }
    }
    archiveAssert(proof !== null, 'GROUP_EVICTION_PROOF_REQUIRED');
    this.assertProof(proof, worker.requireJob(jobId), this.group(jobId));
    archiveAssert(this.eligible(this.group(jobId), jobId), 'GROUP_EVICTION_CONFLICT');
    signal?.throwIfAborted();
    const current = await info(workspace.jobRoot);
    if (current !== null) {
      archiveAssert(
        current.isDirectory() &&
          !current.isSymbolicLink() &&
          current.dev.toString() === proof.rootDevice &&
          current.ino.toString() === proof.rootInode,
        'GROUP_WORKSPACE_UNSAFE',
      );
      // Also rejects symlinks/special files in a partial extraction tree. No output
      // ledger exists, and the entire selected source was proved retrievable above.
      await this.measure(jobId);
      if (this.options.removeTree) await this.options.removeTree(workspace.jobRoot);
      else await rm(workspace.jobRoot, { recursive: true, force: false });
      await syncDirectory(path.dirname(workspace.jobRoot));
    }
    archiveAssert((await info(workspace.jobRoot)) === null, 'GROUP_CACHE_REMOVAL_UNPROVED');
    db.transaction(() => {
      archiveAssert(this.eligible(this.group(jobId), jobId), 'GROUP_EVICTION_CONFLICT');
      this.assertProof(proof, worker.requireJob(jobId), this.group(jobId));
      const timestamp = this.now();
      db.prepare(
        `UPDATE archive_inputs SET state='PENDING',completed_bytes='0',partial_device=NULL,partial_inode=NULL,
        ready_device=NULL,ready_inode=NULL,local_sha256=NULL,updated_at=? WHERE job_id=?`,
      ).run(timestamp, jobId);
      db.prepare(
        `UPDATE archive_imports SET phase=CASE WHEN phase='WAITING_PASSWORD' THEN 'WAITING_PASSWORD' ELSE 'PENDING' END,
        input_bytes_done='0',expanded_bytes='0',video_count=0,video_bytes='0',depth=0,archive_count=0,candidate_index=NULL,updated_at=? WHERE job_id=?`,
      ).run(timestamp, jobId);
      db.prepare(
        `UPDATE import_jobs SET object_bytes_done='0',object_bytes_total='0',download_rate_bps=NULL,upload_rate_bps=NULL,verify_rate_bps=NULL,
        eta_seconds=NULL,rates_sampled_at=NULL,revision=revision+1,last_checkpoint_at=?,updated_at=? WHERE id=?`,
      ).run(timestamp, timestamp, jobId);
      db.prepare(
        `UPDATE import_pipeline_groups SET admission='WAITING',resident_bytes='0',resident_sampled_at=?,needs_redownload=1,
        last_error_code=NULL,revision=revision+1,updated_at=? WHERE job_id=?`,
      ).run(timestamp, timestamp, jobId);
      db.prepare('DELETE FROM import_spool_reservations WHERE job_id=?').run(jobId);
    }).immediate();
    capacity.notifyCapacityChanged();
    return true;
  }
  private job(id: string): ImportWorkerJob & { sourceManifest: GroupSourceManifest } {
    archiveAssert(/^[a-f0-9-]{36}$/i.test(id), 'GROUP_WORKSPACE_UNSAFE');
    const job = this.options.worker.requireJob(id);
    archiveAssert(job.sourceManifest?.version === 4, 'GROUP_SOURCE_REQUIRED');
    return { ...job, sourceManifest: job.sourceManifest };
  }
  private group(jobId: string): PipelineGroupRow {
    const row = this.options.db
      .prepare('SELECT * FROM import_pipeline_groups WHERE job_id=?')
      .get(jobId) as PipelineGroupRow | undefined;
    archiveAssert(row !== undefined, 'GROUP_NOT_FOUND');
    return row;
  }
  private eligible(row: PipelineGroupRow, jobId: string): boolean {
    return (
      ['WAITING', 'CACHED', 'EVICTING'].includes(row.admission) &&
      this.options.db
        .prepare(
          `SELECT 1 FROM import_jobs j JOIN archive_imports a ON a.job_id=j.id
      WHERE j.id=? AND j.state<>'RUNNING' AND j.source_cleanup_policy='KEEP' AND a.prepared_json IS NULL AND a.video_count=0
        AND NOT EXISTS(SELECT 1 FROM import_objects o WHERE o.job_id=j.id)`,
        )
        .get(jobId) !== undefined
    );
  }
  private assertProof(proof: ProofValue, job: ImportWorkerJob, row: PipelineGroupRow) {
    archiveAssert(
      proof.jobId === job.jobId &&
        proof.generation === row.eviction_generation &&
        proof.groupKey === row.group_key &&
        proof.sourceManifestDigest === job.sourceManifestDigest &&
        JSON.stringify(proof.inputs) ===
          JSON.stringify(
            job.sourceManifest!.objects.map((x) => ({
              fsid: x.fsid,
              size: x.size,
              mtime: x.mtime,
            })),
          ),
      'GROUP_EVICTION_PROOF_REQUIRED',
    );
  }
  private refuse(jobId: string, code: string) {
    this.options.db
      .prepare('UPDATE import_pipeline_groups SET last_error_code=?,updated_at=? WHERE job_id=?')
      .run(code, this.now(), jobId);
  }
  private async hasPayload(
    root: string,
    depth = 0,
    budget = { remaining: 100000 },
  ): Promise<boolean> {
    if (depth > 2048 || budget.remaining-- <= 0) return true;
    const stat = await info(root);
    if (stat === null) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        (await this.hasPayload(path.join(root, entry.name), depth + 1, budget))
      )
        return true;
    }
    return false;
  }
  private async assertRoot() {
    const root = this.options.spool.root,
      stats = await lstat(root);
    const canonical = await realpath(root),
      resolved = await lstat(canonical);
    archiveAssert(
      stats.isDirectory() &&
        !stats.isSymbolicLink() &&
        (process.platform === 'win32'
          ? resolved.dev === stats.dev && resolved.ino === stats.ino
          : canonical === root),
      'GROUP_WORKSPACE_UNSAFE',
    );
    const archives = await info(path.join(root, 'archives'));
    archiveAssert(
      archives === null || (archives.isDirectory() && !archives.isSymbolicLink()),
      'GROUP_WORKSPACE_UNSAFE',
    );
  }
  private async assertOwner(job: ImportWorkerJob, root: string) {
    const filename = path.join(root, 'owner.json'),
      stats = await lstat(filename);
    archiveAssert(
      stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1 && stats.size <= 1024,
      'GROUP_WORKSPACE_UNSAFE',
    );
    archiveAssert(
      (await readFile(filename, 'utf8')) ===
        JSON.stringify({
          version: 1,
          jobId: job.jobId,
          sourceManifestDigest: job.sourceManifestDigest,
        }),
      'GROUP_WORKSPACE_UNSAFE',
    );
  }
}
