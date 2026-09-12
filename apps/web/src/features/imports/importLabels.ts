import type {
  ImportAction,
  ImportCurrentCondition,
  ImportDestination,
  ImportDestinationUnavailableReason,
  ImportJobState,
  ImportMediaType,
  ImportPublicationError,
  ImportPublishDisabledReason,
  ImportSourceKind,
  ImportSourceCleanup,
  ImportSourceCleanupGateName,
  ImportSourceCleanupPolicy,
  ImportStep,
  PublicationPolicy,
  PublicationState,
} from '@ptvault/contracts';

/**
 * Every string the import surface puts on screen for a contract value.
 *
 * One table, shared by the list, the detail panel and the create form, because a
 * state with two names is a state the reader has to reconcile: 「等待重试」 in the
 * table and 「重试中」 in the detail read as two different things happening.
 *
 * Human labels explain the operation; stable step codes remain in events,
 * receipts and exported diagnostics for exact technical correlation.
 */

/** The durable steps, in the order they are reached. */
export const IMPORT_STEP_ORDER: readonly ImportStep[] = [
  'SHARE_TRANSFER',
  'DISCOVERING',
  'SOURCE_PREFLIGHT',
  'DOWNLOADING',
  'LOCAL_LANDING',
  'HASHING',
  'UPLOADING_STAGING',
  'STAGING_READBACK',
  'COMMITTING',
  'COMMITTED_READBACK',
  'CONTROL_PLANE_BACKUP',
  'SPOOL_CLEANUP',
  'COMPLETED',
  'MEDIA_PUBLISH',
];

export const IMPORT_STEP_LABELS: Record<ImportStep, string> = {
  SHARE_TRANSFER: '分享转存',
  DISCOVERING: '发现文件',
  SOURCE_PREFLIGHT: '来源预检',
  DOWNLOADING: '百度下载',
  LOCAL_LANDING: '本地落位',
  HASHING: '计算文件校验值',
  UPLOADING_STAGING: '上传云端临时副本',
  STAGING_READBACK: '回读校验临时副本',
  COMMITTING: '确认云端正式副本',
  COMMITTED_READBACK: '回读校验正式副本',
  CONTROL_PLANE_BACKUP: '备份恢复资料',
  SPOOL_CLEANUP: '清理 VPS 暂存',
  COMPLETED: '已完成',
  MEDIA_PUBLISH: 'Jellyfin 发布',
};

export const IMPORT_STEP_HINTS: Partial<Record<ImportStep, string>> = {
  UPLOADING_STAGING: '正在上传云端临时副本；上传完成后还要回读核对内容，不以传输成功代替备份完整。',
  STAGING_READBACK: '正在把云端临时副本读回来校验；此时是校验流量，不是在重复上传。',
  COMMITTING: '临时副本已验过，正在确认正式保存位置；后续还需校验正式副本。',
  COMMITTED_READBACK: '正在回读正式副本并核对校验值；这是最终内容校验，之后仍有恢复资料与暂存收尾。',
  CONTROL_PLANE_BACKUP: '正在保存用于恢复的加密资料；视频字节校验完成不代表本步骤已完成。',
  SPOOL_CLEANUP: '正在释放 VPS 暂存；来源原件仍保留，只有所需验证和恢复资料完成后才会清理本地副本。',
};

export const IMPORT_STATE_LABELS: Record<ImportJobState, string> = {
  QUEUED: '排队中',
  RUNNING: '进行中',
  RETRY_WAIT: '等待重试',
  BLOCKED: '受阻',
  // The suffix is the claim, not decoration: stopping did not delete a sole copy
  // of anything. Dropping it would turn a safety property into a bare failure.
  FAILED_SAFE: '已安全失败',
  CANCELLED_SAFE: '已安全取消',
  COMPLETED: '已完成',
};

/** A CSS state class per job state, so tone never rests on colour alone. */
export const IMPORT_STATE_TONE: Record<
  ImportJobState,
  'neutral' | 'active' | 'warn' | 'bad' | 'ok'
> = {
  QUEUED: 'neutral',
  RUNNING: 'active',
  RETRY_WAIT: 'warn',
  BLOCKED: 'warn',
  FAILED_SAFE: 'bad',
  CANCELLED_SAFE: 'neutral',
  COMPLETED: 'ok',
};

export const IMPORT_CONDITION_LABELS: Record<ImportCurrentCondition, string> = {
  AUTH_REQUIRED: '来源授权待核实',
  RATE_LIMITED: '来源侧限速',
  RESOURCE_WAIT: '等待资源',
  SOURCE_CHANGED: '来源已变化',
  DESTINATION_UNAVAILABLE: '目标不可用',
};

