import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RotateCcw, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import type { OffloadAvailableAction, OffloadSnapshot } from '@ptvault/contracts';

import { ApiError, newIdempotencyKey } from '../../api/client.js';
import { sessionQueryKey, getSession } from '../auth/authApi.js';
import { cancelOffload, cleanupOffload, retryOffload } from '../torrents/qbApi.js';
import {
  offloadSchedulerQueryKey,
  offloadsQueryKey,
  pauseOffload,
  resumeOffload,
} from './jobApi.js';

/**
 * Job states an operator may act on, for an API build that does not send
 * `availableActions`.
 *
 * Only a fallback. When the server computes the action list, that list wins
 * outright — it is derived from durable pause state *and* the global scheduler
 * gate, neither of which is visible in `jobState`, so any local re-derivation
 * would offer buttons the server refuses.
 *
 * `QUEUED` is deliberately excluded alongside `RUNNING`: a worker can claim a
 * queued job at any moment, so acting on it would race that worker and the UI
 * would have promised something it cannot guarantee. Mirrors the server's own
 * `STOPPED_JOB_STATES`.
 */
const ACTIONABLE_STATES = new Set(['FAILED_SAFE', 'BLOCKED', 'RETRY_WAIT']);

/** The step a stalled transfer reached, in the operator's words. */
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
    if (error.status === 400) return '这次请求缺少幂等键，服务器已拒绝；请重试。';
    if (error.status === 401) return '会话已过期，请重新登录。';
    if (error.status === 403) return '验证码不正确或已被使用，请用当前的新码重试。';
    if (error.status === 404) return '这个任务已经不存在了，刷新后重试。';
    if (error.status === 409) return '任务状态已变化，刷新后再看它现在停在哪一步。';
    if (error.status === 503) return '无法确认 Jellyfin 当前是否在播放，本次未删除任何文件。';
    return error.message;
  }
  return '操作失败。';
}

/**
 * What the server's action list allows, or the legacy derivation when it sent none.
 *
 * Absent is not the same as empty: `[]` means the server computed the list and
 * there is nothing to offer, while `undefined` means this API build predates the
 * field. Drawing the first as the second would hide the buttons on a paused
 * transfer; drawing the second as the first would offer none at all on an older
 * server that still accepts retry and cancel.
 */
export function allowedActions(snapshot: OffloadSnapshot): Set<OffloadAvailableAction> {
  if (snapshot.availableActions !== undefined) return new Set(snapshot.availableActions);
  if (snapshot.cancelledAt !== null || snapshot.currentStep === 'COMPLETED') return new Set();
  if (snapshot.currentStep === 'CLOUD_COMMITTED')
    return new Set<OffloadAvailableAction>(['CLEANUP']);
  if (snapshot.currentStep === 'LOCAL_CLEANUP') return new Set<OffloadAvailableAction>(['CLEANUP']);
  if (ACTIONABLE_STATES.has(snapshot.jobState)) {
    return new Set<OffloadAvailableAction>(['RETRY', 'CANCEL']);
  }
  return new Set();
}

/**
 * How far a pause request has got, said in a sentence rather than as a state name.
 *
 * `STALLED` is the one this exists for. It means the fixed acknowledgement
 * deadline passed with the handler still unwinding, so the job is *still running*
 * — rclone may still be moving bytes. Every earlier draft of this panel wrote
 * "已暂停" for it, which is the one sentence that must never appear here: an
 * operator who reads it concludes the uploads have stopped and goes on to delete
 * something.
 */
