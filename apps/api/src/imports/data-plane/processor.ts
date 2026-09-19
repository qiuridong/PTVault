import type {
  ImportWorkerJob,
  ImportWorkerObject,
  ImportWorkerRepository,
} from '../worker-repository.js';
import { ImportControlStop, ImportDataPlaneError } from './errors.js';
import type { RangeDownloader } from './range-downloader.js';
import type { BytePacer } from './rate-pacer.js';
import { BfImportWorkerJournal } from './repository-journal.js';
import type { ReadyEvidence, SpoolManager } from './spool.js';
import type {
  DataPlaneFailure,
  ImportControlPlaneBackupWriter,
  ImportDataPlaneDestinationResolver,
  ImportDataPlaneSourceResolver,
  ImportObjectTask,
} from './types.js';
import { classifyDataPlaneFailure, SingleObjectImportWorker } from './worker.js';
import type { ImportResourceScheduler } from './resource-scheduler.js';
import type { ImportSpoolCapacityGate } from './spool-capacity.js';
import type { ImportDestinationCapacityGate } from './destination-capacity.js';
import type { ArchiveImportProcessor } from '../archive/processor.js';
import { isArchiveSourceManifest } from '../source-manifest.js';
import type { GroupResourceScheduler } from '../groups/resources.js';

export type ImportDataPlaneProcessorOptions = {
  groupResources?: GroupResourceScheduler;
  groupAdmission?: { tick(): Promise<void> };
  claimLimits?: () => { legacy: number; grouped: number };
  archiveProcessing?: ArchiveImportProcessor;
  repository: ImportWorkerRepository;
  sources: ImportDataPlaneSourceResolver;
  destinations: ImportDataPlaneDestinationResolver;
  downloader: RangeDownloader;
  spool: SpoolManager;
  backupWriter: ImportControlPlaneBackupWriter;
  pacer?: BytePacer;
  checkpointEveryBytes?: number;
  now?: () => Date;
  random?: () => number;
  resources?: ImportResourceScheduler;
  spoolCapacity?: ImportSpoolCapacityGate;
  /** Independent follow-up: failure never changes the completed archive result. */
  publication?: { runForJob(jobId: string): Promise<unknown> };
};

export type ImportDataPlaneRunResult =
  | { outcome: 'IDLE' }
  | { outcome: 'COMPLETED'; jobId: string }
  | { outcome: 'INTERRUPTED'; jobId: string }
  | { outcome: 'CONTROLLED'; jobId: string; control: 'PAUSED' | 'CANCELLED' }
  | ({ outcome: 'STOPPED'; jobId: string } & DataPlaneFailure);

function backupGenerationId(evidence: unknown): string {
  if (
    typeof evidence !== 'object' ||
    evidence === null ||
    !('generationId' in evidence) ||
    typeof evidence.generationId !== 'string' ||
    evidence.generationId.length === 0
  ) {
    throw new ImportDataPlaneError('RECOVERY_RECEIPT_INVALID');
  }
  return evidence.generationId;
}

export class ImportDataPlaneProcessor {
  private readonly repository: ImportWorkerRepository;
  private readonly sources: ImportDataPlaneProcessorOptions['sources'];
  private readonly destinations: ImportDataPlaneDestinationResolver;
  private readonly downloader: RangeDownloader;
  private readonly spool: SpoolManager;
  private readonly backupWriter: ImportControlPlaneBackupWriter;
  private readonly pacer: BytePacer | undefined;
  private readonly checkpointEveryBytes: number | undefined;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly resources: ImportResourceScheduler | undefined;
  private readonly spoolCapacity: ImportSpoolCapacityGate | undefined;
  private readonly publication: ImportDataPlaneProcessorOptions['publication'];
  private readonly destinationCapacity: ImportDestinationCapacityGate;
  private readonly archiveProcessing: ImportDataPlaneProcessorOptions['archiveProcessing'];
  private readonly groupResources: ImportDataPlaneProcessorOptions['groupResources'];
  private readonly groupAdmission: ImportDataPlaneProcessorOptions['groupAdmission'];
  private readonly claimLimits: ImportDataPlaneProcessorOptions['claimLimits'];

