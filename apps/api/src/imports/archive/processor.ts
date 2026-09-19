import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  archiveBaseManifest,
  sourceManifestDigest,
  isArchiveSourceManifest,
} from '../source-manifest.js';
import type { ImportWorkerJob, ImportWorkerRepository } from '../worker-repository.js';
import { ImportControlStop, ImportDataPlaneError } from '../data-plane/errors.js';
import type {
  ImportDataPlaneSource,
  ImportDataPlaneSourceResolver,
  ImportObjectTask,
} from '../data-plane/types.js';
import type { RangeDownloader } from '../data-plane/range-downloader.js';
import type { ImportSpoolCapacityGate } from '../data-plane/spool-capacity.js';
import type { SpoolManager, ReadyEvidence } from '../data-plane/spool.js';
import type { ImportResourceScheduler } from '../data-plane/resource-scheduler.js';
import type { GroupResourceScheduler } from '../groups/resources.js';
import type { BytePacer } from '../data-plane/rate-pacer.js';
import {
  DownloadContinuity,
  type DownloadContinuityOptions,
} from '../data-plane/download-continuity.js';
import type { ArchivePasswordStore } from './secrets.js';
import type { ArchiveRepository, ArchiveInput, PreparedArchiveOutput } from './repository.js';
import { ArchiveError, archiveAssert, normalizeArchiveMember } from './inspection.js';
import {
  RecursiveArchiveExtractor,
  assertArchiveFreeSpace,
  scanArchiveTree,
  type ArchiveCodec,
} from './engine.js';

export type ArchiveProcessorOptions = {
  repository: ArchiveRepository;
  worker: ImportWorkerRepository;
  sources: ImportDataPlaneSourceResolver;
  downloader: RangeDownloader;
  spool: SpoolManager;
  spoolCapacity: ImportSpoolCapacityGate;
  codec: ArchiveCodec;
  passwords: Pick<ArchivePasswordStore, 'read' | 'delete'>;
  reserveBytes: () => string;
  videoProbe: (absolutePath: string, signal?: AbortSignal) => Promise<boolean>;
  resources?: ImportResourceScheduler;
  groupResources?: GroupResourceScheduler;
  groupDownloadConnections?: () => number;
  pacer?: BytePacer;
  checkpointEveryBytes?: number;
  downloadContinuity?: DownloadContinuityOptions;
};
export type ArchiveWorkspace = { jobRoot: string; inputs: string; parts: string; work: string };

async function existing(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function directory(filename: string): Promise<void> {
  try {
    await mkdir(filename, { mode: 0o700 });
  } catch (error) {
    // Different admitted groups can create the shared archives root together.
    // EEXIST is only acceptable after the same strict directory/symlink check.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(filename);
  archiveAssert(info.isDirectory() && !info.isSymbolicLink(), 'ARCHIVE_WORKSPACE_UNSAFE');
  await chmod(filename, 0o700);
}
async function syncDirectory(filename: string): Promise<void> {
  let fd;
  try {
    fd = await open(filename, 'r');
    await fd.sync();
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error;
  } finally {
    await fd?.close();
  }
}
async function insideDirectories(root: string, relative: string): Promise<string> {
  const normalized = normalizeArchiveMember(relative),
    parts = normalized.split('/');
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    await directory(cursor);
  }
  return path.join(root, normalized);
}

async function hashFile(
  filename: string,
  size: string,
  signal?: AbortSignal,
): Promise<{ sha256: string; device: string; inode: string }> {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    archiveAssert(
      before.isFile() && before.nlink === 1n && before.size.toString() === size,
      'ARCHIVE_INPUT_CHANGED',
    );
    const hash = createHash('sha256'),
      buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    archiveAssert(before.size <= BigInt(Number.MAX_SAFE_INTEGER), 'ARCHIVE_LIMIT_INVALID');
    while (BigInt(offset) < before.size) {
      signal?.throwIfAborted();
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - offset),
        offset,
      );
      archiveAssert(read.bytesRead > 0, 'ARCHIVE_INPUT_CHANGED');
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    archiveAssert(
      after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.mtimeNs === before.mtimeNs &&
        after.nlink === 1n,
      'ARCHIVE_INPUT_CHANGED',
    );
    return {
      sha256: hash.digest('hex'),
      device: after.dev.toString(),
      inode: after.ino.toString(),
    };
  } finally {
    await handle.close();
  }
}

