import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  CircleCheck,
  CircleDashed,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  ListTodo,
  MemoryStick,
  Network,
  Radio,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import type { CachePressure, MountHealth } from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import { useServerEvents } from '../../api/useServerEvents.js';
import { ShaderBackground } from '../../showcase/ShaderBackground.js';
import { useReveal } from '../../showcase/useReveal.js';
import { DiskMeter } from '../../ui/DiskMeter.js';
import { formatBytes } from '../../ui/format.js';
import { getOffloads, offloadsQueryKey } from '../jobs/jobApi.js';
import {
  getDisks,
  getMountHealth,
  getRehydrates,
  mediaDisksQueryKey,
  mediaHealthQueryKey,
  mediaRehydratesQueryKey,
} from '../media/mediaApi.js';
import { getRecoveryStatus, recoveryStatusQueryKey } from '../recovery/recoveryApi.js';
import { getStorageAccounts, storageAccountsQueryKey } from '../storage/accountApi.js';
import { deriveAlerts, type AlertTone } from './dashboardAlerts.js';
import { Sparkline } from './Sparkline.js';
import { getSystemMetrics, systemMetricsQueryKey } from './systemApi.js';
import { deriveUploadAdvice, estimateSeconds } from './uploadAdvice.js';

type PanelTone = 'cyan' | 'green' | 'amber' | 'red';

const PRESSURE_LABELS: Record<CachePressure, string> = {
  NORMAL: '正常',
  EVICTING: '腾出中',
  CRITICAL: '触及保护线',
};

const ALERT_ICONS: Record<AlertTone, LucideIcon> = {
  error: TriangleAlert,
  warn: TriangleAlert,
  info: CircleDashed,
};

/** Rates read better per second than per interval, and always with the unit. */
function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? '—' : `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * A duration in the units an operator plans in.
 *
 * Rounded up, never down: a migration reported as finishing in "2 小时" that
 * actually takes 2 h 50 m is the kind of estimate that gets a laptop closed.
 */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${Math.ceil(seconds)} 秒`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.ceil(minutes)} 分钟`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.ceil(hours)} 小时`;
  return `${(hours / 24).toFixed(1)} 天`;
}

/** Why host telemetry is missing, in the operator's language. */
const HOST_UNAVAILABLE_LABELS: Record<string, string> = {
  ENOENT: '本机没有 /proc，主机指标只在 Linux 上可读',
  EACCES: '进程没有读 /proc 的权限',
  NOT_SAMPLED_YET: '正在采集第一份样本',
  SAMPLER_NOT_RUNNING: '该进程未启用主机采样',
};

function hostUnavailableLabel(reason: string | null): string {
  if (reason === null) return '主机指标不可用';
  return HOST_UNAVAILABLE_LABELS[reason] ?? `主机指标不可用（${reason}）`;
}

/** A labelled bar for a percentage that has its own meaning of "too high". */
function PercentMeter({
  label,
  percent,
  detail,
  breached,
}: {
  label: string;
  percent: number | null;
  detail: string;
  breached?: boolean;
}) {
  return (
    <div className="disk-meter">
      <div className="disk-meter-head">
        <span className="disk-meter-label">{label}</span>
        <span className="disk-meter-figure">
          {percent === null ? '—' : `${Math.round(percent)}%`}
        </span>
      </div>
      <div
        className={`meter-track${breached ? ' is-breached' : ''}`}
        role="img"
        aria-label={`${label}：${percent === null ? '暂无读数' : `${Math.round(percent)}%`}`}
      >
        <span className="meter-fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <p className="disk-meter-note">{detail}</p>
    </div>
  );
}

/**
 * One panel of the operations grid.
 *
 * `status` carries the verdict and `children` the evidence, so a panel can always
 * be read at a glance and still be checked. Tone is passed in rather than derived
 * here because it belongs to the reading, not to the layout. `span` is the width
 * in the twelve-column bento: a panel carrying a chart earns twice the room of
 * one carrying a three-line list.
 */
