import { DownloadFailureDiagnosticSchema } from '@ptvault/contracts';
import type { ImportObjectState } from '../worker-repository.js';
import { IMPORT_OBJECT_STATES } from '../worker-repository.js';
import { retryDecision } from './backoff.js';
import { isSourceNetworkRetryCode } from './network-retry.js';
import { providerRetryAfterMs } from './download-continuity.js';
import {
  DestinationError,
  type DestinationReceipt,
  type DestinationStage,
  type VerifiedDestinationAdapter,
} from './destination.js';
import { dataPlaneInvariant, ImportControlStop, ImportDataPlaneError } from './errors.js';
import type { DurableDownloadCheckpoint, RangeDownloader } from './range-downloader.js';
import { RangeDownloadError } from './range-downloader.js';
import type { BytePacer } from './rate-pacer.js';
import type { ReadyEvidence, ReadyHash, SpoolManager } from './spool.js';
import type { DataPlaneFailure, ImportDataPlaneSource, ImportObjectTask } from './types.js';

export type DataPlaneWorkerStage =
  'SOURCE_PREFLIGHT' | 'DOWNLOADING' | 'LOCAL_LANDING' | 'HASHING' | DestinationStage;

export interface ImportDataPlaneJournal {
  stage(
    task: ImportObjectTask,
    stage: DataPlaneWorkerStage,
    evidence?: unknown,
  ): void | Promise<void>;
  downloadCheckpoint(
    task: ImportObjectTask,
    checkpoint: DurableDownloadCheckpoint,
    partialPath: string,
  ): void | Promise<void>;
  acquired(task: ImportObjectTask, evidence: ReadyEvidence): void | Promise<void>;
  hashed(task: ImportObjectTask, ready: ReadyEvidence, hash: ReadyHash): void | Promise<void>;
  destinationReceipt(task: ImportObjectTask, receipt: DestinationReceipt): void | Promise<void>;
  failure(task: ImportObjectTask, failure: DataPlaneFailure): void | Promise<void>;
}

export type SingleObjectWorkerResult =
  | {
      outcome: 'AWAITING_CONTROL_PLANE_BACKUP';
      ready: ReadyEvidence;
      hash: ReadyHash;
      committedKey: string;
    }
  | ({ outcome: 'STOPPED' } & DataPlaneFailure)
  | { outcome: 'CONTROLLED'; control: 'PAUSED' | 'CANCELLED' }
  | { outcome: 'INTERRUPTED' };

export type SingleObjectImportWorkerOptions = {
  source: ImportDataPlaneSource;
  downloader: RangeDownloader;
  spool: SpoolManager;
  destination: VerifiedDestinationAdapter;
  journal: ImportDataPlaneJournal;
  pacer?: BytePacer;
  checkpointEveryBytes?: number;
  now?: () => Date;
  random?: () => number;
  networkRetryAttempt?: () => number;
  withLocalPreparation?: <T>(
    task: ImportObjectTask,
    signal: AbortSignal,
    body: () => Promise<T>,
  ) => Promise<T>;
  withStagingUpload?: <T>(
    task: ImportObjectTask,
    signal: AbortSignal,
    body: () => Promise<T>,
  ) => Promise<T>;
};

const STATE_RANK = new Map(IMPORT_OBJECT_STATES.map((state, index) => [state, index] as const));

function atLeast(state: ImportObjectState, expected: ImportObjectState): boolean {
  return STATE_RANK.get(state)! >= STATE_RANK.get(expected)!;
}

export class SingleObjectImportWorker {
  private readonly source: ImportDataPlaneSource;
  private readonly downloader: RangeDownloader;
  private readonly spool: SpoolManager;
  private readonly destination: VerifiedDestinationAdapter;
  private readonly journal: ImportDataPlaneJournal;
  private readonly pacer: BytePacer | undefined;
  private readonly checkpointEveryBytes: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly networkRetryAttempt: (() => number) | undefined;
  private readonly withLocalPreparation: SingleObjectImportWorkerOptions['withLocalPreparation'];
  private readonly withStagingUpload: SingleObjectImportWorkerOptions['withStagingUpload'];

  constructor(options: SingleObjectImportWorkerOptions) {
    this.source = options.source;
    this.downloader = options.downloader;
    this.spool = options.spool;
    this.destination = options.destination;
    this.journal = options.journal;
    this.pacer = options.pacer;
    this.checkpointEveryBytes = options.checkpointEveryBytes ?? 8 * 1024 * 1024;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.networkRetryAttempt = options.networkRetryAttempt;
    this.withLocalPreparation = options.withLocalPreparation;
    this.withStagingUpload = options.withStagingUpload;
  }

