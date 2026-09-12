/** A retry deadline is eligibility, never a reservation of the next transfer slot. */
export function importRetryWaitViewModel(retryAt: string | number | null | undefined, now: number) {
  const deadline =
    typeof retryAt === 'number'
      ? retryAt
      : typeof retryAt === 'string'
        ? Date.parse(retryAt)
        : Number.NaN;
  if (!Number.isFinite(deadline))
    return {
      kind: 'UNKNOWN' as const,
      label: '等待重试',
      deadline: null,
      hint: '未提供有效的最早重试时间；当前未在传输，不推测还需等待多久。',
    };
  if (deadline > now)
    return {
      kind: 'BACKOFF' as const,
      label: '退避中',
      deadline,
      hint: '尚未到最早重试时间，当前未在传输；到时进入调度队列，不保证立即开始下载。',
    };
  return {
    kind: 'SCHEDULING' as const,
    label: '等待调度',
    deadline,
    hint: '退避时间已结束，正在等待调度或资源名额；当前未在传输，获得名额后自动重试。',
  };
}