function Panel({
  title,
  icon: Icon,
  tone,
  status,
  span = 4,
  reveal = 0,
  children,
}: {
  title: string;
  icon: LucideIcon;
  tone: PanelTone;
  status: string;
  span?: 4 | 6 | 8 | 12;
  reveal?: number;
  children: React.ReactNode;
}) {
  const headingId = `panel-${title}`;
  const revealRef = useReveal<HTMLElement>(reveal);
  return (
    <article
      ref={revealRef}
      className={`operational-panel tone-${tone} panel-span-${span}`}
      aria-labelledby={headingId}
    >
      <div className="panel-heading">
        <span className="panel-icon" aria-hidden="true">
          <Icon size={19} strokeWidth={1.8} />
        </span>
        <h2 id={headingId}>{title}</h2>
      </div>
      <p className="panel-status">{status}</p>
      <div className="panel-detail">{children}</div>
    </article>
  );
}

function CacheRow({ mount }: { mount: MountHealth }) {
  const ceiling = Math.max(mount.cacheMaxBytes, 1);
  const percent = Math.min(100, (mount.cacheBytes / ceiling) * 100);
  return (
    <div className="cache-row">
      <div className="disk-meter-head">
        <span className="disk-meter-label">
          <code>{mount.accountId.slice(0, 8)}</code>
        </span>
        <span className="disk-meter-figure">
          {formatBytes(mount.cacheBytes)} / {formatBytes(mount.cacheMaxBytes)}
        </span>
      </div>
      <div
        className={`meter-track${mount.pressure === 'CRITICAL' ? ' is-breached' : ''}`}
        role="img"
        aria-label={`账户 ${mount.accountId.slice(0, 8)} 缓存 ${formatBytes(mount.cacheBytes)}，上限 ${formatBytes(mount.cacheMaxBytes)}`}
      >
        <span className="meter-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="disk-meter-note">
        {mount.mounted ? '已挂载' : '未挂载'} ·{' '}
        {mount.rcReachable ? `压力 ${PRESSURE_LABELS[mount.pressure]}` : '控制端口无响应'}
        {mount.lastError ? ` · ${mount.lastError}` : ''}
      </p>
    </div>
  );
}

