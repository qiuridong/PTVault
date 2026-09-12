import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import type { OffloadRejection, TorrentSummary } from '@ptvault/contracts';

import { ApiError, newIdempotencyKey } from '../../api/client.js';
import { offloadsQueryKey } from '../jobs/jobApi.js';
import {
  cancelOffload,
  retryOffload,
  startOffloads,
  type OffloadTriggerResponse,
} from './qbApi.js';

export type OffloadConfirmDialogProps = {
  /** The operator's current selection; never empty when this dialog is open. */
  selected: TorrentSummary[];
  /** Called once the server has accepted the batch, before the panel is dismissed. */
  onSubmitted?: () => void;
  onClose: () => void;
};

const REJECTION_LABELS: Record<string, string> = {
  PREFLIGHT_INELIGIBLE: '预检不通过',
  ACTIVE_WRITE: '文件仍在写入',
  PATH_MISSING: '文件不存在',
  NOT_COMPLETE: '种子尚未完成',
  ALREADY_OFFLOADED: '已迁移',
  OFFLOAD_ALREADY_ACTIVE: '已有迁移任务占用',
  DUPLICATE_TARGET: '重复选择',
  TORRENT_NOT_FOUND: '种子不存在',
  INVALID_TORRENT_IDENTITY: '种子标识无效',
  CREATE_FAILED: '创建任务失败',
  OUTSIDE_ALLOWED_ROOT: '路径不在允许范围',
  SYMLINK_ESCAPE: '符号链接越界',
  SHARED_TORRENT_FILE: '文件被其它种子共用',
};

/** Where a stalled transfer got to, in the operator's words. */
const STEP_LABELS: Record<string, string> = {
  PREFLIGHT: '预检',
  PAUSING: '暂停种子',
  SNAPSHOTTING: '快照源文件',
  HASHING: '哈希校验',
  UPLOADING_STAGING: '上传到暂存区',
  VERIFYING: '解密回读校验',
  FINALIZING_REMOTE: '定稿远端',
  CLOUD_COMMITTED: '云端已提交',
  LOCAL_CLEANUP: '本地清理',
  COMPLETED: '已完成',
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '会话已过期，请重新登录。';
    if (error.status === 403) return '验证码不正确或已被使用，请用当前的新码重试。';
    // 409 means "nothing was queued". The trigger answers it with a per-target
    // rejection list, which the result view shows — so reaching this branch means
    // the mode check refused before any target was examined.
    if (error.status === 409) return '本站运行在 SHADOW 模式，迁移未开放。';
    return error.message;
  }
  return '发起迁移失败。';
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The two ways out of a transfer that is holding a torrent.
 *
 * Shown only when the server marked the holder `resolvable` — a job a worker is
 * still driving must be waited out, and offering a button for it would race that
 * worker and tell the operator something untrue.
 *
 * Retry is offered first and styled as the primary action: the held snapshot may
 * already contain the exported .torrent and per-file hashes, so resuming skips
 * work that cancelling would throw away.
 */