/**
 * What each condition means for the person reading it.
 *
 * Present because the next move differs entirely, and a bare condition name sends
 * someone to re-enter a passcode that was never the problem.
 */
export const IMPORT_CONDITION_HINTS: Record<ImportCurrentCondition, string> = {
  AUTH_REQUIRED: '来源授权、凭据或旧身份需要核实，请按服务端提供的动作核对；不会自动改选账户。',
  RATE_LIMITED: '来源在限速，不需要操作，到时间会自动重试。',
  RESOURCE_WAIT:
    '服务端正在等待资源；具体队列以报告的等待项为准。未报告原因时不推断暂存不足、目标容量或传输进度。',
  SOURCE_CHANGED:
    '来源清单已变化，保留已有归档与回执；需要显式重新核对或重新规划，不自动切换来源。',
  DESTINATION_UNAVAILABLE: '目标云盘此刻不可写，已验证的部分不受影响。',
};

export const PUBLICATION_POLICY_LABELS: Record<PublicationPolicy, string> = {
  ARCHIVE_ONLY: '仅备份到 OneDrive',
  PUBLISH_TO_JELLYFIN: '备份完成后发布到 Jellyfin',
};

/** Short form for a table cell, where the full sentence would not fit. */
export const PUBLICATION_POLICY_SHORT: Record<PublicationPolicy, string> = {
  ARCHIVE_ONLY: '仅备份',
  PUBLISH_TO_JELLYFIN: '发布到 Jellyfin',
};

export const PUBLICATION_STATE_LABELS: Record<PublicationState, string> = {
  // Stated positively so an archive-only job cannot be misread as a publication
  // that has not started yet.
  NOT_REQUESTED: '未发布到 Jellyfin',
  PENDING: '等待发布',
  RUNNING: '发布中',
  PUBLISHED: '已发布',
  FAILED_SAFE: '发布失败（备份未受影响）',
  UNPUBLISHED: '已取消发布',
};

export const IMPORT_SOURCE_LABELS: Record<ImportSourceKind, string> = {
  BAIDU_SHARE: '百度分享链接',
  BAIDU_APP_DIR: '百度账户目录',
  OTHER: '其他来源',
};

export const IMPORT_DESTINATION_KIND_LABELS: Record<ImportDestination['kind'], string> = {
  ONEDRIVE_RAW: 'OneDrive raw',
  STANDALONE_CRYPT: '独立 crypt',
  PT_VAULT_IMPORT: 'PT Vault IMPORT',
};

export const IMPORT_MEDIA_TYPE_LABELS: Record<ImportMediaType, string> = {
  MOVIE: '电影',
  SERIES: '剧集',
};

/** Which Jellyfin content type each media type may be published into. */
export const MEDIA_TYPE_CONTENT: Record<ImportMediaType, 'Movies' | 'Shows'> = {
  MOVIE: 'Movies',
  SERIES: 'Shows',
};

export const DESTINATION_UNAVAILABLE_LABELS: Record<ImportDestinationUnavailableReason, string> = {
  NOT_CONFIGURED: '这台机器上没有配置这个目标。',
  FEATURE_DISABLED: '这台机器上关闭了这个目标。',
  RATE_LIMITED: '这个连接正在被服务商限速，请等账户级重试时间到达。',
  QUOTA_EXHAUSTED: '这个目标已经没有可用容量。',
  CIRCUIT_OPEN: '这个目标刚刚连续失败，正在冷却。',
  AUTH_REQUIRED: '这个目标的授权需要刷新。',
  SHADOW_MODE: '只读影子模式下不写入任何目标。',
};

export const PUBLISH_DISABLED_LABELS: Record<ImportPublishDisabledReason, string> = {
  PUBLICATION_RUNTIME_NOT_CONFIGURED:
    'Jellyfin 连接已配置，但网盘发布运行时尚未装配；请核对媒体 farm、挂载与发布控制器。',
  IMPORT_RUNTIME_NOT_CONFIGURED:
    '网盘导入运行时尚未装配；请到网盘迁移设置核对凭据、spool、恢复账户和 provider。这不代表 Jellyfin 未接入。',
  SHADOW_MODE: '只读影子模式下不会创建媒体库条目。',
  FEATURE_DISABLED: '这台机器上关闭了 Jellyfin 发布。',
  JELLYFIN_NOT_CONFIGURED: '这台机器上没有配置 Jellyfin。',
  NO_ALLOWLISTED_LIBRARY: '服务端还没有允许任何网盘导入媒体库。',
  DESTINATION_UNSUPPORTED: '所选目标不支持发布到 Jellyfin。',
};

