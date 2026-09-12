import type { ImportPlan } from '@ptvault/contracts';
import type { SourceDirectory } from './sourceSelection.js';

/** An old server may ignore the optional request fence: HTTP 200 is not proof. */
export function verifyDirectoryPlanIdentity(
  source: SourceDirectory,
  destinationId: string,
  plan: ImportPlan,
): void {
  if (
    plan.sourceKind !== 'BAIDU_APP_DIR' ||
    plan.sourceConnectionId !== source.connectionId ||
    plan.sourceRootFsid !== source.fsid ||
    plan.destinationId !== destinationId
  ) {
    throw new Error('DIRECTORY_PLAN_IDENTITY_UNVERIFIED');
  }
}