  async run(task: ImportObjectTask, signal?: AbortSignal): Promise<SingleObjectWorkerResult> {
    try {
      const resourceSignal = signal ?? new AbortController().signal;
      const prepare = () => this.prepare(task, signal);
      const { ready, hash } =
        this.withLocalPreparation === undefined
          ? await prepare()
          : await this.withLocalPreparation(task, resourceSignal, prepare);

      let committedKey = task.committedKey ?? `${task.committedPrefix}/${hash.sha256}`;
      if (!atLeast(task.state, 'COMMITTED_VERIFIED')) {
        const committed = await this.destination.commit({
          localReadyPath: ready.readyPath,
          expectedSize: hash.size,
          expectedSha256: hash.sha256,
          stagingKey: task.stagingKey ?? `${task.stagingPrefix}/${task.jobId}/${task.objectId}`,
          committedKey,
          reconcileCommittedFirst: atLeast(task.state, 'COMMITTING'),
          ...(signal === undefined ? {} : { signal }),
          onStage: (stage) => this.journal.stage(task, stage),
          onDurableReceipt: (receipt) => this.journal.destinationReceipt(task, receipt),
          ...(this.withStagingUpload === undefined
            ? {}
            : {
                withStagingUpload: <T>(body: () => Promise<T>) =>
                  this.withStagingUpload!(task, resourceSignal, body),
              }),
        });
        committedKey = committed.committedKey;
      }
      return {
        outcome: 'AWAITING_CONTROL_PLANE_BACKUP',
        ready,
        hash,
        committedKey,
      };
    } catch (error) {
      if (error instanceof ImportControlStop) {
        return { outcome: 'CONTROLLED', control: error.control };
      }
      if (signal?.aborted) return { outcome: 'INTERRUPTED' };
      const failure = classifyDataPlaneFailure(
        error,
        task.objectAttempt,
        this.now,
        this.random,
        this.networkRetryAttempt?.(),
      );
      await this.journal.failure(task, failure);
      return { outcome: 'STOPPED', ...failure };
    }
  }

  private async prepare(
    task: ImportObjectTask,
    signal: AbortSignal | undefined,
  ): Promise<{ ready: ReadyEvidence; hash: ReadyHash }> {
    let ready: ReadyEvidence;
    if (!atLeast(task.state, 'ACQUIRED')) {
      if (!atLeast(task.state, 'LOCAL_LANDING')) {
        await this.journal.stage(task, 'SOURCE_PREFLIGHT');
        const preflight = await this.source.preflight(task, signal);
        dataPlaneInvariant(
          preflight.sourceSnapshot.fsid === task.sourceFsid &&
            preflight.sourceSnapshot.size === task.sourceSize &&
            preflight.sourceSnapshot.mtime === task.sourceMtime &&
            preflight.lease.expectedSize === task.sourceSize,
          'SOURCE_CHANGED',
        );
        const paths = await this.spool.paths(task.jobId, task.objectId);
        if (task.resumeCheckpoint !== null) {
          dataPlaneInvariant(
            task.resumeCheckpoint.partialPath === paths.partPath &&
              task.resumeCheckpoint.completedBytes === task.completedBytes,
            'SPOOL_CHECKPOINT_CONFLICT',
          );
          await this.spool.assertPartialIdentity(paths.partPath, {
            device: task.resumeCheckpoint.partialDevice,
            inode: task.resumeCheckpoint.partialInode,
            completedBytes: task.completedBytes,
          });
        }
        await this.journal.stage(task, 'DOWNLOADING', {
          completedBytes: task.completedBytes,
          leaseId: preflight.lease.leaseId,
          leaseExpiresAt: preflight.lease.expiresAt,
        });
        await this.downloader.download({
          lease: preflight.lease,
          partPath: paths.partPath,
          completedBytes: task.completedBytes,
          ...(signal === undefined ? {} : { signal }),
          ...(this.pacer === undefined ? {} : { pacer: this.pacer }),
          checkpointEveryBytes: this.checkpointEveryBytes,
          onDurableCheckpoint: (checkpoint) =>
            this.journal.downloadCheckpoint(task, checkpoint, paths.partPath),
        });
        await this.journal.stage(task, 'LOCAL_LANDING');
      }
      ready = await this.spool.finalize(task.jobId, task.objectId, task.sourceSize);
      await this.journal.acquired(task, ready);
    } else {
      ready = await this.spool.readyEvidence(task.jobId, task.objectId, task.sourceSize);
    }

    let hash: ReadyHash;
    if (!atLeast(task.state, 'HASHED')) {
      await this.journal.stage(task, 'HASHING');
      hash = await this.spool.hashReady(ready);
      await this.journal.hashed(task, ready, hash);
    } else {
      hash = await this.spool.hashReady(ready);
      dataPlaneInvariant(
        task.localSha256 !== null && task.localSha256 === hash.sha256,
        'SPOOL_HASH_MISMATCH',
      );
    }
    return { ready, hash };
  }
}