export function DashboardPage() {
  const live = useServerEvents();
  const poll = (ms: number): number | false => (live === 'live' ? false : ms);

  const disksQuery = useQuery({
    queryKey: mediaDisksQueryKey,
    queryFn: getDisks,
    refetchInterval: poll(15_000),
  });
  const healthQuery = useQuery({
    queryKey: mediaHealthQueryKey,
    queryFn: getMountHealth,
    refetchInterval: poll(15_000),
  });
  const accountsQuery = useQuery({
    queryKey: storageAccountsQueryKey,
    queryFn: getStorageAccounts,
    refetchInterval: poll(30_000),
  });
  const offloadsQuery = useQuery({
    queryKey: offloadsQueryKey,
    queryFn: getOffloads,
    refetchInterval: poll(10_000),
  });
  const rehydratesQuery = useQuery({
    queryKey: mediaRehydratesQueryKey,
    queryFn: getRehydrates,
    refetchInterval: poll(10_000),
  });
  const recoveryQuery = useQuery({
    queryKey: recoveryStatusQueryKey,
    queryFn: getRecoveryStatus,
  });
  // Always polled, never event-driven: load and bandwidth change continuously,
  // and there is no event that means "the CPU is busier now". The interval
  // matches the sampler's, so the page asks about as often as there is
  // something new to hear.
  const systemQuery = useQuery({
    queryKey: systemMetricsQueryKey,
    queryFn: getSystemMetrics,
    refetchInterval: 10_000,
  });

  const queries = [
    disksQuery,
    healthQuery,
    accountsQuery,
    offloadsQuery,
    rehydratesQuery,
    recoveryQuery,
    systemQuery,
  ];
  // One banner, not six. Every panel fails the same way when the session lapses,
  // and six copies of the same sentence would bury the one thing to do about it.
  const sessionExpired = queries.some(
    (query) => query.error instanceof ApiError && query.error.status === 401,
  );

  const disks = disksQuery.data;
  const mounts = healthQuery.data;
  const accounts = accountsQuery.data;
  const offloads = offloadsQuery.data;
  const rehydrates = rehydratesQuery.data;

  const alerts = deriveAlerts({
    disks,
    mounts: mounts ?? [],
    accounts: accounts ?? [],
    offloads: offloads ?? [],
    rehydrates: rehydrates ?? [],
    recoveryUnlocked: recoveryQuery.data?.deletionUnlocked,
    now: Date.now(),
  });

  // "Everything is fine" is a claim about data we have. Until every reading that
  // feeds the rules has arrived, the honest report is that we are still looking —
  // an empty alert list from an empty page is not a clean bill of health.
  const alertsComplete = [disks, mounts, accounts, offloads, rehydrates, recoveryQuery.data].every(
    (value) => value !== undefined,
  );

  const savings = disks?.savings;
  // Deliberately not added together. `CLOUD` bytes came back; `CLOUD_COMMITTED`
  // bytes are still occupying the disk pending approval to delete them. One number
  // covering both would report space as reclaimed while it is still in use.
  const singleDisk = disks !== undefined && disks.hot.path === disks.cache.path;

  const activeOffloads = (offloads ?? []).filter(
    (job) =>
      job.cancelledAt === null &&
      job.jobState !== 'COMPLETED' &&
      job.jobState !== 'CANCELLED_SAFE' &&
      job.jobState !== 'FAILED_SAFE' &&
      job.jobState !== 'BLOCKED',
  );
  const stoppedOffloads = (offloads ?? []).filter(
    (job) =>
      job.cancelledAt === null && (job.jobState === 'FAILED_SAFE' || job.jobState === 'BLOCKED'),
  );
  const awaitingCleanup = (offloads ?? []).filter(
    (job) =>
      job.currentStep === 'CLOUD_COMMITTED' &&
      job.cleanupCompletedAt === null &&
      job.cancelledAt === null,
  );
  const activeRehydrates = (rehydrates ?? []).filter(
    (job) =>
      job.cancelledAt === null && job.currentStep !== 'COMPLETED' && job.jobState !== 'FAILED_SAFE',
  );
  const stoppedRehydrates = (rehydrates ?? []).filter(
    (job) =>
      job.cancelledAt === null && (job.jobState === 'FAILED_SAFE' || job.jobState === 'BLOCKED'),
  );

  const healthyAccounts = (accounts ?? []).filter((account) => account.health === 'HEALTHY').length;
  const mountedCount = (mounts ?? []).filter((mount) => mount.mounted).length;
  const worstPressure: CachePressure = (mounts ?? []).some((m) => m.pressure === 'CRITICAL')
    ? 'CRITICAL'
    : (mounts ?? []).some((m) => m.pressure === 'EVICTING')
      ? 'EVICTING'
      : 'NORMAL';

  const diskBreached =
    disks !== undefined &&
    (disks.hot.freeBytes <= disks.hot.reserveBytes ||
      disks.cache.freeBytes <= disks.cache.reserveBytes);

  const system = systemQuery.data;
  const hostReadable = system !== undefined && system.source === 'PROC';
  const uplink = system?.interfaces.find((entry) => entry.isDefaultRoute);
  const advice = deriveUploadAdvice({
    throughput: system?.throughput,
    accounts,
    interfaces: system?.interfaces,
  });
  const history = system?.history ?? [];
  // Load is only readable against the core count: 4.0 on four cores is a
  // saturated run queue, on sixteen it is a quarter busy.
  const loadRatio =
    system?.cpu === null || system?.cpu === undefined ? null : system.cpu.load1 / system.cpu.cores;
  const memoryUsedPercent =
    system?.memory == null
      ? null
      : ((system.memory.totalBytes - system.memory.availableBytes) / system.memory.totalBytes) *
        100;

  return (
    <section className="content-page" aria-labelledby="dashboard-title">
      <div className="dashboard-hero">
        <ShaderBackground className="dashboard-hero-canvas" />
        <header className="page-header dashboard-hero-header">
          <div>
            <p className="page-kicker">运维</p>
            <h1 id="dashboard-title">仪表盘</h1>
            {savings ? (
              <p className="dashboard-savings">
                已上云 <strong>{savings.cloudCount}</strong> 个种子 ·{' '}
                <strong>{formatBytes(savings.cloudBytes)}</strong> 本地空间已释放
                {savings.awaitingCount > 0 ? (
                  <>
                    ；另有 <strong>{savings.awaitingCount}</strong> 个（
                    {formatBytes(savings.awaitingBytes)}
                    ）已在云端验证通过，本地副本仍占着盘，等待批准删除
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          <span
            className="connection-state"
            title={live === 'live' ? '事件流已连接' : '事件流未连接，改为轮询'}
          >
            {live === 'live' ? (
              <Radio size={15} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <CircleDashed size={15} strokeWidth={1.8} aria-hidden="true" />
            )}
            {live === 'live' ? '实时' : live === 'connecting' ? '连接中' : '轮询中'}
          </span>
        </header>

        {/*
          Three figures large enough to read from across the room, and no more.
          Each is a number an operator acts on: how much disk came back, how much
          room the cloud still has, and whether anything is moving right now. A
          reading that has not arrived shows a dash rather than a zero — "0" and
          "not measured yet" lead to opposite decisions.
        */}
        <dl className="hero-metrics">
          <div className="hero-metric">
            <dt>本地已回收</dt>
            <dd>{savings ? formatBytes(savings.cloudBytes) : '—'}</dd>
          </div>
          <div className="hero-metric">
            <dt>云端余量</dt>
            <dd>
              {advice.totalHeadroomBytes === null ? '—' : formatBytes(advice.totalHeadroomBytes)}
            </dd>
          </div>
          <div className="hero-metric">
            <dt>正在运行</dt>
            <dd>
              {offloads === undefined || rehydrates === undefined
                ? '—'
                : activeOffloads.length + activeRehydrates.length}
              <small>个任务</small>
            </dd>
          </div>
        </dl>
      </div>

      {sessionExpired ? (
        <p className="error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> 会话已过期，请重新登录。
        </p>
      ) : null}

      <div className="operational-grid">
        {/*
          First in the grid, because it is the only panel that answers "is there
          anything I have to do". Everything after it is evidence for a question
          the operator has already decided to ask.
        */}
        <Panel
          title="告警"
          icon={Bell}
          span={4}
          tone={
            alerts.some((alert) => alert.tone === 'error')
              ? 'red'
              : alerts.some((alert) => alert.tone === 'warn')
                ? 'amber'
                : alertsComplete
                  ? 'green'
                  : 'cyan'
          }
          status={
            alerts.length > 0 ? `${alerts.length} 条` : alertsComplete ? '一切正常' : '读取中'
          }
        >
          {alerts.length === 0 ? (
            alertsComplete ? (
              <p className="panel-ok">
                <CircleCheck size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
                挂载、磁盘、账户与任务都没有需要处理的问题。
              </p>
            ) : (
              <p>正在读取各项遥测，尚不能给出结论。</p>
            )
          ) : (
            <ul className="alert-list">
              {alerts.map((alert, index) => {
                const Icon = ALERT_ICONS[alert.tone];
                return (
                  <li key={`${alert.href}-${index}`} className={`alert-${alert.tone}`}>
                    <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
                    <Link to={alert.href}>{alert.message}</Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          title="上传能力"
          icon={Gauge}
          span={8}
          reveal={40}
          tone={
            advice.largestJobBytes === null
              ? 'cyan'
              : advice.uplinkPressure === 'BUSY'
                ? 'amber'
                : 'green'
          }
          status={
            advice.largestJobBytes === null
              ? '读取中'
              : advice.uplinkPressure === 'BUSY'
                ? '上行正忙'
                : advice.uplinkPressure === 'IDLE'
                  ? '上行空闲'
                  : '可评估容量'
          }
        >
          {advice.largestJobBytes === null ? (
            <p>正在读取账户容量与实测速率。</p>
          ) : (
            <>
              <ul className="panel-list">
                <li>
                  <span className="panel-list-name">这次最大能传</span>
                  <span className="panel-list-value">{formatBytes(advice.largestJobBytes)}</span>
                </li>
                <li>
                  <span className="panel-list-name">云端总余量</span>
                  <span className="panel-list-value">
                    {advice.totalHeadroomBytes === null
                      ? '—'
                      : formatBytes(advice.totalHeadroomBytes)}
                  </span>
                </li>
                <li>
                  <span className="panel-list-name">上传阶段实测</span>
                  <span className="panel-list-value">{formatRate(advice.uploadRate)}</span>
                </li>
                <li>
                  <span className="panel-list-name">端到端实测（含校验）</span>
                  <span className="panel-list-value">{formatRate(advice.endToEndRate)}</span>
                </li>
                <li>
                  <span className="panel-list-name">当前上行占用</span>
                  <span className="panel-list-value">
                    {formatRate(advice.uplinkTxBytesPerSecond)}
                  </span>
                </li>
              </ul>
              <p className="disk-meter-note">
                {/* Single-account bound, not the sum: a job writes every blob of one
                    torrent to the account it picked, so two half-full accounts
                    cannot take one large film between them. */}
                受单个账户限制（{advice.largestAccountLabel}）
                {advice.unusableAccounts > 0
                  ? ` · ${advice.unusableAccounts} 个账户容量未知或不健康，未计入`
                  : ''}
              </p>
              <ul className="panel-list">
                {[10, 100, 500].map((gib) => (
                  <li key={gib}>
                    <span className="panel-list-name">传 {gib} GiB 约需</span>
                    <span className="panel-list-value">
                      {formatDuration(estimateSeconds(gib * 1024 ** 3, advice.endToEndRate))}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="disk-meter-note">
                估算用端到端速率（上传 + 逐字节哈希 + 解密回读校验），不是纯上传速率
                {system && system.throughput.endToEnd.jobs > 0
                  ? ` · 取自最近 ${system.throughput.endToEnd.jobs} 次迁移实测`
                  : ' · 尚无完成的迁移可供实测'}
              </p>
            </>
          )}
        </Panel>

        <Panel
          title="VPS 磁盘"
          icon={HardDrive}
          span={6}
          reveal={80}
          tone={diskBreached ? 'red' : 'cyan'}
          status={
            disks === undefined
              ? '读取中'
              : diskBreached
                ? '已触及保护线'
                : singleDisk
                  ? '在保护线之上'
                  : '两块盘均在保护线之上'
          }
        >
          {disks === undefined ? (
            <p>正在读取磁盘容量。</p>
          ) : singleDisk ? (
            // One filesystem serving both roles: drawing it twice would suggest two
            // independent budgets where there is one.
            <DiskMeter label="系统盘（数据 + 缓存）" disk={disks.hot} />
          ) : (
            <>
              <DiskMeter label="数据盘（种子）" disk={disks.hot} />
              <DiskMeter label="缓存盘（临时观看）" disk={disks.cache} />
            </>
          )}
        </Panel>

        <Panel
          title="VFS 缓存"
          icon={MemoryStick}
          span={6}
          reveal={120}
          tone={
            worstPressure === 'CRITICAL' ? 'red' : worstPressure === 'EVICTING' ? 'amber' : 'green'
          }
          status={
            mounts === undefined
              ? '读取中'
              : mounts.length === 0
                ? '无挂载'
                : `${mountedCount}/${mounts.length} 已挂载 · ${PRESSURE_LABELS[worstPressure]}`
          }
        >
          {mounts === undefined ? (
            <p>正在读取挂载状态。</p>
          ) : mounts.length === 0 ? (
            <p>尚未注册云端存储账户，没有可读的挂载。</p>
          ) : (
            <>
              {mounts.map((mount) => (
                <CacheRow key={mount.accountId} mount={mount} />
              ))}
              {disks ? (
                <p className="disk-meter-note">
                  缓存上限合计 {formatBytes(disks.cache.cacheMaxBytes)}
                </p>
              ) : null}
            </>
          )}
        </Panel>

        <Panel
          title="账户池"
          icon={Database}
          span={6}
          reveal={280}
          tone={
            accounts === undefined || accounts.length === 0
              ? 'cyan'
              : healthyAccounts === accounts.length
                ? 'green'
                : 'red'
          }
          status={
            accounts === undefined
              ? '读取中'
              : accounts.length === 0
                ? '未注册账户'
                : `${healthyAccounts}/${accounts.length} 健康`
          }
        >
          {accounts === undefined ? (
            <p>正在读取存储账户。</p>
          ) : accounts.length === 0 ? (
            <p>尚未注册任何存储账户。</p>
          ) : (
            <ul className="panel-list">
              {accounts.map((account) => (
                <li key={account.id}>
                  <span className="panel-list-name">{account.label}</span>
                  <span className="panel-list-value">
                    {account.freeBytes === null
                      ? '容量未知'
                      : `剩余 ${formatBytes(account.freeBytes)}`}
                    {account.health === 'HEALTHY' ? '' : ` · ${account.health}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="任务"
          icon={ListTodo}
          span={6}
          reveal={320}
          tone={stoppedOffloads.length + stoppedRehydrates.length > 0 ? 'red' : 'cyan'}
          status={
            offloads === undefined || rehydrates === undefined
              ? '读取中'
              : activeOffloads.length + activeRehydrates.length === 0
                ? '没有进行中的任务'
                : `${activeOffloads.length + activeRehydrates.length} 个进行中`
          }
        >
          <ul className="panel-list">
            <li>
              <span className="panel-list-name">
                <Link to="/transfers">迁移进行中</Link>
              </span>
              <span className="panel-list-value">{activeOffloads.length}</span>
            </li>
            <li>
              <span className="panel-list-name">
                <Link to="/transfers?group=AWAITING_CLEANUP">已上云待删除</Link>
              </span>
              <span className="panel-list-value">{awaitingCleanup.length}</span>
            </li>
            <li>
              <span className="panel-list-name">
                <Link to="/transfers?group=FAILED">迁移已停止</Link>
              </span>
              <span className="panel-list-value">{stoppedOffloads.length}</span>
            </li>
            <li>
              <span className="panel-list-name">
                <Link to="/media">回迁进行中</Link>
              </span>
              <span className="panel-list-value">{activeRehydrates.length}</span>
            </li>
            <li>
              <span className="panel-list-name">
                <Link to="/media">回迁已停止</Link>
              </span>
              <span className="panel-list-value">{stoppedRehydrates.length}</span>
            </li>
          </ul>
        </Panel>

        <Panel
          title="系统负载"
          icon={Cpu}
          span={4}
          reveal={160}
          tone={!hostReadable ? 'cyan' : loadRatio !== null && loadRatio >= 1 ? 'amber' : 'green'}
          status={
            system === undefined
              ? '读取中'
              : !hostReadable
                ? '不可读'
                : loadRatio !== null && loadRatio >= 1
                  ? '运行队列已饱和'
                  : '有余力'
          }
        >
          {system === undefined ? (
            <p>正在读取主机指标。</p>
          ) : !hostReadable ? (
            <p>{hostUnavailableLabel(system.unavailableReason)}</p>
          ) : (
            <>
              <PercentMeter
                label="CPU"
                percent={system.cpu?.usagePercent ?? null}
                detail={
                  system.cpu === null
                    ? ''
                    : `${system.cpu.cores} 核 · 负载 ${system.cpu.load1.toFixed(2)} / ${system.cpu.load5.toFixed(2)} / ${system.cpu.load15.toFixed(2)}`
                }
                breached={loadRatio !== null && loadRatio >= 1}
              />
              <Sparkline
                series={[
                  { values: history.map((point) => point.cpuPercent), className: 'spark-cpu' },
                ]}
                ariaLabel="CPU 使用率近况"
              />
              <PercentMeter
                label="内存"
                percent={memoryUsedPercent}
                detail={
                  system.memory === null
                    ? ''
                    : `可用 ${formatBytes(system.memory.availableBytes)} / ${formatBytes(system.memory.totalBytes)}${
                        system.memory.swapTotalBytes > 0
                          ? ` · swap 已用 ${formatBytes(system.memory.swapUsedBytes)}`
                          : ' · 无 swap'
                      }`
                }
              />
              <p className="disk-meter-note">
                已运行 {formatDuration(system.uptimeSeconds)} · 采样间隔{' '}
                {Math.round(system.sampleIntervalMs / 1000)} 秒
              </p>
            </>
          )}
        </Panel>

        <Panel
          title="网络吞吐"
          icon={Network}
          span={4}
          reveal={200}
          tone={!hostReadable ? 'cyan' : advice.uplinkPressure === 'BUSY' ? 'amber' : 'green'}
          status={
            system === undefined
              ? '读取中'
              : !hostReadable
                ? '不可读'
                : uplink === undefined
                  ? '未找到默认路由'
                  : `↑ ${formatRate(uplink.txBytesPerSecond)} · ↓ ${formatRate(uplink.rxBytesPerSecond)}`
          }
        >
          {system === undefined ? (
            <p>正在读取网络计数器。</p>
          ) : !hostReadable ? (
            <p>{hostUnavailableLabel(system.unavailableReason)}</p>
          ) : uplink === undefined ? (
            // Without a default route there is no interface whose number means
            // "my uplink"; picking the busiest one would silently chart a bridge.
            <p>没有默认路由，无法判断哪个网卡是对外链路。</p>
          ) : (
            <>
              <Sparkline
                series={[
                  {
                    values: history.map((point) => point.txBytesPerSecond),
                    className: 'spark-tx',
                  },
                  {
                    values: history.map((point) => point.rxBytesPerSecond),
                    className: 'spark-rx',
                  },
                ]}
                ariaLabel="上行与下行速率近况"
              />
              <ul className="panel-list">
                <li>
                  <span className="panel-list-name">上行（对外）</span>
                  <span className="panel-list-value">{formatRate(uplink.txBytesPerSecond)}</span>
                </li>
                <li>
                  <span className="panel-list-name">下行</span>
                  <span className="panel-list-value">{formatRate(uplink.rxBytesPerSecond)}</span>
                </li>
                <li>
                  <span className="panel-list-name">累计发出</span>
                  <span className="panel-list-value">{formatBytes(uplink.txTotalBytes)}</span>
                </li>
                <li>
                  <span className="panel-list-name">累计收到</span>
                  <span className="panel-list-value">{formatBytes(uplink.rxTotalBytes)}</span>
                </li>
              </ul>
              <p className="disk-meter-note">
                <code>{uplink.name}</code> · 累计值自开机起算
                {system.omittedInterfaces > 0
                  ? ` · 另有 ${system.omittedInterfaces} 个网卡（容器 veth 等）未列出`
                  : ''}
              </p>
            </>
          )}
        </Panel>

        <Panel
          title="磁盘 I/O"
          icon={HardDrive}
          span={4}
          reveal={240}
          tone={
            !hostReadable
              ? 'cyan'
              : system.disks.some((disk) => (disk.busyPercent ?? 0) >= 90)
                ? 'amber'
                : 'green'
          }
          status={
            system === undefined
              ? '读取中'
              : !hostReadable
                ? '不可读'
                : system.disks.length === 0
                  ? '无块设备读数'
                  : system.disks.some((disk) => (disk.busyPercent ?? 0) >= 90)
                    ? '磁盘接近饱和'
                    : `${system.disks.length} 块设备`
          }
        >
          {system === undefined ? (
            <p>正在读取磁盘计数器。</p>
          ) : !hostReadable ? (
            <p>{hostUnavailableLabel(system.unavailableReason)}</p>
          ) : (
            <>
              <Sparkline
                series={[
                  {
                    values: history.map((point) => point.writeBytesPerSecond),
                    className: 'spark-write',
                  },
                  {
                    values: history.map((point) => point.readBytesPerSecond),
                    className: 'spark-read',
                  },
                ]}
                ariaLabel="磁盘读写速率近况"
              />
              <ul className="panel-list">
                {system.disks.map((disk) => (
                  <li key={disk.name}>
                    <span className="panel-list-name">
                      <code>{disk.name}</code>
                    </span>
                    <span className="panel-list-value">
                      读 {formatRate(disk.readBytesPerSecond)} · 写{' '}
                      {formatRate(disk.writeBytesPerSecond)}
                      {disk.busyPercent === null ? '' : ` · 忙 ${Math.round(disk.busyPercent)}%`}
                    </span>
                  </li>
                ))}
              </ul>
              {/* Device names, not the mount points above: the kernel reports I/O
                  per block device and nothing here maps sda to /data, so naming
                  them would be a guess presented as a fact. */}
              <p className="disk-meter-note">按内核块设备名列出，未与上方挂载点对应</p>
            </>
          )}
        </Panel>
      </div>
    </section>
  );
}