  constructor(options: ImportDataPlaneProcessorOptions) {
    this.repository = options.repository;
    this.sources = options.sources;
    this.destinations = options.destinations;
    this.downloader = options.downloader;
    this.spool = options.spool;
    this.backupWriter = options.backupWriter;
    this.pacer = options.pacer;
    this.checkpointEveryBytes = options.checkpointEveryBytes;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.resources = options.resources;
    this.spoolCapacity = options.spoolCapacity;
    this.publication = options.publication;
    this.destinationCapacity = this.repository.destinationCapacity();
    this.archiveProcessing = options.archiveProcessing;
    this.groupResources = options.groupResources;
    this.groupAdmission = options.groupAdmission;
    this.claimLimits = options.claimLimits;
  }

  reconcileInterruptedJobs(): number {
    const reconciled = this.repository.reconcileInterruptedJobs();
    this.destinationCapacity.reconcile();
    return reconciled;
  }

  async runOnce(signal?: AbortSignal): Promise<ImportDataPlaneRunResult> {
    await this.groupAdmission?.tick();
    const claimed = this.repository.claimNextJob(this.claimLimits?.());
    if (claimed === null) return { outcome: 'IDLE' };
    if (claimed.sourceManifest?.version === 4 && this.groupResources)
      return this.groupResources.withInFlight(
        claimed.jobId,
        signal ?? new AbortController().signal,
        () => this.process(claimed, signal),
      );
    if (this.resources === undefined) return this.process(claimed, signal);
    const resourceSignal = signal ?? new AbortController().signal;
    try {
      return await this.resources.withMaxInFlight(claimed.jobId, resourceSignal, () =>
        this.process(claimed, signal),
      );
    } catch (error) {
      if (resourceSignal.aborted) return { outcome: 'INTERRUPTED', jobId: claimed.jobId };
      throw error;
    }
  }

