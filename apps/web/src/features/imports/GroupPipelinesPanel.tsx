import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { ImportPipelineGroup, ImportPipelineSummary } from '@ptvault/contracts';
import { RetryImpactNote } from './RetryImpactNote.js';
import {
  actOnGroupPipeline,
  getGroupPipeline,
  getGroupPipelines,
  groupErrorMessage,
  groupPipelinesQueryKey,
} from './groupApi.js';
import {
  actOnImport,
  getImportDetail,
  importDetailQueryKey,
  importsQueryKey,
  provideArchiveCredentials,
} from './importApi.js';
import { ArchiveCandidatesField } from './ArchiveCandidatesField.js';
import { formatCountdown, formatDecimalBytes } from './importFormatting.js';
import { groupWaitViewModel } from './groupWaitViewModel.js';
import { downloadFailureViewModel } from './downloadFailureViewModel.js';

const PARENT_STATE: Record<ImportPipelineSummary['state'], string> = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  WAITING: '等待处理',
  PARTIAL: '部分完成',
  COMPLETED: '全部完成',
  CANCELLED: '已取消',
};
const PARENT_ACTION = {
  PAUSE: '暂停流水线',
  RESUME: '恢复流水线',
  CANCEL: '取消未完成组',
  RETRY: '重试失败组',
} as const;
const CHILD_ACTION = {
  PAUSE: '暂停该组',
  RESUME: '恢复该组',
  CANCEL: '取消该组',
  RETRY: '重试该组',
} as const;
type ParentAction = keyof typeof PARENT_ACTION;

export function GroupPipelinesPanel({
  selectedPipelineId,
  onSelectPipeline,
  onSelectJob,
  readOnly,
  now = Date.now(),
}: {
  selectedPipelineId: string | null;
  onSelectPipeline: (id: string) => void;
  onSelectJob: (id: string) => void;
  readOnly: boolean;
  now?: number;
}) {
  const [page, setPage] = useState(0);
  const query = useQuery({
    queryKey: groupPipelinesQueryKey,
    queryFn: getGroupPipelines,
    refetchInterval: 5000,
  });
  return (
    <div className="group-pipelines-layout">
      <section className="settings-card" aria-label="分组流水线列表">
        <h3>分组流水线</h3>
        <p className="field-hint">
          一个目录是一条流水线，完整分卷作为一组。显示最近最多 100
          条；原样迁移与旧解压任务在“普通任务”查看。
        </p>
        {query.isPending ? <p role="status">正在加载分组流水线…</p> : null}
        {query.isError ? <p role="alert">{groupErrorMessage(query.error)}</p> : null}
        {query.data?.length === 0 ? (
          <p>还没有分组流水线。在新建迁移中选择账户目录，开启“递归解压为视频”和“分组流水线”。</p>
        ) : null}
        <div className="group-bounded-list">
          {query.data?.slice(page * 20, page * 20 + 20).map((pipeline) => (
            <button
              type="button"
              key={pipeline.pipelineId}
              className={`group-parent-card ${selectedPipelineId === pipeline.pipelineId ? 'is-selected' : ''}`}
              aria-pressed={selectedPipelineId === pipeline.pipelineId}
              onClick={() => onSelectPipeline(pipeline.pipelineId)}
            >
              <strong>{pipeline.sourceAlias}</strong>
              <span>
                {pipeline.paused ? '已暂停 · ' : ''}
                {PARENT_STATE[pipeline.state]} · 完成 {pipeline.counts.completed}/
                {pipeline.counts.total} 组
              </span>
              <small>
                执行 {pipeline.counts.running} · 密码 {pipeline.counts.waitingPassword} · 待处理{' '}
                {pipeline.counts.needsAttention} · 已验证{' '}
                {formatDecimalBytes(pipeline.verifiedBytes)}
              </small>
            </button>
          ))}
        </div>
        {(query.data?.length ?? 0) > 20 ? (
          <div className="baidu-browser-actions">
            <button
              className="ghost-button"
              type="button"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              较新流水线
            </button>
            <span>第 {page + 1} 页</span>
            <button
              className="ghost-button"
              type="button"
              disabled={(page + 1) * 20 >= (query.data?.length ?? 0)}
              onClick={() => setPage(page + 1)}
            >
              较早流水线
            </button>
          </div>
        ) : null}
      </section>
      {selectedPipelineId ? (
        <PipelineDetail
          key={selectedPipelineId}
          id={selectedPipelineId}
          onSelectJob={onSelectJob}
          readOnly={readOnly}
          now={now}
        />
      ) : null}
    </div>
  );
}