export const PUBLICATION_ERROR_LABELS: Record<ImportPublicationError, string> = {
  ARCHIVE_NOT_VERIFIED: '归档对象尚未全部完成 committed 回读校验。',
  DESTINATION_UNMOUNTABLE: '归档目的地没有可用的 Jellyfin 挂载。',
  JELLYFIN_UNREACHABLE: '连不上 Jellyfin。备份本身已经验证通过。',
  JELLYFIN_AUTH_FAILED: 'Jellyfin 拒了令牌。备份本身已经验证通过。',
  NOTIFICATION_REJECTED: '目录与链接都对，只是刷新媒体库的调用被拒——手动扫描一次即可出现。',
  LIBRARY_NOT_ALLOWLISTED: '这个媒体库不在服务端允许的清单里。',
  MEDIA_TYPE_MISMATCH: '媒体类型与这个库的内容类型不相容。',
  PUBLICATION_PATH_CONFLICT: '媒体投影路径与现有目录或其他发布冲突。',
  FARM_LINK_FAILED: '创建 symlink 投影失败，云端对象未受影响。',
  VFS_REFRESH_FAILED: '刷新挂载目录缓存失败，条目可能暂时读不到。',
  READ_PROBE_FAILED: '从 Jellyfin 可见的路径读不到这个链接。',
};

export const IMPORT_ACTION_LABELS: Record<ImportAction, string> = {
  PAUSE: '暂停',
  RESUME: '恢复',
  CANCEL: '取消',
  RETRY: '失败重试',
  PROVIDE_CREDENTIALS: '重新提供凭据',
  REPUBLISH: '重新发布',
  UNPUBLISH: '取消发布',
};

/** What each action will and will not do, shown on the confirmation panel. */
export const IMPORT_ACTION_CONSEQUENCE: Record<ImportAction, string> = {
  PAUSE: '任务会停在当前 checkpoint，已验证的字节和 receipt 都保留。',
  RESUME: '从最后一个 checkpoint 继续，不会重新下载已经验证过的对象。',
  CANCEL: '放弃这次迁移。来源网盘和已提交的云端对象都不会被删除。',
  RETRY: '从最后一个 checkpoint 重跑，会重新核对来源清单与已有 staging。',
  PROVIDE_CREDENTIALS: '把新的提取码交给后台任务；它只在进程内使用一次，不会被保存。',
  REPUBLISH: '重新建立 catalog 与 symlink 投影并再通知一次 Jellyfin，不会重传任何字节。',
  UNPUBLISH: '只移除 catalog/farm 投影与媒体库条目。OneDrive 上的备份一个字节都不会删。',
};

export const SOURCE_CLEANUP_POLICY_LABELS: Record<ImportSourceCleanupPolicy, string> = {
  KEEP: '保留来源',
  JOB_STAGING_ONLY: '只清理任务暂存对象',
  SELECTED_SOURCE: '清理已选本人来源',
};

export const SOURCE_CLEANUP_STATUS_LABELS: Record<ImportSourceCleanup['status'], string> = {
  RUNNING: '执行中',
  COMPLETED: '已完成',
  PARTIAL: '部分完成',
  FOLLOW_UP_REQUIRED: '需要人工跟进',
  FAILED_SAFE: '已安全失败',
};

export const SOURCE_CLEANUP_OBJECT_STATUS_LABELS: Record<
  ImportSourceCleanup['objects'][number]['status'],
  string
> = {
  PENDING: '等待处理',
  PREFLIGHT_VERIFIED: '执行前复核通过',
  PROVIDER_REQUESTED: '服务商已受理',
  COMPLETED: '已完成',
  FOLLOW_UP_REQUIRED: '需要人工跟进',
};

export const SOURCE_CLEANUP_GATE_LABELS: Record<ImportSourceCleanupGateName, string> = {
  GLOBAL_FEATURE_ENABLED: '全局来源清理已启用',
  TASK_POLICY_MATCH: '任务冻结策略相符',
  SOURCE_SCOPE_MATCH: '来源精确范围相符',
  SHARE_OWNER_BOUNDARY: '分享拥有者边界安全',
  MODE_FEATURE_ENABLED: '当前来源模式允许清理',
  MANIFEST_FROZEN: '对象 manifest 已冻结',
  COMMITTED_VERIFIED: 'committed 回读已验证',
  HASH_CHAIN_MATCH: '哈希链一致',
  RECOVERY_GENERATION_VERIFIED: '恢复代次已验证',
  SOURCE_UNCHANGED: '来源对象未漂移',
  NO_ACTIVE_REFERENCES: '没有活跃引用',
  SAME_ACCOUNT_DELETE_CAPABLE: '同一账户具备删除能力',
  GRACE_PERIOD_ELAPSED: '宽限期已过',
  PUBLICATION_READY: '发布门已满足',
};