export function classifyDataPlaneFailure(
  error: unknown,
  attempt: number,
  now: () => Date = () => new Date(),
  random: () => number = Math.random,
  networkRetryAttempt?: number,
): DataPlaneFailure {
  const failure = classifyFailureCondition(error, attempt, now, random, networkRetryAttempt);
  const diagnostic = DownloadFailureDiagnosticSchema.safeParse(
    error instanceof ImportDataPlaneError ? error.downloadDiagnostic : undefined,
  );
  return diagnostic.success ? { ...failure, downloadDiagnostic: diagnostic.data } : failure;
}

function classifyFailureCondition(
  error: unknown,
  attempt: number,
  now: () => Date,
  random: () => number,
  networkRetryAttempt?: number,
): DataPlaneFailure {
  const code =
    error instanceof ImportDataPlaneError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'UNEXPECTED_DATA_PLANE_ERROR';
  if (
    code.startsWith('AUTH_') ||
    code === 'IMPORT_SECRET_EXPIRED' ||
    code === 'IMPORT_SECRET_NOT_FOUND' ||
    code === 'ARCHIVE_PASSWORDS_EXHAUSTED' ||
    code === 'ARCHIVE_CREDENTIAL_MISSING' ||
    code === 'ARCHIVE_CREDENTIAL_EXPIRED' ||
    code === 'ARCHIVE_CREDENTIAL_INVALID' ||
    code.startsWith('SECRET_')
  ) {
    return { condition: 'AUTH_REQUIRED', errorCode: code };
  }
  if (code === 'RATE_LIMITED' || code === 'API_QUOTA_EXCEEDED') {
    const providerRetryAfter =
      typeof error === 'object' &&
      error !== null &&
      'retryAfterMs' in error &&
      (typeof error.retryAfterMs === 'number' || error.retryAfterMs === null)
        ? error.retryAfterMs
        : null;
    const explicit = error instanceof RangeDownloadError ? error.retryAfterMs : providerRetryAfter;
    const decision = retryDecision({
      attempt,
      retryAfterMs: explicit,
      now: now(),
      random,
    });
    return { condition: 'RATE_LIMITED', errorCode: code, retryAt: decision.retryAt };
  }
  if (code === 'SOURCE_CHANGED' || code === 'RANGE_NOT_HONORED') {
    return { condition: 'SOURCE_CHANGED', errorCode: code };
  }
  if (code === 'DESTINATION_CAPACITY_WAIT') {
    return { condition: 'RESOURCE_WAIT', errorCode: code, retryAt: now().getTime() + 30_000 };
  }
  if (
    code.includes('RESERVATION') ||
    code === 'ENOSPC' ||
    code === 'BAIDU_QUOTA_EXCEEDED' ||
    code === 'ARCHIVE_DISK_SPACE_LOW'
  ) {
    return { condition: 'RESOURCE_WAIT', errorCode: code };
  }
  if (
    code.startsWith('SPOOL_') ||
    code === 'DESTINATION_HASH_MISMATCH' ||
    code.includes('SIZE_MISMATCH')
  ) {
    return { condition: 'FAILED_SAFE', errorCode: code };
  }
  if (
    error instanceof DestinationError ||
    code.startsWith('DESTINATION_') ||
    code.startsWith('RCLONE_') ||
    code.startsWith('RECOVERY_')
  ) {
    const decision = retryDecision({ attempt, now: now(), random });
    return {
      condition: 'DESTINATION_UNAVAILABLE',
      errorCode: code,
      retryAt: decision.retryAt,
    };
  }
  if (isSourceNetworkRetryCode(code)) {
    const time = now();
    const explicitRetryAfter = providerRetryAfterMs(error);
    const decision = retryDecision({
      attempt: networkRetryAttempt ?? Math.max(0, attempt - 1),
      retryAfterMs: explicitRetryAfter,
      now: time,
      random,
      maximumMs: 120_000,
    });
    return {
      condition: 'RETRY_WAIT',
      errorCode: code,
      retryAt:
        explicitRetryAfter === null
          ? time.getTime() + Math.min(decision.delayMs, 120_000)
          : decision.retryAt,
    };
  }
  if (code === 'BAIDU_TRANSFER_ALREADY_RUNNING' || code === 'BAIDU_TRANSFER_TIMEOUT') {
    const decision = retryDecision({ attempt, now: now(), random });
    return { condition: 'RETRY_WAIT', errorCode: code, retryAt: decision.retryAt };
  }
  return { condition: 'FAILED_SAFE', errorCode: code };
}
