import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDashed, PauseCircle, PlayCircle, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import type { OffloadDeploymentBlocker, OffloadSchedulerStatus } from '@ptvault/contracts';

import { ApiError, newIdempotencyKey } from '../../api/client.js';
import { getSession, sessionQueryKey } from '../auth/authApi.js';
import {
  getOffloadScheduler,
  offloadSchedulerQueryKey,
  offloadsQueryKey,
  pauseAllOffloads,
  resumeAllOffloads,
} from './jobApi.js';

/** The scheduler's own state, in the operator's words. */
const SCHEDULER_LABELS: Record<OffloadSchedulerStatus['schedulerState'], string> = {
  RUNNING: '正常调度中',
  PAUSING: '正在暂停（仍有处理器在收尾）',
  PAUSED: '已暂停调度',
};

/**
 * Why the database is not drained — one sentence per class of active work.
 *
 * Named individually rather than summarised as a count because the answer to each
 * is different: an OFFLOAD still running is waited out, an import still running is
 * a separate feature nobody paused, and a worker handler outside both is the case
 * that a pause-all does not cover at all.
 */
const BLOCKER_LABELS: Record<OffloadDeploymentBlocker, string> = {
  OFFLOAD_SCHEDULER_NOT_PAUSED: '迁移调度尚未暂停',
  OFFLOAD_JOBS_ACTIVE: '仍有迁移任务处于 RUNNING / QUEUED / RETRY_WAIT',
  OFFLOAD_HANDLERS_ACTIVE: '仍有迁移处理器在进程内运行',
  NON_OFFLOAD_JOBS_ACTIVE: '仍有非迁移任务在数据库里活动',
  IMPORTS_ACTIVE: '仍有网盘导入任务在活动（暂停全部迁移不会停下它们）',
  WORKER_HANDLERS_ACTIVE: '进程内 Worker 仍持有处理器',
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return '这次请求缺少幂等键，服务器已拒绝；请重试。';
    if (error.status === 401) return '会话已过期，请重新登录。';
    if (error.status === 403) return '验证码不正确或已被使用，请用当前的新码重试。';
    if (error.status === 409) return '调度状态已变化，刷新后再看它现在的状态。';
    return error.message;
  }
  return '操作失败。';
}

