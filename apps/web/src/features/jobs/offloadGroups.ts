import type { OffloadSnapshot } from '@ptvault/contracts';

export type OffloadGroup = 'ACTIVE' | 'AWAITING_CLEANUP' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export function groupOf(offload: OffloadSnapshot): OffloadGroup {
  if (offload.cancelledAt !== null || offload.jobState === 'CANCELLED_SAFE') return 'CANCELLED';
  if (offload.jobState === 'FAILED_SAFE' || offload.jobState === 'BLOCKED') return 'FAILED';
  if (offload.currentStep === 'CLOUD_COMMITTED' && offload.cleanupCompletedAt === null) {
    return 'AWAITING_CLEANUP';
  }
  if (offload.currentStep === 'COMPLETED' || offload.cleanupCompletedAt !== null)
    return 'COMPLETED';
  return 'ACTIVE';
}
