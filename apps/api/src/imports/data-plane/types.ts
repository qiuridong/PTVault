import type { DownloadFailureDiagnostic } from '@ptvault/contracts';
import type {
  DiscoveredImportObject,
  ImportObjectState,
  ImportWorkerJob,
  ImportWorkerObject,
} from '../worker-repository.js';
import type { VerifiedDestinationAdapter } from './destination.js';
import type { DownloadLease } from './range-downloader.js';

export type ImportObjectTask = {
  jobId: string;
  jobAttempt: number;
  objectId: string;
  objectAttempt: number;
  sourceFsid: string;
  sourcePath?: string;
  sourceScope?: 'FILE';
  sourceSize: string;
  sourceMtime: string;
  state: ImportObjectState;
  secretRef: string | null;
  destinationAccountId: string;
  completedBytes: string;
  localSha256: string | null;
  stagingKey: string | null;
  committedKey: string | null;
  stagingPrefix: string;
  committedPrefix: string;
  resumeCheckpoint: {
    partialPath: string;
    partialDevice: string;
    partialInode: string;
    completedBytes: string;
  } | null;
};

export type SourcePreflightResult = {
  lease: DownloadLease;
  sourceSnapshot: { fsid: string; size: string; mtime: string };
};

export interface ImportDataPlaneSource {
  discover(job: ImportWorkerJob, signal?: AbortSignal): Promise<DiscoveredImportObject[]>;
  preflight(task: ImportObjectTask, signal?: AbortSignal): Promise<SourcePreflightResult>;
  releaseCredential?(job: ImportWorkerJob): void | Promise<void>;
}

/** Resolves from the immutable job binding; implementations have no global fallback. */
export interface ImportDataPlaneSourceResolver {
  resolve(job: ImportWorkerJob): Promise<ImportDataPlaneSource>;
}

export type ResolvedImportDestination = {
  destinationAccountId: string;
  adapter: VerifiedDestinationAdapter;
  stagingPrefix: string;
  committedPrefix: string;
};

export interface ImportDataPlaneDestinationResolver {
  resolve(job: ImportWorkerJob): Promise<ResolvedImportDestination>;
}

export type ImportControlPlaneBackupReceipt = {
  generationId: string;
  size: string;
  sha256: string;
  evidence: unknown;
};

export interface ImportControlPlaneBackupWriter {
  backup(
    job: ImportWorkerJob,
    objects: readonly ImportWorkerObject[],
    signal?: AbortSignal,
  ): Promise<ImportControlPlaneBackupReceipt>;
}

export type DataPlaneFailureCondition =
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'RETRY_WAIT'
  | 'RESOURCE_WAIT'
  | 'SOURCE_CHANGED'
  | 'DESTINATION_UNAVAILABLE'
  | 'FAILED_SAFE'
  | 'CANCELLED_SAFE';

export type DataPlaneFailure = {
  condition: DataPlaneFailureCondition;
  errorCode: string;
  retryAt?: number;
  downloadDiagnostic?: DownloadFailureDiagnostic;
};