/** Download all volumes before decoding; upload only installed, hashed video leaves. */
export class ArchiveImportProcessor {
  constructor(private readonly options: ArchiveProcessorOptions) {}
  requiredSpoolBytes(job: ImportWorkerJob): string {
    return this.options.repository.requiredSpoolBytes(job.jobId);
  }

  async reserveReadyOutputPreparation(job: ImportWorkerJob, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const status = this.options.repository.status(job.jobId);
    archiveAssert(status?.phase === 'READY', 'ARCHIVE_OUTPUTS_NOT_PREPARED');
    let reserved = this.requiredSpoolBytes(job);
    if (job.sourceManifest?.version === 4) {
      // Group admission already measured and reserved the retained workspace.
      // READY preparation only reopens/hashes existing outputs; it must not ask
      // for the obsolete extraction peak again. Reuse the grant without resizing
      // it, and fail closed if it is absent or cannot cover all retained videos.
      reserved = this.options.spoolCapacity.reservationBytes(job.jobId);
      if (BigInt(reserved) === 0n || BigInt(reserved) < BigInt(job.jobBytesTotal))
        throw new ImportDataPlaneError('IMPORT_SPOOL_RESERVATION_CONFLICT');
    }
    await this.options.spoolCapacity.reserve(job.jobId, reserved, signal);
  }

