import type { LegacyImportSourceBinding } from '@ptvault/contracts';

import { ApiError, ContractError } from '../../api/client.js';
import type { CloudConnectionListResponse } from '../storage/connectionApi.js';

export function legacyBindingMode(binding: LegacyImportSourceBinding) {
  if (binding.state === 'NOT_REQUIRED' && binding.nextStep === 'NONE' && !binding.replanRequired)
    return 'NONE';
  if (
    binding.state === 'REPLAN_REQUIRED' ||
    binding.nextStep === 'REPLAN_PRESERVE_ARCHIVE' ||
    binding.replanRequired
  )
    return 'REPLAN';
  if (binding.state === 'VERIFIED' && binding.nextStep === 'RETRY_OR_RESUME') return 'VERIFIED';
  if (binding.state === 'IDENTITY_REQUIRED' && binding.nextStep === 'SELECT_ENV_CONNECTION')
    return 'SELECT';
  return 'INCONSISTENT';
}

/** Explicit environment provenance and the two server authority lists, never a label/default account. */
export function legacyEnvironmentConnections(response: CloudConnectionListResponse | undefined) {
  if (
    !response ||
    response.capabilities.disabledReason !== null ||
    !response.capabilities.supportedActions.includes('BROWSE')
  )
    return [];
  return response.connections.filter(
    (connection) =>
      connection.provider === 'BAIDU' &&
      connection.legacy &&
      connection.readOnly &&
      connection.supportedActions.includes('BROWSE'),
  );
}

export type LegacySourceError = {
  message: string;
  uncertain: boolean;
  refresh: boolean;
  replan: boolean;
  authRequired: boolean;
};

function errorResult(
  message: string,
  flags: Partial<Omit<LegacySourceError, 'message'>> = {},
): LegacySourceError {
  return {
    message,
    uncertain: false,
    refresh: false,
    replan: false,
    authRequired: false,
    ...flags,
  };
}

/** Never echoes server/provider prose or the MFA input. */
export function presentLegacySourceError(error: unknown): LegacySourceError {
  if (error instanceof ContractError)
    return errorResult(
      '来源绑定响应与当前契约不一致，结果待核实；请刷新核对，或重试同一绑定请求。',
      { uncertain: true },
    );
  if (!(error instanceof ApiError))
    return errorResult('网络响应中断，结果待核实；可刷新核对，或输入新的验证码重试同一绑定请求。', {
      uncertain: true,
    });
  switch (error.code) {
    case 'IMPORT_REVISION_CONFLICT':
      return errorResult('任务修订已变化，正在刷新；请核对最新修订并重新确认原来源身份。', {
        refresh: true,
      });
    case 'IMPORT_IDEMPOTENCY_CONFLICT':
      return errorResult(
        '幂等操作标识与请求不一致，服务端拒绝了该请求；正在刷新，请核对后重新确认。',
        { refresh: true },
      );
    case 'SOURCE_CHANGED':
      return errorResult(
        '来源已变化，旧清单与当前来源不一致；保留历史数据并重新规划，不切换到其他来源。',
        { refresh: true, replan: true },
      );
    case 'AUTH_LEGACY_REPLAN_REQUIRED':
      return errorResult('历史来源身份或清单证据不完整，需要保留旧任务并重新规划。', {
        refresh: true,
        replan: true,
      });
    case 'AUTH_REQUIRED':
      return errorResult('原来源环境连接需要恢复授权或解除限流；请核对原账户，不自动切换连接。', {
        refresh: true,
        authRequired: true,
      });
    case 'AUTH_LEGACY_BINDING_CONFLICT':
      return errorResult('旧任务已经绑定其他来源身份；正在刷新，页面不会覆盖既有绑定。', {
        refresh: true,
      });
    case 'AUTH_LEGACY_BINDING_NOT_APPLICABLE':
      return errorResult('当前任务不适用旧来源绑定；正在重新读取任务与绑定状态。', {
        refresh: true,
      });
    case 'MFA_STEP_UP_FAILED':
      return errorResult('动态验证码无效或已过期，请输入新的 6 位验证码。');
    case 'IMPORT_NOT_FOUND':
      return errorResult('原任务已不存在，请返回任务列表核对。');
  }
  if (error.status === 401) return errorResult('会话已过期，请重新登录后核对原来源身份。');
  if (error.status === 403)
    return errorResult('当前会话没有绑定来源身份的权限；请核对会话与两步验证。');
  if (error.status === 409)
    return errorResult('来源绑定条件已变化，正在刷新；请按服务端当前状态重新核对。', {
      refresh: true,
    });
  if (error.status >= 500)
    return errorResult('服务端响应未确认，结果待核实；可刷新核对，或重试同一绑定请求。', {
      uncertain: true,
    });
  return errorResult('来源绑定请求未被接受，请核对服务端状态与所选原账户。');
}
