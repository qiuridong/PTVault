import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleDashed,
  Cloud,
  CloudOff,
  HardDrive,
  Pin,
  RotateCcw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type {
  MediaAvailability,
  MediaCatalogEntry,
  MountHealth,
  RehydrateSnapshot,
} from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import { useServerEvents } from '../../api/useServerEvents.js';
import { PinDialog } from './PinDialog.js';
import { RehydrateDialog } from './RehydrateDialog.js';
import {
  getMediaCatalog,
  getMountHealth,
  getRehydrates,
  cancelRehydrate,
  mediaCatalogQueryKey,
  mediaHealthQueryKey,
  mediaRehydratesQueryKey,
  retryRehydrate,
} from './mediaApi.js';

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

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? '会话已过期，请重新登录以查看媒体库。' : error.message;
  }
  return '无法加载媒体库。';
}

const AVAILABILITY_LABELS: Record<MediaAvailability, string> = {
  LOCAL: '本地',
  CLOUD: '云端',
  BOTH: '本地 + 云端',
  // Deliberately not "缺失": the file is there, it just cannot be read right now.
  UNAVAILABLE: '暂不可播',
};

const REHYDRATE_STEP_LABELS: Record<string, string> = {
  RESERVING_SPACE: '预留空间',
  EVICTING_CACHE: '腾出缓存',
  DOWNLOADING_TEMP: '下载到临时目录',
  VERIFYING_LOCAL: '校验本地文件',
  INSTALLING_LOCAL: '移入原位置',
  QB_RECHECKING: 'qB 复检',
  QB_RESUMING: '恢复做种',
  COMPLETED: '已完成',
};

const RETRYABLE_REHYDRATE_STATES = new Set(['FAILED_SAFE', 'BLOCKED', 'RETRY_WAIT']);
const CANCELLABLE_REHYDRATE_STEPS = new Set([
  'RESERVING_SPACE',
  'EVICTING_CACHE',
  'DOWNLOADING_TEMP',
  'VERIFYING_LOCAL',
]);

/**
 * Separates the four failures the operator would otherwise conflate.
 *
 * "Cannot play" has very different causes with very different fixes, and a single
 * red banner would send them looking in the wrong place. Disk protection is not a
 * mount outage; a mount outage is not missing data.
 *
 * Per mount, because each storage account is mounted separately. One account being
 * down leaves every title on the others playing, and a page-wide banner would
 * announce an outage most of the library is not having.
 */
function diagnose(health: MountHealth): { tone: 'ok' | 'warn' | 'error'; message: string } {
  if (!health.mounted) {
    return { tone: 'error', message: '挂载离线：该账户的云端媒体暂时读不到，本地文件不受影响。' };
  }
  if (!health.rcReachable) {
    return { tone: 'warn', message: 'rclone 控制端口无响应：无法读取缓存状态或主动腾出缓存。' };
  }
  if (health.pressure === 'CRITICAL') {
    return {
      tone: 'error',
      message: '磁盘保护：剩余空间已触及 15% 保护线，新的回迁与预取暂停放行。',
    };
  }
  if (health.pressure === 'EVICTING') {
    return { tone: 'warn', message: '正在腾出缓存：接近保护线或缓存超过上限，播放不受影响。' };
  }
  return { tone: 'ok', message: '挂载正常，缓存在上限之内。' };
}

/**
 * The one line at the top of the page.
 *
 * Three states rather than two, because "部分离线" is the state this whole design
 * exists to make visible: with one mount per account, a dead account costs exactly
 * the titles it backs. Rendering that as "挂载离线" would tell the operator the
 * library is gone while most of it plays fine.
 */
function summarise(mounts: MountHealth[]): {
  tone: 'ok' | 'warn' | 'error';
  label: string;
  healthy: number;
} {
  const healthy = mounts.filter((mount) => mount.mounted).length;
  if (mounts.length === 0) return { tone: 'warn', label: '未注册云端账户', healthy };
  if (healthy === mounts.length) return { tone: 'ok', label: '挂载正常', healthy };
  if (healthy === 0) return { tone: 'error', label: '挂载全部离线', healthy };
  return { tone: 'warn', label: `部分挂载离线（${healthy}/${mounts.length} 正常）`, healthy };
}