  async workspace(jobId: string, create = true): Promise<ArchiveWorkspace> {
    archiveAssert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId),
      'ARCHIVE_WORKSPACE_UNSAFE',
    );
    const root = path.join(this.options.spool.root, 'archives'),
      jobRoot = path.join(root, jobId);
    const paths = {
      jobRoot,
      inputs: path.join(jobRoot, 'inputs'),
      parts: path.join(jobRoot, 'parts'),
      work: path.join(jobRoot, 'work'),
    };
    if (!create) return paths;
    await this.options.spool.initialize();
    await directory(root);
    const wasPresent = await existing(jobRoot);
    await directory(jobRoot);
    const job = this.options.worker.requireJob(jobId);
    archiveAssert(isArchiveSourceManifest(job.sourceManifest), 'ARCHIVE_WORKSPACE_UNSAFE');
    const owner = JSON.stringify({
        version: 1,
        jobId,
        sourceManifestDigest: job.sourceManifestDigest,
      }),
      marker = path.join(jobRoot, 'owner.json');
    if (wasPresent) {
      const info = await lstat(marker);
      archiveAssert(
        info.isFile() && !info.isSymbolicLink() && info.size <= 1024,
        'ARCHIVE_WORKSPACE_UNSAFE',
      );
      archiveAssert((await readFile(marker, 'utf8')) === owner, 'ARCHIVE_WORKSPACE_UNSAFE');
    } else {
      await writeFile(marker, owner, { flag: 'wx', mode: 0o600 });
      const handle = await open(marker, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(jobRoot);
    }
    for (const filename of [paths.inputs, paths.parts, paths.work]) await directory(filename);
    return paths;
  }

  async prepare(job: ImportWorkerJob, signal?: AbortSignal): Promise<ImportWorkerJob> {
    archiveAssert(isArchiveSourceManifest(job.sourceManifest), 'ARCHIVE_SOURCE_PROOF_REQUIRED');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const check = () => {
      const result = this.options.worker.acknowledgeControl(job.jobId, job.attempt);
      if (result !== 'CONTINUE') {
        const control = new ImportControlStop(result);
        controller.abort(control);
        throw control;
      }
      controller.signal.throwIfAborted();
    };
    const timer = setInterval(() => {
      try {
        check();
      } catch (error) {
        controller.abort(error);
      }
    }, 250);
    try {
      check();
      const status = this.options.repository.status(job.jobId);
      archiveAssert(status !== null, 'ARCHIVE_JOB_NOT_FOUND');
      if (status.phase === 'READY' || status.phase === 'CLEANED') {
        this.retireCredentials(job);
        return this.options.worker.requireJob(job.jobId);
      }
      await this.options.spoolCapacity.reserve(
        job.jobId,
        this.requiredSpoolBytes(job),
        controller.signal,
      );
      const body = () => this.prepareLocal(job, controller.signal, check);
      return this.options.resources === undefined || job.sourceManifest.version === 4
        ? await body()
        : await this.options.resources.withLocalPreparation(job.jobId, controller.signal, body);
    } catch (error) {
      if (controller.signal.reason instanceof ImportControlStop) throw controller.signal.reason;
      if (error instanceof ArchiveError) this.options.repository.failure(job, error.code);
      throw error;
    } finally {
      clearInterval(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async prepareLocal(
    job: ImportWorkerJob,
    signal: AbortSignal,
    check: () => void,
  ): Promise<ImportWorkerJob> {
    const repo = this.options.repository,
      paths = await this.workspace(job.jobId);
    let prepared = repo.prepared(job.jobId);
    if (prepared === null) {
      const manifest = job.sourceManifest!;
      archiveAssert(isArchiveSourceManifest(manifest), 'ARCHIVE_SOURCE_PROOF_REQUIRED');
      const base = archiveBaseManifest(manifest),
        sourceJob = {
          ...job,
          objectCount: base.objects.length,
          jobBytesTotal: base.objects.reduce((sum, item) => sum + BigInt(item.size), 0n).toString(),
          sourceManifest: base,
          sourceManifestDigest: sourceManifestDigest(base),
        };
      const source = await this.options.sources.resolve(sourceJob);
      const grouped = manifest.version === 4 && this.options.groupResources !== undefined;
      const continuity = new DownloadContinuity(this.options.downloadContinuity);
      const runInputOperation = async <T>(
        operationKey: string,
        operation: () => Promise<T>,
        downloadPermit: boolean,
      ): Promise<T> => {
        if (!grouped) return operation();
        let sequence = 0;
        return continuity.run({
          signal,
          completedBytes: () => repo.completedInputBytes(job.jobId),
          run: (retrying) => {
            const execute = () => {
              check();
              if (retrying)
                this.options.worker.beginDownloadRetry({
                  jobId: job.jobId,
                  attempt: job.attempt,
                  operationKey,
                  sequence,
                });
              return operation();
            };
            return downloadPermit
              ? this.options.groupResources!.withDownload(job.jobId, signal, execute)
              : execute();
          },
          onRetry: (notice) => {
            check();
            sequence = notice.sequence;
            this.options.worker.recordDownloadRetry({
              jobId: job.jobId,
              attempt: job.attempt,
              operationKey,
              sequence,
              retryAt: notice.retryAt,
              errorCode: notice.error.code,
              ...(notice.error.downloadDiagnostic
                ? { downloadDiagnostic: notice.error.downloadDiagnostic }
                : {}),
            });
          },
        });
      };
      const collectInputs = async () => {
        // Metadata is control work, not ownership of the data-transfer slot.
        await runInputOperation('manifest-before', () => source.discover(sourceJob, signal), false);
        check();
        const remaining = repo
          .inputs(job.jobId)
          .reduce((sum, x) => sum + BigInt(x.sourceSize) - BigInt(x.completedBytes), 0n);
        await assertArchiveFreeSpace(
          paths.jobRoot,
          remaining + BigInt(manifest.archive.maxExpandedBytes),
          BigInt(this.options.reserveBytes()),
        );
        for (const input of repo.inputs(job.jobId)) {
          check();
          await runInputOperation(
            input.sourceFsid,
            () => {
              // Re-read after every failed connection: only the durable prefix is
              // authoritative, and each attempt gets a newly checked source lease.
              const current = repo.input(job.jobId, input.sourceFsid);
              return this.downloadInput(job, current, source, paths, signal, check);
            },
            true,
          );
        }
        // Confirm the immutable source snapshot again after collecting the group.
        await runInputOperation('manifest-after', () => source.discover(sourceJob, signal), false);
        check();
      };
      await collectInputs();
      const decode = async () => {
        await this.clearWork(paths);
        const ref = repo.secretRef(job.jobId),
          passwords = ref === null ? [] : this.options.passwords.read(ref);
        const extractor = new RecursiveArchiveExtractor({ codec: this.options.codec });
        const result = await extractor.extract({
          inputRoot: paths.inputs,
          workRoot: paths.work,
          passwords,
          limits: { ...repo.options(job.jobId), reserveBytes: this.options.reserveBytes() },
          signal,
          videoProbe: this.options.videoProbe,
          onProgress: (event) => {
            check();
            repo.progress(job, event);
          },
        });
        const outputs: PreparedArchiveOutput[] = [];
        for (const [index, video] of result.videos.entries()) {
          check();
          const hashed = await hashFile(video.absolutePath, video.size, signal);
          outputs.push({
            ...video,
            objectId: randomUUID(),
            localId: String(index + 1),
            sha256: hashed.sha256,
          });
        }
        repo.freezePrepared(job, outputs);
      };
      if (manifest.version === 4 && this.options.groupResources)
        await this.options.groupResources.withExtraction(job.jobId, signal, decode);
      else await decode();
      prepared = repo.prepared(job.jobId);
    }
    archiveAssert(prepared !== null, 'ARCHIVE_OUTPUT_PROOF_INVALID');
    const canonicalJobRoot = await realpath(paths.jobRoot),
      canonicalInputsRoot = await realpath(paths.inputs);
    const evidence: { objectId: string; ready: ReadyEvidence }[] = [];
    for (const output of prepared.outputs) {
      check();
      archiveAssert(
        output.absolutePath.startsWith(canonicalJobRoot + path.sep),
        'ARCHIVE_WORKSPACE_UNSAFE',
      );
      const spool = await this.options.spool.paths(job.jobId, output.objectId);
      const original = await existing(output.absolutePath),
        part = await existing(spool.partPath),
        ready = await existing(spool.readyPath);
      let hash: Awaited<ReturnType<typeof hashFile>>;
      if (output.absolutePath.startsWith(canonicalInputsRoot + path.sep)) {
        archiveAssert(original && !(part && ready), 'ARCHIVE_OUTPUT_INSTALL_CONFLICT');
        const input = repo
          .inputs(job.jobId)
          .find((value) => value.relativePath === output.relativePath);
        const sourceHash = await hashFile(output.absolutePath, output.size, signal);
        archiveAssert(
          input !== undefined &&
            input.state === 'READY' &&
            input.localSha256 === output.sha256 &&
            input.sourceSize === output.size &&
            input.readyDevice === sourceHash.device &&
            input.readyInode === sourceHash.inode &&
            sourceHash.sha256 === output.sha256,
          'ARCHIVE_INPUT_CHANGED',
        );
        if (ready) hash = await hashFile(spool.readyPath, output.size, signal);
        else {
          let staged: Awaited<ReturnType<typeof hashFile>> | null = null;
          if (part) {
            const info = await lstat(spool.partPath, { bigint: true });
            archiveAssert(
              info.isFile() &&
                !info.isSymbolicLink() &&
                info.nlink === 1n &&
                info.size <= BigInt(output.size),
              'ARCHIVE_OUTPUT_INSTALL_CONFLICT',
            );
            if (info.size === BigInt(output.size)) {
              const existingHash = await hashFile(spool.partPath, output.size, signal);
              if (existingHash.sha256 === output.sha256) staged = existingHash;
            }
            if (staged === null) await rm(spool.partPath, { force: false });
          }
          if (staged === null) {
            check();
            await assertArchiveFreeSpace(
              spool.jobDirectory,
              BigInt(output.size),
              BigInt(this.options.reserveBytes()),
            );
            const sourceHandle = await open(
              output.absolutePath,
              constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
            );
            try {
              const info = await sourceHandle.stat({ bigint: true });
              archiveAssert(
                info.isFile() &&
                  info.nlink === 1n &&
                  info.dev.toString() === sourceHash.device &&
                  info.ino.toString() === sourceHash.inode,
                'ARCHIVE_INPUT_CHANGED',
              );
              await pipeline(
                sourceHandle.createReadStream({ autoClose: false }),
                createWriteStream(spool.partPath, { flags: 'wx', mode: 0o600 }),
                { signal },
              );
            } finally {
              await sourceHandle.close();
            }
            staged = await hashFile(spool.partPath, output.size, signal);
          }
          hash = staged;
        }
      } else {
        archiveAssert(
          Number(original) + Number(part) + Number(ready) === 1,
          'ARCHIVE_OUTPUT_INSTALL_CONFLICT',
        );
        const actualPath = original ? output.absolutePath : part ? spool.partPath : spool.readyPath;
        hash = await hashFile(actualPath, output.size, signal);
        archiveAssert(hash.sha256 === output.sha256, 'ARCHIVE_OUTPUT_CHANGED');
        if (original) {
          await rename(output.absolutePath, spool.partPath);
          await syncDirectory(path.dirname(output.absolutePath));
          await syncDirectory(spool.jobDirectory);
        }
      }
      check();
      archiveAssert(hash.sha256 === output.sha256, 'ARCHIVE_OUTPUT_CHANGED');
      const landed = await this.options.spool.finalize(job.jobId, output.objectId, output.size);
      archiveAssert(
        landed.device === hash.device && landed.inode === hash.inode,
        'ARCHIVE_OUTPUT_CHANGED',
      );
      evidence.push({ objectId: output.objectId, ready: landed });
    }
    check();
    repo.installPrepared(job, evidence);
    this.retireCredentials(job);
    return this.options.worker.requireJob(job.jobId);
  }

  private async downloadInput(
    job: ImportWorkerJob,
    input: ArchiveInput,
    source: ImportDataPlaneSource,
    paths: ArchiveWorkspace,
    signal: AbortSignal,
    check: () => void,
  ): Promise<void> {
    const target = await insideDirectories(paths.inputs, input.relativePath),
      part = path.join(paths.parts, input.objectId + '.part');
    if (input.state === 'READY') {
      const hash = await hashFile(target, input.sourceSize, signal);
      archiveAssert(
        hash.sha256 === input.localSha256 &&
          hash.device === input.readyDevice &&
          hash.inode === input.readyInode,
        'ARCHIVE_INPUT_CHANGED',
      );
      return;
    }
    archiveAssert(input.state !== 'CLEANED', 'ARCHIVE_INPUT_STATE_INVALID');
    if (await existing(target)) {
      archiveAssert(
        !(await existing(part)) && input.completedBytes === input.sourceSize,
        'ARCHIVE_INPUT_CHANGED',
      );
      const hash = await hashFile(target, input.sourceSize, signal);
      archiveAssert(
        hash.device === input.partialDevice && hash.inode === input.partialInode,
        'ARCHIVE_INPUT_CHANGED',
      );
      this.options.repository.inputReady(job, input.sourceFsid, hash);
      return;
    }
    if (await existing(part)) {
      const info = await lstat(part, { bigint: true });
      archiveAssert(
        info.isFile() && !info.isSymbolicLink() && info.nlink === 1n,
        'ARCHIVE_INPUT_CHANGED',
      );
      if (input.completedBytes !== '0')
        archiveAssert(
          info.dev.toString() === input.partialDevice &&
            info.ino.toString() === input.partialInode &&
            info.size >= BigInt(input.completedBytes),
          'ARCHIVE_INPUT_CHANGED',
        );
    } else {
      archiveAssert(input.completedBytes === '0', 'ARCHIVE_INPUT_CHANGED');
      const created = await open(part, 'wx', 0o600);
      await created.close();
      await syncDirectory(paths.parts);
    }
    const manifest = job.sourceManifest!;
    const original = manifest.objects.find((x) => x.fsid === input.sourceFsid);
    archiveAssert(original !== undefined, 'SOURCE_CHANGED');
    const task: ImportObjectTask = {
      jobId: job.jobId,
      jobAttempt: job.attempt,
      objectId: input.objectId,
      objectAttempt: job.attempt,
      sourceFsid: input.sourceFsid,
      sourcePath: original.path,
      ...(manifest.version === 4 || (manifest.version === 3 && manifest.archive.baseVersion === 2)
        ? { sourceScope: 'FILE' as const }
        : {}),
      sourceSize: input.sourceSize,
      sourceMtime: input.sourceMtime,
      state: 'DISCOVERED',
      secretRef: null,
      destinationAccountId: job.destinationId,
      completedBytes: input.completedBytes,
      localSha256: null,
      stagingKey: null,
      committedKey: null,
      stagingPrefix: 'unused',
      committedPrefix: 'unused',
      resumeCheckpoint: null,
    };
    const preflight = await source.preflight(task, signal);
    check();
    archiveAssert(
      preflight.sourceSnapshot.fsid === input.sourceFsid &&
        preflight.sourceSnapshot.size === input.sourceSize &&
        preflight.sourceSnapshot.mtime === input.sourceMtime &&
        preflight.lease.expectedSize === input.sourceSize,
      'SOURCE_CHANGED',
    );
    const downloadStartedAt = Date.now(),
      downloadStartedBytes = BigInt(input.completedBytes);
    await this.options.downloader.download({
      lease: preflight.lease,
      partPath: part,
      completedBytes: input.completedBytes,
      signal,
      ...(manifest.version === 4
        ? { connections: this.options.groupDownloadConnections ?? (() => 5) }
        : {}),
      ...(this.options.pacer ? { pacer: this.options.pacer } : {}),
      checkpointEveryBytes: this.options.checkpointEveryBytes ?? 8 * 1024 * 1024,
      onDurableCheckpoint: async (checkpoint) => {
        check();
        const info = await lstat(part, { bigint: true });
        archiveAssert(
          info.isFile() && !info.isSymbolicLink() && info.nlink === 1n,
          'ARCHIVE_INPUT_CHANGED',
        );
        const elapsed = Date.now() - downloadStartedAt;
        this.options.repository.checkpoint(job, input.sourceFsid, {
          completedBytes: checkpoint.completedBytes,
          partialDevice: info.dev.toString(),
          partialInode: info.ino.toString(),
          // Parallel look-ahead lands in bursts. Report this attempt's durable
          // average, not the momentary memory-to-disk flush rate as network speed.
          ...(manifest.version === 4
            ? {
                downloadRateBps:
                  elapsed > 0
                    ? (
                        ((BigInt(checkpoint.completedBytes) - downloadStartedBytes) * 1000n) /
                        BigInt(elapsed)
                      ).toString()
                    : null,
              }
            : {}),
        });
        await assertArchiveFreeSpace(paths.jobRoot, 0n, BigInt(this.options.reserveBytes()));
      },
    });
    check();
    const hash = await hashFile(part, input.sourceSize, signal);
    await rename(part, target);
    await syncDirectory(path.dirname(target));
    await syncDirectory(paths.parts);
    this.options.repository.inputReady(job, input.sourceFsid, hash);
  }

  private async clearWork(paths: ArchiveWorkspace): Promise<void> {
    for (const name of await readdir(paths.work)) {
      archiveAssert(/^layer-[0-9a-f-]{36}$/.test(name), 'ARCHIVE_WORKSPACE_UNSAFE');
      const target = path.resolve(paths.work, name);
      archiveAssert(path.dirname(target) === paths.work, 'ARCHIVE_WORKSPACE_UNSAFE');
      const info = await lstat(target);
      archiveAssert(info.isDirectory() && !info.isSymbolicLink(), 'ARCHIVE_WORKSPACE_UNSAFE');
      await rm(target, { recursive: true, force: false });
    }
  }

  private retireCredentials(job: ImportWorkerJob): void {
    const ref = this.options.repository.secretRef(job.jobId);
    if (ref !== null) {
      this.options.repository.retireSecret(job, ref);
      // All group consumers are created atomically. Retire only this reference;
      // a successful sibling must not erase the candidate set of a waiting group.
      if (!this.options.repository.hasSecretReference(ref)) this.options.passwords.delete(ref);
    }
  }

  async cleanup(job: ImportWorkerJob, generationId: string, signal?: AbortSignal): Promise<void> {
    const repo = this.options.repository;
    repo.assertCleanupReady(job.jobId, generationId);
    const paths = await this.workspace(job.jobId, false);
    if (await existing(paths.jobRoot)) {
      if (!repo.cleanupStarted(job.jobId)) {
        // Verify the intact owned input set before durably authorizing its removal.
        await this.workspace(job.jobId);
        signal?.throwIfAborted();
        const files = (await scanArchiveTree(paths.inputs, 100000)).filter((x) => !x.directory),
          expected = repo.inputs(job.jobId);
        archiveAssert(
          files.length === expected.length && (await readdir(paths.parts)).length === 0,
          'ARCHIVE_WORKSPACE_UNSAFE',
        );
        for (const input of expected) {
          const info = await lstat(path.join(paths.inputs, input.relativePath), { bigint: true });
          archiveAssert(
            info.isFile() &&
              !info.isSymbolicLink() &&
              info.size.toString() === input.sourceSize &&
              info.dev.toString() === input.readyDevice &&
              info.ino.toString() === input.readyInode,
            'ARCHIVE_INPUT_CHANGED',
          );
        }
        repo.authorizeSpoolCleanup(job.jobId, generationId);
      }
      const root = path.resolve(this.options.spool.root, 'archives');
      archiveAssert(
        path.dirname(paths.jobRoot) === root && path.basename(paths.jobRoot) === job.jobId,
        'ARCHIVE_WORKSPACE_UNSAFE',
      );
      const info = await lstat(paths.jobRoot);
      archiveAssert(info.isDirectory() && !info.isSymbolicLink(), 'ARCHIVE_WORKSPACE_UNSAFE');
      repo.assertCleanupReady(job.jobId, generationId);
      await rm(paths.jobRoot, { recursive: true, force: false });
      await syncDirectory(root);
    }
    repo.markCleaned(job.jobId, generationId);
  }
}
