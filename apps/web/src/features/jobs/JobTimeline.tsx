import { useQuery } from '@tanstack/react-query';
import { CircleDashed, ShieldCheck, TriangleAlert, X } from 'lucide-react';

import type { OffloadSnapshot, OffloadStep } from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import { getOffloadEvents, offloadEventsQueryKey } from './jobApi.js';
import { ResourceWaitStatus } from './ResourceWait.js';
import { TransferProgress, hasTransferTelemetry } from './TransferProgress.js';

/** Ordered offload lifecycle used to render the safety checkpoints. */
const ORDERED_STEPS: readonly OffloadStep[] = [
  'PREFLIGHT',
  'PAUSING',
  'SNAPSHOTTING',
  'HASHING',
  'UPLOADING_STAGING',
  'VERIFYING',
  'FINALIZING_REMOTE',
  'CLOUD_COMMITTED',
  'LOCAL_CLEANUP',
  'COMPLETED',
];

const stepLabels: Record<OffloadStep, string> = {
  PREFLIGHT: '预检',
  PAUSING: '暂停种子',
  SNAPSHOTTING: '快照源文件',
  HASHING: '哈希校验文件',
  UPLOADING_STAGING: '上传到暂存区',
  VERIFYING: '解密回读校验',
  FINALIZING_REMOTE: '定稿远端',
  CLOUD_COMMITTED: '云端已提交',
  LOCAL_CLEANUP: '本地清理',
  COMPLETED: '已完成',
};

/**
 * The three safety milestones the operator must be able to read at a glance.
 * These strings are intentionally in Chinese per the plan's UI requirement.
 */
type SafetyMilestone = {
  label: string;
  reachedAtStep: OffloadStep;
};

const SAFETY_MILESTONES: readonly SafetyMilestone[] = [
  { label: '本地仍安全', reachedAtStep: 'PREFLIGHT' },
  { label: '云端已验证', reachedAtStep: 'CLOUD_COMMITTED' },
  { label: '本地已清理', reachedAtStep: 'COMPLETED' },
];

function stepIndex(step: OffloadStep): number {
  return ORDERED_STEPS.indexOf(step);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? '会话已过期，请重新登录以查看时间线。' : error.message;
  }
  return '无法加载任务时间线。';
}

export function JobTimeline({
  snapshot,
  onClose,
}: {
  snapshot: OffloadSnapshot;
  onClose: () => void;
}) {
  const eventsQuery = useQuery({
    queryKey: offloadEventsQueryKey(snapshot.jobId),
    queryFn: () => getOffloadEvents(snapshot.jobId),
  });

  const currentIndex = stepIndex(snapshot.currentStep);
  const localCleared = snapshot.cleanupCompletedAt !== null;

  return (
    <section className="job-timeline" aria-labelledby={`timeline-${snapshot.jobId}`}>
      {/*
        A titled panel with a close button, rather than the bare `<h3>` this had.
        Opening a timeline was a one-way door: the only `setSelectedJobId(null)` on
        the page ran after a successful cancel or retry, so dismissing the panel
        meant mutating the transfer it described.
      */}
      <header className="job-timeline-head">
        <h3 id={`timeline-${snapshot.jobId}`}>卸载时间线</h3>
        <button type="button" className="icon-button" aria-label="关闭时间线" onClick={onClose}>
          <X size={18} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </header>

      {/*
        Said out loud because the milestone above it is a fact about the past. "本地
        已清理" records what this transfer did on the day it ran; a restore afterwards
        does not un-record it, and an operator reading the milestone as current status
        concluded a file was gone while it sat on disk. The media page is the one
        place that answers "where is it now".
      */}
      {localCleared ? (
        <p className="field-hint">
          这里记录的是本次迁移当时清理了本地文件。之后是否已回迁请看
          <strong>媒体页</strong>，那里显示的才是文件现在的位置。
        </p>
      ) : null}

      <ul className="safety-milestones">
        {SAFETY_MILESTONES.map((milestone) => {
          const reached =
            milestone.label === '本地已清理'
              ? localCleared
              : currentIndex >= stepIndex(milestone.reachedAtStep);
          return (
            <li
              key={milestone.label}
              className={`safety-milestone${reached ? ' is-reached' : ''}`}
              data-reached={reached}
            >
              {reached ? (
                <ShieldCheck size={14} strokeWidth={1.9} aria-hidden="true" />
              ) : (
                <CircleDashed size={14} strokeWidth={1.9} aria-hidden="true" />
              )}
              {milestone.label}
            </li>
          );
        })}
      </ul>

      {/*
        Above the step list, because it answers a more urgent question than "which
        step". A staging upload holds one step for hours; without figures the panel
        is indistinguishable between moving at 90 MiB/s and being wedged, and the
        step label alone sent operators to check whether the transfer had died.

        Drawn only when the server actually reported telemetry. An API version that
        does not measure it gets one honest sentence instead of a row of 「未报告」
        placeholders, and never a 0 B/s that would read as a stall.
      */}
      {hasTransferTelemetry(snapshot) ? (
        <TransferProgress snapshot={snapshot} />
      ) : (
        <>
          <ResourceWaitStatus snapshot={snapshot} />
          <p className="field-hint">
            这台机器上的 API 版本还没有上报字节与速率。
            阶段仍然是准确的，但这一栏不会显示进度或网速——不是传输停了。
          </p>
        </>
      )}

      <ol className="timeline-steps">
        {ORDERED_STEPS.map((step, index) => {
          const state =
            index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'pending';
          return (
            <li
              key={step}
              className={`timeline-step timeline-step-${state}`}
              aria-current={state === 'current'}
            >
              {stepLabels[step]}
            </li>
          );
        })}
      </ol>

      {eventsQuery.isError ? (
        <p className="route-status route-status-error" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          {errorMessage(eventsQuery.error)}
        </p>
      ) : eventsQuery.isSuccess && eventsQuery.data.length > 0 ? (
        <ul className="timeline-events">
          {eventsQuery.data.map((event) => (
            <li key={event.id}>
              <span className="timeline-event-type">{event.eventType}</span>
              <time dateTime={new Date(event.createdAt).toISOString()}>
                {new Date(event.createdAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
