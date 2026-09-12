import type { ImportEvent, ImportProgressSnapshot } from '@ptvault/contracts';

import { IMPORT_CONDITION_HINTS, IMPORT_CONDITION_LABELS } from './importLabels.js';
import { downloadFailureViewModel } from './downloadFailureViewModel.js';
import { importRetryWaitViewModel } from './importRetryWaitViewModel.js';

/** Only the backend's exact allowlisted current-stop detail can refine RESOURCE_WAIT. */
export function importConditionViewModel(
  progress: ImportProgressSnapshot,
  events: readonly ImportEvent[] = [],
  now = Date.now(),
) {
  const condition = progress.currentCondition;
  const latestStop = events.reduce<ImportEvent | undefined>(
    (latest, event) =>
      ['IMPORT_WORKER_STOPPED', 'IMPORT_DOWNLOAD_RETRY_SCHEDULED'].includes(event.code) &&
      (latest === undefined || Date.parse(event.at) >= Date.parse(latest.at))
        ? event
        : latest,
    undefined,
  );
  const currentStop =
    latestStop !== undefined && Date.parse(latestStop.at) === Date.parse(progress.lastCheckpointAt)
      ? latestStop
      : undefined;
  const inPlace = progress.state === 'RUNNING' && progress.downloadRetryInPlace === true;
  if (inPlace || (progress.state === 'RETRY_WAIT' && condition === undefined)) {
    const failure = downloadFailureViewModel(currentStop?.detail, currentStop?.downloadDiagnostic);
    const retry = importRetryWaitViewModel(progress.retryAt, now);
    return {
      label: inPlace
        ? retry.kind === 'BACKOFF'
          ? '就地续传退避中'
          : '等待就地续传名额'
        : (failure?.label ?? '等待自动重试'),
      hint: `${inPlace ? '当前驻盘名额和断点保留，正在进行有界的就地续传；未占用下载名额，其他组可继续。' : ''}${retry.hint} ${inPlace ? '无需重新创建任务。' : '仍保留的断点会复用，分组缓存是否保留以组状态为准，无需重新创建任务。'}${failure ? ` ${failure.hint} ${failure.evidence.join(' · ')}` : ''}`,
    };
  }
  if (condition === undefined) return null;
  if (condition === 'RESOURCE_WAIT' && progress.resourceWait === undefined) {
    if (currentStop?.detail === 'DESTINATION_CAPACITY_WAIT') {
      return {
        label: '等待目标容量',
        hint: '目标可用容量暂时不足，任务在等待容量释放或重新核验。此状态不代表下载或上传已经开始，也不表示已获得上传槽位。',
      };
    }
  }
  return { label: IMPORT_CONDITION_LABELS[condition], hint: IMPORT_CONDITION_HINTS[condition] };
}