function ConflictActions({
  conflict,
  onResolved,
}: {
  conflict: NonNullable<OffloadRejection['conflict']>;
  onResolved: () => void;
}) {
  const codeId = useId();
  const queryClient = useQueryClient();
  const [mfaCode, setMfaCode] = useState('');

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['qb', 'torrents'] });
    await queryClient.invalidateQueries({ queryKey: offloadsQueryKey });
  };

  /*
   * One idempotency key for cancel, reused until the cancel succeeds.
   *
   * Only cancel needs it. `/api/offloads/cancel` books a bounded durable receipt
   * and replays it *before* consuming the MFA code, so an attempt repeated after
   * a lost answer or a mistyped code must carry the same key — a fresh one per
   * attempt would miss the replay and spend a second single-use code. Retry is a
   * plain recovery action with no receipt, so it deliberately sends no key.
   */
  const cancelKey = useRef<string | undefined>(undefined);
  const keyForCancel = (): string => {
    cancelKey.current ??= newIdempotencyKey();
    return cancelKey.current;
  };

  const retry = useMutation({
    mutationFn: () => retryOffload({ jobId: conflict.jobId, mfaCode }),
    onSuccess: async () => {
      setMfaCode('');
      await invalidate();
      onResolved();
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      cancelOffload({ jobId: conflict.jobId, mfaCode, idempotencyKey: keyForCancel() }),
    onSuccess: async () => {
      cancelKey.current = undefined;
      setMfaCode('');
      await invalidate();
      onResolved();
    },
  });

  const busy = retry.isPending || cancel.isPending;
  const canAct = /^[0-9]{6}$/.test(mfaCode) && !busy;
  const failure = retry.error ?? cancel.error;

  if (!conflict.resolvable) {
    return (
      <p className="offload-conflict-note">
        任务 <code>{conflict.jobId.slice(0, 8)}</code> 正在
        {STEP_LABELS[conflict.currentStep] ?? conflict.currentStep}，运行中不可操作，请等它结束。
      </p>
    );
  }

  return (
    <div className="offload-conflict">
      <p className="offload-conflict-note">
        任务 <code>{conflict.jobId.slice(0, 8)}</code> 停在
        {STEP_LABELS[conflict.currentStep] ?? conflict.currentStep}
        。可以让它从这一步继续，或取消它腾出这个种子。
        <strong>两者都不会删除本地文件。</strong>
      </p>
      <label className="field" htmlFor={codeId}>
        <span>两步验证码</span>
        <input
          id={codeId}
          aria-label={`处理任务 ${conflict.jobId.slice(0, 8)} 的两步验证码`}
          type="text"
          value={mfaCode}
          onChange={(event) => setMfaCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
        />
      </label>
      {failure ? (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {errorMessage(failure)}
        </p>
      ) : null}
      <div className="instance-form-actions">
        <button type="button" onClick={() => cancel.mutate()} disabled={!canAct}>
          {cancel.isPending ? '正在取消……' : '取消该任务'}
        </button>
        <button
          type="button"
          className="primary-action"
          onClick={() => retry.mutate()}
          disabled={!canAct}
        >
          {retry.isPending ? '正在重试……' : '继续该任务'}
        </button>
      </div>
    </div>
  );
}

/**
 * Last human gate before bytes move.
 *
 * Deliberately not a one-click action: it restates exactly what was selected,
 * requires a fresh TOTP code, and reports partial acceptance instead of implying
 * the whole batch was queued. The server re-runs preflight per target and may
 * reject some of them, so this shows `rejected` rather than closing on success.
 */
export function OffloadConfirmDialog({
  selected,
  onSubmitted,
  onClose,
}: OffloadConfirmDialogProps) {
  const titleId = useId();
  const codeId = useId();
  const queryClient = useQueryClient();
  const [mfaCode, setMfaCode] = useState('');
  // Defaults to STANDARD, so a second cloud copy is opt-in. Two copies of
  // everything would need twice the cloud footprint, and deletion has never
  // depended on the second one — `cleanup` asks for a verified *primary*.
  const [important, setImportant] = useState(false);
  const [result, setResult] = useState<OffloadTriggerResponse | null>(null);

  const totalBytes = selected.reduce((sum, torrent) => sum + torrent.totalSize, 0);

  const mutation = useMutation({
    mutationFn: () =>
      startOffloads({
        targets: selected.map((torrent) => ({
          instanceId: torrent.instanceId,
          torrentHash: torrent.hash,
        })),
        importance: important ? 'IMPORTANT' : 'STANDARD',
        mfaCode,
      }),
    onSuccess: async (response) => {
      setResult(response);
      setMfaCode('');
      // The result view below reads `result`, never `selected`, so dropping the
      // parent's selection here cannot blank out what this panel is reporting.
      onSubmitted?.();
      // Prefix match: every instance's torrent list now shows stale cloud state.
      await queryClient.invalidateQueries({ queryKey: ['qb', 'torrents'] });
      // The history filter on the torrent page is keyed by all prior offloads. A
      // newly queued job must leave "从未迁移" immediately, not after the worker's
      // first SSE event happens to arrive.
      await queryClient.invalidateQueries({ queryKey: offloadsQueryKey });
    },
  });

  const canSubmit = /^[0-9]{6}$/.test(mfaCode) && !mutation.isPending;

  if (result !== null) {
    return (
      <section className="preflight-panel" aria-labelledby={titleId}>
        <header className="preflight-header">
          <div>
            <h2 id={titleId}>已发起 {result.offloads.length} 个迁移任务</h2>
            <p className="preflight-identity">
              共选择 {result.requested} 项，
              {result.rejected.length === 0
                ? '全部进入队列。'
                : `${result.rejected.length} 项被拒绝。`}
            </p>
          </div>
          <button type="button" className="inventory-inspect" onClick={onClose} aria-label="关闭">
            <X size={15} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </header>

        {result.rejected.length > 0 ? (
          <ul className="offload-rejections">
            {result.rejected.map((rejection) => (
              <li key={`${rejection.instanceId}:${rejection.torrentHash}`}>
                <div className="offload-rejection-head">
                  <code>{rejection.torrentHash.slice(0, 12)}</code>{' '}
                  {REJECTION_LABELS[rejection.code] ?? rejection.code}
                  {rejection.issues.length > 0
                    ? `（${rejection.issues.map((code) => REJECTION_LABELS[code] ?? code).join('、')}）`
                    : ''}
                </div>
                {/*
                  A refusal the operator can act on, rather than a dead end. Before
                  this, one stalled transfer held its torrent forever: the trigger
                  said "already migrating" and there was nowhere to go from there.
                */}
                {rejection.conflict ? (
                  <ConflictActions
                    conflict={rejection.conflict}
                    onResolved={() => setResult(null)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="instance-form-actions">
          <button type="button" className="primary-action" onClick={onClose}>
            完成
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="preflight-panel" aria-labelledby={titleId}>
      <header className="preflight-header">
        <div>
          <h2 id={titleId}>确认迁移 {selected.length} 个种子</h2>
          <p className="preflight-identity">
            共 {formatBytes(totalBytes)}，上传完成后才会释放本地空间。
          </p>
        </div>
        <button type="button" className="inventory-inspect" onClick={onClose} aria-label="关闭">
          <X size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </header>

      <p className="inline-message" role="note">
        <ShieldAlert size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
        每个任务会暂停对应种子、加密上传到云端， 并在解密回读校验通过后才删除本地文件。
      </p>

      <ul className="offload-selection">
        {selected.slice(0, 8).map((torrent) => (
          <li key={`${torrent.instanceId}:${torrent.hash}`}>
            <span className="offload-selection-name">{torrent.name}</span>
            <span className="offload-selection-size">{formatBytes(torrent.totalSize)}</span>
          </li>
        ))}
        {selected.length > 8 ? <li>……另有 {selected.length - 8} 项</li> : null}
      </ul>

      <form
        className="instance-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          mutation.mutate();
        }}
      >
        <label className="instance-form-checkbox">
          <input
            type="checkbox"
            aria-label="标记为重要，额外保存第二份云端副本"
            checked={important}
            onChange={(event) => setImportant(event.target.checked)}
          />
          <span>标记为重要：额外保存第二份云端副本</span>
        </label>
        <p className="field-hint">
          第二份副本会在主副本校验通过后由独立任务补传，<strong>不会延长本次迁移</strong>。
          它防的是「云端账户丢了、备份也跟着没了」；本地文件的删除条件与它无关。
        </p>

        <label className="field" htmlFor={codeId}>
          <span>两步验证码</span>
          <input
            id={codeId}
            type="text"
            value={mfaCode}
            onChange={(event) => setMfaCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
          />
          <small className="field-hint">
            一个验证码只能发起一批，用过即失效；活跃会话本身不足以启动迁移。
          </small>
        </label>

        {mutation.isError ? (
          <p className="inline-message error-message" role="alert">
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
            {errorMessage(mutation.error)}
          </p>
        ) : null}

        <div className="instance-form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-action" disabled={!canSubmit}>
            {mutation.isPending ? '正在发起……' : `迁移 ${selected.length} 项`}
          </button>
        </div>
      </form>
    </section>
  );
}
