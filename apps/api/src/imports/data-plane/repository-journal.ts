import { lstat } from 'node:fs/promises';

import {
  IMPORT_OBJECT_STATES,
  type ImportObjectReceipt,
  type ImportObjectReceiptKind,
  type ImportObjectState,
  type ImportWorkerRepository,
  type ImportWorkerStage,
} from '../worker-repository.js';
import type { DestinationReceipt } from './destination.js';
import { dataPlaneInvariant, ImportControlStop } from './errors.js';
import type { DurableDownloadCheckpoint } from './range-downloader.js';
import type { ReadyEvidence, ReadyHash } from './spool.js';
import type { DataPlaneFailure, ImportObjectTask } from './types.js';
import type { DataPlaneWorkerStage, ImportDataPlaneJournal } from './worker.js';

const STAGE_MAP: Readonly<Record<DataPlaneWorkerStage, ImportWorkerStage>> = {
  SOURCE_PREFLIGHT: 'SOURCE_PREFLIGHT',
  DOWNLOADING: 'DOWNLOADING',
  LOCAL_LANDING: 'LOCAL_LANDING',
  HASHING: 'HASHING',
  UPLOADING_STAGING: 'UPLOADING_STAGING',
  STAGING_READBACK: 'STAGING_READBACK',
  COMMITTING: 'COMMITTING',
  COMMITTED_READBACK: 'COMMITTED_READBACK',
};

const RECEIPT_STATE: Readonly<Record<ImportObjectReceiptKind, ImportObjectState>> = {
  ACQUIRED: 'ACQUIRED',
  HASHED: 'HASHED',
  STAGING_UPLOADED: 'STAGING_UPLOADED',
  STAGING_VERIFIED: 'STAGING_VERIFIED',
  COMMITTED: 'COMMITTED',
  COMMITTED_VERIFIED: 'COMMITTED_VERIFIED',
};

const STATE_RANK = new Map(IMPORT_OBJECT_STATES.map((state, index) => [state, index] as const));

export class BfImportWorkerJournal implements ImportDataPlaneJournal {
  constructor(private readonly repository: ImportWorkerRepository) {}

  stage(task: ImportObjectTask, stage: DataPlaneWorkerStage, evidence?: unknown): void {
    this.repository.recordStage({
      jobId: task.jobId,
      objectId: task.objectId,
      attempt: task.objectAttempt,
      stage: STAGE_MAP[stage],
      ...(evidence === undefined ? {} : { evidence }),
    });
    this.checkControl(task);
  }

  async downloadCheckpoint(
    task: ImportObjectTask,
    checkpoint: DurableDownloadCheckpoint,
    partialPath: string,
  ): Promise<void> {
    const current = await lstat(partialPath, { bigint: true });
    dataPlaneInvariant(
      current.isFile() && !current.isSymbolicLink(),
      'LEDGER_PARTIAL_TYPE_INVALID',
    );
    dataPlaneInvariant(
      current.size.toString() === checkpoint.completedBytes,
      'LEDGER_PARTIAL_SIZE_MISMATCH',
    );
    const leaseExpiresAt = Date.parse(checkpoint.leaseExpiresAt);
    dataPlaneInvariant(Number.isSafeInteger(leaseExpiresAt), 'LEDGER_LEASE_EXPIRY_INVALID');
    this.repository.saveCheckpoint({
      jobId: task.jobId,
      objectId: task.objectId,
      attempt: task.objectAttempt,
      completedBytes: checkpoint.completedBytes,
      sourceSnapshot: {
        fsid: task.sourceFsid,
        size: task.sourceSize,
        mtime: task.sourceMtime,
      },
      downloadLeaseId: checkpoint.leaseId,
      downloadLeaseExpiresAt: leaseExpiresAt,
      partialPath,
      partialDevice: current.dev.toString(),
      partialInode: current.ino.toString(),
    });
    this.checkControl(task);
  }

  acquired(task: ImportObjectTask, evidence: ReadyEvidence): void {
    this.recordOrValidate(task, {
      kind: 'ACQUIRED',
      idempotencyKey: `import-receipt:${task.objectId}:ACQUIRED`,
      evidence,
      size: evidence.size,
    });
    this.checkControl(task);
  }