function PauseStateNote({ snapshot }: { snapshot: OffloadSnapshot }) {
  const state = snapshot.pauseAcknowledgementState;
  if (state === undefined || state === 'NOT_REQUESTED') return null;

  if (state === 'PENDING') {
    const deadline = snapshot.pauseAcknowledgementDeadlineAt;
    return (
      <p className="inline-message" role="status">
        <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className="note-text">
          已提交暂停请求，处理器还在收尾——<strong>现在还没有停</strong>，字节可能仍在上传。
          {deadline === undefined
            ? ''
            : `确认截止时间 ${new Date(deadline).toLocaleTimeString()}，重复点击不会延长它。`}
        </span>
      </p>
    );
  }

  if (state === 'STALLED') {
    return (
      <p className="inline-message error-message" role="alert">
        <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className="note-text">
          暂停请求已过确认窗口仍未被确认。这个任务<strong>仍在运行</strong>
          ，不能当成已暂停；此刻只有「取消」是安全的操作。
        </span>
      </p>
    );
  }

  return (
    <p className="offload-conflict-note" role="note">
      <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
      <span className="note-text">
        已暂停：处理器与子进程都已停止
        {snapshot.pausedAt === undefined || snapshot.pausedAt === null
          ? ''
          : `（${new Date(snapshot.pausedAt).toLocaleString()}）`}
        。本地字节全部保留。
      </span>
    </p>
  );
}

/**
 * What is durably known about the torrent in qB — three states, never a boolean.
 *
 * `UNKNOWN` and `CONFIRMING` are honest absences and are written as such. Drawn
 * as "qB 正在做种" they would send an operator looking for a problem that does not
 * exist; drawn as "已暂停" they would claim evidence that has not been recorded.
 * A `CONFIRMED_PAUSED` with no timestamp is normal on a transfer that reached a
 * later step before v20 evidence existed, and is not downgraded for it.
 */
function QbPauseNote({ snapshot }: { snapshot: OffloadSnapshot }) {
  const state = snapshot.qbPauseState;
  if (state === undefined) return null;

  if (state === 'CONFIRMED_PAUSED') {
    return (
      <p className="field-hint">
        qB 种子已确认暂停
        {snapshot.qbPauseConfirmedAt === undefined
          ? '（本条记录没有精确时间戳，属于正常情况）'
          : `（${new Date(snapshot.qbPauseConfirmedAt).toLocaleString()}）`}
        。{snapshot.qbTorrentAutoResume === false ? '暂停或继续传输都不会自动恢复做种。' : ''}
      </p>
    );
  }

  return (
    <p className="field-hint">
      {state === 'CONFIRMING' ? '正在确认 qB 种子是否已暂停' : 'qB 种子的暂停状态未知'}
      ——<strong>这不等于种子在做种</strong>，只是还没有持久化证据。
    </p>
  );
}

/** The two facts an operator has to have before pressing 继续. */
function ResumeCaveats({ snapshot }: { snapshot: OffloadSnapshot }) {
  return (
    <>
      <p className="offload-conflict-note">
        <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className="note-text">
          继续的粒度是<strong>文件级</strong>
          ：没有保存云端分片上传的偏移，所以正在传的那个文件会从头重传；已完成的文件不会重来。
        </span>
      </p>
      {snapshot.qbTorrentAutoResume === false ? (
        <p className="field-hint">继续传输不会恢复 qB 里的种子，需要你自己在 qB 中恢复做种。</p>
      ) : null}
    </>
  );
}

/**
 * Continue or abandon a transfer that stopped, and pause one that has not.
 *
 * Exists because a stopped transfer previously had no exit at all: the
 * active-identity index kept holding its torrent, so the trigger answered
 * "already migrating" forever and that torrent could never be migrated again.
 *
 * No action here deletes local files. That is stated on screen rather than left
 * to be inferred, because the question an operator actually has in front of a
 * failed migration is "are my files still there".
 */
