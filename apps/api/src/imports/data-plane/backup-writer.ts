import type { ImportWorkerJob, ImportWorkerObject } from '../worker-repository.js';
import { dataPlaneInvariant } from './errors.js';
import type { ImportControlPlaneBackupReceipt, ImportControlPlaneBackupWriter } from './types.js';

export interface RecoveryGenerationWorkflow {
  generate(input: { destinationAccountIds: readonly string[]; signal: AbortSignal }): Promise<{
    version: number;
    bundleSha256: string;
    escrowSha256: string;
    accountIds: string[];
  }>;
}

/** Wraps the existing encrypted, multi-account recovery workflow as the cleanup gate. */
export class RecoveryWorkflowImportBackupWriter implements ImportControlPlaneBackupWriter {
  private readonly accountIds: readonly string[];

  constructor(
    private readonly workflow: RecoveryGenerationWorkflow,
    destinationAccountIds: readonly string[],
  ) {
    this.accountIds = [...new Set(destinationAccountIds)];
    dataPlaneInvariant(this.accountIds.length >= 2, 'RECOVERY_REQUIRES_TWO_DESTINATIONS');
  }

  async backup(
    job: ImportWorkerJob,
    objects: readonly ImportWorkerObject[],
    signal?: AbortSignal,
  ): Promise<ImportControlPlaneBackupReceipt> {
    dataPlaneInvariant(
      objects.length === job.objectCount &&
        objects.every(
          (object) =>
            object.state === 'COMMITTED_VERIFIED' &&
            object.committedSha256 !== null &&
            object.committedSha256 === object.localSha256,
        ),
      'RECOVERY_IMPORT_OBJECTS_NOT_VERIFIED',
    );
    const controller = signal ?? new AbortController().signal;
    const generated = await this.workflow.generate({
      destinationAccountIds: this.accountIds,
      signal: controller,
    });
    const verifiedAccounts = new Set(generated.accountIds);
    dataPlaneInvariant(
      /^[0-9a-f]{64}$/.test(generated.bundleSha256) &&
        /^[0-9a-f]{64}$/.test(generated.escrowSha256) &&
        verifiedAccounts.size >= 2 &&
        this.accountIds.every((accountId) => verifiedAccounts.has(accountId)),
      'RECOVERY_GENERATION_RECEIPT_INVALID',
    );
    return {
      generationId: `recovery-v${generated.version}`,
      size: job.jobBytesTotal,
      sha256: generated.bundleSha256,
      evidence: {
        version: generated.version,
        bundleSha256: generated.bundleSha256,
        escrowSha256: generated.escrowSha256,
        accountIds: generated.accountIds,
      },
    };
  }
}
