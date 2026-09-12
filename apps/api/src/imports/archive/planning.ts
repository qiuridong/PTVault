import type { ArchivePlanRequest, ArchivePlanSummary } from '@ptvault/contracts';
import type { StoredImportPlan } from '../repository.js';
import type { PlannerResult } from '../model.js';
import { buildArchiveSourceManifest, canonicalSourceManifest } from '../source-manifest.js';
import { archiveAssert, archiveGroups } from './inspection.js';

export function planArchive(
  result: PlannerResult,
  request: ArchivePlanRequest,
  spoolMaxBytes: string,
): PlannerResult {
  const base = canonicalSourceManifest(result.sourceManifest);
  archiveAssert(
    base.sourceKind === 'BAIDU_APP_DIR' && base.version !== 3,
    'ARCHIVE_SOURCE_UNSUPPORTED',
  );
  if (base.version === 2)
    archiveAssert(
      !/(?:\.\d{2,4}|\.part\d+\.rar|\.[rz]\d{2,3})$/i.test(base.rootPath),
      'ARCHIVE_SELECT_VOLUME_DIRECTORY',
    );
  archiveGroups(base.objects.map((object) => object.relativePath));
  const requiredSpoolBytes = (
    BigInt(result.totalBytes) + BigInt(request.maxExpandedBytes)
  ).toString();
  archiveAssert(BigInt(requiredSpoolBytes) <= BigInt(spoolMaxBytes), 'ARCHIVE_SPOOL_LIMIT');
  return {
    ...result,
    requiredSpoolBytes,
    sourceManifest: buildArchiveSourceManifest(base, {
      mode: 'RECURSIVE_VIDEO',
      maxDepth: request.maxDepth,
      maxExpandedBytes: request.maxExpandedBytes,
      maxFiles: 100000,
    }),
  };
}

export function archivePlanSummary(plan: StoredImportPlan): ArchivePlanSummary | undefined {
  const manifest = plan.sourceManifest;
  if (manifest?.version !== 3) return undefined;
  const { mode, maxDepth, maxFiles, maxExpandedBytes } = manifest.archive;
  const groups = archiveGroups(manifest.objects.map((object) => object.relativePath));
  const ingress = (plan.selection as { archiveIngress: { count: number } }).archiveIngress;
  return {
    mode,
    maxDepth,
    maxFiles,
    maxExpandedBytes,
    candidateCount: ingress.count,
    inputCount: plan.objectCount,
    inputBytes: plan.totalBytes,
    requiredSpoolBytes: plan.requiredSpoolBytes,
    groups: groups.slice(0, 500),
    groupsTruncated: groups.length > 500,
  };
}
