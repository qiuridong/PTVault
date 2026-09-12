import type { ArchivePlanRequest, ImportPlan } from '@ptvault/contracts';

export function verifyGroupPlanIdentity(
  grouped: boolean | undefined,
  request: ArchivePlanRequest | undefined,
  plan: ImportPlan,
): void {
  const proof = plan.pipeline;
  if (!grouped) {
    if (proof !== undefined) throw Error('GROUP_PLAN_IDENTITY_UNVERIFIED');
    return;
  }
  if (
    !proof ||
    !request ||
    plan.archive !== undefined ||
    proof.options.processing.mode !== request.mode ||
    proof.options.processing.maxDepth !== request.maxDepth ||
    proof.options.processing.maxExpandedBytes !== request.maxExpandedBytes ||
    proof.candidateCount !== new Set(request.candidates).size ||
    proof.executableCount + proof.attentionCount !== proof.groupCount ||
    proof.largestGroupBytes !== plan.requiredSpoolBytes ||
    new Set(proof.groups.map((group) => group.key)).size !== proof.groups.length ||
    proof.groups.some(
      (group) =>
        BigInt(group.requiredSpoolBytes) !==
        BigInt(group.inputBytes) + BigInt(request.maxExpandedBytes),
    ) ||
    (!proof.groupsTruncated &&
      (proof.groupCount !== proof.groups.length ||
        proof.groups.reduce(
          (maximum, group) =>
            BigInt(group.requiredSpoolBytes) > maximum ? BigInt(group.requiredSpoolBytes) : maximum,
          0n,
        ) !== BigInt(proof.largestGroupBytes) ||
        proof.groups.reduce((sum, group) => sum + BigInt(group.inputBytes), 0n) !==
          BigInt(plan.totalBytes) ||
        proof.groups.reduce((sum, group) => sum + group.members.length, 0) !== plan.objectCount))
  )
    throw Error('GROUP_PLAN_IDENTITY_UNVERIFIED');
}