  hashed(task: ImportObjectTask, ready: ReadyEvidence, hash: ReadyHash): void {
    this.recordOrValidate(task, {
      kind: 'HASHED',
      idempotencyKey: `import-receipt:${task.objectId}:HASHED`,
      evidence: {
        readyPath: ready.readyPath,
        device: ready.device,
        inode: ready.inode,
        mtimeNs: ready.mtimeNs,
        hashedAt: hash.hashedAt,
      },
      size: hash.size,
      sha256: hash.sha256,
    });
    this.checkControl(task);
  }

  destinationReceipt(task: ImportObjectTask, receipt: DestinationReceipt): void {
    const base = {
      idempotencyKey: `import-receipt:${task.objectId}:${receipt.kind}`,
      evidence: receipt,
      size: receipt.size,
      destinationAccountId: task.destinationAccountId,
    };
    if (receipt.kind === 'STAGING_UPLOADED') {
      this.recordOrValidate(task, {
        ...base,
        kind: receipt.kind,
        stagingKey: receipt.key,
        ...(receipt.providerRequestId === undefined
          ? {}
          : { providerRequestId: receipt.providerRequestId }),
      });
    } else if (receipt.kind === 'STAGING_VERIFIED') {
      this.recordOrValidate(task, {
        ...base,
        kind: receipt.kind,
        stagingKey: receipt.key,
        sha256: receipt.sha256,
      });
    } else {
      const current = this.repository.requireObject(task.objectId);
      const stagingKey =
        current.stagingKey ?? `${task.stagingPrefix}/${task.jobId}/${task.objectId}`;
      this.recordOrValidate(task, {
        ...base,
        kind: receipt.kind,
        stagingKey,
        committedKey: receipt.key,
        ...(receipt.kind === 'COMMITTED_VERIFIED' ? { sha256: receipt.sha256 } : {}),
        ...('providerRequestId' in receipt && receipt.providerRequestId !== undefined
          ? { providerRequestId: receipt.providerRequestId }
          : {}),
      });
    }
    this.checkControl(task);
  }

  failure(task: ImportObjectTask, failure: DataPlaneFailure): void {
    this.repository.recordFailure({
      jobId: task.jobId,
      jobAttempt: task.jobAttempt,
      objectId: task.objectId,
      objectAttempt: task.objectAttempt,
      condition: failure.condition,
      errorCode: failure.errorCode,
      ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }),
      ...(failure.downloadDiagnostic === undefined
        ? {}
        : { downloadDiagnostic: failure.downloadDiagnostic }),
    });
  }

  private recordOrValidate(
    task: ImportObjectTask,
    receipt: Omit<ImportObjectReceipt, 'jobId' | 'objectId' | 'attempt'>,
  ): void {
    const object = this.repository.requireObject(task.objectId);
    const targetState = RECEIPT_STATE[receipt.kind];
    if (STATE_RANK.get(object.state)! >= STATE_RANK.get(targetState)!) {
      dataPlaneInvariant(receipt.size === object.sourceSize, 'LEDGER_RECEIPT_SIZE_CONFLICT');
      if (receipt.kind === 'HASHED') {
        dataPlaneInvariant(receipt.sha256 === object.localSha256, 'LEDGER_LOCAL_HASH_CONFLICT');
      }
      if (receipt.kind === 'STAGING_UPLOADED' || receipt.kind === 'STAGING_VERIFIED') {
        dataPlaneInvariant(receipt.stagingKey === object.stagingKey, 'LEDGER_STAGING_KEY_CONFLICT');
      }
      if (receipt.kind === 'STAGING_VERIFIED') {
        dataPlaneInvariant(receipt.sha256 === object.stagingSha256, 'LEDGER_STAGING_HASH_CONFLICT');
      }
      if (receipt.kind === 'COMMITTED' || receipt.kind === 'COMMITTED_VERIFIED') {
        dataPlaneInvariant(
          receipt.committedKey === object.committedKey,
          'LEDGER_COMMITTED_KEY_CONFLICT',
        );
      }
      if (receipt.kind === 'COMMITTED_VERIFIED') {
        dataPlaneInvariant(
          receipt.sha256 === object.committedSha256,
          'LEDGER_COMMITTED_HASH_CONFLICT',
        );
      }
      return;
    }
    this.repository.recordReceipt({
      jobId: task.jobId,
      objectId: task.objectId,
      attempt: task.objectAttempt,
      ...receipt,
    });
  }

  private checkControl(task: ImportObjectTask): void {
    const control = this.repository.acknowledgeControl(task.jobId, task.jobAttempt);
    if (control !== 'CONTINUE') throw new ImportControlStop(control);
  }
}
