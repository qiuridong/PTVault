import { DeletionPermitSchema, type DeletionPermit, type RecoveryStatus } from '@ptvault/contracts';

export class RecoveryGate {
  constructor(
    private readonly repository: { currentStatus(): RecoveryStatus | Promise<RecoveryStatus> },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issueDeletionPermit(jobId: string): Promise<DeletionPermit> {
    if (!jobId) throw new Error('DELETION_PERMIT_JOB_REQUIRED');
    const status = await this.repository.currentStatus();
    if (!status.deletionUnlocked || status.version === null) {
      throw new Error('RECOVERY_MATERIAL_NOT_READY');
    }
    return DeletionPermitSchema.parse({
      kind: 'DELETION_PERMIT',
      jobId,
      recoveryVersion: status.version,
      baselineRevision: status.baselineRevision,
      materialRevision: status.materialRevision,
      issuedAt: this.now().getTime(),
    });
  }
}
