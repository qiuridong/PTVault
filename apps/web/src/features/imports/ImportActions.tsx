import { useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CircleSlash,
  KeyRound,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Send,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import { useId, useRef, useState } from 'react';

import type { ImportAction, ImportDetail } from '@ptvault/contracts';

import { newIdempotencyKey } from '../../api/client.js';
import {
  actOnImport,
  importDetailQueryKey,
  importErrorMessage,
  importsQueryKey,
  provideImportCredentials,
  provideArchiveCredentials,
  retryPublication,
  unpublishPublication,
  type ImportLifecycleAction,
} from './importApi.js';
import { IMPORT_ACTION_CONSEQUENCE, IMPORT_ACTION_LABELS } from './importLabels.js';
import type { ReadOnlyReason } from './ImportCreatePanel.js';
import { ArchiveCandidatesField } from './ArchiveCandidatesField.js';
import { RetryImpactNote } from './RetryImpactNote.js';

const ACTION_ICONS: Record<ImportAction, typeof Pause> = {
  PAUSE: Pause,
  RESUME: Play,
  CANCEL: X,
  RETRY: RotateCcw,
  PROVIDE_CREDENTIALS: KeyRound,
  REPUBLISH: Send,
  UNPUBLISH: Undo2,
};

const LIFECYCLE: Partial<Record<ImportAction, ImportLifecycleAction>> = {
  PAUSE: 'pause',
  RESUME: 'resume',
  CANCEL: 'cancel',
  RETRY: 'retry',
};

/** Actions that remove something a viewer can see, so they read as destructive. */
const DESTRUCTIVE: ReadonlySet<ImportAction> = new Set(['CANCEL', 'UNPUBLISH']);

const READ_ONLY_LABELS: Record<Exclude<ReadOnlyReason, null>, string> = {
  DEMO: '演示只读',
  SHADOW: '只读影子模式',
  FEATURE_DISABLED: '尚未启用',
};

/**
 * What an operator may do to one import, driven entirely by the server's list.
 *
 * Snapshot `availableActions` and deployment `supportedActions` jointly enable a button.
 * Deriving actionability from the job state in the browser is how a page ends up
 * offering "pause" to a worker that claimed the job a second ago — the guess and
 * the truth diverge under exactly the conditions that make someone reach for the
 * button.
 *
 * Ordinary retry uses one click; its cost is described before the action.
 * Other actions retain their existing confirmation and authorization boundaries.
 *
 * None of these live in the command palette. A fuzzy list one keystroke from
 * Enter is the wrong home for anything that moves or removes data.
 */
export function ImportActions({
  detail,
  supportedActions,
  readOnlyReason,
}: {
  detail: ImportDetail;
  supportedActions: readonly ImportAction[];
  readOnlyReason: ReadOnlyReason;
}) {
  const panelId = useId();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ImportAction | null>(null);
  const [confirming, setConfirming] = useState<ImportAction | null>(null);
  const [passcode, setPasscode] = useState('');
  const [archiveCandidates, setArchiveCandidates] = useState<string[]>([]);
  const archiveCredentialKey = useRef(newIdempotencyKey());
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<ImportAction | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const publicationIntent = useRef<{ fingerprint: string; key: string } | null>(null);

  const offered = detail.availableActions;
  const supported = new Set(supportedActions);
  const canRun = (action: ImportAction): boolean =>
    readOnlyReason === null && offered.includes(action) && supported.has(action);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: importsQueryKey });
    await queryClient.invalidateQueries({ queryKey: importDetailQueryKey(detail.jobId) });
  };

  const publicationKey = (action: 'REPUBLISH' | 'UNPUBLISH', publicationId: string): string => {
    const fingerprint = `${action}:${publicationId}`;
    if (publicationIntent.current?.fingerprint !== fingerprint) {
      publicationIntent.current = { fingerprint, key: newIdempotencyKey() };
    }
    return publicationIntent.current.key;
  };

  const run = async (action: ImportAction): Promise<void> => {
    if (pending !== null || !canRun(action)) return;
    setPending(action);
    setError(null);
    setUnsupported(null);
    setOutcome(null);
    /*
     * A local flag, not the `unsupported` state.
     *
     * State set during this call is not visible to this closure — it belongs to
     * the next render — so branching on `unsupported` here would always take the
     * "supported" path and refetch after a 404. Harmless in effect, misleading to
     * read, and exactly the kind of thing that stops being harmless once someone
     * adds a second consequence to the branch.
     */
    let routeMissing = false;
    try {
      const lifecycle = LIFECYCLE[action];
      if (lifecycle !== undefined) {
        const result = await actOnImport(detail.jobId, lifecycle);
        routeMissing = !result.supported;
      } else if (action === 'PROVIDE_CREDENTIALS') {
        const result =
          detail.archive === undefined
            ? await provideImportCredentials(detail.jobId, {
                kind: 'INLINE',
                passcode,
              })
            : await provideArchiveCredentials(
                detail.jobId,
                archiveCandidates.filter((value) => value !== ''),
                detail.progress.revision,
                archiveCredentialKey.current,
              );
        routeMissing = !result.supported;
        if (detail.archive !== undefined && result.supported)
          setOutcome('候选密码已更新，输入已清空。点击“恢复”后从已有分卷继续解压。');
      } else if (action === 'REPUBLISH') {
        const publicationId = detail.publication?.publicationId;
        if (publicationId === undefined) return;
        const result = await retryPublication(
          publicationId,
          publicationKey('REPUBLISH', publicationId),
        );
        routeMissing = !result.supported;
      } else if (action === 'UNPUBLISH') {
        const publicationId = detail.publication?.publicationId;
        if (publicationId === undefined) return;
        const result = await unpublishPublication(
          publicationId,
          publicationKey('UNPUBLISH', publicationId),
        );
        routeMissing = !result.supported;
        // The contract will not let this response claim otherwise, so the page can
        // state it flatly rather than hedging.
        if (result.supported) setOutcome('已取消发布。OneDrive 上的备份一个字节都没有删除。');
      }
      if (routeMissing) setUnsupported(action);
      else await refresh();
      if (action === 'REPUBLISH' || action === 'UNPUBLISH') publicationIntent.current = null;
      setConfirming(null);
    } catch (cause) {
      setError(importErrorMessage(cause));
    } finally {
      // The passcode's whole permitted lifetime is the request it was typed for.
      setPasscode('');
      setArchiveCandidates([]);
      setPending(null);
    }
  };

  if (offered.length === 0) {
    return (
      <p className="offload-conflict-note" role="note">
        这个任务当前没有可执行的操作。服务端说了算，页面不自己猜。
      </p>
    );
  }

  return (
    <section className="import-actions" aria-labelledby={`${panelId}-title`}>
      <h3 id={`${panelId}-title`}>操作</h3>
      {offered.includes('RETRY') || (detail.archive !== undefined && offered.includes('RESUME')) ? (
        detail.archive === undefined ? (
          <p className="field-hint">
            重试会按现有检查点继续，先核对来源和已完成步骤；不会删除来源原件。
          </p>
        ) : (
          <RetryImpactNote impact={detail.archive.retryImpact} />
        )
      ) : null}

      {readOnlyReason === null ? null : (
        <p className="inline-message import-readonly" role="note">
          <Lock size={14} strokeWidth={1.9} aria-hidden="true" />
          {/* One span, not two flex children: as a sibling of the icon the
              <strong> shrank in the narrow detail column and broke 「演示只读」
              across two lines. */}
          <span>
            <strong>{READ_ONLY_LABELS[readOnlyReason]}</strong>
            ——下面的操作会被拒绝，所以先说在前面，不必点完才发现。
          </span>
        </p>
      )}

      <div className="import-action-row">
        {offered.map((action) => {
          const Icon = ACTION_ICONS[action];
          // Two independent gates: the server offers it for this job, and this API
          // version implements it at all. A button that is drawn live and then
          // swallows the click is worse than one that explains itself.
          const implemented = supported.has(action);
          const blocked = !canRun(action);
          return (
            <button
              key={action}
              type="button"
              className={DESTRUCTIVE.has(action) ? 'danger-button' : 'ghost-button'}
              disabled={blocked || pending !== null}
              title={implemented ? undefined : 'API 尚未启用该操作'}
              onClick={() => {
                if (action === 'RETRY') {
                  void run(action);
                  return;
                }
                setConfirming(action);
                setError(null);
                setOutcome(null);
              }}
            >
              <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
              {IMPORT_ACTION_LABELS[action]}
              {implemented ? null : <span className="import-action-gap">API 尚未启用</span>}
            </button>
          );
        })}
      </div>

      {confirming === null ? null : (
        <div
          className="import-confirm"
          role="group"
          aria-label={`确认${IMPORT_ACTION_LABELS[confirming]}`}
        >
          <p className="import-confirm-line">
            <strong>{IMPORT_ACTION_LABELS[confirming]}</strong>
            {confirming === 'PROVIDE_CREDENTIALS' && detail.archive !== undefined
              ? '更新本任务各层共用的候选列表，不自动启动；保存后再确认继续。'
              : IMPORT_ACTION_CONSEQUENCE[confirming]}
          </p>

          {confirming === 'PROVIDE_CREDENTIALS' ? (
            detail.archive !== undefined ? (
              <ArchiveCandidatesField
                value={archiveCandidates}
                onChange={(values) => {
                  setArchiveCandidates(values);
                  archiveCredentialKey.current = newIdempotencyKey();
                }}
                disabled={pending !== null}
              />
            ) : (
              <div className="field">
                <label htmlFor={`${panelId}-passcode`}>提取码</label>
                <input
                  id={`${panelId}-passcode`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value)}
                />
                <small className="field-hint">
                  只交付一次，请求结束立即从浏览器清除；不写入地址栏、不存本地、不进日志。
                </small>
              </div>
            )
          ) : null}

          <div className="import-confirm-actions">
            <button
              type="button"
              className="ghost-button"
              disabled={pending !== null}
              onClick={() => {
                setConfirming(null);
                setPasscode('');
                setArchiveCandidates([]);
                publicationIntent.current = null;
              }}
            >
              返回
            </button>
            <button
              type="button"
              className={DESTRUCTIVE.has(confirming) ? 'danger-button' : 'primary-button'}
              disabled={
                pending !== null ||
                !canRun(confirming) ||
                (confirming === 'PROVIDE_CREDENTIALS' &&
                  (detail.archive === undefined
                    ? passcode === ''
                    : archiveCandidates.every((value) => value === '')))
              }
              onClick={() => void run(confirming)}
            >
              {pending === confirming ? '正在执行…' : `确认${IMPORT_ACTION_LABELS[confirming]}`}
            </button>
          </div>
        </div>
      )}

      {unsupported === null ? null : (
        <p className="inline-message" role="note">
          <CircleSlash size={14} strokeWidth={1.8} aria-hidden="true" />
          这台机器上的 API 版本还没有「{IMPORT_ACTION_LABELS[unsupported]}」这个操作。
        </p>
      )}

      {outcome === null ? null : (
        <p className="inline-message" role="status">
          <Ban size={14} strokeWidth={1.8} aria-hidden="true" /> {outcome}
        </p>
      )}

      {error === null ? null : (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {error}
        </p>
      )}
    </section>
  );
}
