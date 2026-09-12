import {
  CloudConnectionErrorResponseSchema,
  type CloudConnection,
  type CloudConnectionAction,
  type CloudConnectionCapabilities,
  type CloudConnectionReferenceSummary,
  type CloudProvider,
} from '@ptvault/contracts';

import { ApiError, ContractError } from '../../api/client.js';
import {
  ACTION_LABELS,
  AUTH_STATE_DETAILS,
  AUTH_STATE_LABELS,
  CAPABILITY_DETAILS,
  CAPABILITY_LABELS,
  PROVIDER_LABELS,
  PROVISION_STATE_DETAILS,
  PROVISION_STATE_LABELS,
  RATE_LIMIT_LABELS,
  referenceLabel,
} from './connectionLabels.js';

const TELEMETRY_STALE_MS = 10 * 60_000;
const CARD_ACTION_ORDER: readonly CloudConnectionAction[] = [
  'BROWSE',
  'PROVISION',
  'TAKEOVER_LEGACY',
  'TEST',
  'EDIT',
  'REAUTHORIZE',
  'ENABLE',
  'DISABLE',
  'DISCONNECT',
];

export type ConnectionMutationAction = Extract<
  CloudConnectionAction,
  'TEST' | 'EDIT' | 'ENABLE' | 'DISABLE' | 'DISCONNECT'
>;

export type ConnectionCardViewModel = {
  id: string;
  revision: number;
  provider: CloudProvider;
  providerLabel: string;
  label: string;
  principalMasked: string;
  authState: CloudConnection['authState'];
  authLabel: string;
  authDetail: string;
  provisionState: CloudConnection['provisionState'];
  provisionLabel: string;
  provisionDetail: string;
  provisionFailureCode: string | null;
  legacy: boolean;
  readOnly: boolean;
  clientProfile: CloudConnection['clientProfile'];
  capabilities: Array<{
    code: CloudConnection['capabilities'][number];
    label: string;
    detail: string;
  }>;
  actions: Array<{ code: CloudConnectionAction; label: string }>;
  activeJobCount: number;
  references: string[];
  lastCheckedLabel: string;
  telemetryStale: boolean;
  accessExpiresLabel: string;
  storageDestinationCount: number;
  throttle: null | {
    codeLabel: string;
    retryAtLabel: string;
    waitLabel: string;
    activeJobCount: number;
  };
};

function timestampLabel(value: number | null): string {
  return value === null ? '从未' : new Date(value).toLocaleString('zh-CN');
}

