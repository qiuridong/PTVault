import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Eraser,
  KeyRound,
  Lock,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { useRef, useState } from 'react';

import type { ImportDetail, ImportSourceCleanupPreview } from '@ptvault/contracts';

import { newIdempotencyKey } from '../../api/client.js';
import {
  executeImportSourceCleanup,
  getImportSourceCleanup,
  importDetailQueryKey,
  importErrorMessage,
  importsQueryKey,
  previewImportSourceCleanup,
  sourceCleanupQueryKey,
} from './importApi.js';
import { formatDecimalBytes } from './importFormatting.js';
import {
  SOURCE_CLEANUP_GATE_LABELS,
  SOURCE_CLEANUP_POLICY_LABELS,
  SOURCE_CLEANUP_STATUS_LABELS,
} from './importLabels.js';
import {
  sourceCleanupObjectViewModel,
  sourceCleanupSemanticsLabel,
} from './sourceCleanupViewModel.js';
import type { ReadOnlyReason } from './ImportCreatePanel.js';

const READ_ONLY_LABELS: Record<Exclude<ReadOnlyReason, null>, string> = {
  DEMO: '演示只读',
  SHADOW: '只读影子模式',
  FEATURE_DISABLED: '来源清理能力未启用',
};

type Intent = { fingerprint: string; key: string };

function intentKey(ref: React.MutableRefObject<Intent | null>, fingerprint: string): string {
  if (ref.current?.fingerprint !== fingerprint) {
    ref.current = { fingerprint, key: newIdempotencyKey() };
  }
  return ref.current.key;
}

