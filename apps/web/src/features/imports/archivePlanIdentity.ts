import type { ArchivePlanRequest, ImportPlan } from '@ptvault/contracts';
export function verifyArchivePlanIdentity(
  request: ArchivePlanRequest | undefined,
  plan: ImportPlan,
): void {
  const proof = plan.archive;
  if (request === undefined) {
    if (proof !== undefined) throw new Error('ARCHIVE_PLAN_IDENTITY_UNVERIFIED');
    return;
  }
  if (
    proof === undefined ||
    proof.mode !== request.mode ||
    proof.maxDepth !== request.maxDepth ||
    proof.maxExpandedBytes !== request.maxExpandedBytes ||
    proof.candidateCount !== new Set(request.candidates).size ||
    proof.inputCount !== plan.objectCount ||
    proof.inputBytes !== plan.totalBytes ||
    proof.requiredSpoolBytes !== plan.requiredSpoolBytes ||
    BigInt(proof.requiredSpoolBytes) !== BigInt(plan.totalBytes) + BigInt(request.maxExpandedBytes)
  )
    throw new Error('ARCHIVE_PLAN_IDENTITY_UNVERIFIED');
}
