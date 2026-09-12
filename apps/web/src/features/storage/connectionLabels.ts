import type {
  CloudConnectionAction,
  CloudConnectionAuthState,
  CloudConnectionCapability,
  CloudConnectionProvisionState,
  CloudConnectionRateLimitCode,
  CloudConnectionReference,
  CloudOAuthFailureCode,
  CloudProvider,
} from '@ptvault/contracts';

export const PROVIDER_LABELS: Record<CloudProvider, string> = {
  BAIDU: '百度网盘',
  ONEDRIVE: 'OneDrive',
};

export const AUTH_STATE_LABELS: Record<CloudConnectionAuthState, string> = {
  CONNECTED: '已连接',
  REAUTH_REQUIRED: '需要重新授权',
  DISABLED: '已停用',
  DISCONNECTED: '已断开',
  ERROR: '连接异常',
};

export const AUTH_STATE_DETAILS: Record<CloudConnectionAuthState, string> = {
  CONNECTED: '服务端持有可用授权，能代表这个账户执行已授予的操作。',
  REAUTH_REQUIRED: '授权已失效；重新授权会保留连接身份和现有绑定。',
  DISABLED: '管理员停用了这个连接；授权仍在，重新启用不需要再次登录。',
  DISCONNECTED: '服务端已丢弃授权；需要新建 OAuth 流程才能再次使用。',
  ERROR: '服务端报告连接异常；这不等于授权已经被撤销。',
};

export const PROVISION_STATE_LABELS: Record<CloudConnectionProvisionState, string> = {
  NOT_REQUESTED: '未请求配置',
  PROVISIONING: '正在配置',
  READY: '配置就绪',
  PROVISION_FAILED: '配置失败',
};

export const PROVISION_STATE_DETAILS: Record<CloudConnectionProvisionState, string> = {
  NOT_REQUESTED: '尚未为这个连接物化存储目的地；来源连接可以保持这一状态。',
  PROVISIONING: '服务端正在物化受控配置并执行校验。',
  READY: '服务端已经完成配置；可用范围仍以能力与动作列表为准。',
  PROVISION_FAILED: '授权流程已经结束，但服务端物化存储目的地失败；连接会保留供诊断。',
};

export const CAPABILITY_LABELS: Record<CloudConnectionCapability, string> = {
  SOURCE_BROWSE: '来源浏览',
  SOURCE_DOWNLOAD: '来源下载',
  SHARE_TRANSFER: '分享转存',
  SOURCE_DELETE: '可删除本人文件',
  ARCHIVE_DESTINATION: '归档目的地',
  JELLYFIN_MOUNT: 'Jellyfin 挂载',
  RECOVERY_ELIGIBLE: '可作为恢复副本',
  RECOVERY_ACTIVE: '恢复副本已启用',
};

export const CAPABILITY_DETAILS: Record<CloudConnectionCapability, string> = {
  SOURCE_BROWSE: '可列出这个账户的目录与文件，供任务选择来源。',
  SOURCE_DOWNLOAD: '可从这个账户读取数据作为迁移来源。',
  SHARE_TRANSFER: '可将分享内容转存到系统管理的目录。',
  SOURCE_DELETE: '通过迁移安全门后，可删除管理员明确选中的本人文件。',
  ARCHIVE_DESTINATION: '可作为加密归档写入目的地。',
  JELLYFIN_MOUNT: '可作为 Jellyfin 的读取挂载。',
  RECOVERY_ELIGIBLE: '技术上具备资格，但尚未声明已进入当前恢复故障域。',
  RECOVERY_ACTIVE: '已经实际纳入当前恢复故障域。',
};

export const ACTION_LABELS: Record<CloudConnectionAction, string> = {
  START_OAUTH: '连接账户',
  REAUTHORIZE: '重新授权',
  TEST: '测试连接',
  EDIT: '编辑名称',
  ENABLE: '启用',
  DISABLE: '停用',
  DISCONNECT: '断开',
  BROWSE: '浏览来源',
  PROVISION: '创建归档目的地',
  TAKEOVER_LEGACY: '接管旧目的地',
};

export const RATE_LIMIT_LABELS: Record<CloudConnectionRateLimitCode, string> = {
  PROVIDER_RATE_LIMITED: '服务商限速',
  BAIDU_RATE_LIMITED: '百度网盘限速',
  ONEDRIVE_RATE_LIMITED: 'OneDrive 限速',
};

export const OAUTH_FAILURE_LABELS: Record<CloudOAuthFailureCode, string> = {
  STATE_INVALID: '授权状态无效，请发起新流程。',
  FLOW_EXPIRED: '授权流程已过期，请发起新流程。',
  FLOW_ALREADY_USED: '授权流程已经使用过，请发起新流程。',
  PROVIDER_MISMATCH: '回调服务商与发起流程不一致。',
  SESSION_MISMATCH: '登录会话已经变化，请发起新流程。',
  REDIRECT_URI_MISMATCH: '回调地址配置不一致，请检查服务端配置。',
  TOKEN_EXCHANGE_FAILED: '服务商未完成令牌交换，请稍后重试。',
  IDENTITY_MISMATCH: '重新授权返回的账户身份与原连接不一致。',
  USER_CANCELLED: '你取消了这次授权。',
  NOT_PROVISIONED: '登录已完成，但服务端物化存储目的地失败。',
};

/** All eight canonical reference kinds, kept in one exhaustively checked map. */
export function referenceLabel(reference: CloudConnectionReference): string {
  const count = reference.count;
  switch (reference.kind) {
    case 'SOURCE_IMPORT_JOB':
      return `${count} 笔来源迁移任务`;
    case 'DESTINATION_IMPORT_JOB':
      return `${count} 笔目的地迁移任务`;
    case 'ACTIVE_OFFLOAD_JOB':
      return `${count} 笔活动下云任务`;
    case 'MOUNT':
      return `${count} 个挂载`;
    case 'CLOUD_CATALOG':
      return `${count} 条云端目录记录`;
    case 'RECOVERY_COPY':
      return `${count} 份恢复副本`;
    case 'CLOUD_REPLICA':
      return `${count} 份活动云副本`;
    case 'STORAGE_BINDING':
      return `${count} 个存储绑定`;
  }
}
