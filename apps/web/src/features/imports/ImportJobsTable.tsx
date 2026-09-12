import { ChevronDown, Clapperboard, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';

import type { ImportAction, ImportJobSummary } from '@ptvault/contracts';

import { RATE_LIMIT_LABELS } from '../storage/connectionLabels.js';
import type { ReadOnlyReason } from './ImportCreatePanel.js';
import { importErrorMessage } from './importApi.js';
import {
  NOT_REPORTED,
  formatCountdown,
  formatDecimalBytes,
  formatEta,
  formatOptionalRate,
  formatPercent,
  percentOfDecimal,
} from './importFormatting.js';
import { importResourceWaitText } from './importResourceWait.js';
import { importTelemetryIsVisible, importTelemetryState } from './importTelemetry.js';
import {
  IMPORT_ACTION_CONSEQUENCE,
  IMPORT_ACTION_LABELS,
  IMPORT_CONDITION_LABELS,
  IMPORT_DESTINATION_KIND_LABELS,
  IMPORT_SOURCE_LABELS,
  IMPORT_STATE_LABELS,
  IMPORT_STATE_TONE,
  IMPORT_STEP_LABELS,
  PUBLICATION_POLICY_LABELS,
  PUBLICATION_STATE_LABELS,
  SOURCE_CLEANUP_POLICY_LABELS,
} from './importLabels.js';

/**
 * Columns in the main row. Used for the detail row's `colSpan`, so the two cannot
 * drift apart — a short `colSpan` silently narrows the panel to the width of the
 * first few columns.
 */
const MAIN_COLUMNS = 7;

type InlineImportAction = Extract<ImportAction, 'PAUSE' | 'RESUME' | 'CANCEL'>;

const INLINE_ACTIONS: readonly InlineImportAction[] = ['PAUSE', 'RESUME', 'CANCEL'];

const READ_ONLY_LABELS: Record<Exclude<ReadOnlyReason, null>, string> = {
  DEMO: '演示只读',
  SHADOW: '只读影子模式',
  FEATURE_DISABLED: '操作尚未启用',
};

/**
 * Compact lifecycle controls for a list summary.
 *
 * The offered set comes only from `job.availableActions`; state is intentionally
 * absent from this component. The deployment capability and read-only mode are
 * independent gates, and every request remains behind an explicit consequence
 * confirmation.
 */
function InlineImportActions({
  job,
  supportedActions,
  readOnlyReason,
  onAction,
}: {
  job: ImportJobSummary;
  supportedActions: readonly ImportAction[];
  readOnlyReason: ReadOnlyReason;
  onAction: (jobId: string, action: InlineImportAction) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<InlineImportAction | null>(null);
  const [pending, setPending] = useState<InlineImportAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = new Set(supportedActions);
  const offered = INLINE_ACTIONS.filter((action) => job.availableActions.includes(action));

  if (offered.length === 0) return null;

  const run = async (action: InlineImportAction): Promise<void> => {
    if (pending !== null || readOnlyReason !== null || !supported.has(action)) return;
    setPending(action);
    setError(null);
    try {
      await onAction(job.jobId, action);
      setConfirming(null);
    } catch (cause) {
      setError(importErrorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="import-inline-actions" aria-label="任务摘要操作">
      <div className="import-action-row">
        {offered.map((action) => {
          const implemented = supported.has(action);
          return (
            <button
              key={action}
              type="button"
              className={action === 'CANCEL' ? 'danger-button' : 'ghost-button'}
              disabled={readOnlyReason !== null || !implemented || pending !== null}
              title={implemented ? undefined : '当前部署尚未启用该操作'}
              onClick={() => {
                setConfirming(action);
                setError(null);
              }}
            >
              {IMPORT_ACTION_LABELS[action]}
            </button>
          );
        })}
      </div>

      {readOnlyReason === null ? null : (
        <p className="field-hint" role="note">
          {READ_ONLY_LABELS[readOnlyReason]}：摘要操作保持禁用。
        </p>
      )}
      {offered.some((action) => !supported.has(action)) ? (
        <p className="field-hint" role="note">
          服务端为任务提供了操作，但当前部署的 capability 尚未启用它。
        </p>
      ) : null}

      {confirming === null ? null : (
        <div
          className="import-confirm"
          role="group"
          aria-label={`确认${IMPORT_ACTION_LABELS[confirming]}`}
        >
          <p className="import-confirm-line">
            <strong>{IMPORT_ACTION_LABELS[confirming]}</strong>
            {IMPORT_ACTION_CONSEQUENCE[confirming]}
          </p>
          <div className="import-confirm-actions">
            <button
              type="button"
              className="ghost-button"
              disabled={pending !== null}
              onClick={() => setConfirming(null)}
            >
              返回
            </button>
            <button
              type="button"
              className={confirming === 'CANCEL' ? 'danger-button' : 'primary-button'}
              disabled={pending !== null || readOnlyReason !== null || !supported.has(confirming)}
              onClick={() => void run(confirming)}
            >
              {pending === confirming
                ? `正在${IMPORT_ACTION_LABELS[confirming]}…`
                : `确认${IMPORT_ACTION_LABELS[confirming]}`}
            </button>
          </div>
        </div>
      )}

      {error === null ? null : (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {error}
        </p>
      )}
    </section>
  );
}

/**
 * The one rate that belongs in a row.
 *
 * The detail panel breaks the three legs out; a row has space for the one that is
 * currently doing the work, chosen by which reading exists rather than by summing
 * them. When none was reported the cell says so — a row that showed `0 B/s` for a
 * throttled job would read as a stall.
 */
function activeRate(job: ImportJobSummary): { label: string; value: string } {
  const { downloadRateBps, uploadRateBps, verifyRateBps } = job.progress;
  if (uploadRateBps !== undefined)
    return { label: '上传', value: formatOptionalRate(uploadRateBps) };
  if (downloadRateBps !== undefined)
    return { label: '下载', value: formatOptionalRate(downloadRateBps) };
  if (verifyRateBps !== undefined)
    return { label: '校验', value: formatOptionalRate(verifyRateBps) };
  return { label: '速率', value: NOT_REPORTED };
}

/**
 * One import, as a dense main row plus an on-demand secondary panel.
 *
 * The row carries the facts an operator scans a queue for; everything else this
 * API version reports sits behind the row's own disclosure. That split is what
 * removed the fifteen-column horizontal scroll, and it costs no request: every
 * field in the panel is already on the `ImportJobSummary` that drew the row, so
 * expanding is instant and still works with the event stream down.
 *
 * The disclosure is deliberately *not* the detail panel. Expanding shows what the
 * list already knows, including the summary-level server action authority.
 * `ImportJobDetail` still fetches receipts and events; both surfaces intersect the
 * same server authority with deployment capabilities instead of deriving actions
 * from state.
 */
function ImportJobRow({
  job,
  isSelected,
  onSelect,
  supportedActions,
  readOnlyReason,
  onAction,
  now,
}: {
  job: ImportJobSummary;
  isSelected: boolean;
  onSelect: (jobId: string) => void;
  supportedActions: readonly ImportAction[];
  readOnlyReason: ReadOnlyReason;
  onAction: (jobId: string, action: InlineImportAction) => Promise<void>;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();

  const { progress } = job;
  const percent = percentOfDecimal(progress.jobBytesVerified, progress.jobBytesTotal);
  const rate = activeRate(job);
  const waitText = importResourceWaitText(progress);
  const telemetryState = importTelemetryState(progress, now);
  const telemetryVisible = importTelemetryIsVisible(telemetryState);
  const publicationState = progress.publicationState ?? 'NOT_REQUESTED';
  const willPublish = progress.publicationPolicy === 'PUBLISH_TO_JELLYFIN';

  return (
    <>
      <tr
        aria-selected={isSelected}
        className={isSelected ? 'import-row is-selected' : 'import-row'}
      >
        <td data-label="任务">
          <div className="import-cell-task">
            <button
              type="button"
              className="import-row-disclosure"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronDown
                size={15}
                strokeWidth={2}
                aria-hidden="true"
                className={open ? 'is-open' : undefined}
              />
              {/* Names the job, because the panel it opens deliberately does not. */}
              <span className="visually-hidden">
                {open ? '收起' : '展开'} {job.sourceAlias} 的次要信息
              </span>
            </button>
            <div className="import-cell-task-name">
              <span className="torrent-name" title={job.sourceAlias}>
                {job.sourceAlias}
              </span>
              <span className="import-cell-tags">
                {job.sourceRequiresPasscode ? (
                  <span className="import-passcode-tag">带提取码</span>
                ) : null}
                {/*
                 * Archive-only is the default and gets no marker; a badge on every
                 * row is a badge nobody reads. This one earns its place because it
                 * changes what 「完成」 means — a publish job has a step after the
                 * archive is verified. Both policies are spelled out in the panel.
                 */}
                {willPublish ? (
                  <span className="import-publish-flag">
                    <Clapperboard size={11} strokeWidth={2} aria-hidden="true" />
                    发布
                  </span>
                ) : null}
              </span>
            </div>
          </div>
        </td>

        <td data-label="目标">
          <span className="import-destination-cell">
            {job.destination.displayName}
            <small>{IMPORT_DESTINATION_KIND_LABELS[job.destination.kind]}</small>
          </span>
        </td>

        <td data-label="状态">
          <span className="import-state-tag" data-tone={IMPORT_STATE_TONE[progress.state]}>
            {progress.state === 'FAILED_SAFE' || progress.state === 'BLOCKED' ? (
              <TriangleAlert size={12} strokeWidth={2.2} aria-hidden="true" />
            ) : null}
            {IMPORT_STATE_LABELS[progress.state]}
          </span>
          {progress.currentCondition === undefined ? null : (
            <span className="import-condition-tag">
              {IMPORT_CONDITION_LABELS[progress.currentCondition]}
            </span>
          )}
          {job.sourceRateLimit === undefined ? null : (
            <span className="import-source-rate-limit">
              {RATE_LIMIT_LABELS[job.sourceRateLimit.code]} · 影响{' '}
              {job.sourceRateLimit.affectedActiveJobs} 笔任务
            </span>
          )}
        </td>

        <td data-label="阶段">
          {waitText === null ? (
            <span className="import-step-primary">{IMPORT_STEP_LABELS[progress.currentStep]}</span>
          ) : (
            <>
              <span className="import-step-primary is-waiting" role="status" aria-live="polite">
                {waitText}
              </span>
              <small className="import-step-secondary">
                逻辑阶段：{IMPORT_STEP_LABELS[progress.currentStep]}
              </small>
            </>
          )}
        </td>

        <td className="is-numeric" data-label="已验证">
          {percent === null ? (
            <span className="is-unknown">{NOT_REPORTED}</span>
          ) : (
            <span className="import-verified">
              {formatPercent(percent)}
              {/* Decoration only; the figure above already states it. */}
              <span className="import-row-meter" aria-hidden="true">
                <span style={{ width: `${percent}%` }} />
              </span>
            </span>
          )}
        </td>

        <td className="is-numeric" data-label="速率 / 剩余">
          {telemetryState === 'waiting' ? (
            <span className="is-unknown">未在传输</span>
          ) : telemetryState === 'stale' ? (
            <span className="is-unknown">样本已过期</span>
          ) : rate.value === NOT_REPORTED ? (
            <span className="is-unknown">{NOT_REPORTED}</span>
          ) : (
            <span className="import-throughput-rate">
              {rate.value}
              <small className="import-rate-leg"> {rate.label}</small>
            </span>
          )}
          {/*
           * A scheduled retry outranks both readings and is shown even while the job
           * is also queued for a permit: backoff is a different fact from a queue,
           * and it is the one with a deadline someone acts on. The ETA is withheld
           * during a wait for the same reason the rate is.
           */}
          {progress.state === 'RETRY_WAIT' && progress.retryAt !== undefined ? (
            <small className="import-retry-cell">
              重试 {formatCountdown(progress.retryAt, now)}
            </small>
          ) : !telemetryVisible ? null : progress.etaSeconds === undefined ? (
            <small className="import-throughput-eta is-unknown">剩余 {NOT_REPORTED}</small>
          ) : (
            <small className="import-throughput-eta">剩余 {formatEta(progress.etaSeconds)}</small>
          )}
        </td>

        <td>
          <button
            type="button"
            className="inventory-inspect"
            aria-expanded={isSelected}
            onClick={() => onSelect(job.jobId)}
          >
            查看详情
          </button>
        </td>
      </tr>

      {/*
       * `aria-label` on purpose, and deliberately without the source alias.
       *
       * A row's accessible name otherwise falls back to its contents, so repeating
       * the alias here would leave two rows answering to the same name — ambiguous
       * for a screen reader searching for that job, and for any query. The
       * disclosure button that opens this panel names the job instead.
       */}
      <tr
        id={detailId}
        className="import-row-detail"
        aria-label="这个迁移任务的次要信息"
        hidden={!open}
      >
        <td colSpan={MAIN_COLUMNS}>
          <div className="import-detail-grid">
            <dl>
              <div>
                <dt>来源类型</dt>
                <dd>{IMPORT_SOURCE_LABELS[job.sourceKind]}</dd>
              </div>
              <div>
                <dt>对象</dt>
                <dd>
                  第 {progress.objectIndex} / {progress.objectCount} 个
                </dd>
              </div>
              {progress.currentObjectAlias === undefined ? null : (
                <div>
                  <dt>当前对象</dt>
                  <dd>
                    <code>{progress.currentObjectAlias}</code>
                  </dd>
                </div>
              )}
            </dl>

            <dl>
              <div>
                <dt>已验证字节</dt>
                <dd>
                  {formatDecimalBytes(progress.jobBytesVerified)} /{' '}
                  {formatDecimalBytes(progress.jobBytesTotal)}
                </dd>
              </div>
              <div>
                <dt>当前对象字节</dt>
                <dd>
                  {formatDecimalBytes(progress.objectBytesDone)} /{' '}
                  {formatDecimalBytes(progress.objectBytesTotal)}
                </dd>
              </div>
            </dl>

            <dl>
              <div>
                <dt>发布策略</dt>
                <dd>{PUBLICATION_POLICY_LABELS[progress.publicationPolicy]}</dd>
              </div>
              <div>
                <dt>发布状态</dt>
                <dd>
                  <span
                    className="import-publication-tag"
                    data-state={publicationState.toLowerCase()}
                  >
                    {PUBLICATION_STATE_LABELS[publicationState]}
                  </span>
                </dd>
              </div>
              {job.publication === null ? null : (
                <div>
                  <dt>媒体库</dt>
                  <dd>{job.publication.libraryDisplayName}</dd>
                </div>
              )}
            </dl>

            <dl>
              <div>
                <dt>来源清理策略</dt>
                <dd>
                  {job.sourceCleanupPolicy === undefined ? (
                    // Absent means this API version does not report the field, which
                    // is not the same statement as 「保留来源」. Rendering it as a
                    // policy would invent a decision nobody recorded.
                    <span className="is-unknown">该 API 版本未报告</span>
                  ) : (
                    SOURCE_CLEANUP_POLICY_LABELS[job.sourceCleanupPolicy]
                  )}
                </dd>
              </div>
              {job.sourceCleanupRequiresPublication === true ? (
                <div>
                  <dt>清理前置</dt>
                  <dd>需先完成发布</dd>
                </div>
              ) : null}
            </dl>

            <dl>
              <div>
                <dt>创建时间</dt>
                <dd>
                  <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
                </dd>
              </div>
              <div>
                <dt>最后 checkpoint</dt>
                <dd>
                  <time dateTime={progress.lastCheckpointAt}>
                    {new Date(progress.lastCheckpointAt).toLocaleString()}
                  </time>
                </dd>
              </div>
              {progress.retryAt === undefined ? null : (
                <div>
                  <dt>下次重试</dt>
                  <dd>
                    <time dateTime={progress.retryAt}>
                      {new Date(progress.retryAt).toLocaleString()}
                    </time>
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {job.sourceRateLimit === undefined ? null : (
            <p className="inline-message import-source-rate-limit-detail" role="note">
              <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>
                <strong>
                  {RATE_LIMIT_LABELS[job.sourceRateLimit.code]} · 影响{' '}
                  {job.sourceRateLimit.affectedActiveJobs} 笔任务
                </strong>
                {' · '}预计恢复{' '}
                <time dateTime={job.sourceRateLimit.retryAt}>
                  {new Date(job.sourceRateLimit.retryAt).toLocaleString()}
                </time>
                {' · '}状态码 <code>{job.sourceRateLimit.code}</code>
                。这是来源连接级状态，同一连接的活动任务共同受影响。
              </span>
            </p>
          )}

          <InlineImportActions
            job={job}
            supportedActions={supportedActions}
            readOnlyReason={readOnlyReason}
            onAction={onAction}
          />

          {/*
           * Says what this panel is not. The two disclosures on a row look alike and
           * neither surface enables anything from a guess about `state`.
           */}
          <p className="import-detail-note" role="note">
            以上字段和行内操作权限来自列表已取得的任务摘要，展开不发请求。完整回执与事件在
            <strong>查看详情</strong>里。
          </p>
        </td>
      </tr>
    </>
  );
}

/**
 * The import list.
 *
 * Seven columns, not fifteen. The wide table this replaced could only be read by
 * scrolling sideways, which on a 390px screen meant the state and the stage were
 * never on screen together — the two facts a queue is actually scanned for. The
 * rest of what the API reports moved into each row's own panel rather than being
 * dropped: nothing this surface used to show became unreachable.
 *
 * State is carried by a word and an icon as well as a tone class, so it survives a
 * colour-blind reader and a washed-out screen.
 */
export function ImportJobsTable({
  jobs,
  selectedJobId,
  onSelect,
  supportedActions,
  readOnlyReason,
  onAction,
  now,
}: {
  jobs: readonly ImportJobSummary[];
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
  supportedActions: readonly ImportAction[];
  readOnlyReason: ReadOnlyReason;
  onAction: (jobId: string, action: InlineImportAction) => Promise<void>;
  now: number;
}) {
  return (
    <div className="inventory-table-wrap import-table-wrap">
      <table className="inventory-table import-table">
        <caption className="visually-hidden">网盘迁移任务</caption>
        <thead>
          <tr>
            <th scope="col">任务</th>
            <th scope="col">目标</th>
            <th scope="col">状态</th>
            <th scope="col">阶段</th>
            <th scope="col">已验证</th>
            <th scope="col">速率 / 剩余</th>
            <th scope="col">
              <span className="visually-hidden">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <ImportJobRow
              key={job.jobId}
              job={job}
              isSelected={job.jobId === selectedJobId}
              onSelect={onSelect}
              supportedActions={supportedActions}
              readOnlyReason={readOnlyReason}
              onAction={onAction}
              now={now}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
