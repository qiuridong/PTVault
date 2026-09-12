import type { ImportProgressSnapshot } from '@ptvault/contracts';

/**
 * One Chinese vocabulary for scheduler waits across both subsystems.
 *
 * The two schedulers have separate enums — an OFFLOAD job waits on
 * `UPLOAD_SLOT`/`READBACK_SLOT`/`REMOTE_HEAVY_SLOT`, an import waits on
 * `UPLOAD`/`LOCAL_PREPARATION`/`SPOOL_CAPACITY`/`MAX_IN_FLIGHT` — but an operator
 * reading two pages should not have to learn two vocabularies for the same
 * physical thing. Every label names a *slot or a quota*, never an activity: a job
 * that holds no permit is not "uploading", and wording it that way is exactly how
 * a queued job gets read as an in-flight transfer.
 *
 * The OFFLOAD wording is pinned by `JobsPage.test.tsx` / `TransferProgress.test.tsx`
 * and lives in `features/jobs/ResourceWait.tsx`; this module carries the import
 * side and keeps it phrased to match.
 */
export type ImportResourceWait = NonNullable<ImportProgressSnapshot['resourceWait']>['resource'];

export const IMPORT_RESOURCE_WAIT_LABELS: Record<ImportResourceWait, string> = {
  MAX_IN_FLIGHT: '最大在途任务额度',
  LOCAL_PREPARATION: '本地准备槽位',
  UPLOAD: '上传槽位',
  SPOOL_CAPACITY: 'spool 暂存容量',
};

/**
 * What an import is actually blocked on, or `null` when it holds every permit it
 * needs.
 *
 * Queue position is always present. Semaphore waits may additionally carry an
 * `active` / `capacity` pair; spool-capacity waits deliberately omit it because
 * byte capacity is not an integer permit count. The contract enforces the pair,
 * and this renderer remains defensive so a partial value is never presented as
 * real occupancy.
 */
export function importResourceWaitText(progress: ImportProgressSnapshot): string | null {
  const wait = progress.resourceWait;
  if (wait === undefined) return null;
  const occupancy =
    wait.active === undefined || wait.capacity === undefined
      ? ''
      : ` · 槽位占用 ${wait.active}/${wait.capacity}`;
  return `等待${IMPORT_RESOURCE_WAIT_LABELS[wait.resource]} · 队列第 ${wait.queuePosition} 位${occupancy}`;
}
