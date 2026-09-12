import type { ImportPlan } from '@ptvault/contracts';
import type { SourceFile } from './sourceSelection.js';

/** Only actual provider metadata echoed by the V2 manifest proves a file selection. */
export function verifyFilePlanIdentity(
  source: SourceFile,
  destinationId: string,
  plan: ImportPlan,
): void {
  const proof = plan.sourceFileProof;
  if (
    plan.sourceKind !== 'BAIDU_APP_DIR' ||
    plan.sourceConnectionId !== source.connectionId ||
    plan.destinationId !== destinationId ||
    plan.sourceRootFsid !== null ||
    plan.objectCount !== 1 ||
    plan.totalBytes !== source.size ||
    proof?.scope !== 'FILE' ||
    proof.path !== source.path ||
    proof.fsid !== source.fsid ||
    proof.size !== source.size ||
    proof.mtime !== source.mtime
  )
    throw new Error('FILE_PLAN_IDENTITY_UNVERIFIED');
}
