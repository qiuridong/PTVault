import { SetupOverviewSchema, type NetdiskSettingsStatus, type SetupCheck, type SetupConfigView, type SetupOverview, type SetupUseCase } from '@ptvault/contracts';

import type { AppConfig } from '../config/env.js';

const MISSING_LABELS = {
  ACTIVE_MODE: '启用所选用途',
  SECRET_ROOT: '私密凭据目录',
  SPOOL_ROOT: '临时文件目录',
  BAIDU_PROVIDER: '百度授权组件',
  RCLONE_CONFIG: '网盘配置',
  RECOVERY_ACCOUNTS: '两个恢复账户',
  RECOVERY_RUNTIME: '恢复组件',
} as const;

export function configuredUseCases(config: AppConfig): SetupUseCase[] {
  return [
    ...(config.importSecretRoot !== null || config.importEnabled ? ['NETDISK' as const] : []),
    ...(config.mode === 'ACTIVE' && config.offloadEnabled !== false ? ['PT_OFFLOAD' as const] : []),
    ...(config.jellyfinUrl !== null ? ['JELLYFIN' as const] : []),
  ];
}

/** An explanation of existing authorities, never a second capability/configuration system. */
export function buildSetupOverview(input: {
  config: AppConfig;
  netdisk: NetdiskSettingsStatus;
  useCases?: SetupUseCase[];
  configuration?: SetupConfigView;
  applying?: boolean;
  offloadConfigured: boolean;
  publicationEnabled: boolean;
  connections: readonly { provider: string; authState: string; capabilities: readonly string[] }[];
  accounts: readonly { id: string; health: string }[];
  qbInstances: readonly { enabled: boolean; hasCredential: boolean; lastSyncAt: number | null; lastSyncError: string | null }[];
  recoveryReady: boolean;
}): SetupOverview {
  const useCases = input.useCases ?? input.configuration?.values.useCases ?? configuredUseCases(input.config);
  const netdiskSelected = useCases.includes('NETDISK');
  const ptSelected = useCases.includes('PT_OFFLOAD');
  const mediaSelected = ptSelected || useCases.includes('JELLYFIN');
  const storageSelected = netdiskSelected || ptSelected;
  const healthy = new Set(input.accounts.filter((account) => account.health === 'HEALTHY').map((account) => account.id));
  const recoveryIds = netdiskSelected ? input.config.importRecoveryAccountIds : [...healthy];
  const recoveryCount = new Set(recoveryIds.filter((id) => healthy.has(id))).size;
  const sourceConnected = input.connections.some((connection) => connection.provider === 'BAIDU' && connection.authState === 'CONNECTED' && connection.capabilities.includes('SOURCE_DOWNLOAD'));
  const qbConnected = input.qbInstances.some((instance) => instance.enabled && instance.hasCredential && instance.lastSyncAt !== null && instance.lastSyncError === null);
  const checks: SetupCheck[] = [];
  function add(id: SetupCheck['id'], label: string, selected: boolean, ready: boolean, detail: string, href: string) {
    checks.push({ id, label, state: !selected ? 'NOT_SELECTED' : ready ? 'READY' : 'NEEDS_SETUP', detail: selected ? detail : '当前用途不需要，可以以后再接入。', href });
  }
  const missing = input.netdisk.runtimeMissing?.map((key) => MISSING_LABELS[key]) ?? [];
  add('NETDISK_RUNTIME', '网盘导入环境', netdiskSelected, input.netdisk.provisioned,
    input.netdisk.provisioned ? '导入组件已就绪，是否允许新建任务仍由网盘设置控制。' : missing.length ? `还需要：${missing.join('、')}。` : '导入环境尚未准备好；现有任务开关不会替代这些条件。', '/settings/setup');
  add('BAIDU_SOURCE', '百度来源账户', netdiskSelected, sourceConnected,
    sourceConnected ? '已连接具有下载能力的百度账户；登录成功不等于已验证大文件下载。' : '先连接百度账户，再选择要导入的文件。', '/storage-accounts?from=setup');
  add('DESTINATION', '加密存储目标', storageSelected, healthy.size > 0,
    healthy.size > 0 ? `最近的账户检查中，有 ${healthy.size} 个目标可用。任务开始前还会重新核对容量。` : '连接 OneDrive 或导入已有 rclone 配置，并准备加密存储目标。', '/storage-accounts?from=setup');
  add('RECOVERY_ACCOUNTS', '恢复资料的两个存储账户', storageSelected, recoveryCount >= 2,
    recoveryCount >= 2 ? '已配置至少两个可用的恢复账户。' : '恢复资料需要保存在两个可用账户中；这与媒体文件的默认目标是两件事。', '/settings/setup#recovery-accounts');
  add('RECOVERY_MATERIAL', '恢复资料与恢复演练', storageSelected, input.recoveryReady,
    input.recoveryReady ? '当前恢复资料已通过原有检查。' : '保存恢复文件并完成现有恢复检查；不要只把“已导出”当成可以恢复。', '/recovery?from=setup');
  add('SPOOL', '临时目录配置', netdiskSelected, input.config.importSpoolRoot !== null,
    input.config.importSpoolRoot !== null ? '目录配置已生效。下面的读写检查会使用服务账户，不会把目录存在当作可写。' : '先选择临时文件目录，再检查它的可用空间和写入权限。', '/settings/setup#file-locations');
  add('QB_CONNECTION', 'qBittorrent 连接', ptSelected, qbConnected,
    qbConnected ? '至少一个已启用实例有凭据且完成过同步。' : '先保存 qBittorrent 连接并刷新一次。没有凭据的预留实例不算已连接。', '/settings?from=setup#qb');
  add('QB_PATHS', '本地文件位置', ptSelected, input.config.qbAllowedRoots.length > 0,
    input.config.qbAllowedRoots.length > 0 ? '已限定来源目录。请选一个小文件运行实际读取检查，确认容器路径映射正确。' : '需要确认 qBittorrent 文件在服务器上的实际目录。不会修改 qB 的下载位置。', '/settings/setup#file-locations');
  add('JELLYFIN', 'Jellyfin 连接与文件映射', mediaSelected, input.config.jellyfinUrl !== null && input.config.jellyfinTokenFile !== null && input.config.jellyfinPathMaps.length > 0,
    input.config.jellyfinUrl !== null ? '连接参数已配置；库访问和播放检查仍使用现有 Jellyfin 检查。' : ptSelected ? '本地 PT 迁移保留播放占用保护，因此需要接入 Jellyfin。仅网盘归档不需要它。' : '接入 Jellyfin 并确认它能看到发布目录。', '/settings?from=setup#jellyfin');
  add('CREATION', '允许手动创建网盘任务', netdiskSelected, input.netdisk.effective.creationEnabled,
    input.netdisk.effective.creationEnabled ? '已允许手动创建；不会自动处理所有文件。' : input.netdisk.configured.creationEnabled ? '开启选择已保存，缺少的运行条件补齐后才会生效。' : '默认尚未开启。准备好后在网盘设置中开启，再主动选择一份小文件试用。', '/settings/netdisk?from=setup#netdisk-runtime');
  return SetupOverviewSchema.parse({
    configurationSource: input.configuration === undefined ? 'SERVER_ENVIRONMENT' : 'MANAGED_INSTALLER',
    configuration: input.configuration ?? null,
    useCases,
    applying: input.applying ?? false,
    checks,
    runtime: { mode: input.config.mode, netdiskConfigured: input.netdisk.provisioned, netdiskCreationEnabled: input.netdisk.effective.creationEnabled, offloadConfigured: input.offloadConfigured, publicationEnabled: input.publicationEnabled },
  });
}
