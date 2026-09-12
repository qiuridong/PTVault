import { useQuery } from '@tanstack/react-query';
import {
  CircleSlash,
  Clapperboard,
  FolderSync,
  HardDrive,
  Pin,
  Plus,
  Server,
  Settings2,
  SlidersHorizontal,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { MediaCatalogEntry } from '@ptvault/contracts';

import { useReveal } from '../../showcase/useReveal.js';
import { DiskMeter } from '../../ui/DiskMeter.js';
import { formatAge, formatBytes } from '../../ui/format.js';
import { getSession, sessionQueryKey } from '../auth/authApi.js';
import { PinDialog } from '../media/PinDialog.js';
import {
  getDisks,
  getMediaCatalog,
  mediaCatalogQueryKey,
  mediaDisksQueryKey,
} from '../media/mediaApi.js';
import { getInstances, qbInstancesQueryKey, type QbInstanceSummary } from '../torrents/qbApi.js';
import { InstanceEditor } from './InstanceEditor.js';
import { JellyfinSection } from './JellyfinSection.js';
import { useSettingsScrollSpy } from './useSettingsScrollSpy.js';
import {
  getJellyfinInfo,
  getSystemInfo,
  getTransferSettings,
  jellyfinInfoQueryKey,
  systemInfoQueryKey,
  transferSettingsQueryKey,
} from './settingsApi.js';
import { TransferSettingsSection } from './TransferSettingsSection.js';

/** `?instance=` value that opens the editor for a not-yet-created instance. */
const NEW_INSTANCE = 'new';
/** `?pin=` value: `<instanceId>:<hash>` of the entry whose pin is being changed. */
const PIN_SEPARATOR = ':';

type SectionState = 'live' | 'partial' | 'absent';

const STATE_LABELS: Record<SectionState, string> = {
  live: '已接入',
  partial: '部分可用',
  absent: '还没建',
};

/**
 * One band of the page.
 *
 * `state` is on the section header rather than buried in its body because the
 * first question this page has to answer is which parts actually work today.
 * Reading that off the headings should not require reading the paragraphs.
 */
function SettingsSection({
  index,
  id,
  title,
  icon: Icon,
  lede,
  state,
  children,
}: {
  index: string;
  id: string;
  title: string;
  icon: LucideIcon;
  lede: string;
  state: SectionState;
  children: ReactNode;
}) {
  const revealRef = useReveal<HTMLElement>(Number(index));
  return (
    <section ref={revealRef} className="settings-section" id={id} aria-labelledby={`${id}-title`}>
      <header className="settings-section-head">
        <span className="settings-numeral" aria-hidden="true">
          {index}
        </span>
        <span className="settings-section-icon" aria-hidden="true">
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <div className="settings-section-titles">
          <h2 id={`${id}-title`}>{title}</h2>
          <p className="settings-lede">{lede}</p>
        </div>
        <span className={`settings-state settings-state-${state}`}>{STATE_LABELS[state]}</span>
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

/**
 * A section that has no surface yet, stating what is missing and what answers
 * the same question today.
 *
 * An empty frame on an operations console reads as a failed request, and the
 * operator's next move is to go check whether the backend is down — a wasted
 * trip. Naming the gap costs one paragraph and saves that trip.
 */
function NotBuilt({ children }: { children: ReactNode }) {
  return (
    <div className="settings-notbuilt">
      <span className="settings-notbuilt-glyph" aria-hidden="true">
        <CircleSlash size={18} strokeWidth={1.7} />
      </span>
      <div>{children}</div>
    </div>
  );
}

/**
 * What the poller last saw, or an honest silence.
 *
 * Three states, not two. `undefined` means the API on this box predates the
 * columns and cannot answer; `null` means it answered "never". Drawing both as
 * 「从未同步」 would put a definite claim on screen for a question nobody asked.
 */
function SyncLine({ instance, now }: { instance: QbInstanceSummary; now: number }) {
  if (instance.lastSyncAt === undefined) {
    return <span className="instance-meta-value is-unknown">该 API 版本不报同步结果</span>;
  }
  if (instance.lastSyncError !== null && instance.lastSyncError !== undefined) {
    return (
      <span className="instance-meta-value is-bad">
        <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
        {instance.lastSyncError}
        {instance.lastSyncAt === null ? '' : ` · ${formatAge(instance.lastSyncAt, now)}`}
      </span>
    );
  }
  if (instance.lastSyncAt === null) {
    return <span className="instance-meta-value is-unknown">还没跑过一轮</span>;
  }
  return <span className="instance-meta-value">{formatAge(instance.lastSyncAt, now)}</span>;
}

function InstanceCard({
  instance,
  now,
  onEdit,
}: {
  instance: QbInstanceSummary;
  now: number;
  onEdit: () => void;
}) {
  const maps = instance.pathMaps;
  return (
    <article className="instance-card" data-enabled={instance.enabled}>
      <header className="instance-card-head">
        <div>
          <h3>{instance.displayName}</h3>
          <p className="instance-id">{instance.id}</p>
        </div>
        <span className={`instance-pill${instance.enabled ? ' is-on' : ''}`}>
          {instance.enabled ? '同步中' : '已停用'}
        </span>
      </header>

      <dl className="instance-meta">
        <div>
          <dt>WebUI</dt>
          <dd>
            {instance.baseUrl === null ? (
              <span className="instance-meta-value is-unknown">未配置凭据</span>
            ) : (
              <span className="instance-meta-value is-mono">{instance.baseUrl}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>用户名</dt>
          <dd>
            <span className="instance-meta-value is-mono">{instance.username ?? '—'}</span>
          </dd>
        </div>
        <div>
          <dt>最近同步</dt>
          <dd>
            <SyncLine instance={instance} now={now} />
          </dd>
        </div>
        <div>
          <dt>路径映射</dt>
          <dd>
            {maps === undefined ? (
              <span className="instance-meta-value is-unknown">该 API 版本不报</span>
            ) : maps.length === 0 ? (
              <span className="instance-meta-value is-unknown">无（按 qB 报的路径读）</span>
            ) : (
              <span className="instance-meta-value is-mono">{maps.join(' · ')}</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="instance-card-actions">
        <button type="button" className="ghost-button" onClick={onEdit}>
          <Settings2 size={15} strokeWidth={1.9} aria-hidden="true" />
          编辑
        </button>
        <Link className="settings-link" to={`/torrents?filter=${encodeURIComponent(instance.id)}`}>
          查看这个实例的种子
        </Link>
      </div>
    </article>
  );
}

/**
 * Connections, capacity policy, and a plain statement of what this page cannot
 * answer yet.
 *
 * Built section by section rather than as one placeholder or one finished page.
 * Each section that is not built says what is missing rather than showing an
 * empty frame.
 */
export function SettingsPage() {
  const navigationRef = useSettingsScrollSpy();
  // The editor lives in the URL (`?instance=new` or `?instance=<id>`) rather
  // than in component state, so leaving to check something elsewhere and coming
  // back returns to the form instead of a bare list — and Back closes it, which
  // is what a reader expects of something that looks like a page.
  const [searchParams, setSearchParams] = useSearchParams();
  const instanceParam = searchParams.get('instance');
  const pinParam = searchParams.get('pin');

  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: getSession,
    // `ProtectedRoute` has already revalidated the session before any child
    // renders; refetching on mount here would unmount this page mid-render.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
  });
  const instancesQuery = useQuery({ queryKey: qbInstancesQueryKey, queryFn: getInstances });
  const disksQuery = useQuery({ queryKey: mediaDisksQueryKey, queryFn: getDisks });
  const catalogQuery = useQuery({ queryKey: mediaCatalogQueryKey, queryFn: getMediaCatalog });
  const systemQuery = useQuery({ queryKey: systemInfoQueryKey, queryFn: getSystemInfo });
  const jellyfinQuery = useQuery({ queryKey: jellyfinInfoQueryKey, queryFn: getJellyfinInfo });
  /*
   * Read here as well as inside the section, for the heading chip only.
   *
   * Same query key, so TanStack serves both from one request rather than two —
   * and the chip cannot disagree with the body it labels, which is the failure a
   * separately-derived chip would eventually produce.
   */
  const transfersQuery = useQuery({
    queryKey: transferSettingsQueryKey,
    queryFn: getTransferSettings,
  });

  const instances = useMemo(() => instancesQuery.data ?? [], [instancesQuery.data]);
  const now = Date.now();

  /*
   * The instance list doubles as the capability probe.
   *
   * These fields are read off the same row for every instance, so they arrive
   * for all of them or for none. With no instances at all there is nothing to
   * probe with, and the editor is shown: a first save round-trips through the
   * same schema, so an API that drops the key reveals itself immediately rather
   * than never.
   */
  const supportsPathMaps =
    instances.length === 0 || instances.some((instance) => instance.pathMaps !== undefined);

  const setInstanceParam = (value: string | null): void => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete('instance');
    else next.set('instance', value);
    setSearchParams(next, { replace: value === null });
  };

  const setPinParam = (entry: MediaCatalogEntry | null): void => {
    const next = new URLSearchParams(searchParams);
    if (entry === null) next.delete('pin');
    else next.set('pin', `${entry.instanceId}${PIN_SEPARATOR}${entry.torrentHash}`);
    setSearchParams(next, { replace: entry === null });
  };

  /**
   * `undefined` = closed, `null` = adding. An id that matches nothing resolves
   * to closed rather than to a new-instance form: a stale link must not quietly
   * turn "edit this" into "create one", which would invite a duplicate id.
   */
  const editing: QbInstanceSummary | null | undefined =
    instanceParam === null
      ? undefined
      : instanceParam === NEW_INSTANCE
        ? null
        : (instances.find((instance) => instance.id === instanceParam) ?? undefined);

  const pinned = useMemo(
    () => (catalogQuery.data ?? []).filter((entry) => entry.pinned),
    [catalogQuery.data],
  );
  const pinning = useMemo(() => {
    if (pinParam === null) return null;
    const separator = pinParam.indexOf(PIN_SEPARATOR);
    if (separator <= 0) return null;
    const instanceId = pinParam.slice(0, separator);
    const hash = pinParam.slice(separator + 1);
    return (
      (catalogQuery.data ?? []).find(
        (entry) => entry.instanceId === instanceId && entry.torrentHash === hash,
      ) ?? null
    );
  }, [pinParam, catalogQuery.data]);

  const disks = disksQuery.data;
  // On a single-disk deployment both pools report the same path. Drawing it
  // twice would suggest two disks and two independent margins.
  const oneDisk = disks !== undefined && disks.hot.path === disks.cache.path;
  const mode = sessionQuery.data?.mode;
  const system = systemQuery.data;

  /*
   * The state chip on each heading, derived rather than declared.
   *
   * Three different sentences hide behind "this section is not showing much",
   * and they lead to three different next moves: the API here is older than this
   * bundle (redeploy the API), the thing is not configured on this machine (go
   * edit the unit), or it is configured and working. A hardcoded chip would have
   * to pick one and be wrong on the other two.
   */
  const jellyfinState: SectionState =
    jellyfinQuery.data === undefined
      ? 'partial'
      : !jellyfinQuery.data.supported
        ? 'partial'
        : jellyfinQuery.data.data.configured
          ? jellyfinQuery.data.data.error !== null ||
            jellyfinQuery.data.data.libraries.some(
              (library) => (library.typeConflicts?.length ?? 0) > 0,
            )
            ? 'partial'
            : 'live'
          : 'absent';
  const systemState: SectionState =
    system === undefined ? 'partial' : system.supported ? 'live' : 'partial';
  /*
   * 「已接入」 means both runtimes are provisioned — not that the switches are on.
   *
   * A deliberately closed creation gate is a working section, so it must not read
   * as broken; an unprovisioned runtime is 「部分可用」 because the settings are
   * readable and editable while the thing they configure cannot run. Neither is
   * 「还没建」: the surface exists as soon as the route answers.
   */
  const transfers = transfersQuery.data;
  const offloadRuntimeAvailable =
    transfers?.supported === true &&
    (transfers.data.offload.provisioned ||
      transfers.data.offload.provisionReason === 'PARALLEL_RUNTIME_DISABLED');
  const transferState: SectionState =
    transfers === undefined ? 'partial' : offloadRuntimeAvailable ? 'live' : 'partial';
  /*
   * The netdisk band is a doorway, so its chip reports the far side.
   *
   * Read off the same query key as the qB chip, so the two cannot disagree about
   * one record. 「部分可用」 rather than 「还没建」 when the runtime is not
   * provisioned: the settings surface exists and is readable, it is the thing it
   * configures that cannot currently run.
   */
  const netdiskState: SectionState =
    transfers === undefined
      ? 'partial'
      : !transfers.supported
        ? 'absent'
        : transfers.data.netdisk.provisioned
          ? 'live'
          : 'partial';

  return (
    <section className="content-page settings-page" aria-labelledby="settings-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">运维</p>
          <h1 id="settings-title">设置</h1>
          <Link className="ghost-button" to="/settings/setup">首次设置与接入检查</Link>
          <p className="page-lede">
            这一页回答「这台机器连着什么，以及它替我守着哪条线」。
            六个分区分别呈现实例、迁移调度、网盘入口、磁盘、Jellyfin 与系统信息；
            读不到的东西会说明是没配置、还是这台机器上的 API
            还没有那个接口——这两件事下一步要做的不一样。
          </p>
        </div>
      </header>

      <div className="settings-layout">
        <nav ref={navigationRef} className="settings-index" aria-label="设置分区">
          <a href="#qb-instances">
            <span aria-hidden="true">01</span> qBittorrent 实例
          </a>
          <a href="#transfer-scheduling">
            <span aria-hidden="true">02</span> 迁移调度
          </a>
          <a href="#netdisk-imports">
            <span aria-hidden="true">03</span> 网盘迁移
          </a>
          <a href="#cache-disks">
            <span aria-hidden="true">04</span> 缓存与磁盘
          </a>
          <a href="#jellyfin">
            <span aria-hidden="true">05</span> Jellyfin
          </a>
          <a href="#system">
            <span aria-hidden="true">06</span> 系统
          </a>
        </nav>

        <div className="settings-sections">
          <SettingsSection
            index="01"
            id="qb-instances"
            title="qBittorrent 实例"
            icon={Server}
            lede="要轮询哪些 qB、用什么凭据、它的路径怎么对应到本机。只写本站配置，不动任何种子。"
            state="live"
          >
            {instancesQuery.isPending ? (
              <p className="settings-loading">正在读取实例列表…</p>
            ) : instancesQuery.isError ? (
              <p className="inline-message error-message" role="alert">
                <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                读取实例列表失败，下面看到的不是全部。
              </p>
            ) : instances.length === 0 ? (
              <p className="settings-empty">
                还没有配置任何实例。种子库存为空就是因为这个——没有实例可轮询。
              </p>
            ) : (
              <div className="instance-grid">
                {instances.map((instance) => (
                  <InstanceCard
                    key={instance.id}
                    instance={instance}
                    now={now}
                    onEdit={() => setInstanceParam(instance.id)}
                  />
                ))}
              </div>
            )}

            {editing === undefined ? (
              <button
                type="button"
                className="primary-button"
                onClick={() => setInstanceParam(NEW_INSTANCE)}
              >
                <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
                添加实例
              </button>
            ) : (
              <InstanceEditor
                instance={editing}
                supportsPathMaps={supportsPathMaps}
                onClose={() => setInstanceParam(null)}
              />
            )}
          </SettingsSection>

          <SettingsSection
            index="02"
            id="transfer-scheduling"
            title="迁移调度"
            icon={SlidersHorizontal}
            lede="qB/VPS 种子迁移的新建门与并发上限，以及此刻真正占着槽位的工作。改这里不部署、不重启、不动 qB。"
            state={transferState}
          >
            <TransferSettingsSection />
          </SettingsSection>

          <SettingsSection
            index="03"
            id="netdisk-imports"
            title="网盘迁移"
            icon={FolderSync}
            lede="网盘导入有独立的运行时、来源账户、spool、发布与来源清理，所以它的设置在自己的页面上。"
            state={netdiskState}
          >
            <p className="field-hint">
              网盘迁移和 qB/VPS 种子迁移是两条互不相干的管线：一笔 offload 由
              <code>(instanceId, torrentHash)</code> 标识，一笔网盘导入根本没有种子。
              把它们挤在同一张调度卡上，会让网盘那半看起来只是 qB 调度多出来的两个旋钮。
            </p>
            <p className="field-hint">
              那一页显示被执行器强制的设置。发布与来源清理接口已存在，但仍受运行时、
              凭据、白名单及独立安全门限制；保存设置不等于完成装配或获准执行来源清理。
            </p>
            <div className="instance-form-actions">
              <Link className="primary-button" to="/settings/netdisk">
                <FolderSync size={15} strokeWidth={1.9} aria-hidden="true" />
                进入网盘迁移设置
              </Link>
            </div>
            <p className="field-hint">
              云盘账户的登录、能力与容量在<Link to="/storage-accounts">存储账户</Link>
              页；任务本身在<Link to="/imports">网盘迁移</Link>页。
            </p>
          </SettingsSection>

          <SettingsSection
            index="04"
            id="cache-disks"
            title="缓存与磁盘"
            icon={HardDrive}
            lede="两块盘各自的余量与保护线，以及被固定下来、清理不许回收的标题。"
            state="live"
          >
            {disksQuery.isPending ? (
              <p className="settings-loading">正在读取磁盘…</p>
            ) : disksQuery.isError || disks === undefined ? (
              <p className="inline-message error-message" role="alert">
                <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                读不到磁盘容量。别把这当成「空间充足」——这里没有读数。
              </p>
            ) : (
              <div className="settings-cards">
                <div className="settings-card">
                  <h3>容量</h3>
                  <DiskMeter
                    label={oneDisk ? '媒体与缓存（同一块盘）' : '媒体盘'}
                    disk={disks.hot}
                  />
                  {oneDisk ? null : <DiskMeter label="缓存盘" disk={disks.cache} />}
                  <p className="disk-meter-note">
                    缓存上限 {formatBytes(disks.cache.cacheMaxBytes)}
                    ——这是本系统自己给缓存划的天花板，与盘的物理容量是两件事。
                    保护线是刻度上那一道竖线，越过它之后回迁请求会被拒绝。
                  </p>
                </div>

                <div className="settings-card">
                  <h3>迁移换回来的空间</h3>
                  <dl className="settings-figures">
                    <div>
                      <dt>已释放本地</dt>
                      <dd>
                        {formatBytes(disks.savings.cloudBytes)}
                        <small>{disks.savings.cloudCount} 个种子，本地已删</small>
                      </dd>
                    </div>
                    <div>
                      <dt>已验证未删</dt>
                      <dd>
                        {formatBytes(disks.savings.awaitingBytes)}
                        <small>{disks.savings.awaitingCount} 个，云端已核对，本地仍在</small>
                      </dd>
                    </div>
                  </dl>
                  <p className="disk-meter-note">
                    「已验证未删」是还能一键腾出来的量，去<Link to="/recovery">恢复</Link>
                    页看删除门是否已开。
                  </p>
                </div>
              </div>
            )}

            <div className="settings-card">
              <h3>
                <Pin size={15} strokeWidth={1.9} aria-hidden="true" /> 固定的标题
              </h3>
              <p className="field-hint">
                固定表示「这个别回收」。它只对本系统自己的缓存清理生效——rclone
                有它自己的最久未使用回收，不认识这里的固定。固定得越多，其他影片能用的缓存越少。
              </p>
              {catalogQuery.isPending ? (
                <p className="settings-loading">正在读取媒体目录…</p>
              ) : catalogQuery.isError ? (
                <p className="inline-message error-message" role="alert">
                  <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                  读不到媒体目录，固定列表无法显示。
                </p>
              ) : pinned.length === 0 ? (
                <p className="settings-empty">
                  没有固定任何标题。去<Link to="/media">云端媒体</Link>页可以固定。
                </p>
              ) : (
                <ul className="pin-list">
                  {pinned.map((entry) => (
                    <li key={`${entry.instanceId}:${entry.torrentHash}`}>
                      <span className="pin-name">{entry.name}</span>
                      <span className="pin-size">{formatBytes(entry.totalBytes)}</span>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setPinParam(entry)}
                      >
                        取消固定
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {pinning === null ? null : (
                <PinDialog entry={pinning} onClose={() => setPinParam(null)} />
              )}
            </div>
          </SettingsSection>

          <SettingsSection
            index="05"
            id="jellyfin"
            title="Jellyfin"
            icon={Clapperboard}
            lede="连接、根路径配置覆盖与跨库类型冲突分别检查；发布完整度、列表和实际播放需另外验证。"
            state={jellyfinState}
          >
            <JellyfinSection now={now} />
          </SettingsSection>

          <SettingsSection
            index="06"
            id="system"
            title="系统"
            icon={Settings2}
            lede="这套服务自己的身份：运行模式、部署的版本与提交、库结构版本、挂载健康。"
            state={systemState}
          >
            {systemQuery.isPending ? (
              <p className="settings-loading">正在读取服务信息…</p>
            ) : systemQuery.isError ? (
              <p className="inline-message error-message" role="alert">
                <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                读不到服务信息。
              </p>
            ) : system !== undefined && system.supported ? (
              <>
                <div className="settings-cards">
                  <div className="settings-card">
                    <h3>部署身份</h3>
                    <dl className="settings-figures">
                      <div>
                        <dt>运行模式</dt>
                        <dd>
                          {system.data.mode}
                          <small>
                            {system.data.mode === 'ACTIVE'
                              ? '会真的上传与删除本地文件'
                              : '只读：迁移路由根本没有注册'}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>版本</dt>
                        <dd>
                          {system.data.version ?? '未标注'}
                          <small>
                            {/*
                              `+dirty` is shown rather than trimmed. A build made
                              from an unclean tree cannot be reproduced from the
                              commit alone, and that is exactly what someone
                              reading this line during an incident needs to know.
                            */}
                            {system.data.buildCommit ?? '没有提交标识'}
                          </small>
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="settings-card">
                    <h3>数据与挂载</h3>
                    <dl className="settings-figures">
                      <div>
                        <dt>库结构版本</dt>
                        <dd>
                          v{system.data.schemaVersion}
                          <small>迁移脚本跑到的那一版</small>
                        </dd>
                      </div>
                      <div>
                        <dt>挂载</dt>
                        <dd>
                          {system.data.mounts.healthy} / {system.data.mounts.total}
                          <small>
                            {system.data.mounts.total === 0
                              ? '还没有注册存储账户'
                              : system.data.mounts.healthy < system.data.mounts.total
                                ? '有账户的挂载不健康，它名下的片子此刻播不了'
                                : '全部健康'}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>最近一次对账</dt>
                        <dd>
                          {system.data.lastReconciledAt === null
                            ? '还没跑过'
                            : formatAge(system.data.lastReconciledAt, now)}
                          <small>完整挂载探测加链接树同步</small>
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <p className="field-hint">
                  各项阈值（磁盘保护线百分比、同步间隔、缓存上限）还没有接口可读，这里不列——
                  列出来只能是写死在前端的一份副本，和服务端真正在用的值会各走各的。 主机实时读数在
                  <Link to="/">仪表盘</Link>上，这里不重复画。
                </p>
              </>
            ) : (
              <NotBuilt>
                <p>
                  这台机器上的 API
                  版本还没有服务信息接口，所以版本、库结构版本与挂载健康在这里读不出来。
                  能确定的只有运行模式，它来自会话本身：<strong>{mode ?? '还没读到'}</strong>。
                </p>
                <p>
                  主机的实时读数（CPU、内存、网络、磁盘 I/O）不受影响，在
                  <Link to="/">仪表盘</Link>上。
                </p>
              </NotBuilt>
            )}
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}
