import type { CreateImportRequest, ImportPlan } from '@ptvault/contracts';
import { verifyDirectoryPlanIdentity } from './directoryPlanIdentity.js';
import type { SourceDirectory, SourceFile } from './sourceSelection.js';
import { verifyFilePlanIdentity } from './filePlanIdentity.js';

export type DirectorySubmission = {
  key: string;
  source: SourceDirectory | SourceFile;
  destinationId: string;
  plan: ImportPlan;
  request: CreateImportRequest;
  status: 'PENDING' | 'UNKNOWN' | 'CREATED' | 'REJECTED';
  attempts: number;
  error: string | null;
  jobId: string | null;
  pipelineId?: string;
};
export type DirectorySubmissions = Readonly<Record<string, DirectorySubmission>>;

export function directorySubmissionKey(
  source: Pick<SourceDirectory, 'connectionId' | 'fsid'> & { scope?: 'FILE' },
  destinationId: string,
): string {
  return JSON.stringify(
    source.scope === 'FILE'
      ? [source.connectionId, source.fsid, destinationId, 'FILE']
      : [source.connectionId, source.fsid, destinationId],
  );
}

/** This record outlives selection edits; only an explicit new batch may clear it. */
export function freezeDirectorySubmission(
  source: SourceDirectory | SourceFile,
  plan: ImportPlan,
  request: CreateImportRequest,
): DirectorySubmission {
  const destinationId = request.destinationId ?? plan.destinationId;
  if ('scope' in source && source.scope === 'FILE') {
    verifyFilePlanIdentity(source, destinationId, plan);
    if (
      request.sourceCleanupPolicy === 'JOB_STAGING_ONLY' ||
      (request.sourceCleanupPolicy === 'SELECTED_SOURCE' && !source.path.startsWith('/apps/bdpan/'))
    )
      throw new Error('FILE_SUBMISSION_INVALID');
  } else verifyDirectoryPlanIdentity(source, destinationId, plan);
  if (request.planId !== plan.planId || request.credential.kind !== 'NONE')
    throw new Error('DIRECTORY_SUBMISSION_INVALID');
  const record: DirectorySubmission = {
    key: directorySubmissionKey(source, destinationId),
    source,
    destinationId,
    plan,
    request,
    status: 'PENDING',
    attempts: 0,
    error: null,
    jobId: null,
  };
  return structuredClone(record);
}