export function TransferActions({
  snapshot,
  onResolved,
}: {
  snapshot: OffloadSnapshot;
  onResolved: () => void;
}) {
  const codeId = useId();
  const queryClient = useQueryClient();
  const [mfaCode, setMfaCode] = useState('');
  const [cleanupWarning, setCleanupWarning] = useState<string | null>(null);

  /*
   * One idempotency key per *intent*, reused across retries.
   *
   * The server replays the receipt it recorded for a key it has already seen,
   * which is exactly what makes pressing 「暂停」 again after a dropped connection
   * safe. Minting a key inside the request would defeat that: every attempt would
   * carry a fresh one and book a second control request. Cleared on success so
   * the next deliberate press is a new intent rather than a replay of the last.
   */
  const controlKeys = useRef(new Map<string, string>());
  const keyFor = (intent: string): string => {
    const existing = controlKeys.current.get(intent);
    if (existing !== undefined) return existing;
    const minted = newIdempotencyKey();
    controlKeys.current.set(intent, minted);
    return minted;
  };

  // Read from cache; `ProtectedRoute` has already revalidated it by the time any
  // child renders, and refetching on mount here would unmount this page.
  const session = useQuery({
    queryKey: sessionQueryKey,
    queryFn: getSession,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: offloadsQueryKey });
    await queryClient.invalidateQueries({ queryKey: ['qb', 'torrents'] });
  };

  /*
   * Retry carries no idempotency key; cancel does.
   *
   * They look symmetrical on screen but are not on the wire: cancel books a
   * bounded durable receipt and replays it before spending another single-use
   * TOTP code, while retry is a plain recovery action the server registers
   * without a receipt. Passing a key to retry would imply a replay guarantee
   * that does not exist.
   *
   * Cancel's key is cleared only on success. A failed attempt keeps it
   * deliberately: a 403 for a mistyped code must be retryable under the same
   * booking, and because the route replays before it consumes the code, reusing
   * the key is what stops the second attempt spending a second code.
   */
  const retry = useMutation({
    mutationFn: () => retryOffload({ jobId: snapshot.jobId, mfaCode }),
    onSuccess: async () => {
      setMfaCode('');
      await invalidate();
      onResolved();
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      cancelOffload({ jobId: snapshot.jobId, mfaCode, idempotencyKey: keyFor('CANCEL') }),
    onSuccess: async () => {
      controlKeys.current.delete('CANCEL');
      setMfaCode('');
      await invalidate();
      onResolved();
    },
  });
  /*
   * Pause takes no MFA code and does not close the panel.
   *
   * No code because pausing destroys nothing and starts nothing — it is the safe
   * direction, and demanding a fresh TOTP to stop a runaway upload would mean
   * watching it run for the rest of the window. The panel stays open because a
   * 202 is not the end of the story: the operator has to see whether the handler
   * actually acknowledged, and the scheduler answer moves with it.
   */
  const pause = useMutation({
    mutationFn: () => pauseOffload({ jobId: snapshot.jobId, idempotencyKey: keyFor('PAUSE') }),
    onSuccess: async () => {
      controlKeys.current.delete('PAUSE');
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: offloadSchedulerQueryKey });
    },
  });
  const resume = useMutation({
    mutationFn: () =>
      resumeOffload({ jobId: snapshot.jobId, mfaCode, idempotencyKey: keyFor('RESUME') }),
    onSuccess: async () => {
      controlKeys.current.delete('RESUME');
      setMfaCode('');
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: offloadSchedulerQueryKey });
    },
  });
  const cleanup = useMutation({
    mutationFn: () => cleanupOffload({ jobId: snapshot.jobId, mfaCode }),
    onSuccess: async (result) => {
      setMfaCode('');
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: ['media'] });
      if (result.followUpPending) {
        setCleanupWarning(
          result.localDeleted
            ? '本地文件已经删除，但云端标签或媒体目录刷新尚未完成。请用新的验证码再次执行收尾。'
            : '本地清理已经开始，部分文件可能已删除。请不要把源目录视为完整，并用新的验证码继续收尾。',
        );
      } else {
        setCleanupWarning(null);
        onResolved();
      }
    },
  });

  // SHADOW registers neither route, so offering the buttons would offer a 404.
  if (session.data?.mode !== 'ACTIVE') return null;

  const actions = allowedActions(snapshot);
  const status = (
    <>
      <PauseStateNote snapshot={snapshot} />
      <QbPauseNote snapshot={snapshot} />
    </>
  );

  if (actions.has('CLEANUP')) {
    const busy = cleanup.isPending;
    const canClean = /^[0-9]{6}$/.test(mfaCode) && !busy;
    const resuming = snapshot.currentStep === 'LOCAL_CLEANUP';
    return (
      <section className="offload-conflict" aria-labelledby={`${codeId}-cleanup-title`}>
        <h3 id={`${codeId}-cleanup-title`}>{resuming ? '继续本地清理收尾' : '单独批准本地清理'}</h3>
        {status}
        <p className="offload-conflict-note">
          <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="note-text">
            {resuming
              ? '上次清理已开始，系统会跳过已记录删除的文件，并重新完成剩余文件与媒体目录收尾。'
              : '云端主副本已完成解密回读校验，本地文件仍在。清理会再次核对恢复材料版本、逐文件 PRIMARY 证据、文件身份、外部硬链接与活动播放。'}
          </span>
        </p>
        {/*
          The deletion gate, written out where the deletion button is. 「已验证」 on
          this page means the staged object and the committed PRIMARY copy were
          both read back decrypted and matched by SHA-256; local originals stay on
          disk until both have. Stating it beside the button is the difference
          between an operator who knows what the evidence covers and one who
          assumes an upload is a backup.
        */}
        <p className="field-hint">
          只有云端 staging 与 committed 两次解密回读的 SHA-256 都与本地原件一致，
          这个按钮才会真正删除本地唯一副本；任一条证据缺失，清理都会拒绝执行。
        </p>
        <label className="field" htmlFor={codeId}>
          <span>两步验证码</span>
          <input
            id={codeId}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={mfaCode}
            onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            disabled={busy}
          />
        </label>
        <button
          type="button"
          className="danger-button"
          disabled={!canClean}
          onClick={() => cleanup.mutate()}
        >
          <Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
          {busy ? '正在复核并清理…' : resuming ? '继续清理并完成收尾' : '复核后删除本地文件'}
        </button>
        {cleanupWarning ? (
          <p className="inline-message" role="status">
            <TriangleAlert size={15} strokeWidth={1.8} aria-hidden="true" />
            <span className="note-text">{cleanupWarning}</span>
          </p>
        ) : null}
        {cleanup.error ? (
          <p className="form-error" role="alert">
            <TriangleAlert size={15} strokeWidth={1.8} aria-hidden="true" />
            <span className="note-text">{errorMessage(cleanup.error)}</span>
          </p>
        ) : null}
      </section>
    );
  }

  if (snapshot.currentStep === 'COMPLETED') {
    return (
      <p className="offload-conflict-note" role="note">
        <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className="note-text">本地文件已安全清理，云端副本仍由解密回读证据保护。</span>
      </p>
    );
  }

  if (snapshot.cancelledAt !== null) {
    return (
      <p className="offload-conflict-note" role="note">
        这个任务已取消，本地文件未受影响。该种子现在可以重新发起迁移。
      </p>
    );
  }

  /*
   * Pause on its own, without the MFA form.
   *
   * Its own branch rather than another button in the retry/cancel row because the
   * two have different authority: this one needs no code, and putting it beside
   * inputs the operator must fill in would suggest it does. When the server also
   * offers CANCEL — a requested-but-unacknowledged pause, where cancel is the only
   * safe action — the coded form below is rendered too.
   */
  if (actions.has('PAUSE')) {
    return (
      <section className="offload-conflict" aria-labelledby={`${codeId}-pause-title`}>
        <h3 id={`${codeId}-pause-title`}>暂停这个传输</h3>
        {status}
        <p className="offload-conflict-note">
          <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="note-text">
            暂停只是让它停在当前位置：<strong>不删除任何本地文件</strong>
            ，也不放弃已经上传或已经验证的字节。不需要验证码。
          </span>
        </p>
        <ResumeCaveats snapshot={snapshot} />
        <div className="instance-form-actions">
          <button
            type="button"
            className="primary-action"
            onClick={() => pause.mutate()}
            disabled={pause.isPending}
          >
            <Pause size={14} strokeWidth={1.9} aria-hidden="true" />
            {pause.isPending ? '正在提交暂停请求……' : '暂停传输'}
          </button>
        </div>
        {pause.error ? (
          <p className="inline-message error-message" role="alert">
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="note-text">{errorMessage(pause.error)}</span>
          </p>
        ) : null}
      </section>
    );
  }

  const canRetry = actions.has('RETRY');
  const canResume = actions.has('RESUME');
  const canCancel = actions.has('CANCEL');

  if (!canRetry && !canResume && !canCancel) {
    /*
     * An empty list is the server's answer, not a gap to be filled in locally.
     *
     * It has more than one cause and the snapshot does not say which: a running
     * job cannot be paused individually while the global scheduler is itself
     * paused, and a job a worker still holds cannot be acted on at all. Both are
     * stated as the reasons they are, without claiming which one applies — the
     * scheduler panel is where that question is answered.
     */
    const active =
      snapshot.jobState === 'RUNNING' ||
      snapshot.jobState === 'QUEUED' ||
      snapshot.jobState === 'RETRY_WAIT';
    return (
      <>
        {status}
        <p className="offload-conflict-note" role="note">
          {active
            ? '任务正在运行，运行中不可操作：服务器没有为它提供任何可执行操作。运行中的任务由 worker 持有，而全局调度本身处于暂停时也不能再单独暂停它。等它停下来、或解除全局暂停后，这里会出现相应按钮。'
            : '服务器当前没有为这一步提供可执行操作。'}
        </p>
      </>
    );
  }

  const busy = retry.isPending || cancel.isPending || resume.isPending;
  const canAct = /^[0-9]{6}$/.test(mfaCode) && !busy;
  const failure = retry.error ?? cancel.error ?? resume.error;

  return (
    <section className="offload-conflict" aria-labelledby={`${codeId}-title`}>
      <h3 id={`${codeId}-title`}>{canResume ? '继续这个已暂停的任务' : '处理这个已停止的任务'}</h3>
      {status}
      <p className="offload-conflict-note">
        它停在「{STEP_LABELS[snapshot.currentStep] ?? snapshot.currentStep}
        」。{canResume || canRetry ? '可以让它从这一步继续，或' : '可以'}
        取消它把种子腾出来。
        <strong>两者都不会删除本地文件。</strong>
      </p>
      {canResume ? <ResumeCaveats snapshot={snapshot} /> : null}
      <label className="field" htmlFor={codeId}>
        <span>两步验证码</span>
        <input
          id={codeId}
          aria-label="两步验证码"
          type="text"
          value={mfaCode}
          onChange={(event) => setMfaCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
        />
        <small className="field-hint">一个验证码只能用一次；活跃会话本身不足以改动传输任务。</small>
      </label>
      {failure ? (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="note-text">{errorMessage(failure)}</span>
        </p>
      ) : null}
      <div className="instance-form-actions">
        {canCancel ? (
          <button type="button" onClick={() => cancel.mutate()} disabled={!canAct}>
            <X size={14} strokeWidth={1.9} aria-hidden="true" />
            {cancel.isPending ? '正在取消……' : '取消任务'}
          </button>
        ) : null}
        {/*
          Retry and resume are primary: the snapshot may already hold the exported
          .torrent and per-file hashes, so continuing skips work that cancelling
          discards. They are never both offered — the server's list distinguishes a
          transfer that failed from one an operator paused.
        */}
        {canResume ? (
          <button
            type="button"
            className="primary-action"
            onClick={() => resume.mutate()}
            disabled={!canAct}
          >
            <Play size={14} strokeWidth={1.9} aria-hidden="true" />
            {resume.isPending ? '正在继续……' : '继续任务'}
          </button>
        ) : null}
        {canRetry ? (
          <button
            type="button"
            className="primary-action"
            onClick={() => retry.mutate()}
            disabled={!canAct}
          >
            <RotateCcw size={14} strokeWidth={1.9} aria-hidden="true" />
            {retry.isPending ? '正在重试……' : '继续任务'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
