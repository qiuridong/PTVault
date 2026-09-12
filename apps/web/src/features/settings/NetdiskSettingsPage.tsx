import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Clapperboard,
  Database,
  Eraser,
  Gauge,
  HardDrive,
  KeyRound,
  Lock,
  Play,
  Save,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router-dom';

import type {
  CloudConnection,
  NetdiskSettingsStatus,
  PublicationPolicy,
  StorageAccount,
  TransferResourceStats,
} from '@ptvault/contracts';

import { formatDecimalBytes } from '../imports/importFormatting.js';
import { getStorageAccounts, storageAccountsQueryKey } from '../storage/accountApi.js';
import { cloudConnectionsQueryKey, getCloudConnections } from '../storage/connectionApi.js';
import { NotBuilt, SettingsSection, type SectionState } from './SettingsSection.js';
import { useSettingsScrollSpy } from './useSettingsScrollSpy.js';
import {
  NETDISK_DELETE_GRACE_MAX_SECONDS,
  NETDISK_LOCAL_PREPARATION_MAX,
  NETDISK_MAX_IN_FLIGHT_MAX,
  NETDISK_MAX_IN_FLIGHT_MIN,
  NETDISK_UPLOAD_MAX,
  netdiskSaveErrorMessage,
  useNetdiskSettings,
} from './useNetdiskSettings.js';

type ProvisionReason = NetdiskSettingsStatus['provisionReason'];

const PROVISION_LABELS: Record<ProvisionReason, string> = {
  READY: '运行时可用',
  MODE_NOT_ACTIVE: '这台机器不在 ACTIVE 模式，运行时会把写能力钳制为关闭',
  RUNTIME_NOT_CONFIGURED: '服务端缺少必要的凭据、路径或 rclone 配置',
};

const RUNTIME_MISSING_LABELS: Record<
  NonNullable<NetdiskSettingsStatus['runtimeMissing']>[number],
  string
> = {
  ACTIVE_MODE: '服务模式不是 ACTIVE',
  SECRET_ROOT: 'PTVAULT_IMPORT_SECRET_ROOT：服务端加密凭据目录',
  SPOOL_ROOT: 'PTVAULT_IMPORT_SPOOL_ROOT：独立暂存目录与容量预算',
  BAIDU_PROVIDER: '百度 provider 未装配：需要应用配置及真实账户授权窗口',
  RCLONE_CONFIG: 'rclone 配置路径未设置',
  RECOVERY_ACCOUNTS: 'PTVAULT_IMPORT_RECOVERY_ACCOUNT_IDS：至少两个恢复账户',
  RECOVERY_RUNTIME: '恢复运行时未装配：核对恢复副本与加密恢复配置',
};

const PUBLICATION_LABELS: Record<PublicationPolicy, string> = {
  ARCHIVE_ONLY: '仅归档（默认）',
  PUBLISH_TO_JELLYFIN: '归档验证后发布到 Jellyfin',
};

/** The six states the save area can be in, in the order they are checked. */
type SaveState = 'saving' | 'conflict' | 'error' | 'invalid' | 'dirty' | 'clean';

const SAVE_STATE_LABELS: Record<SaveState, string> = {
  saving: '正在保存…请不要重复提交；同一参数的重试会复用同一幂等键。',
  conflict: '保存已被拦下：服务端有更新的修订。草稿保留在页面上；详情见下方。',
  error: '上一次保存失败。草稿保留在页面上；失败原因见下方。',
  invalid: '草稿有不合法的值，保存已停用。逐项修好后再保存。',
  dirty: '有未保存的修改。离开这一页会丢弃它们。',
  clean: '没有待保存的修改。',
};

/**
 * The eight official sections, in order, declared once.
 *
 * The index and the headings used to be written out twice, and they had already
 * drifted: the nav said 「并发」 / 「来源账户」 / 「保存与安全」 while the sections said
 * 「并发与资源等待」 / 「默认来源账户」 / 「保存与安全保证」. An index whose wording does not
 * match the heading it scrolls to is an index you stop trusting, so both now come
 * from this list. Adding a section here without rendering it is a type error at
 * the call site rather than a nav entry that scrolls nowhere.
 */