/**
 * Figures that belong to the disk rather than to one mount.
 *
 * Cache usage sums because the mounts share one cache budget and one disk. Free
 * space does not sum — it is the same filesystem seen by every mount, so the
 * minimum is the honest read when rows were written at different moments; adding
 * them up would report several times the space that exists.
 */
function aggregate(mounts: MountHealth[]): {
  cacheBytes: number;
  cacheMaxBytes: number;
  diskFreeBytes: number;
  diskReserveBytes: number;
} | null {
  if (mounts.length === 0) return null;
  return {
    cacheBytes: mounts.reduce((total, mount) => total + mount.cacheBytes, 0),
    cacheMaxBytes: mounts.reduce((total, mount) => total + mount.cacheMaxBytes, 0),
    diskFreeBytes: Math.min(...mounts.map((mount) => mount.diskFreeBytes)),
    diskReserveBytes: Math.max(...mounts.map((mount) => mount.diskReserveBytes)),
  };
}

function rehydrateActionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '会话已过期，请重新登录。';
    if (error.status === 403) return '验证码不正确或已被使用，请用当前的新码重试。';
    if (error.status === 404) return '这个回迁任务已经不存在了，请刷新页面。';
    if (error.status === 409) return '回迁状态已变化，请刷新页面后再操作。';
    return error.message;
  }
  return '回迁操作失败。';
}