function PipelineDetail({
  id,
  onSelectJob,
  readOnly,
  now,
}: {
  id: string;
  onSelectJob: (id: string) => void;
  readOnly: boolean;
  now: number;
}) {
  const client = useQueryClient(),
    [offset, setOffset] = useState(0),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [confirmCancel, setConfirmCancel] = useState(false);
  const intent = useRef<{ action: ParentAction; key: string } | null>(null);
  const query = useQuery({
    queryKey: [...groupPipelinesQueryKey, id, offset],
    queryFn: () => getGroupPipeline(id, offset),
    refetchInterval: 5000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: importsQueryKey });
  const run = async (action: ParentAction) => {
    if (pending || readOnly) return;
    if (action === 'CANCEL' && !confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    if (intent.current?.action !== action) intent.current = { action, key: crypto.randomUUID() };
    setPending(true);
    setError(null);
    try {
      await actOnGroupPipeline(id, action, intent.current.key);
      intent.current = null;
      setConfirmCancel(false);
      await refresh();
    } catch (cause) {
      setError(groupErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const detail = query.data;
  const pageStates =
    detail?.groups.map((group) => groupWaitViewModel(group, detail.paused, now)) ?? [];
  return (
    <section className="settings-card group-detail" aria-label="流水线详情">
      <h3>流水线详情</h3>
      {query.isPending ? <p role="status">正在加载组级进度…</p> : null}
      {query.isError ? <p role="alert">{groupErrorMessage(query.error)}</p> : null}
      {detail ? (
        <>
          <p>
            <strong>{detail.sourceAlias}</strong> · {detail.paused ? '已暂停 · ' : ''}
            {PARENT_STATE[detail.state]} · 完成 {detail.counts.completed}/{detail.counts.total} 组
          </p>
          <dl className="import-plan-figures">
            <div>
              <dt>已验证视频</dt>
              <dd>{formatDecimalBytes(detail.verifiedBytes)}</dd>
            </div>
            <div>
              <dt>最近观测暂存数据</dt>
              <dd>{formatDecimalBytes(detail.residentBytes)}</dd>
            </div>
            <div>
              <dt>当前预留空间</dt>
              <dd>{formatDecimalBytes(detail.reservedBytes)}</dd>
            </div>
            <div>
              <dt>等待或异常</dt>
              <dd>
                密码 {detail.counts.waitingPassword} · 待处理 {detail.counts.needsAttention}
              </dd>
            </div>
          </dl>
          <p className="group-wait-summary">
            本页：退避中 {pageStates.filter((state) => state.backoff).length} · 等待调度{' '}
            {pageStates.filter((state) => state.scheduling).length}
          </p>
          <p className="field-hint">
            来源保留。每组独立完成双回读、恢复材料与本地释放；“部分完成”不代表整条流水线完成。预留空间是预算，不等于实际文件大小。
            退避中表示尚未到最早重试时间；等待调度还需准入或阶段名额，不是仍在倒计时。
          </p>
          <div className="baidu-browser-actions">
            {detail.availableActions.map((action) => (
              <button
                key={action}
                type="button"
                className="ghost-button"
                disabled={readOnly || pending}
                onClick={() => void run(action)}
              >
                {PARENT_ACTION[action]}
              </button>
            ))}
          </div>
          {confirmCancel ? (
            <div className="inline-message" role="alert">
              <p>
                仅停止未完成组，不删除来源或已验证云备份。已经产出的唯一文件仍受回读和恢复材料保护。
              </p>
              <button
                type="button"
                className="ghost-button"
                disabled={pending}
                onClick={() => void run('CANCEL')}
              >
                确认取消未完成组
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setConfirmCancel(false)}
              >
                返回
              </button>
            </div>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          {detail.paused ? (
            <p className="field-hint">
              父流水线已暂停；可以补充密码。恢复父流水线后，仅继续由父流水线暂停的组，单独暂停的组保持原状态。
            </p>
          ) : null}
          <div
            key={offset}
            className="group-bounded-list"
            role="region"
            aria-label="组级队列"
            tabIndex={0}
          >
            <ul className="group-queue">
              {detail.groups.map((group) => (
                <GroupRow
                  key={group.key}
                  group={group}
                  parentPaused={detail.paused}
                  readOnly={readOnly}
                  onSelectJob={onSelectJob}
                  onChanged={refresh}
                  now={now}
                />
              ))}
            </ul>
          </div>
          <div className="baidu-browser-actions">
            <button
              type="button"
              className="ghost-button"
              aria-label="上一页组队列"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页
            </button>
            <span aria-live="polite">
              第 {detail.groups.length ? offset + 1 : 0}–{offset + detail.groups.length} 组 / 共{' '}
              {detail.counts.total} 组
            </span>
            <button
              type="button"
              className="ghost-button"
              aria-label="下一页组队列"
              disabled={detail.nextOffset === null}
              onClick={() => {
                if (detail.nextOffset !== null) setOffset(detail.nextOffset);
              }}
            >
              下一页
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
function GroupRow({
  group,
  parentPaused,
  readOnly,
  onSelectJob,
  onChanged,
  now,
}: {
  group: ImportPipelineGroup;
  parentPaused: boolean;
  readOnly: boolean;
  onSelectJob: (id: string) => void;
  onChanged: () => Promise<unknown>;
  now: number;
}) {
  const [passwordOpen, setPasswordOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [confirmCancel, setConfirmCancel] = useState(false);
  const status = groupWaitViewModel(group, parentPaused, now);
  const failure = group.lastFailure;
  const diagnostic = downloadFailureViewModel(failure?.code, failure?.downloadDiagnostic);
  const run = async (action: keyof typeof CHILD_ACTION) => {
    if (readOnly || pending || !group.jobId) return;
    if (action === 'CANCEL' && !confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await actOnImport(
        group.jobId,
        ({ PAUSE: 'pause', RESUME: 'resume', CANCEL: 'cancel', RETRY: 'retry' } as const)[action],
      );
      if (!response.supported) throw Error('IMPORT_ACTION_ROUTE_MISSING');
      setConfirmCancel(false);
      await onChanged();
    } catch (cause) {
      setError(groupErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <li className="group-queue-row">
      <div className="group-row-title">
        <strong>
          {String(group.ordinal + 1).padStart(4, '0')} · {group.entry}
        </strong>
        <span className="group-stage" data-state={status.stage}>
          {status.label}
        </span>
      </div>
      <p className="field-hint">
        输入 {group.inputCount} 个 / {formatDecimalBytes(group.inputBytes)} · 已验证{' '}
        {formatDecimalBytes(group.verifiedBytes)} · 暂存{' '}
        {group.residentSampledAt === null ? '尚未采样' : formatDecimalBytes(group.residentBytes)} ·
        尝试 {group.attempt} 次
      </p>
      {status.hint ? <p className="field-hint">{status.hint}</p> : null}
      {group.cacheState === 'EVICTING' ? (
        <p className="field-hint">正在核对来源并安全回收输入缓存，恢复前会等待这一步完成。</p>
      ) : group.jobId && !['COMPLETED', 'CANCELLED'].includes(group.stage) ? (
        <RetryImpactNote impact={group.retryImpact} />
      ) : null}
      {group.errorCode === 'ARCHIVE_VOLUME_SET_INVALID' ? (
        <p>
          分卷不完整，未创建下载任务；补齐后单独重新选择相关来源生成计划，现有来源快照保持不变。
        </p>
      ) : group.errorCode === 'GROUP_EXCEEDS_RESIDENT_BUDGET' ? (
        <p>该组预估峰值超过全局预算，等待预算满足后准入。</p>
      ) : null}
      {status.deadline !== null ? (
        <p className="field-hint">
          最早重试时间：
          <time dateTime={new Date(status.deadline).toISOString()}>
            {new Date(status.deadline).toLocaleString()}
          </time>{' '}
          · 剩余 {formatCountdown(new Date(status.deadline).toISOString(), now)}
        </p>
      ) : null}
      {failure ? (
        <div className="group-last-failure">
          <p>
            最近一次异常 ·{' '}
            <time dateTime={new Date(failure.at).toISOString()}>
              {new Date(failure.at).toLocaleString()}
            </time>
          </p>
          <p>
            <strong>{diagnostic?.label ?? '已记录异常'}</strong> · <code>{failure.code}</code>
          </p>
          {diagnostic ? (
            <p className="field-hint">
              {diagnostic.hint} {diagnostic.evidence.join(' · ')}
            </p>
          ) : null}
        </div>
      ) : group.retryAt !== null && (status.backoff || status.scheduling) ? (
        <p className="field-hint">
          该组未提供最近异常详情，可打开组详情查看已有事件；未记录的细分原因不会推测补填。
        </p>
      ) : null}
      {group.publicationState === 'PUBLISHED' ? (
        <p className="field-hint">Jellyfin 已发布</p>
      ) : group.publicationState === 'FAILED_SAFE' ? (
        <p>视频备份已保留；发布需要单独重试，请打开组详情。</p>
      ) : null}
      <div className="baidu-browser-actions">
        {group.jobId ? (
          <button
            className="ghost-button"
            type="button"
            aria-label={`查看组详情 ${group.entry}`}
            onClick={() => onSelectJob(group.jobId!)}
          >
            组详情 / 发布操作
          </button>
        ) : null}
        {group.availableActions
          .filter((action): action is keyof typeof CHILD_ACTION => action in CHILD_ACTION)
          .map((action) => (
            <button
              className="ghost-button"
              type="button"
              key={action}
              disabled={
                readOnly || pending || (parentPaused && (action === 'RESUME' || action === 'RETRY'))
              }
              onClick={() => void run(action)}
            >
              {CHILD_ACTION[action]}
            </button>
          ))}
        {group.jobId &&
        group.stage === 'WAITING_PASSWORD' &&
        group.availableActions.includes('PROVIDE_CREDENTIALS') ? (
          <button
            type="button"
            className="ghost-button"
            disabled={readOnly}
            onClick={() => setPasswordOpen(!passwordOpen)}
          >
            {passwordOpen ? '收起密码输入' : '补充候选密码'}
          </button>
        ) : null}
      </div>
      {confirmCancel ? (
        <div role="alert">
          <p>只取消这一组，不删除来源及已验证云备份。</p>
          <button
            className="ghost-button"
            type="button"
            disabled={pending}
            onClick={() => void run('CANCEL')}
          >
            确认取消该组
          </button>
          <button className="ghost-button" type="button" onClick={() => setConfirmCancel(false)}>
            返回
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {passwordOpen && group.jobId ? (
        <GroupPasswordForm
          jobId={group.jobId}
          parentPaused={parentPaused}
          readOnly={readOnly}
          onChanged={onChanged}
        />
      ) : null}
    </li>
  );
}
function GroupPasswordForm({
  jobId,
  parentPaused,
  readOnly,
  onChanged,
}: {
  jobId: string;
  parentPaused: boolean;
  readOnly: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [candidates, setCandidates] = useState<string[]>([]),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: importDetailQueryKey(jobId),
    queryFn: () => getImportDetail(jobId),
  });
  const save = async () => {
    if (pending || readOnly || query.data?.supported !== true) return;
    const values = candidates.filter((value) => value !== '');
    const revision = query.data.data.progress.revision;
    setPending(true);
    setCandidates([]);
    setError(null);
    setMessage(null);
    let saved = false;
    try {
      const result = await provideArchiveCredentials(jobId, values, revision, crypto.randomUUID());
      if (!result.supported) throw Error('IMPORT_ACTION_ROUTE_MISSING');
      saved = true;
      if (!parentPaused) {
        const resumed = await actOnImport(jobId, 'resume');
        if (!resumed.supported) throw Error('IMPORT_ACTION_ROUTE_MISSING');
      }
      setMessage(
        parentPaused
          ? '候选密码已保存；父流水线仍暂停，请先恢复父流水线。'
          : '候选密码已保存，该组已恢复排队。其他组保持原状态。',
      );
      await onChanged();
    } catch (cause) {
      setError(`${saved ? '候选密码已保存；恢复尚未确认。' : ''}${groupErrorMessage(cause)}`);
      void onChanged().catch(() => undefined);
    } finally {
      setPending(false);
      setCandidates([]);
    }
  };
  return (
    <div className="group-password-form">
      <ArchiveCandidatesField
        value={candidates}
        onChange={setCandidates}
        disabled={readOnly || pending}
      />
      {query.isError ? <p role="alert">{groupErrorMessage(query.error)}</p> : null}
      <button
        className="primary-button"
        type="button"
        disabled={
          readOnly ||
          pending ||
          query.data?.supported !== true ||
          !candidates.some((value) => value !== '')
        }
        onClick={() => void save()}
      >
        {pending ? '正在保存…' : parentPaused ? '保存该组密码' : '保存并继续该组'}
      </button>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