/** One labelled count. */
function Count({ label, value }: { label: string; value: number | undefined }) {
  if (value === undefined) return null;
  return (
    <div className="scheduler-count">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The three-layer drain readout, and the reason it is three and not one boolean.
 *
 * `offloadDrained` covers this feature's own work. `databaseDrained` adds every
 * other durable job and import. Neither is a deployment verdict, and
 * `deploymentReadiness` deliberately has no value meaning "deployable": an rclone
 * process holding a transfer open is invisible to this database, so the last check
 * is an OS-level one (`data-rclone=0`) that no page can perform. This component
 * therefore never renders a green light — its best state is "database drained,
 * still needs the rclone check on the host".
 */
export function DrainReadout({ status }: { status: OffloadSchedulerStatus }) {
  return (
    <div className="scheduler-drain">
      <ul className="scheduler-layers">
        <li data-drained={status.offloadDrained}>
          {status.offloadDrained ? (
            <ShieldCheck size={14} strokeWidth={1.9} aria-hidden="true" />
          ) : (
            <CircleDashed size={14} strokeWidth={1.9} aria-hidden="true" />
          )}
          第一层 · 迁移已排空：{status.offloadDrained ? '是' : '否'}
        </li>
        <li data-drained={status.databaseDrained}>
          {status.databaseDrained ? (
            <ShieldCheck size={14} strokeWidth={1.9} aria-hidden="true" />
          ) : (
            <CircleDashed size={14} strokeWidth={1.9} aria-hidden="true" />
          )}
          第二层 · 整库已排空：{status.databaseDrained ? '是' : '否'}
        </li>
        {/*
          The third layer is never drawn as satisfied, because this process cannot
          observe it. `DB_DRAINED_RCLONE_CHECK_REQUIRED` is the *best* value the
          contract can carry and it still means "not cleared" — drawing it as a
          pass is the single most dangerous thing this panel could do, since a
          restart during an open rclone transfer is what loses a staged upload.
        */}
        <li data-drained={false}>
          <CircleDashed size={14} strokeWidth={1.9} aria-hidden="true" />
          第三层 · 外部 rclone 检查：本页无法确认，必须在宿主机上人工确认 <code>data-rclone=0</code>
        </li>
      </ul>

      <p className="scheduler-readiness" role="note">
        <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className="note-text">
          {status.deploymentReadiness === 'NOT_DRAINED'
            ? '当前状态：尚未排空，不可重启。'
            : '当前状态：数据库已排空，但仍需外部 rclone 检查——这不等于可以部署。'}{' '}
          <strong>这一栏没有任何取值表示「可以部署」。</strong>
        </span>
      </p>

      {status.deploymentBlockers.length > 0 ? (
        <>
          <p className="field-hint">仍在阻止重启的原因：</p>
          <ul className="scheduler-blockers">
            {status.deploymentBlockers.map((blocker) => (
              <li key={blocker}>{BLOCKER_LABELS[blocker] ?? blocker}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/**
 * The global pause switch and the drain picture a restart is judged against.
 *
 * Reads `GET /api/offloads/scheduler` rather than deriving anything from the
 * transfer list: the scheduler gate is durable state of its own, and the counts it
 * reports include work this page never lists (imports, non-offload jobs, in-process
 * handlers). Refetched when a `scheduler.updated` frame arrives — the frame carries
 * a revision, not the picture.
 */
export function TransferSchedulerPanel() {
  const codeId = useId();
  const queryClient = useQueryClient();
  const [mfaCode, setMfaCode] = useState('');

  // One key per intent, reused across retries so a lost answer can be re-sent
  // without booking a second control request. Cleared once the server has
  // answered, so the next deliberate press is a new intent.
  const controlKeys = useRef(new Map<string, string>());
  const keyFor = (intent: string): string => {
    const existing = controlKeys.current.get(intent);
    if (existing !== undefined) return existing;
    const minted = newIdempotencyKey();
    controlKeys.current.set(intent, minted);
    return minted;
  };

  const session = useQuery({
    queryKey: sessionQueryKey,
    queryFn: getSession,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
  });

  /*
   * Not requested at all outside ACTIVE.
   *
   * `registerOffloadRoutes` is only called when the offload executor exists, so in
   * SHADOW this route is not merely forbidden — it is absent, and asking for it
   * would put a 404 in the console of a deployment where nothing is wrong. The
   * demo answers unknown GETs with 403 for the same reason.
   */
  const active = session.data?.mode === 'ACTIVE';
  const scheduler = useQuery({
    queryKey: offloadSchedulerQueryKey,
    queryFn: getOffloadScheduler,
    enabled: active,
  });

  const afterControl = async (status: OffloadSchedulerStatus): Promise<void> => {
    // The mutation already answered with the fresh status; seeding it means the
    // panel updates without waiting for a second round trip, and the refetch
    // below still reconciles against the route's own `no-store` answer.
    queryClient.setQueryData(offloadSchedulerQueryKey, status);
    await queryClient.invalidateQueries({ queryKey: offloadSchedulerQueryKey });
    await queryClient.invalidateQueries({ queryKey: offloadsQueryKey });
  };

  const pauseAll = useMutation({
    mutationFn: () => pauseAllOffloads({ idempotencyKey: keyFor('PAUSE_ALL') }),
    onSuccess: async (status) => {
      controlKeys.current.delete('PAUSE_ALL');
      await afterControl(status);
    },
  });
  const resumeAll = useMutation({
    mutationFn: () => resumeAllOffloads({ mfaCode, idempotencyKey: keyFor('RESUME_ALL') }),
    onSuccess: async (status) => {
      controlKeys.current.delete('RESUME_ALL');
      setMfaCode('');
      await afterControl(status);
    },
  });

  // SHADOW registers no control route, and the GET is session-only. Rendering the
  // switch there would offer a 404 dressed as a control.
  if (!active) return null;
  if (scheduler.isPending) {
    return (
      <div className="route-status">
        <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
        正在读取迁移调度状态…
      </div>
    );
  }
  if (scheduler.isError || scheduler.data === undefined) {
    return (
      <div className="route-status route-status-error" role="alert">
        <TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
        {errorMessage(scheduler.error)}
        {/* Said explicitly: an unreadable scheduler is not a drained one. */}
        <span> 读不到调度状态时，不能据此判断已经排空。</span>
      </div>
    );
  }

  const status = scheduler.data;
  const paused = status.schedulerState !== 'RUNNING';
  const canResume = /^[0-9]{6}$/.test(mfaCode) && !resumeAll.isPending;
  const failure = pauseAll.error ?? resumeAll.error;

  return (
    <section className="scheduler-panel" aria-labelledby={`${codeId}-title`}>
      <header className="scheduler-panel-head">
        <h2 id={`${codeId}-title`}>迁移调度与排空状态</h2>
        <span className={`scheduler-state scheduler-state-${status.schedulerState.toLowerCase()}`}>
          {SCHEDULER_LABELS[status.schedulerState]}
        </span>
      </header>

      {/*
        `PAUSING` is written as its own state rather than folded into 「已暂停」: the
        gate is persisted, so no new OFFLOAD starts, but handlers already running
        are still unwinding and bytes may still be moving.
      */}
      {status.schedulerState === 'PAUSING' ? (
        <p className="inline-message" role="status">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="note-text">
            全局暂停已持久化，新任务不会再启动；但已在运行的处理器还在收尾，
            <strong>此刻不能视为已停止</strong>。
          </span>
        </p>
      ) : null}

      <dl className="scheduler-counts">
        <Count label="已请求暂停" value={status.requestedCount} />
        <Count label="运行中" value={status.runningCount} />
        <Count label="已暂停" value={status.pausedCount} />
        <Count label="超时未确认" value={status.stalledCount} />
        <Count label="排队中" value={status.queuedCount} />
        <Count label="迁移处理器" value={status.activeOffloadHandlers} />
        <Count label="全部处理器" value={status.activeWorkerHandlers} />
        <Count label="迁移任务" value={status.offloadJobs} />
        <Count label="非迁移任务" value={status.nonOffloadJobs} />
        <Count label="导入任务" value={status.imports} />
      </dl>

      {/*
        Stated where the counts are, because a non-zero 「超时未确认」 is the one
        figure on this panel that must not be read as progress toward a stop.
      */}
      {status.stalledCount !== undefined && status.stalledCount > 0 ? (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="note-text">
            有 {status.stalledCount} 个暂停请求超过确认窗口仍未被确认。这些任务
            <strong>仍在运行</strong>，不要按已暂停对待。
          </span>
        </p>
      ) : null}

      <DrainReadout status={status} />

      <p className="field-hint">
        继续的粒度是<strong>文件级</strong>：正在传输的那个文件会从头重传，已完成的文件不会。
        暂停或继续都不会自动恢复 qB 里的做种。
      </p>

      {failure ? (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {errorMessage(failure)}
        </p>
      ) : null}

      {paused ? (
        <>
          <label className="field" htmlFor={`${codeId}-code`}>
            <span>两步验证码</span>
            <input
              id={`${codeId}-code`}
              aria-label="两步验证码"
              type="text"
              value={mfaCode}
              onChange={(event) =>
                setMfaCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))
              }
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
            />
            <small className="field-hint">
              解除全局暂停会批量恢复上传，因此需要一个新的验证码。
            </small>
          </label>
          <div className="instance-form-actions">
            <button
              type="button"
              className="primary-action"
              onClick={() => resumeAll.mutate()}
              disabled={!canResume}
            >
              <PlayCircle size={15} strokeWidth={1.8} aria-hidden="true" />
              {resumeAll.isPending ? '正在恢复调度……' : '恢复全部迁移'}
            </button>
          </div>
        </>
      ) : (
        <div className="instance-form-actions">
          {/* No code: pausing everything destroys nothing and starts nothing. */}
          <button type="button" onClick={() => pauseAll.mutate()} disabled={pauseAll.isPending}>
            <PauseCircle size={15} strokeWidth={1.8} aria-hidden="true" />
            {pauseAll.isPending ? '正在暂停全部迁移……' : '暂停全部迁移'}
          </button>
        </div>
      )}
    </section>
  );
}