export function SourceCleanupPanel({
  detail,
  readOnlyReason,
}: {
  detail: ImportDetail;
  readOnlyReason: ReadOnlyReason;
}) {
  const queryClient = useQueryClient();
  const policy = detail.sourceCleanupPolicy;
  const cleanupEnabled = policy !== undefined && policy !== 'KEEP';
  const statusQuery = useQuery({
    queryKey: sourceCleanupQueryKey(detail.jobId),
    queryFn: () => getImportSourceCleanup(detail.jobId),
    enabled: cleanupEnabled,
    refetchInterval: (query) => {
      const answer = query.state.data;
      return answer?.supported === true && answer.data?.status === 'RUNNING' ? 5_000 : false;
    },
  });
  const [preview, setPreview] = useState<ImportSourceCleanupPreview | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [previewPending, setPreviewPending] = useState(false);
  const [executePending, setExecutePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationUnsupported, setMutationUnsupported] = useState(false);
  const previewIntent = useRef<Intent | null>(null);
  const executeIntent = useRef<Intent | null>(null);

  if (policy === undefined) {
    return (
      <section className="import-detail-section" aria-label="来源清理">
        <h3>
          <Eraser size={15} strokeWidth={1.9} aria-hidden="true" /> 来源清理
        </h3>
        <p className="import-publication-none">
          旧版任务没有报告冻结的来源清理策略。页面不会从来源类型或完成状态推导删除权限。
        </p>
      </section>
    );
  }

  if (policy === 'KEEP') {
    return (
      <section className="import-detail-section" aria-label="来源清理">
        <h3>
          <Eraser size={15} strokeWidth={1.9} aria-hidden="true" /> 来源清理
        </h3>
        <p className="import-publication-none">
          任务明确选择了保留来源（KEEP）；不会生成清理预览，也不会执行来源删除。
        </p>
      </section>
    );
  }

  const statusAnswer = statusQuery.data;
  const cleanup = statusAnswer?.supported === true ? statusAnswer.data : null;
  const routeAbsent = statusAnswer?.supported === false || mutationUnsupported;
  const previewStale = preview !== null && preview.jobRevision !== detail.progress.revision;

  const runPreview = async (): Promise<void> => {
    setPreviewPending(true);
    setError(null);
    setMutationUnsupported(false);
    const fingerprint = `${detail.jobId}:${policy}:${detail.progress.revision}`;
    try {
      const result = await previewImportSourceCleanup(
        detail.jobId,
        { policy, expectedJobRevision: detail.progress.revision },
        intentKey(previewIntent, fingerprint),
      );
      if (!result.supported) {
        setMutationUnsupported(true);
        return;
      }
      setPreview(result.data);
      previewIntent.current = null;
      executeIntent.current = null;
    } catch (cause) {
      setError(importErrorMessage(cause));
    } finally {
      setPreviewPending(false);
    }
  };

  const runExecute = async (): Promise<void> => {
    if (preview === null || !preview.eligible || previewStale) return;
    setExecutePending(true);
    setError(null);
    setMutationUnsupported(false);
    const fingerprint = [
      detail.jobId,
      preview.previewId,
      preview.previewRevision,
      preview.fingerprint,
      preview.jobRevision,
    ].join(':');
    try {
      const result = await executeImportSourceCleanup(
        detail.jobId,
        {
          previewId: preview.previewId,
          previewRevision: preview.previewRevision,
          previewFingerprint: preview.fingerprint,
          expectedJobRevision: preview.jobRevision,
          mfaCode,
        },
        intentKey(executeIntent, fingerprint),
      );
      if (!result.supported) {
        setMutationUnsupported(true);
        return;
      }
      queryClient.setQueryData(sourceCleanupQueryKey(detail.jobId), {
        supported: true,
        data: result.data,
      });
      // Required cleanup can withdraw UNPUBLISH; refresh authority rather than
      // deriving a new action list from the cleanup response in the browser.
      void queryClient.invalidateQueries({
        queryKey: importDetailQueryKey(detail.jobId),
        exact: true,
      });
      void queryClient.invalidateQueries({ queryKey: importsQueryKey, exact: true });
      setPreview(null);
      executeIntent.current = null;
    } catch (cause) {
      setError(importErrorMessage(cause));
    } finally {
      setMfaCode('');
      setExecutePending(false);
    }
  };

  return (
    <section className="import-detail-section" aria-label="来源清理">
      <h3>
        <Eraser size={15} strokeWidth={1.9} aria-hidden="true" /> 来源清理
      </h3>
      <p className="import-policy-line">
        冻结策略：{SOURCE_CLEANUP_POLICY_LABELS[policy]}
        {detail.sourceCleanupRequiresPublication === true ? ' · 必须先发布成功' : ''}
      </p>

      {readOnlyReason === null ? null : (
        <p className="inline-message import-readonly" role="note">
          <Lock size={14} strokeWidth={1.9} aria-hidden="true" />
          {READ_ONLY_LABELS[readOnlyReason]}：预览仍可审阅，执行保持禁用。
        </p>
      )}

      {statusQuery.isPending ? (
        <p className="route-status">
          <CircleDashed size={15} strokeWidth={1.8} aria-hidden="true" /> 正在读取来源清理状态…
        </p>
      ) : statusQuery.isError ? (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          {importErrorMessage(statusQuery.error)}
        </p>
      ) : routeAbsent ? (
        <p className="inline-message" role="note">
          <CircleSlash size={14} strokeWidth={1.8} aria-hidden="true" />
          这台机器上的 API 版本还没有来源清理接口。
        </p>
      ) : cleanup !== null ? (
        <div className="source-cleanup-status" role="group" aria-label="来源清理状态">
          <div className="import-detail-state">
            <span
              className="import-state-tag"
              data-tone={cleanup.status === 'COMPLETED' ? 'ok' : 'warn'}
            >
              {SOURCE_CLEANUP_STATUS_LABELS[cleanup.status]}
            </span>
            <span>{SOURCE_CLEANUP_POLICY_LABELS[cleanup.policy]}</span>
          </div>
          <dl className="instance-meta">
            <div>
              <dt>精确来源根</dt>
              <dd>
                <code>{cleanup.exactSourceRoot}</code>
              </dd>
            </div>
            <div>
              <dt>来源账户</dt>
              <dd>{cleanup.sourceAccountMasked}</dd>
            </div>
            <div>
              <dt>对象进度</dt>
              <dd>
                完成 {cleanup.completedObjectCount} / {cleanup.objectCount}
              </dd>
            </div>
            <div>
              <dt>失败对象</dt>
              <dd>{cleanup.failedObjectCount}</dd>
            </div>
            <div>
              <dt>完成字节</dt>
              <dd>
                {formatDecimalBytes(cleanup.completedBytes)} /{' '}
                {formatDecimalBytes(cleanup.totalBytes)}
              </dd>
            </div>
            <div>
              <dt>服务商语义</dt>
              <dd>{sourceCleanupSemanticsLabel(cleanup)}</dd>
            </div>
            <div>
              <dt>人工跟进</dt>
              <dd>{cleanup.followUpRequired ? '需要' : '不需要'}</dd>
            </div>
            <div>
              <dt>擦除声明</dt>
              <dd>{cleanup.physicalErasureClaimed ? '已声明' : '不声称物理擦除'}</dd>
            </div>
          </dl>
          <p className="field-hint">
            回收站放置不是物理擦除声明；状态只证明服务商请求与 durable journal 记录到哪一步。
          </p>
          {cleanup.objects.length === 0 ? null : (
            <ul className="import-issue-list">
              {cleanup.objects.slice(0, 20).map((object) => {
                const model = sourceCleanupObjectViewModel(object);
                return (
                  <li key={object.objectId}>
                    <code>{object.objectId}</code>
                    <span>
                      {model.statusLabel}
                      {object.followUpRequired ? ' · 需要跟进' : ''}
                      {model.semanticsLabel === null ? '' : ` · ${model.semanticsLabel}`}
                      <small>{model.receiptLabel}</small>
                      {model.errorCode === null ? null : <code>{model.errorCode}</code>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {cleanup.objects.length <= 20 ? null : (
            <p className="field-hint">仅显示前 20 个对象；完整逐对象状态保留在服务端 journal。</p>
          )}
        </div>
      ) : (
        <>
          {preview === null ? (
            <button
              type="button"
              className="ghost-button"
              disabled={previewPending}
              onClick={() => void runPreview()}
            >
              <ShieldCheck size={15} strokeWidth={1.9} aria-hidden="true" />
              {previewPending ? '正在生成预览…' : '生成来源清理预览'}
            </button>
          ) : (
            <div className="source-cleanup-preview" role="group" aria-label="来源清理预览">
              <dl className="instance-meta">
                <div>
                  <dt>精确来源根</dt>
                  <dd>
                    <code>{preview.exactSourceRoot}</code>
                  </dd>
                </div>
                <div>
                  <dt>来源账户</dt>
                  <dd>{preview.sourceAccountMasked}</dd>
                </div>
                <div>
                  <dt>范围</dt>
                  <dd>
                    {preview.objectCount} 个对象 · {formatDecimalBytes(preview.totalBytes)}
                  </dd>
                </div>
                <div>
                  <dt>服务商语义</dt>
                  <dd>移入服务商回收站，不代表物理擦除</dd>
                </div>
                <div>
                  <dt>资格</dt>
                  <dd>{preview.eligible ? '全部门通过' : '仍有门未通过'}</dd>
                </div>
                <div>
                  <dt>到期</dt>
                  <dd>
                    <time dateTime={preview.expiresAt}>
                      {new Date(preview.expiresAt).toLocaleString()}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>指纹</dt>
                  <dd>
                    <code>{preview.fingerprint}</code>
                  </dd>
                </div>
              </dl>
              <ul className="recovery-checklist">
                {preview.gates.map((gate) => (
                  <li key={gate.gate} className={`recovery-check${gate.passed ? ' is-met' : ''}`}>
                    {gate.passed ? (
                      <CheckCircle2 size={16} strokeWidth={1.9} aria-hidden="true" />
                    ) : (
                      <XCircle size={16} strokeWidth={1.9} aria-hidden="true" />
                    )}
                    <span className="recovery-check-label">
                      {SOURCE_CLEANUP_GATE_LABELS[gate.gate]}
                    </span>
                    <span className="recovery-check-detail">
                      {gate.passed ? '通过' : '未通过'}
                      {gate.reason === null ? '' : ` ${gate.reason}`}
                    </span>
                  </li>
                ))}
              </ul>
              {previewStale ? (
                <p className="inline-message error-message" role="alert">
                  <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                  任务修订已变化，这份预览失效；请重新生成。
                </p>
              ) : null}
              <div className="field">
                <label htmlFor={`cleanup-mfa-${detail.jobId}`}>来源清理两步验证码</label>
                <span className="input-with-icon">
                  <KeyRound size={15} strokeWidth={1.8} aria-hidden="true" />
                  <input
                    id={`cleanup-mfa-${detail.jobId}`}
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={mfaCode}
                    disabled={
                      !preview.eligible || previewStale || readOnlyReason !== null || executePending
                    }
                    onChange={(event) =>
                      setMfaCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))
                    }
                  />
                </span>
              </div>
              <div className="import-confirm-actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={executePending}
                  onClick={() => {
                    setPreview(null);
                    setMfaCode('');
                    executeIntent.current = null;
                  }}
                >
                  丢弃预览
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={
                    !preview.eligible ||
                    previewStale ||
                    readOnlyReason !== null ||
                    !/^[0-9]{6}$/.test(mfaCode) ||
                    executePending
                  }
                  onClick={() => void runExecute()}
                >
                  <Eraser size={15} strokeWidth={1.9} aria-hidden="true" />
                  {executePending ? '正在执行…' : '执行来源清理'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error === null ? null : (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {error}
        </p>
      )}
    </section>
  );
}