const NETDISK_SECTIONS = {
  runtime: { index: '01', id: 'netdisk-runtime', title: '运行状态' },
  source: { index: '02', id: 'netdisk-source', title: '默认来源账户' },
  concurrency: { index: '03', id: 'netdisk-concurrency', title: '并发与资源等待' },
  spool: { index: '04', id: 'netdisk-spool', title: 'spool 与容量' },
  destination: { index: '05', id: 'netdisk-destination', title: '默认归档目的地' },
  publication: { index: '06', id: 'netdisk-publication', title: '默认发布策略' },
  cleanup: { index: '07', id: 'netdisk-cleanup', title: '来源清理' },
  safety: { index: '08', id: 'netdisk-safety', title: '保存与安全保证' },
} as const;

const NETDISK_SECTION_ORDER = [
  NETDISK_SECTIONS.runtime,
  NETDISK_SECTIONS.source,
  NETDISK_SECTIONS.concurrency,
  NETDISK_SECTIONS.spool,
  NETDISK_SECTIONS.destination,
  NETDISK_SECTIONS.publication,
  NETDISK_SECTIONS.cleanup,
  NETDISK_SECTIONS.safety,
] as const;

const CLAMP_LABELS: Record<NetdiskSettingsStatus['clamps'][number]['field'], string> = {
  creationEnabled: '新建任务',
  sourceStagingCleanupEnabled: '任务暂存清理',
  sourceDeleteEnabled: '本人来源清理',
};

const CLAMP_REASON_LABELS: Record<NetdiskSettingsStatus['clamps'][number]['reason'], string> = {
  MODE_NOT_ACTIVE: '部署模式不是 ACTIVE',
  RUNTIME_UNPROVISIONED: '运行时未配置',
  EXECUTOR_UNSUPPORTED: '执行器未接入',
};

const DELETION_GATES: readonly { label: string; detail: string }[] = [
  { label: 'manifest 已冻结', detail: '只处理任务冻结清单内的精确对象身份。' },
  { label: 'committed 与哈希链已验证', detail: '归档双回读和哈希链全部通过。' },
  { label: '恢复代次已验证', detail: '当前恢复副本已经过独立回读验证。' },
  { label: '来源未漂移且无并发引用', detail: 'fsid、路径、大小、mtime 未变，也没有活跃引用。' },
  { label: '宽限期、预览与 MFA', detail: '到期后仍须预览精确对象，并用当前单次验证码执行。' },
];

function sourceEligible(connection: CloudConnection): boolean {
  return (
    connection.provider === 'BAIDU' &&
    connection.authState === 'CONNECTED' &&
    connection.capabilities.includes('SOURCE_DOWNLOAD') &&
    (connection.capabilities.includes('SHARE_TRANSFER') ||
      connection.capabilities.includes('SOURCE_BROWSE'))
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  disabled,
  hint,
  runtime,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  min: number;
  max: number;
  disabled: boolean;
  hint: string;
  /** Saved configured value and the value the runtime actually uses. */
  runtime?: { configured: number; effective: number };
  onChange: (value: string) => void;
}) {
  const hintId = `${id}-hint`;
  return (
    <div className="field transfer-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-describedby={hintId}
        className="transfer-number"
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <small id={hintId} className="field-hint">
        {hint}
      </small>
      {runtime === undefined ? null : (
        /*
         * The runtime reading, on its own line and marked when it disagrees.
         *
         * These were one sentence — 「范围 1–8；运行时采用 3。」 — which put the bound
         * and the effective value in the same breath and never said whether the
         * effective value matched what was saved. A clamped setting that reads
         * like a hint is a clamp nobody notices.
         */
        <small
          className="settings-runtime-line"
          data-diff={runtime.configured !== runtime.effective}
        >
          运行时采用 <strong>{runtime.effective}</strong>
          {runtime.configured === runtime.effective
            ? '，与已保存配置一致。'
            : `，已保存配置为 ${runtime.configured}——运行时钳制后不是这个值。`}
        </small>
      )}
    </div>
  );
}

function ResourceReading({ label, value }: { label: string; value: TransferResourceStats }) {
  return (
    <div className="settings-card">
      <h3>{label}</h3>
      <dl className="settings-figures">
        <div>
          <dt>占用</dt>
          <dd>{value.active}</dd>
        </div>
        <div>
          <dt>等待</dt>
          <dd>{value.pending}</dd>
        </div>
        <div>
          <dt>容量</dt>
          <dd>{value.capacity}</dd>
        </div>
      </dl>
    </div>
  );
}