function waitLabel(retryAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  if (seconds < 60) return `约 ${seconds} 秒后`;
  if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟后`;
  return timestampLabel(retryAt);
}

/**
 * The sole server-DTO → card projection. Provider names never create capability
 * or authority: an action must occur in both the deployment and connection
 * lists, while every capability comes verbatim from the connection contract.
 */
export function toConnectionCardViewModel(
  connection: CloudConnection,
  deployment: CloudConnectionCapabilities,
  now: number,
): ConnectionCardViewModel {
  const deploymentActions = new Set(deployment.supportedActions);
  const connectionActions = new Set(connection.supportedActions);
  const retryAt = connection.rateLimit.retryAt;
  const throttle =
    retryAt !== null && connection.rateLimit.code !== null && retryAt > now
      ? {
          codeLabel: RATE_LIMIT_LABELS[connection.rateLimit.code],
          retryAtLabel: timestampLabel(retryAt),
          waitLabel: waitLabel(retryAt, now),
          activeJobCount: connection.activeJobCount,
        }
      : null;

  return {
    id: connection.id,
    revision: connection.revision,
    provider: connection.provider,
    providerLabel: PROVIDER_LABELS[connection.provider],
    label: connection.label,
    principalMasked: connection.principalMasked,
    clientProfile: connection.clientProfile,
    authState: connection.authState,
    authLabel: AUTH_STATE_LABELS[connection.authState],
    authDetail: AUTH_STATE_DETAILS[connection.authState],
    provisionState: connection.provisionState,
    provisionLabel: PROVISION_STATE_LABELS[connection.provisionState],
    provisionDetail: PROVISION_STATE_DETAILS[connection.provisionState],
    provisionFailureCode: connection.provisionFailureCode,
    legacy: connection.legacy,
    readOnly: connection.readOnly,
    capabilities: connection.capabilities.map((code) => ({
      code,
      label: CAPABILITY_LABELS[code],
      detail: CAPABILITY_DETAILS[code],
    })),
    actions:
      deployment.disabledReason === null
        ? CARD_ACTION_ORDER.filter(
            (code) =>
              deploymentActions.has(code) &&
              connectionActions.has(code) &&
              (code !== 'REAUTHORIZE' ||
                (deployment.oauthEnabled && deployment.providers.includes(connection.provider)) ||
                (connection.provider === 'BAIDU' && deployment.baiduDeviceEnabled === true)),
          ).map((code) => ({ code, label: ACTION_LABELS[code] }))
        : [],
    activeJobCount: connection.activeJobCount,
    references: connection.activeReferences
      .filter((reference) => reference.count > 0)
      .map(referenceLabel),
    lastCheckedLabel: timestampLabel(connection.lastCheckedAt),
    telemetryStale:
      connection.lastCheckedAt === null || now - connection.lastCheckedAt > TELEMETRY_STALE_MS,
    accessExpiresLabel:
      connection.accessExpiresAt === null
        ? '服务端未提供'
        : timestampLabel(connection.accessExpiresAt),
    storageDestinationCount: connection.storageAccountIds.length,
    throttle,
  };
}

export function canStartOAuth(
  capabilities: CloudConnectionCapabilities,
  provider: CloudProvider,
): boolean {
  return (
    capabilities.oauthEnabled &&
    capabilities.disabledReason === null &&
    capabilities.providers.includes(provider) &&
    capabilities.supportedActions.includes('START_OAUTH')
  );
}

export type ConnectionErrorPresentation = {
  message: string;
  references: string[];
  revisionConflict: boolean;
  idempotencyConflict: boolean;
  retrySameIntent: boolean;
};

function referenceSummaryLines(summary: CloudConnectionReferenceSummary): string[] {
  const entries: Array<[number, string]> = [
    [summary.activeImportJobs, '笔来源迁移任务'],
    [summary.destinationImportJobs, '笔目的地迁移任务'],
    [summary.activeOffloadJobs, '笔活动下云任务'],
    [summary.mounts, '个挂载'],
    [summary.storageBindings, '个存储绑定'],
    [summary.activeCatalogEntries, '条云端目录记录'],
    [summary.recoveryCopies, '份恢复副本'],
    [summary.activeCloudReplicas, '份活动云副本'],
  ];
  return entries.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
}

function result(
  message: string,
  options: Partial<Omit<ConnectionErrorPresentation, 'message'>> = {},
): ConnectionErrorPresentation {
  return {
    message,
    references: [],
    revisionConflict: false,
    idempotencyConflict: false,
    retrySameIntent: false,
    ...options,
  };
}

/** Fixed, secret-free UI copy keyed only by canonical code/status. */
export function presentConnectionError(error: unknown): ConnectionErrorPresentation {
  if (error instanceof ContractError) {
    return result('网页与服务端的云盘连接契约不一致；操作结果尚未确认，请刷新后核对。');
  }
  if (!(error instanceof ApiError)) {
    return result('网络响应中断，操作结果尚未确认；可用同一操作重试。', {
      retrySameIntent: true,
    });
  }

  const parsedDetails = CloudConnectionErrorResponseSchema.safeParse(error.details);
  const references =
    parsedDetails.success && parsedDetails.data.references !== undefined
      ? referenceSummaryLines(parsedDetails.data.references)
      : [];

  switch (error.code) {
    case 'MFA_STEP_UP_FAILED':
      return result('动态验证码无效或已过期，请输入新的 6 位验证码。');
    case 'CONNECTION_REVISION_CONFLICT':
      return result('连接已被其他操作更新；正在刷新最新版本，已输入的名称会保留。', {
        revisionConflict: true,
      });
    case 'CONNECTION_REFERENCED':
      return result('仍有业务对象引用这个连接，服务端没有断开授权。', { references });
    case 'CONNECTION_READ_ONLY':
      return result('这是只读连接，服务端没有执行修改。');
    case 'CONNECTION_AUTH_STATE_INVALID':
      return result('连接当前状态不允许执行这项操作，请刷新后按可用动作继续。');
    case 'CONNECTION_TEST_FAILED':
      return result('服务端未通过连接测试；授权与现有绑定均未改变。');
    case 'CONNECTION_NOT_FOUND':
      return result('连接已经不存在，请刷新列表。');
    case 'FLOW_NOT_FOUND':
      return result('授权流程不存在，请发起新流程。');
    case 'FLOW_EXPIRED':
      return result('授权流程已过期，请发起新流程。');
    case 'FLOW_ALREADY_USED':
      return result('授权流程已经使用过，请发起新流程。');
    case 'USER_CANCELLED':
      return result('你取消了这次授权。');
    case 'NOT_PROVISIONED':
      return result('网页登录尚未在这台服务端配置完成。');
    case 'ONEDRIVE_PROVISION_DISABLED':
      return result('这台服务端尚未启用 OneDrive 受控归档物化；现有连接与目的地没有改变。');
    case 'ONEDRIVE_CONNECTION_NOT_FOUND':
      return result('OneDrive 连接已经不存在，请刷新列表。');
    case 'ONEDRIVE_LEGACY_ACCOUNT_NOT_FOUND':
      return result('所选旧目的地已经不存在，请刷新存储目的地。');
    case 'ONEDRIVE_CONNECTION_NOT_ELIGIBLE':
      return result('连接当前身份或授权状态不满足归档物化条件。');
    case 'ONEDRIVE_PROVISION_ALREADY_BOUND':
      return result('这个连接已经绑定存储目的地；服务端没有重复物化。');
    case 'ONEDRIVE_PROVISION_IN_PROGRESS':
      return result('这个连接的归档物化仍在服务端处理中，请稍后用同一操作重试。', {
        retrySameIntent: true,
      });
    case 'ONEDRIVE_CONNECTION_REVISION_CONFLICT':
    case 'ONEDRIVE_PROVISION_FENCE_REJECTED':
    case 'ONEDRIVE_LEGACY_ACCOUNT_CONFLICT':
      return result('连接或旧目的地已经被更新；请刷新后核对精确 revision 与 remote。', {
        revisionConflict: true,
      });
    case 'ONEDRIVE_LEGACY_IDENTITY_MISMATCH':
    case 'ONEDRIVE_LEGACY_REMOTE_MISMATCH':
      return result('旧目的地的 drive 身份或 crypt target 与当前连接不一致，服务端拒绝接管。');
    case 'ONEDRIVE_ESCROW_VERIFY_FAILED':
      return result('恢复 escrow 回读校验未通过；候选绑定已回滚，连接仍保留。');
    case 'ONEDRIVE_CRYPT_ROUNDTRIP_FAILED':
      return result('受控 crypt 往返校验未通过；候选绑定已回滚，连接仍保留。');
    case 'ONEDRIVE_PROVISION_FAILED':
      return result('归档物化未完成；候选配置已回滚，网页登录连接仍保留以便重试。');
    case 'IDEMPOTENCY_OPERATION_IN_PROGRESS':
      return result('同一操作仍在服务端处理中，请稍后用同一操作重试。', {
        retrySameIntent: true,
      });
    case 'IDEMPOTENCY_KEY_CONFLICT':
      return result('操作标识与请求内容冲突；将为当前意图生成新的操作标识。', {
        idempotencyConflict: true,
      });
    case 'IDEMPOTENCY_KEY_REQUIRED':
    case 'IDEMPOTENCY_RECEIPT_CORRUPT':
      return result('服务端未能确认幂等操作收据；请刷新连接状态后再继续。');
    case 'INVALID_REQUEST':
      return result('请求未通过服务端校验；请检查名称与验证码。');
    case 'STATE_INVALID':
    case 'PROVIDER_MISMATCH':
    case 'SESSION_MISMATCH':
    case 'REDIRECT_URI_MISMATCH':
    case 'TOKEN_EXCHANGE_FAILED':
    case 'IDENTITY_MISMATCH':
      return result('授权回调未通过服务端校验，请发起新流程或检查服务端配置。');
  }

  if (error.status === 401) return result('会话已过期，请重新登录。');
  if (error.status === 403) return result('当前会话没有执行这项操作的权限。');
  if (error.status === 410) return result('授权流程已经失效，请发起新流程。');
  if (error.status === 429) {
    return result('该连接正在被服务商限速；其他连接仍可继续工作。', {
      retrySameIntent: true,
    });
  }
  if (error.status >= 500) {
    return result('服务端响应中断，操作结果尚未确认；可用同一操作重试。', {
      retrySameIntent: true,
    });
  }
  return result(`服务端拒绝了这项操作（HTTP ${error.status}）。`);
}

export function connectionErrorMessage(error: unknown): string {
  return presentConnectionError(error).message;
}
