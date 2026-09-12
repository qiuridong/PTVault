import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clapperboard,
  FileCheck2,
  Radio,
  RadioTower,
  TriangleAlert,
  X,
} from 'lucide-react';

import { Link } from 'react-router-dom';

import type { ImportAction, ImportJobSummary, ImportReceipt } from '@ptvault/contracts';

import type { LiveStatus } from '../../api/useServerEvents.js';
import { RATE_LIMIT_LABELS } from '../storage/connectionLabels.js';
import { getImportDetail, importDetailQueryKey, importErrorMessage } from './importApi.js';
import { formatDecimalBytes } from './importFormatting.js';
import { ImportActions } from './ImportActions.js';
import { ImportEventTimeline } from './ImportEventTimeline.js';
import { ArchiveProgressPanel } from './ArchiveProgressPanel.js';
import type { ReadOnlyReason } from './ImportCreatePanel.js';
import { ImportProgress } from './ImportProgress.js';
import { LegacyImportSourcePanel } from './LegacyImportSourcePanel.js';
import { SourceCleanupPanel } from './SourceCleanupPanel.js';
import { importConditionViewModel } from './importConditionViewModel.js';
import { importRetryWaitViewModel } from './importRetryWaitViewModel.js';
import {
  IMPORT_MEDIA_TYPE_LABELS,
  IMPORT_STATE_LABELS,
  IMPORT_STATE_TONE,
  IMPORT_STEP_LABELS,
  IMPORT_STEP_ORDER,
  PUBLICATION_ERROR_LABELS,
  PUBLICATION_POLICY_LABELS,
  PUBLICATION_STATE_LABELS,
} from './importLabels.js';

/**
 * The steps this job will actually walk.
 *
 * `MEDIA_PUBLISH` is dropped for an archive-only job rather than drawn greyed
 * out: a step that will never run is not "pending", and showing it as pending
 * says the job is unfinished when it is complete.
 */
function stepsFor(policy: 'ARCHIVE_ONLY' | 'PUBLISH_TO_JELLYFIN'): readonly string[] {
  return policy === 'PUBLISH_TO_JELLYFIN'
    ? IMPORT_STEP_ORDER
    : IMPORT_STEP_ORDER.filter((step) => step !== 'MEDIA_PUBLISH');
}

function ReceiptRow({ label, receipt }: { label: string; receipt: ImportReceipt | null }) {
  return (
    <div className="import-receipt" data-present={receipt !== null}>
      <dt>{label}</dt>
      <dd>
        {receipt === null ? (
          // Not "0 objects": the receipt does not exist yet, which is a
          // statement about this job's progress, not about its contents.
          <span className="is-unknown">还没有这一份 receipt</span>
        ) : (
          <>
            <span className="import-receipt-figure">
              {receipt.objectCount} 个对象 · {formatDecimalBytes(receipt.bytes)}
            </span>
            <span className="import-receipt-digest">{receipt.digestPreview ?? '未报告摘要'}</span>
            <time dateTime={receipt.at}>{new Date(receipt.at).toLocaleString()}</time>
          </>
        )}
      </dd>
    </div>
  );
}

/**
 * Everything known about one import, and the actions permitted on it.
 *
 * The REST snapshot is the authority here, not the event stream: an event says
 * only that something changed, and this panel shows a dozen fields no event
 * carries. So the stream invalidates and this refetches, which also means the
 * panel recovers from a closed tab, a route change or a different device by
 * reading the server rather than anything held in the browser.
 */
export function importDetailRefetchInterval(
  live: LiveStatus,
  publicationState?: string,
): number | false {
  // Publication has its own worker and no import SSE revision after COMPLETED.
  return live !== 'live' || publicationState === 'PENDING' || publicationState === 'RUNNING'
    ? 5_000
    : false;
}