export function NetdiskSettingsPage() {
  const navigationRef = useSettingsScrollSpy();
  const fieldId = useId();
  const netdisk = useNetdiskSettings();
  const { status, draft, unavailable } = netdisk;
  const connectionsQuery = useQuery({
    queryKey: cloudConnectionsQueryKey,
    queryFn: getCloudConnections,
  });
  const accountsQuery = useQuery({
    queryKey: storageAccountsQueryKey,
    queryFn: getStorageAccounts,
  });

  const connectionAnswer = connectionsQuery.data;
  const sourceConnections =
    connectionAnswer?.supported === true
      ? connectionAnswer.data.connections.filter(sourceEligible)
      : [];
  const destinationAccounts: readonly StorageAccount[] = accountsQuery.data ?? [];
  const savedSourceMissing =
    draft !== null &&
    draft.defaultSourceConnectionId !== '' &&
    !sourceConnections.some((connection) => connection.id === draft.defaultSourceConnectionId);
  const savedDestinationMissing =
    draft !== null &&
    draft.defaultDestinationAccountId !== '' &&
    !destinationAccounts.some((account) => account.id === draft.defaultDestinationAccountId);
  const runtimeState: SectionState =
    unavailable !== null ? 'absent' : status?.provisioned === true ? 'live' : 'partial';
  const disableEdits = netdisk.isSaving || netdisk.demoReadOnly;

  /*
   * Derived, not stored: every input is already a fact the hook reports, and a
   * second copy of this in state is a second copy that can disagree with it.
   */
  const saveState: SaveState = netdisk.isSaving
    ? 'saving'
    : netdisk.staleRevision
      ? 'conflict'
      : netdisk.saveError !== null
        ? 'error'
        : netdisk.problems.length > 0
          ? 'invalid'
          : netdisk.dirty
            ? 'dirty'
            : 'clean';

  const unavailableMessage =
    unavailable?.kind === 'ROUTE_ABSENT'
      ? '这台机器上的 API 版本还没有 /api/netdisk/settings；这里没有可解释为默认值的读数。'
      : unavailable?.kind === 'NOT_ENABLED'
        ? `网盘设置路由存在但运行时未启用（HTTP ${unavailable.status}）。`
        : unavailable?.kind === 'UNAUTHENTICATED'
          ? '会话已过期，请重新登录后再读取设置。'
          : unavailable?.kind === 'READ_FAILED'
            ? '网盘设置读取失败；不要把空白当成全部关闭。'
            : null;

  return (
    <section className="content-page settings-page" aria-labelledby="netdisk-settings-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">运维</p>
          <h1 id="netdisk-settings-title">网盘迁移设置</h1>
          <p className="page-lede">
            这里直接读写独立的网盘设置版本：来源连接、归档目的地、三层并发、spool、默认发布和来源清理各自有明确契约。
            配置值与运行时有效值分开显示；被钳制的开关不会画成已经生效。
          </p>
        </div>
        <Link className="ghost-button" to="/settings">
          <ArrowLeft size={15} strokeWidth={1.9} aria-hidden="true" /> 回到系统设置
        </Link>
      </header>

      <div className="settings-layout">
        <nav ref={navigationRef} className="settings-index" aria-label="网盘迁移设置分区">
          {NETDISK_SECTION_ORDER.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              <span aria-hidden="true">{section.index}</span> {section.title}
            </a>
          ))}
          {/*
            Unsaved edits, visible from anywhere in the index rather than only next
            to a save button eight sections down. `dirty` already existed and drove
            nothing the reader could see.
          */}
          {netdisk.dirty ? (
            <p className="settings-index-dirty" role="status">
              有未保存修改 · 在
              <a href={`#${NETDISK_SECTIONS.safety.id}`}>{NETDISK_SECTIONS.safety.title}</a>
              保存
            </p>
          ) : null}
        </nav>

        <div className="settings-sections">
          <SettingsSection
            {...NETDISK_SECTIONS.runtime}
            icon={Play}
            lede="配置的新建门、当前有效门，以及正在运行和等待的任务。关闭新建不停止已有任务。"
            state={runtimeState}
          >
            {netdisk.isPending ? (
              <p className="settings-loading">正在读取网盘迁移设置…</p>
            ) : unavailableMessage !== null ? (
              <NotBuilt>
                <p>{unavailableMessage}</p>
              </NotBuilt>
            ) : status === undefined || draft === null ? (
              <p className="settings-loading">正在读取网盘迁移设置…</p>
            ) : (
              <>
                <p className="field-hint">
                  运行时：<strong>{PROVISION_LABELS[status.provisionReason]}</strong> · 设置修订{' '}
                  <code>{status.revision}</code>
                </p>
                {status.runtimeMissing?.length ? (
                  <div role="note" className="settings-card">
                    <h3>服务端装配缺项</h3>
                    <ul>
                      {status.runtimeMissing.map((item) => (
                        <li key={item}>{RUNTIME_MISSING_LABELS[item]}</li>
                      ))}
                    </ul>
                    <p className="field-hint">
                      这些是配置存在性检查，不是凭据验证。OAuth
                      应用、回调地址与真实授权窗口需另行准备； Jellyfin
                      发布还需发布开关、连接和库白名单。保存新建门不会自动补齐配置、启用执行或允许来源清理。
                    </p>
                  </div>
                ) : null}
                <label className="instance-form-checkbox" htmlFor={`${fieldId}-creation`}>
                  <input
                    id={`${fieldId}-creation`}
                    type="checkbox"
                    checked={draft.creationEnabled}
                    disabled={disableEdits}
                    onChange={(event) => netdisk.setField('creationEnabled', event.target.checked)}
                  />
                  <span>允许创建新的网盘迁移</span>
                </label>
                <div className="settings-cards">
                  <div className="settings-card">
                    <h3>任务占用</h3>
                    <dl className="settings-figures">
                      <div>
                        <dt>运行</dt>
                        <dd>{status.activity.activeJobs}</dd>
                      </div>
                      <div>
                        <dt>等待</dt>
                        <dd>{status.activity.waitingJobs}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="settings-card">
                    <h3>新建门</h3>
                    <dl className="settings-figures">
                      <div>
                        <dt>已保存</dt>
                        <dd>{status.configured.creationEnabled ? '开' : '关'}</dd>
                      </div>
                      <div>
                        <dt>运行时</dt>
                        <dd>{status.effective.creationEnabled ? '开' : '关'}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                {status.clamps.length === 0 ? null : (
                  <ul className="recovery-checklist">
                    {status.clamps.map((clamp) => (
                      <li key={`${clamp.field}-${clamp.reason}`} className="recovery-check">
                        <Lock size={16} strokeWidth={1.9} aria-hidden="true" />
                        <span className="recovery-check-label">
                          {CLAMP_LABELS[clamp.field]}被钳制
                        </span>
                        <span className="recovery-check-detail">
                          {CLAMP_REASON_LABELS[clamp.reason]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </SettingsSection>

          <SettingsSection
            {...NETDISK_SECTIONS.source}
            icon={Database}
            lede="只列出已连接、具备下载及分享转存或目录浏览能力的百度连接；留空表示创建任务时必须显式选择或由服务端拒绝。"
            state={status === undefined ? runtimeState : 'live'}
          >
            {draft === null ? (
              <p className="settings-loading">正在读取默认来源…</p>
            ) : (
              <div className="field">
                <label htmlFor={`${fieldId}-source`}>默认来源连接</label>
                <select
                  id={`${fieldId}-source`}
                  value={draft.defaultSourceConnectionId}
                  disabled={disableEdits || connectionsQuery.isPending || connectionsQuery.isError}
                  onChange={(event) =>
                    netdisk.setField('defaultSourceConnectionId', event.target.value)
                  }
                >
                  <option value="">不设置默认来源</option>
                  {savedSourceMissing ? (
                    <option value={draft.defaultSourceConnectionId}>
                      当前已保存 · {draft.defaultSourceConnectionId}
                    </option>
                  ) : null}
                  {sourceConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.label} · {connection.principalMasked}
                    </option>
                  ))}
                </select>
                <small className="field-hint">
                  {connectionsQuery.isError || connectionAnswer?.supported === false
                    ? '统一云连接列表当前读不到；保留已保存值，其他设置仍可编辑。'
                    : '任务显式携带 sourceConnectionId 时优先于这里；页面不会按 provider 名猜一个账户。'}
                </small>
                <Link className="ghost-button" to="/storage-accounts">
                  管理存储账户
                </Link>
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            {...NETDISK_SECTIONS.concurrency}
            icon={Gauge}
            lede="最大在途、本地准备和上传是三个独立 permit；等待数来自同一运行时状态，不把排队画成正在执行。"
            state={runtimeState}
          >
            {status === undefined || draft === null ? (
              <NotBuilt>
                <p>没有设置读数，因此不显示虚构的并发值。</p>
              </NotBuilt>
            ) : (
              <>
                <div className="transfer-grid">
                  <NumberField
                    id={`${fieldId}-max`}
                    label="最大在途任务"
                    value={draft.maxInFlight}
                    min={NETDISK_MAX_IN_FLIGHT_MIN}
                    max={NETDISK_MAX_IN_FLIGHT_MAX}
                    disabled={disableEdits}
                    hint={'范围 1–8。'}
                    runtime={{
                      configured: status.configured.maxInFlight,
                      effective: status.effective.maxInFlight,
                    }}
                    onChange={(value) => netdisk.setField('maxInFlight', value)}
                  />
                  <NumberField
                    id={`${fieldId}-local`}
                    label="本地准备并发"
                    value={draft.localPreparationConcurrency}
                    min={1}
                    max={NETDISK_LOCAL_PREPARATION_MAX}
                    disabled={disableEdits}
                    hint={'来源读取、落盘和哈希共用同一 permit。'}
                    runtime={{
                      configured: status.configured.localPreparationConcurrency,
                      effective: status.effective.localPreparationConcurrency,
                    }}
                    onChange={(value) => netdisk.setField('localPreparationConcurrency', value)}
                  />
                  <NumberField
                    id={`${fieldId}-upload`}
                    label="上传并发"
                    value={draft.uploadConcurrency}
                    min={1}
                    max={NETDISK_UPLOAD_MAX}
                    disabled={disableEdits}
                    hint={'归档写入 permit。'}
                    runtime={{
                      configured: status.configured.uploadConcurrency,
                      effective: status.effective.uploadConcurrency,
                    }}
                    onChange={(value) => netdisk.setField('uploadConcurrency', value)}
                  />
                </div>
                <div className="settings-cards">
                  <ResourceReading label="最大在途" value={status.activity.resources.maxInFlight} />
                  <ResourceReading
                    label="本地准备"
                    value={status.activity.resources.localPreparation}
                  />
                  <ResourceReading label="上传" value={status.activity.resources.upload} />
                </div>
              </>
            )}
          </SettingsSection>

          <SettingsSection
            {...NETDISK_SECTIONS.spool}
            icon={HardDrive}
            lede="最大容量和保留线是十进制字符串，避免超大字节数经过 JavaScript number 丢精度；运行时同时报告已保留与可用。"
            state={runtimeState}
          >
            {status === undefined || draft === null ? (
              <NotBuilt>
                <p>spool 设置与实时占用未返回；这里不画 0。</p>
              </NotBuilt>
            ) : (
              <>
                <div className="transfer-grid">
                  <div className="field transfer-field">
                    <label htmlFor={`${fieldId}-spool-max`}>spool 最大字节</label>
                    <input
                      id={`${fieldId}-spool-max`}
                      inputMode="numeric"
                      value={draft.spoolMaxBytes}
                      disabled={disableEdits}
                      onChange={(event) => netdisk.setField('spoolMaxBytes', event.target.value)}
                    />
                  </div>
                  <div className="field transfer-field">
                    <label htmlFor={`${fieldId}-spool-reserve`}>spool 保留字节</label>
                    <input
                      id={`${fieldId}-spool-reserve`}
                      inputMode="numeric"
                      value={draft.spoolReserveBytes}
                      disabled={disableEdits}
                      onChange={(event) =>
                        netdisk.setField('spoolReserveBytes', event.target.value)
                      }
                    />
                  </div>
                </div>
                <dl className="settings-figures">
                  <div>
                    <dt>运行时最大</dt>
                    <dd>{formatDecimalBytes(status.activity.spool.maxBytes)}</dd>
                  </div>
                  <div>
                    <dt>运行时保留线</dt>
                    <dd>{formatDecimalBytes(status.activity.spool.reserveBytes)}</dd>
                  </div>
                  <div>
                    <dt>任务已预留</dt>
                    <dd>{formatDecimalBytes(status.activity.spool.reservedBytes)}</dd>
                  </div>
                  <div>
                    <dt>当前可用</dt>
                    <dd>{formatDecimalBytes(status.activity.spool.availableBytes)}</dd>
                  </div>
                </dl>
              </>
            )}
          </SettingsSection>

          <SettingsSection
            {...NETDISK_SECTIONS.destination}
            icon={HardDrive}
            lede="默认值保存 storage account 的稳定 ID；任务显式目标优先，页面不从 raw/crypt 别名反推账户。"
            state={status === undefined ? runtimeState : 'live'}
          >
            {draft === null ? (
              <p className="settings-loading">正在读取默认目的地…</p>
            ) : (
              <div className="field">
                <label htmlFor={`${fieldId}-destination`}>默认存储账户</label>
                <select
                  id={`${fieldId}-destination`}
                  value={draft.defaultDestinationAccountId}
                  disabled={disableEdits || accountsQuery.isPending || accountsQuery.isError}
                  onChange={(event) =>
                    netdisk.setField('defaultDestinationAccountId', event.target.value)
                  }
                >
                  <option value="">不设置默认目的地</option>
                  {savedDestinationMissing ? (
                    <option value={draft.defaultDestinationAccountId}>
                      当前已保存 · {draft.defaultDestinationAccountId}
                    </option>
                  ) : null}
                  {destinationAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label} · {account.health}
                    </option>
                  ))}
                </select>
                <small className="field-hint">
                  保存时服务端再次验证目的地；失效或不存在会以 NETDISK_DEFAULT_DESTINATION_INVALID
                  拒绝。
                </small>
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            {...NETDISK_SECTIONS.publication}
            icon={Clapperboard}
            lede="发布是归档验证之后的独立工作流。默认仅归档；任务创建时显式策略可以覆盖这里。"
            state={status === undefined ? runtimeState : 'live'}
          >
            {draft === null ? null : (
              <div className="field">
                <label htmlFor={`${fieldId}-publication`}>新任务默认策略</label>
                <select
                  id={`${fieldId}-publication`}
                  value={draft.defaultPublicationPolicy}
                  disabled={disableEdits}
                  onChange={(event) =>
                    netdisk.setField(
                      'defaultPublicationPolicy',
                      event.target.value as PublicationPolicy,
                    )
                  }
                >
                  {(Object.keys(PUBLICATION_LABELS) as PublicationPolicy[]).map((policy) => (
                    <option key={policy} value={policy}>
                      {PUBLICATION_LABELS[policy]}
                    </option>
                  ))}
                </select>
                <small className="field-hint">
                  发布失败不回滚已经完成双回读的归档；取消发布也不删除云端对象。
                </small>
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            {...NETDISK_SECTIONS.cleanup}
            icon={Eraser}
            lede="全局能力开关与任务冻结策略同时满足才可进入预览；设置页不会直接执行任何删除。"
            state={status === undefined ? runtimeState : 'live'}
          >
            {draft === null ? null : (
              <>
                <div className="transfer-grid">
                  <label className="instance-form-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.sourceStagingCleanupEnabled}
                      disabled={disableEdits}
                      onChange={(event) =>
                        netdisk.setField('sourceStagingCleanupEnabled', event.target.checked)
                      }
                    />
                    <span>允许清理任务自己创建的来源暂存对象</span>
                  </label>
                  <label className="instance-form-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.sourceDeleteEnabled}
                      disabled={disableEdits}
                      onChange={(event) =>
                        netdisk.setField('sourceDeleteEnabled', event.target.checked)
                      }
                    />
                    <span>允许对本人已选来源生成删除预览</span>
                  </label>
                  <NumberField
                    id={`${fieldId}-delete-grace`}
                    label="来源删除宽限秒数"
                    value={draft.sourceDeleteGraceSeconds}
                    min={0}
                    max={NETDISK_DELETE_GRACE_MAX_SECONDS}
                    disabled={disableEdits}
                    hint="0–2592000 秒；这是额外等待门，不会跳过其他安全门。"
                    onChange={(value) => netdisk.setField('sourceDeleteGraceSeconds', value)}
                  />
                </div>
                <ul className="recovery-checklist">
                  {DELETION_GATES.map((gate) => (
                    <li key={gate.label} className="recovery-check">
                      <Lock size={16} strokeWidth={1.9} aria-hidden="true" />
                      <span className="recovery-check-label">{gate.label}</span>
                      <span className="recovery-check-detail">{gate.detail}</span>
                    </li>
                  ))}
                </ul>
                <p className="field-hint">
                  服务商删除语义是<strong>移入回收站</strong>
                  ，不是物理擦除声明；分享链接也不会授予删除分享者原件的边界。
                </p>
              </>
            )}
          </SettingsSection>

          <SettingsSection
            {...NETDISK_SECTIONS.safety}
            icon={ShieldCheck}
            lede="保存使用修订 CAS、CSRF、管理员范围幂等收据和当前 MFA；同一参数的不确定重试复用同一幂等键。"
            state={runtimeState}
          >
            {draft === null ? null : (
              <>
                {netdisk.problems.length === 0 ? null : (
                  <ul className="form-errors" role="alert">
                    {netdisk.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                )}
                {netdisk.staleRevision ? (
                  <p className="inline-message error-message" role="alert">
                    <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                    服务端修订已变化，当前草稿不会覆盖它。请重新载入后再编辑。
                  </p>
                ) : null}
                {netdisk.refreshFailed ? (
                  <p className="inline-message error-message" role="alert">
                    <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                    后台刷新失败；屏幕仍显示上一版读数。
                  </p>
                ) : null}
                <div className="field">
                  <label htmlFor={`${fieldId}-mfa`}>当前两步验证码</label>
                  <span className="input-with-icon">
                    <KeyRound size={15} strokeWidth={1.8} aria-hidden="true" />
                    <input
                      id={`${fieldId}-mfa`}
                      aria-describedby={`${fieldId}-mfa-hint`}
                      type="password"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={netdisk.mfaCode}
                      disabled={disableEdits}
                      onChange={(event) => netdisk.setMfaCode(event.target.value)}
                    />
                  </span>
                  <small id={`${fieldId}-mfa-hint`} className="field-hint">
                    输入当前 6 位一次性验证码；保存尝试后立即从页面状态清除。
                  </small>
                </div>
                {/*
                 * What the save area is currently in, in one line.
                 *
                 * Five of the six states already produced a message somewhere on
                 * this section; `dirty` produced nothing at all, so a page with
                 * unsaved edits looked identical to a saved one apart from a
                 * button that happened to be enabled. Priority order matters: a
                 * revision conflict outranks "unsaved", because saving is the
                 * thing that cannot happen, and reporting "有未保存修改" while the
                 * save is actually blocked would send someone to press it.
                 */}
                <p className="settings-save-state" data-state={saveState}>
                  {SAVE_STATE_LABELS[saveState]}
                </p>
                <div className="instance-form-actions">
                  <button
                    type="button"
                    className="primary-action"
                    disabled={!netdisk.canSave}
                    onClick={netdisk.save}
                  >
                    <Save size={15} strokeWidth={1.8} aria-hidden="true" />
                    {netdisk.isSaving ? '正在保存…' : '保存网盘设置'}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={netdisk.isSaving || (!netdisk.dirty && !netdisk.staleRevision)}
                    onClick={netdisk.reload}
                  >
                    重新载入
                  </button>
                </div>
                {netdisk.saved ? (
                  <p className="inline-message success-message" role="status">
                    <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />{' '}
                    设置已保存并返回新修订。
                  </p>
                ) : null}
                {netdisk.saveError === null ? null : (
                  <p className="inline-message error-message" role="alert">
                    <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                    {netdiskSaveErrorMessage(netdisk.saveError)}
                  </p>
                )}
                <p className="field-hint">
                  <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
                  云端解密回读 SHA-256 通过前，绝不删除本地唯一原件。token、authorization
                  code、dlink 与提取码不进入此页面、URL 或浏览器存储。
                </p>
              </>
            )}
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}
