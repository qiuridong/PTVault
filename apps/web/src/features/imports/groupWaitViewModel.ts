import type { ImportPipelineGroup } from '@ptvault/contracts';
import { importRetryWaitViewModel } from './importRetryWaitViewModel.js';

const STAGE: Record<ImportPipelineGroup['stage'], string> = {
  QUEUED: '等待调度',
  ADMISSION_WAIT: '等待调度',
  DOWNLOAD_WAIT: '等待下载名额',
  DOWNLOADING: '下载中',
  EXTRACTION_WAIT: '等待解压名额',
  EXTRACTING: '解压中',
  UPLOAD_WAIT: '等待上传名额',
  UPLOADING: '上传中',
  VERIFYING: '解密回读校验',
  RECOVERY: '备份恢复材料',
  CLEANUP: '释放本地暂存',
  WAITING_PASSWORD: '等待密码',
  RETRY_WAIT: '退避中',
  NEEDS_ATTENTION: '需要处理',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};
const WAITS: Partial<Record<NonNullable<ImportPipelineGroup['waitKind']>, string>> = {
  CAPACITY: '等待驻盘名额或暂存预算，不等于磁盘已满。',
  DISK: '等待本地可用空间满足这一组的准入预算。',
  PRESSURE: '资源压力保护暂缓新组准入，已有数据保持。',
  DOWNLOAD: '等待下载名额。',
  EXTRACTION: '等待解压名额。',
  UPLOAD: '等待上传名额。',
};
export function groupWaitViewModel(group: ImportPipelineGroup, parentPaused: boolean, now: number) {
  const queued = [
    'QUEUED',
    'ADMISSION_WAIT',
    'DOWNLOAD_WAIT',
    'EXTRACTION_WAIT',
    'UPLOAD_WAIT',
  ].includes(group.stage);
  if ((queued || group.stage === 'RETRY_WAIT') && (parentPaused || group.paused))
    return {
      label: '已暂停',
      stage: 'PAUSED',
      backoff: false,
      scheduling: false,
      deadline: null,
      hint: '恢复后才会重新进入调度，当前不进行自动重试。',
    };
  // The older API reports every retryable group as RETRY_WAIT, even after the
  // deadline. Derive the display from the page clock until the API is replaced.
  if (group.stage === 'RETRY_WAIT') {
    const retry = importRetryWaitViewModel(group.retryAt, now);
    return {
      label: group.retryInPlace && retry.kind === 'SCHEDULING' ? '等待下载名额' : retry.label,
      stage: retry.kind === 'BACKOFF' ? 'RETRY_WAIT' : 'QUEUED',
      backoff: retry.kind === 'BACKOFF',
      scheduling: retry.kind === 'SCHEDULING',
      deadline: retry.kind === 'BACKOFF' ? retry.deadline : null,
      hint:
        (group.retryInPlace
          ? '正在就地续传，当前驻盘名额和断点保留；短暂等待时其他组可使用下载名额。'
          : '') +
        retry.hint +
        (retry.kind === 'SCHEDULING' && group.waitKind ? ` ${WAITS[group.waitKind] ?? ''}` : ''),
    };
  }
  const due = queued && group.retryAt !== null && group.retryAt <= now;
  const waitHint = group.fairnessWait
    ? '为先到的大组保留下一次释放后的准入空间，避免较小组持续插队。'
    : group.waitKind
      ? (WAITS[group.waitKind] ?? '')
      : '等待调度器准入或资源名额，尚未开始传输。';
  return {
    label: STAGE[group.stage],
    stage: group.stage,
    backoff: false,
    scheduling: queued,
    deadline: null,
    hint: queued
      ? `${group.retryInPlace ? '就地续传：驻盘名额和断点保留。' : ''}${due ? '退避时间已结束。' : ''}${waitHint}`
      : '',
  };
}