export function ImportJobDetail({
  jobId,
  summary,
  supportedActions,
  readOnlyReason,
  live,
  now,
  onClose,
}: {
  jobId: string;
  summary: ImportJobSummary | null;
  supportedActions: readonly ImportAction[];
  readOnlyReason: ReadOnlyReason;
  live: LiveStatus;
  now: number;
  onClose: () => void;
}) {
  const detailQuery = useQuery({
    queryKey: importDetailQueryKey(jobId),
    queryFn: () => getImportDetail(jobId),
    refetchInterval: (query) =>
      importDetailRefetchInterval(
        live,
        query.state.data?.supported === true ? query.state.data.data.publication?.state : undefined,
      ),
  });

  const probe = detailQuery.data;
  // The row we were opened from, used until the detail lands so the panel is
  // never an empty frame — on an operations console that reads as a failure.
  const progress = probe?.supported === true ? probe.data.progress : summary?.progress;
  const projectedJob = probe?.supported === true ? probe.data : summary;
  const condition =
    progress === undefined
      ? null
      : importConditionViewModel(progress, probe?.supported === true ? probe.data.events : [], now);

  return (
    <aside className="import-detail" aria-labelledby={`detail-${jobId}`}>
      <header className="import-detail-head">
        <div>
          <p className="import-detail-kicker">任务详情</p>
          <h2 id={`detail-${jobId}`}>{summary?.sourceAlias ?? jobId}</h2>
        </div>
        <div className="import-detail-head-actions">
          <span
            className="connection-state"
            title={
              live === 'live'
                ? '已连接事件流，状态实时更新'
                : live === 'connecting'
                  ? '正在连接事件流'
                  : '事件流断开，已降级为每 5 秒轮询'
            }
          >
            {live === 'live' ? (
              <Radio size={15} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <RadioTower size={15} strokeWidth={1.8} aria-hidden="true" />
            )}
            {live === 'live' ? '实时更新' : live === 'connecting' ? '连接中…' : '轮询中'}
          </span>
          <button type="button" className="icon-button" aria-label="关闭任务详情" onClick={onClose}>
            <X size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
      </header>

      {progress === undefined ? null : (
        <>
          <div className="import-detail-state">
            <span className="import-state-tag" data-tone={IMPORT_STATE_TONE[progress.state]}>
              {progress.state === 'RETRY_WAIT'
                ? importRetryWaitViewModel(progress.retryAt, now).label
                : IMPORT_STATE_LABELS[progress.state]}
            </span>
            <span className="import-detail-step">{IMPORT_STEP_LABELS[progress.currentStep]}</span>
            <span className="import-detail-revision">revision {progress.revision}</span>
          </div>

          {condition === null ? null : (
            <p className="inline-message" role="note">
              <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>
                <strong>{condition.label}</strong> — {condition.hint}
                {progress.currentCondition === 'SOURCE_CHANGED' ? (
                  <>
                    {' '}
                    <Link to="/imports?view=create">打开重新规划</Link>
                  </>
                ) : null}
                {progress.currentCondition === 'RATE_LIMITED' &&
                projectedJob?.sourceRateLimit === undefined ? (
                  <>
                    {' '}
                    限速是<strong>按账户</strong>生效的：同一账户的任务共用一个等待，
                    其他账户不受影响。这里读不到是哪个账户，具体账户、预计恢复时间与受影响任务数在
                    <Link to="/storage-accounts">存储账户</Link>页。
                  </>
                ) : null}
              </span>
            </p>
          )}

          {projectedJob?.archive === undefined ? null : (
            <ArchiveProgressPanel status={projectedJob.archive} />
          )}

          {projectedJob?.sourceRateLimit === undefined ? null : (
            <p className="inline-message import-source-rate-limit-detail" role="note">
              <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>
                <strong>
                  {RATE_LIMIT_LABELS[projectedJob.sourceRateLimit.code]} · 影响{' '}
                  {projectedJob.sourceRateLimit.affectedActiveJobs} 笔任务
                </strong>
                {' · '}预计恢复{' '}
                <time dateTime={projectedJob.sourceRateLimit.retryAt}>
                  {new Date(projectedJob.sourceRateLimit.retryAt).toLocaleString()}
                </time>
                {' · '}状态码 <code>{projectedJob.sourceRateLimit.code}</code>
                。这是来源连接级状态，其他连接不受影响。
              </span>
            </p>
          )}

          <ImportProgress progress={progress} now={now} />

          <p className="import-checkpoint-line">
            最后 checkpoint{' '}
            <time dateTime={progress.lastCheckpointAt}>
              {new Date(progress.lastCheckpointAt).toLocaleString()}
            </time>
          </p>

          <ol className="timeline-steps import-steps">
            {stepsFor(progress.publicationPolicy).map((step) => {
              const order = IMPORT_STEP_ORDER.indexOf(step as (typeof IMPORT_STEP_ORDER)[number]);
              const current = IMPORT_STEP_ORDER.indexOf(progress.currentStep);
              const state = order < current ? 'done' : order === current ? 'current' : 'pending';
              return (
                <li
                  key={step}
                  className={`timeline-step timeline-step-${state}`}
                  aria-current={state === 'current'}
                >
                  {IMPORT_STEP_LABELS[step as (typeof IMPORT_STEP_ORDER)[number]]}
                </li>
              );
            })}
          </ol>
        </>
      )}

      {detailQuery.isPending ? (
        <p className="route-status">
          <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
          正在加载任务详情…
        </p>
      ) : detailQuery.isError ? (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          {importErrorMessage(detailQuery.error)}
        </p>
      ) : probe?.supported === false ? (
        <div className="settings-notbuilt">
          <span className="settings-notbuilt-glyph" aria-hidden="true">
            <CircleSlash size={18} strokeWidth={1.7} />
          </span>
          <div>
            <p>这台机器上的 API 版本还没有网盘迁移任务详情接口。</p>
          </div>
        </div>
      ) : probe?.supported === true ? (
        <>
          <LegacyImportSourcePanel
            key={jobId}
            detail={probe.data}
            readOnlyReason={readOnlyReason}
          />
          <section className="import-detail-section" aria-label="校验 receipt">
            <h3>
              <FileCheck2 size={15} strokeWidth={1.9} aria-hidden="true" /> 校验 receipt
            </h3>
            <dl className="import-receipts">
              <ReceiptRow label="staging 上传" receipt={probe.data.receipts.staging} />
              <ReceiptRow label="committed 提交" receipt={probe.data.receipts.committed} />
              <ReceiptRow label="committed 最终回读" receipt={probe.data.receipts.verify} />
            </dl>
            <p className="field-hint">
              只有 committed 最终回读的明文 SHA-256 与本地一致，这个对象才算
              <strong>已验证</strong>。staging 回读只是提交前的门槛。
            </p>
          </section>

          <section className="import-detail-section" aria-label="发布状态">
            <h3>
              <Clapperboard size={15} strokeWidth={1.9} aria-hidden="true" /> 发布
            </h3>
            <p className="import-policy-line">
              {PUBLICATION_POLICY_LABELS[probe.data.progress.publicationPolicy]}
            </p>
            {probe.data.publication === null ? (
              <p className="import-publication-none">
                {PUBLICATION_STATE_LABELS.NOT_REQUESTED}
                ——这次迁移只做备份，没有创建媒体目录、symlink 或 Jellyfin 条目。
              </p>
            ) : (
              <>
                <dl className="instance-meta">
                  <div>
                    <dt>状态</dt>
                    <dd>
                      <span
                        className="import-publication-tag"
                        data-state={probe.data.publication.state.toLowerCase()}
                      >
                        {PUBLICATION_STATE_LABELS[probe.data.publication.state]}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>发布修订</dt>
                    <dd>
                      <span className="instance-meta-value">
                        revision {probe.data.publication.revision}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>投影对象</dt>
                    <dd>
                      <span className="instance-meta-value">
                        {probe.data.publication.objectCount} 个
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>媒体库</dt>
                    <dd>
                      <span className="instance-meta-value">
                        {probe.data.publication.libraryDisplayName} ·{' '}
                        {IMPORT_MEDIA_TYPE_LABELS[probe.data.publication.mediaType]}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>逻辑路径</dt>
                    <dd>
                      <span className="instance-meta-value is-mono">
                        {probe.data.publication.logicalPath}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>容器路径</dt>
                    <dd>
                      <span className="instance-meta-value is-mono">
                        {probe.data.publication.containerPath}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>承载账户</dt>
                    <dd>
                      {probe.data.publication.mountAccountLabel === null ? (
                        <span className="instance-meta-value is-unknown">还没有选定</span>
                      ) : (
                        <span className="instance-meta-value">
                          {probe.data.publication.mountAccountLabel}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>可读探针</dt>
                    <dd>
                      <span className="instance-meta-value">
                        {probe.data.publication.readProbe === 'PASSED'
                          ? '通过'
                          : probe.data.publication.readProbe === 'FAILED'
                            ? '未通过'
                            : '还没跑过'}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Jellyfin 通知</dt>
                    <dd>
                      {probe.data.publication.jellyfinNotified === null ? (
                        <span className="instance-meta-value is-unknown">还没有调用过</span>
                      ) : (
                        <span
                          className={`instance-meta-value${probe.data.publication.jellyfinNotified ? '' : ' is-bad'}`}
                        >
                          {probe.data.publication.jellyfinNotified ? '已接受' : '被拒'}
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>
                {probe.data.publication.error === null ? (
                  <p className="import-publication-ok">
                    <CheckCircle2 size={14} strokeWidth={1.9} aria-hidden="true" />
                    发布链路没有报错。
                  </p>
                ) : (
                  <p className="inline-message" role="note">
                    <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                    <span>
                      {PUBLICATION_ERROR_LABELS[probe.data.publication.error]}
                      <strong>备份本身不因此回滚。</strong>
                    </span>
                  </p>
                )}
              </>
            )}
          </section>

          <SourceCleanupPanel detail={probe.data} readOnlyReason={readOnlyReason} />

          <ImportActions
            detail={probe.data}
            supportedActions={supportedActions}
            readOnlyReason={readOnlyReason}
          />
          <ImportEventTimeline key={jobId} events={probe.data.events} />
        </>
      ) : null}
    </aside>
  );
}