function RehydrateActions({ snapshot }: { snapshot: RehydrateSnapshot }) {
  const codeId = `rehydrate-${snapshot.jobId}-mfa`;
  const queryClient = useQueryClient();
  const [mfaCode, setMfaCode] = useState('');

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: mediaRehydratesQueryKey }),
      queryClient.invalidateQueries({ queryKey: mediaCatalogQueryKey }),
      queryClient.invalidateQueries({ queryKey: ['qb', 'torrents'] }),
    ]);
  };

  const cancel = useMutation({
    mutationFn: () => cancelRehydrate({ jobId: snapshot.jobId, mfaCode }),
    onSuccess: async () => {
      setMfaCode('');
      await invalidate();
    },
  });
  const retry = useMutation({
    mutationFn: () => retryRehydrate({ jobId: snapshot.jobId, mfaCode }),
    onSuccess: async () => {
      setMfaCode('');
      await invalidate();
    },
  });

  const cancellationCleanupPending =
    snapshot.cancelledAt !== null && snapshot.jobState !== 'CANCELLED_SAFE';
  const canCancel =
    snapshot.installedAt === null &&
    snapshot.jobState !== 'CANCELLED_SAFE' &&
    CANCELLABLE_REHYDRATE_STEPS.has(snapshot.currentStep);
  const canRetry =
    snapshot.cancelledAt === null &&
    snapshot.currentStep !== 'COMPLETED' &&
    RETRYABLE_REHYDRATE_STATES.has(snapshot.jobState);
  if (!canCancel && !canRetry) return null;

  const busy = cancel.isPending || retry.isPending;
  const canAct = /^[0-9]{6}$/.test(mfaCode) && !busy;
  const failure = cancel.error ?? retry.error;

  return (
    <section className="offload-conflict" aria-labelledby={`${codeId}-title`}>
      <h3 id={`${codeId}-title`}>
        {cancellationCleanupPending ? '完成取消清理' : canRetry ? '处理已停止的回迁' : '取消回迁'}
      </h3>
      <label className="field" htmlFor={codeId}>
        <span>两步验证码</span>
        <input
          id={codeId}
          aria-label={`回迁任务 ${snapshot.torrentHash.slice(0, 12)} 的两步验证码`}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={mfaCode}
          onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          disabled={busy}
        />
      </label>
      {failure ? (
        <p className="form-error" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
          {rehydrateActionError(failure)}
        </p>
      ) : null}
      <div className="instance-form-actions">
        {canCancel ? (
          <button type="button" onClick={() => cancel.mutate()} disabled={!canAct}>
            <X size={14} strokeWidth={1.9} aria-hidden="true" />
            {cancel.isPending
              ? '正在取消……'
              : cancellationCleanupPending
                ? '重试取消清理'
                : '取消回迁'}
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
            {retry.isPending ? '正在重试……' : '继续回迁'}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function MediaPage() {
  const queryClient = useQueryClient();
  const live = useServerEvents();
  const [rehydrating, setRehydrating] = useState<MediaCatalogEntry | null>(null);
  const [pinning, setPinning] = useState<MediaCatalogEntry | null>(null);

  const healthQuery = useQuery({
    queryKey: mediaHealthQueryKey,
    queryFn: getMountHealth,
    refetchInterval: live === 'live' ? false : 15_000,
  });
  const catalogQuery = useQuery({ queryKey: mediaCatalogQueryKey, queryFn: getMediaCatalog });
  const rehydratesQuery = useQuery({
    queryKey: mediaRehydratesQueryKey,
    queryFn: getRehydrates,
    // Durable restore steps are not all SSE frames. Keep a small active-job poll
    // even on a connected stream; a missed completion must not freeze the page.
    refetchInterval: (query) =>
      query.state.data?.some(
        (snapshot) =>
          snapshot.currentStep !== 'COMPLETED' &&
          ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(snapshot.jobState),
      )
        ? 3_000
        : live === 'live'
          ? false
          : 10_000,
  });
  useEffect(() => {
    if (rehydratesQuery.data !== undefined) {
      void queryClient.invalidateQueries({ queryKey: mediaCatalogQueryKey });
    }
  }, [queryClient, rehydratesQuery.data]);

  const mounts = healthQuery.data;
  const summary = mounts ? summarise(mounts) : null;
  const totals = mounts ? aggregate(mounts) : null;
  // Only the mounts worth reading about. Listing every healthy one would bury the
  // one that is down; a page-wide banner would overstate it.
  const troubled = (mounts ?? []).filter(
    (mount) => !mount.mounted || !mount.rcReachable || mount.pressure !== 'NORMAL',
  );
  const active = (rehydratesQuery.data ?? []).filter(
    (snapshot) => snapshot.currentStep !== 'COMPLETED' && snapshot.jobState !== 'CANCELLED_SAFE',
  );

  return (
    <section className="content-page" aria-labelledby="media-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">媒体</p>
          <h1 id="media-title">播放与回迁</h1>
          <p className="page-lede">
            已经上云的片子在这里按需拉回本地。Jellyfin
            读的是同一批文件，本地有就走本地、没有就走云端挂载。
          </p>
        </div>
        {summary ? (
          <span
            className="connection-state"
            title={summary.tone === 'ok' ? '云端挂载可读' : '部分或全部云端挂载不可读'}
          >
            {summary.tone === 'ok' ? (
              <Cloud size={15} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <CloudOff size={15} strokeWidth={1.8} aria-hidden="true" />
            )}
            {summary.label}
          </span>
        ) : null}
      </header>

      {mounts !== undefined && mounts.length === 0 ? (
        <p className="inline-message" role="note">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
          尚未注册云端存储账户，云端播放还没有可读的挂载。
        </p>
      ) : null}

      {/*
        One message per troubled mount, each carrying its own severity role: an
        outage is announced (alert), while eviction and a dead control port are not
        (note) because playback continues. Folding them into one list would drop
        that distinction and read every degradation as an emergency.
      */}
      {troubled.map((mount) => {
        const diagnosis = diagnose(mount);
        return (
          <p
            key={mount.accountId}
            className={diagnosis.tone === 'error' ? 'error-message' : 'inline-message'}
            role={diagnosis.tone === 'error' ? 'alert' : 'note'}
          >
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
            <code>{mount.accountId.slice(0, 8)}</code> {diagnosis.message}
          </p>
        );
      })}

      {totals ? (
        <dl className="recovery-facts">
          <div>
            <dt>缓存占用</dt>
            <dd>
              {formatBytes(totals.cacheBytes)} / {formatBytes(totals.cacheMaxBytes)}
            </dd>
          </div>
          <div>
            <dt>磁盘剩余</dt>
            <dd>{formatBytes(totals.diskFreeBytes)}</dd>
          </div>
          <div>
            <dt>保护线</dt>
            <dd>{formatBytes(totals.diskReserveBytes)}</dd>
          </div>
        </dl>
      ) : null}

      {active.length > 0 ? (
        <ul className="offload-rejections" aria-label="进行中的回迁">
          {active.map((snapshot) => (
            <li key={snapshot.jobId}>
              <div className="offload-rejection-head">
                <code>{snapshot.torrentHash.slice(0, 12)}</code>{' '}
                {REHYDRATE_STEP_LABELS[snapshot.currentStep] ?? snapshot.currentStep}
                {snapshot.blockedMissingBytes !== null
                  ? `（还差 ${formatBytes(snapshot.blockedMissingBytes)}）`
                  : ''}
              </div>
              <RehydrateActions snapshot={snapshot} />
            </li>
          ))}
        </ul>
      ) : null}

      {rehydrating ? (
        <RehydrateDialog entry={rehydrating} onClose={() => setRehydrating(null)} />
      ) : null}
      {pinning ? <PinDialog entry={pinning} onClose={() => setPinning(null)} /> : null}

      {catalogQuery.isPending ? (
        <div className="route-status">
          <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
          正在加载媒体库…
        </div>
      ) : catalogQuery.isError ? (
        <div className="route-status route-status-error" role="alert">
          <TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
          {errorMessage(catalogQuery.error)}
        </div>
      ) : catalogQuery.data.length === 0 ? (
        <div className="route-status">尚无已迁移的媒体。迁移完成后会出现在这里。</div>
      ) : (
        <div className="inventory-table-wrap">
          <table className="inventory-table">
            <thead>
              <tr>
                <th scope="col">标题</th>
                <th scope="col">位置</th>
                <th scope="col">体积</th>
                <th scope="col">固定</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {catalogQuery.data.map((entry) => (
                <tr key={`${entry.instanceId}:${entry.torrentHash}`}>
                  <td>{entry.name}</td>
                  <td>
                    {entry.availability === 'LOCAL' || entry.availability === 'BOTH' ? (
                      <HardDrive size={14} strokeWidth={1.8} aria-hidden="true" />
                    ) : null}{' '}
                    {AVAILABILITY_LABELS[entry.availability]}
                  </td>
                  <td>{formatBytes(entry.totalBytes)}</td>
                  <td>
                    {/*
                      A control, not a readout. The pin is the only eviction decision
                      rclone's own LRU cleaner cannot make for itself, and the restore
                      dialog already tells the operator to unpin entries when the cache
                      disk is short — against a screen that offered no way to do it.
                    */}
                    <button
                      type="button"
                      className="inventory-inspect"
                      aria-label={`${entry.pinned ? '取消固定' : '固定'} ${entry.name}`}
                      onClick={() => setPinning(entry)}
                    >
                      {entry.pinned ? (
                        <>
                          <Pin size={14} strokeWidth={1.8} aria-hidden="true" /> 已固定
                        </>
                      ) : (
                        '固定'
                      )}
                    </button>
                  </td>
                  <td>
                    {/*
                      Offered only for titles with no local copy: a restore of something
                      already local would download bytes the operator already has.
                    */}
                    {entry.availability === 'CLOUD' ? (
                      <button
                        type="button"
                        className="inventory-inspect"
                        onClick={() => setRehydrating(entry)}
                      >
                        回迁
                      </button>
                    ) : entry.availability === 'UNAVAILABLE' ? (
                      <span title="挂载离线时无法回迁">挂载离线</span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