  private async process(
    claimed: ImportWorkerJob,
    signal: AbortSignal | undefined,
  ): Promise<ImportDataPlaneRunResult> {
    let activeObject: ImportWorkerObject | null = null;
    try {
      this.checkControl(claimed);
      const archiveJob = isArchiveSourceManifest(claimed.sourceManifest);
      if (archiveJob) {
        if (this.archiveProcessing === undefined)
          throw new ImportDataPlaneError('ARCHIVE_RUNTIME_UNAVAILABLE');
        claimed = await this.archiveProcessing.prepare(claimed, signal);
      }
      this.destinationCapacity.reserve(claimed.jobId, claimed.attempt);
      const source = archiveJob
        ? {
            discover: () =>
              Promise.reject(new ImportDataPlaneError('ARCHIVE_OUTPUTS_NOT_PREPARED')),
            preflight: () =>
              Promise.reject(new ImportDataPlaneError('ARCHIVE_INPUT_UPLOAD_FORBIDDEN')),
          }
        : await this.sources.resolve(claimed);

      let objects = this.repository.listObjects(claimed.jobId);
      if (objects.length < claimed.objectCount) {
        const discovered = await source.discover(claimed, signal);
        for (const object of discovered) {
          if (signal?.aborted) return { outcome: 'INTERRUPTED', jobId: claimed.jobId };
          this.repository.addDiscoveredObject({ ...object, jobId: claimed.jobId });
          this.checkControl(claimed);
        }
      }
      this.repository.finishDiscovery(claimed.jobId);
      await source.releaseCredential?.(claimed);

      let resolved: Awaited<ReturnType<ImportDataPlaneDestinationResolver['resolve']>> | undefined;
      for (;;) {
        this.checkControl(claimed);
        activeObject = this.repository.claimNextObject(claimed.jobId);
        if (activeObject === null) break;
        resolved ??= await this.destinations.resolve(claimed);
        const checkpoint = this.repository.checkpoint(activeObject.objectId);
        const sourceFsid = activeObject.sourceFsid;
        const sourcePath =
          claimed.sourceKind === 'BAIDU_APP_DIR'
            ? claimed.sourceManifest?.objects.find((object) => object.fsid === sourceFsid)?.path
            : undefined;
        const task: ImportObjectTask = {
          jobId: claimed.jobId,
          jobAttempt: claimed.attempt,
          objectId: activeObject.objectId,
          objectAttempt: activeObject.attempt,
          sourceFsid: activeObject.sourceFsid,
          ...(sourcePath === undefined ? {} : { sourcePath }),
          sourceSize: activeObject.sourceSize,
          sourceMtime: activeObject.sourceMtime,
          state: activeObject.state,
          secretRef: claimed.secretRef,
          destinationAccountId: resolved.destinationAccountId,
          completedBytes: activeObject.partialBytes,
          localSha256: activeObject.localSha256,
          stagingKey: activeObject.stagingKey,
          committedKey: activeObject.committedKey,
          stagingPrefix: resolved.stagingPrefix,
          committedPrefix: resolved.committedPrefix,
          resumeCheckpoint:
            checkpoint === null
              ? null
              : {
                  partialPath: checkpoint.partialPath,
                  partialDevice: checkpoint.partialDevice,
                  partialInode: checkpoint.partialInode,
                  completedBytes: checkpoint.completedBytes,
                },
        };
        const worker = new SingleObjectImportWorker({
          source,
          downloader: this.downloader,
          spool: this.spool,
          destination: resolved.adapter,
          journal: new BfImportWorkerJournal(this.repository),
          ...(this.pacer === undefined ? {} : { pacer: this.pacer }),
          ...(this.checkpointEveryBytes === undefined
            ? {}
            : { checkpointEveryBytes: this.checkpointEveryBytes }),
          now: this.now,
          random: this.random,
          networkRetryAttempt: () => this.repository.networkRetryAttempt(claimed.jobId),
          ...{
            withLocalPreparation: async <T>(
              task: ImportObjectTask,
              resourceSignal: AbortSignal,
              body: () => Promise<T>,
            ) => {
              await this.spoolCapacity?.reserve(
                task.jobId,
                archiveJob
                  ? this.archiveProcessing!.requiredSpoolBytes(claimed)
                  : claimed.jobBytesTotal,
                resourceSignal,
              );
              const admitted = () => {
                this.checkControl(claimed);
                this.destinationCapacity.reserve(claimed.jobId, claimed.attempt);
                return body();
              };
              return this.resources === undefined || claimed.sourceManifest?.version === 4
                ? admitted()
                : this.resources.withLocalPreparation(task.jobId, resourceSignal, admitted);
            },
            withStagingUpload: <T>(
              task: ImportObjectTask,
              resourceSignal: AbortSignal,
              body: () => Promise<T>,
            ) => {
              const admitted = () => {
                this.checkControl(claimed);
                this.destinationCapacity.beforeUpload(
                  claimed.jobId,
                  claimed.attempt,
                  task.sourceSize,
                );
                return body();
              };
              return this.resources === undefined || claimed.sourceManifest?.version === 4
                ? admitted()
                : this.resources.withUpload(task.jobId, resourceSignal, admitted);
            },
          },
        });
        const result =
          claimed.sourceManifest?.version === 4 && this.groupResources
            ? await this.groupResources.withUpload(
                claimed.jobId,
                signal ?? new AbortController().signal,
                () => worker.run(task, signal),
              )
            : await worker.run(task, signal);
        if (result.outcome === 'INTERRUPTED') {
          return { outcome: 'INTERRUPTED', jobId: claimed.jobId };
        }
        if (result.outcome === 'CONTROLLED') {
          return { outcome: 'CONTROLLED', jobId: claimed.jobId, control: result.control };
        }
        if (result.outcome === 'STOPPED') {
          return {
            outcome: 'STOPPED',
            jobId: claimed.jobId,
            condition: result.condition,
            errorCode: result.errorCode,
            ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
            ...(result.downloadDiagnostic === undefined
              ? {}
              : { downloadDiagnostic: result.downloadDiagnostic }),
          };
        }
        activeObject = null;
      }

      objects = this.repository.listObjects(claimed.jobId);
      if (objects.every((object) => object.state === 'COMMITTED_VERIFIED')) {
        this.repository.markControlPlaneBackupPending(claimed.jobId, claimed.attempt);
        this.checkControl(claimed);
        const backup = await this.backupWriter.backup(
          this.repository.requireJob(claimed.jobId),
          objects,
          signal,
        );
        this.repository.recordControlPlaneBackup({
          jobId: claimed.jobId,
          idempotencyKey: `import-backup:${claimed.jobId}:${backup.generationId}`,
          size: backup.size,
          sha256: backup.sha256,
          evidence: { generationId: backup.generationId, proof: backup.evidence },
        });
      }

      const backup = this.repository.controlPlaneBackup(claimed.jobId);
      if (backup === null) throw new ImportDataPlaneError('RECOVERY_RECEIPT_MISSING');
      const generationId = backupGenerationId(backup.evidence);
      objects = this.repository.listObjects(claimed.jobId);
      for (const object of objects) {
        if (object.state === 'SPOOL_CLEANED') continue;
        if (object.state !== 'CONTROL_PLANE_BACKED_UP') {
          throw new ImportDataPlaneError('IMPORT_OBJECT_FINALIZATION_CONFLICT');
        }
        this.checkControl(claimed);
        let ready: ReadyEvidence | null;
        try {
          ready = await this.spool.readyEvidence(claimed.jobId, object.objectId, object.sourceSize);
        } catch (error) {
          if (error instanceof ImportDataPlaneError && error.code === 'SPOOL_READY_MISSING') {
            ready = null;
          } else {
            throw error;
          }
        }
        let alreadyAbsent = true;
        if (ready !== null) {
          const hash = await this.spool.hashReady(ready, signal);
          if (object.localSha256 === null || hash.sha256 !== object.localSha256) {
            throw new ImportDataPlaneError('SPOOL_HASH_MISMATCH');
          }
          signal?.throwIfAborted();
          this.checkControl(claimed);
          ({ alreadyAbsent } = await this.spool.cleanup({
            objectId: object.objectId,
            ready,
            recoveryGenerationId: generationId,
            recoveryState: 'CONTROL_PLANE_BACKED_UP',
          }));
        }
        this.repository.recordSpoolCleaned({
          jobId: claimed.jobId,
          objectId: object.objectId,
          attempt: object.attempt,
          idempotencyKey: `import-spool-cleaned:${object.objectId}`,
          evidence: { generationId, readyRemoved: true, alreadyAbsent },
        });
      }
      this.checkControl(claimed);
      if (archiveJob) await this.archiveProcessing!.cleanup(claimed, generationId, signal);
      this.repository.completeJob(claimed.jobId);
      this.spoolCapacity?.release(claimed.jobId);
      try {
        await this.publication?.runForJob(claimed.jobId);
      } catch {
        // Publication has its own durable FAILED_SAFE state. An unavailable
        // Jellyfin/mount/farm must not turn a verified import back into failure.
      }
      return { outcome: 'COMPLETED', jobId: claimed.jobId };
    } catch (error) {
      if (error instanceof ImportControlStop) {
        return { outcome: 'CONTROLLED', jobId: claimed.jobId, control: error.control };
      }
      if (signal?.aborted) return { outcome: 'INTERRUPTED', jobId: claimed.jobId };
      const failure = classifyDataPlaneFailure(
        error,
        claimed.attempt,
        this.now,
        this.random,
        this.repository.networkRetryAttempt(claimed.jobId),
      );
      if (
        claimed.sourceManifest?.version === 4 &&
        failure.condition === 'RESOURCE_WAIT' &&
        failure.retryAt === undefined
      )
        failure.retryAt = this.now().getTime() + 30000;
      this.repository.recordFailure({
        jobId: claimed.jobId,
        jobAttempt: claimed.attempt,
        ...(activeObject === null
          ? {}
          : {
              objectId: activeObject.objectId,
              objectAttempt: activeObject.attempt,
            }),
        condition: failure.condition,
        errorCode: failure.errorCode,
        ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }),
        ...(failure.downloadDiagnostic === undefined
          ? {}
          : { downloadDiagnostic: failure.downloadDiagnostic }),
      });
      return { outcome: 'STOPPED', jobId: claimed.jobId, ...failure };
    } finally {
      this.destinationCapacity.release(claimed.jobId, claimed.attempt);
    }
  }

  private checkControl(job: ImportWorkerJob): void {
    const control = this.repository.acknowledgeControl(job.jobId, job.attempt);
    if (control !== 'CONTINUE') throw new ImportControlStop(control);
  }
}
