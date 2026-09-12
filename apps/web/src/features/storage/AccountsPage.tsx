import type { CloudConnectionAction, CloudProvider } from '@ptvault/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDashed, CircleSlash, KeyRound, Radio, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useServerEvents } from '../../api/useServerEvents.js';
import { ApiError } from '../../api/client.js';
import { isDemoSessionActive } from '../../demo/demoSession.js';
import { ConnectionsTable } from './ConnectionsTable.js';
import { DestinationsTable } from './DestinationsTable.js';
import { ConnectOAuthDialog } from './ConnectOAuthDialog.js';
import { BaiduDeviceDialog } from './BaiduDeviceDialog.js';
import { RcloneImportDialog } from './RcloneImportDialog.js';
import { getSetupOverview, setupOverviewKey } from '../onboarding/setupApi.js';
import { ConnectionActionDialog } from './ConnectionActionDialog.js';
import { ConnectionProvisionDialog } from './ConnectionProvisionDialog.js';
import { getStorageAccounts, storageAccountsQueryKey } from './accountApi.js';
import {
  canStartOAuth,
  presentConnectionError,
  toConnectionCardViewModel,
  type ConnectionMutationAction,
} from './cloudConnectionViewModel.js';
import { PROVIDER_LABELS } from './connectionLabels.js';
import { cloudConnectionsQueryKey, getCloudConnections } from './connectionApi.js';

const RETURN_TO = '/storage-accounts' as const;

type PendingAction =
  | { kind: 'CONNECT'; provider: CloudProvider }
  | { kind: 'REAUTHORIZE'; connectionId: string }
  | { kind: 'MUTATE'; connectionId: string; action: ConnectionMutationAction }
  | { kind: 'PROVISION'; connectionId: string }
  | { kind: 'TAKEOVER_LEGACY'; connectionId: string };

function queryErrorMessage(error: unknown): string {
  return presentConnectionError(error).message;
}

/**
 * Unified account centre. The page coordinates queries and dialogs only: the API
 * facade owns transport, the view-model owns interpretation, cards only render,
 * and hooks own mutation/idempotency state.
 */
export function AccountsPage() {
  const live = useServerEvents();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const demo = isDemoSessionActive();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [importing, setImporting] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const accountsQuery = useQuery({
    queryKey: storageAccountsQueryKey,
    queryFn: getStorageAccounts,
    refetchInterval: live === 'live' ? false : 30_000,
  });
  const setupQuery = useQuery({
    queryKey: setupOverviewKey,
    queryFn: getSetupOverview,
    enabled: !demo,
    retry: false,
    staleTime: 60_000,
  });
  const connectionsQuery = useQuery({
    queryKey: cloudConnectionsQueryKey,
    queryFn: getCloudConnections,
    enabled: !demo,
    refetchInterval: live === 'live' ? false : 30_000,
  });

  const accounts = accountsQuery.data ?? [];
  const answer = connectionsQuery.data;
  const connections = answer?.supported === true ? answer.data.connections : [];
  const capabilities = answer?.supported === true ? answer.data.capabilities : null;
  const models = useMemo(
    () =>
      capabilities === null
        ? []
        : connections.map((connection) => toConnectionCardViewModel(connection, capabilities, now)),
    [capabilities, connections, now],
  );
  const provisionedAccountIds = new Set(
    connections.flatMap((connection) => connection.storageAccountIds),
  );
  const legacyAccounts = accounts.filter((account) => !provisionedAccountIds.has(account.id));
  const pendingConnection =
    pending !== null && pending.kind !== 'CONNECT'
      ? (connections.find((connection) => connection.id === pending.connectionId) ?? null)
      : null;

  const refreshConnections = (): void => {
    void queryClient.invalidateQueries({ queryKey: cloudConnectionsQueryKey });
  };

  const actionFor = (connectionId: string, action: CloudConnectionAction): void => {
    if (action === 'BROWSE') {
      void navigate(
        `/imports?view=create&sourceKind=BAIDU_APP_DIR&sourceConnection=${encodeURIComponent(connectionId)}`,
      );
      return;
    }
    if (action === 'REAUTHORIZE') {
      setPending({ kind: 'REAUTHORIZE', connectionId });
      return;
    }
    if (action === 'PROVISION') {
      setPending({ kind: 'PROVISION', connectionId });
      return;
    }
    if (action === 'TAKEOVER_LEGACY') {
      setPending({ kind: 'TAKEOVER_LEGACY', connectionId });
      return;
    }
    if (
      action === 'TEST' ||
      action === 'EDIT' ||
      action === 'ENABLE' ||
      action === 'DISABLE' ||
      action === 'DISCONNECT'
    ) {
      setPending({ kind: 'MUTATE', connectionId, action });
    }
  };

  return (
    <section className="content-page" aria-labelledby="accounts-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">存储</p>
          <h1 id="accounts-title">存储账户</h1>
          <p className="page-lede">
            <strong>云盘连接</strong>回答「谁登录了、服务端授予了什么」，
            <strong>存储目的地</strong>
            回答「加密归档能写到哪里」。连接出现不等于已经成为归档目的地； 本页不会根据 provider
            名称补推能力或权限。
          </p>
        </div>
        <span
          className="connection-state"
          title={live === 'live' ? '账户变化会自动刷新' : '事件流未连接，改为定时刷新'}
        >
          {live === 'live' ? (
            <Radio size={15} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <CircleDashed size={15} strokeWidth={1.8} aria-hidden="true" />
          )}
          {live === 'live' ? '实时遥测' : '定时刷新'}
        </span>
      </header>

      <section className="storage-layer" aria-labelledby="connections-title">
        <header className="storage-layer-head">
          <div>
            <h2 id="connections-title">云盘连接</h2>
            <p className="storage-layer-lede">
              动作必须同时出现在部署与连接的 supportedActions 中；能力标签只来自连接契约。
            </p>
          </div>
          {capabilities === null || demo ? null : (
            <div className="storage-layer-actions">
              {capabilities.baiduDeviceEnabled ? (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setPending({ kind: 'CONNECT', provider: 'BAIDU' })}
                >
                  <KeyRound size={15} aria-hidden="true" />
                  连接百度网盘
                </button>
              ) : null}
              {capabilities.providers
                .filter(
                  (provider) =>
                    canStartOAuth(capabilities, provider) &&
                    !(provider === 'BAIDU' && capabilities.baiduDeviceEnabled),
                )
                .map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    className="primary-button"
                    onClick={() => setPending({ kind: 'CONNECT', provider })}
                  >
                    <KeyRound size={15} strokeWidth={1.9} aria-hidden="true" />
                    连接{PROVIDER_LABELS[provider]}
                  </button>
                ))}
            </div>
          )}
        </header>

        {capabilities?.disabledReason === null ||
        capabilities?.disabledReason === undefined ? null : (
          <div className="settings-notbuilt" role="note">
            <span className="settings-notbuilt-glyph" aria-hidden="true">
              <CircleSlash size={18} strokeWidth={1.7} />
            </span>
            <div>
              <p>当前部署关闭了云盘连接操作。</p>
              <p>部署状态代码：{capabilities.disabledReason}。现有连接仍以只读方式显示。</p>
            </div>
          </div>
        )}

        {demo ? (
          <div className="settings-notbuilt">
            <span className="settings-notbuilt-glyph" aria-hidden="true">
              <CircleSlash size={18} strokeWidth={1.7} />
            </span>
            <div>
              <p>演示模式不会请求真实云盘连接，也不会发起 OAuth。</p>
            </div>
          </div>
        ) : connectionsQuery.isPending ? (
          <div className="route-status" role="status">
            <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
            正在加载云盘连接…
          </div>
        ) : connectionsQuery.isError ? (
          <div className="route-status route-status-error" role="alert">
            <TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
            {queryErrorMessage(connectionsQuery.error)}
          </div>
        ) : answer?.supported === false ? (
          <div className="settings-notbuilt">
            <span className="settings-notbuilt-glyph" aria-hidden="true">
              <CircleSlash size={18} strokeWidth={1.7} />
            </span>
            <div>
              {answer.reason === 'ROUTE_ABSENT' ? (
                <>
                  <p>这台服务端还没有云盘连接路由。</p>
                  <p>这不是空连接列表；需要先部署匹配契约的 API。</p>
                </>
              ) : (
                <>
                  <p>云盘连接接口尚未启用（HTTP {answer.status}）。</p>
                  <p>页面不会显示会产生假成功的操作。</p>
                </>
              )}
            </div>
          </div>
        ) : models.length === 0 ? (
          <div className="neutral-empty-state">
            <p>还没有由网页登录管理的云盘连接。</p>
            <p>选择上方可用的连接方式；首次使用可返回首次设置检查客户端配置。</p>
          </div>
        ) : (
          <ConnectionsTable models={models} onAction={actionFor} />
        )}
      </section>

      <section className="storage-layer" aria-labelledby="destinations-title">
        <header className="storage-layer-head">
          <div>
            <h2 id="destinations-title">存储目的地</h2>
            <p className="storage-layer-lede">
              已物化、可被 rclone/crypt 使用的目的地。网盘迁移的默认目的地在
              <Link to="/settings/netdisk">网盘迁移设置</Link>。
            </p>
          </div>
        </header>

        {accountsQuery.isPending ? (
          <div className="route-status" role="status">
            <CircleDashed size={16} strokeWidth={1.8} aria-hidden="true" />
            正在加载存储账户…
          </div>
        ) : accountsQuery.isError ? (
          <div className="route-status route-status-error" role="alert">
            <TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
            {queryErrorMessage(accountsQuery.error)}
          </div>
        ) : accounts.length === 0 ? (
          <div className="neutral-empty-state">
            <p>尚未登记任何存储目的地。</p>
          </div>
        ) : (
          <DestinationsTable accounts={accounts} provisionedAccountIds={provisionedAccountIds} />
        )}
      </section>

      {setupQuery.isError &&
      !(setupQuery.error instanceof ApiError && setupQuery.error.status === 404) ? (
        <p className="field-hint">
          首次设置功能信息暂时无法读取，尚不能判断是否支持配置导入。
          <button
            type="button"
            className="ghost-button"
            disabled={setupQuery.isFetching}
            onClick={() => void setupQuery.refetch()}
          >
            重试读取安装功能
          </button>
        </p>
      ) : null}
      {setupQuery.data?.configurationSource === 'MANAGED_INSTALLER' ? (
        <div className="storage-layer-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={pending !== null || importing}
            onClick={() => setImporting(true)}
          >
            导入已有 rclone 配置（仅复制）
          </button>
        </div>
      ) : null}
      {importing ? (
        <RcloneImportDialog
          onClose={() => {
            setImporting(false);
            void queryClient.invalidateQueries({ queryKey: storageAccountsQueryKey });
            void queryClient.invalidateQueries({ queryKey: setupOverviewKey });
          }}
          onCompleted={() => {
            void queryClient.invalidateQueries({ queryKey: storageAccountsQueryKey });
            void queryClient.invalidateQueries({ queryKey: setupOverviewKey });
          }}
        />
      ) : null}

      {pending?.kind === 'CONNECT' &&
      pending.provider === 'BAIDU' &&
      capabilities?.baiduDeviceEnabled ? (
        <BaiduDeviceDialog onClose={() => setPending(null)} onCompleted={refreshConnections} />
      ) : pending?.kind === 'CONNECT' ? (
        <ConnectOAuthDialog
          key={`connect:${pending.provider}`}
          provider={pending.provider}
          returnTo={RETURN_TO}
          onClose={() => setPending(null)}
          onCompleted={() => {
            refreshConnections();
            void queryClient.invalidateQueries({ queryKey: storageAccountsQueryKey });
          }}
        />
      ) : null}

      {pending?.kind === 'REAUTHORIZE' &&
      pendingConnection?.provider === 'BAIDU' &&
      capabilities?.baiduDeviceEnabled ? (
        <BaiduDeviceDialog
          target={{ id: pendingConnection.id, revision: pendingConnection.revision }}
          onClose={() => setPending(null)}
          onCompleted={refreshConnections}
        />
      ) : pending?.kind === 'REAUTHORIZE' && pendingConnection !== null ? (
        <ConnectOAuthDialog
          key={`reauthorize:${pendingConnection.id}`}
          provider={pendingConnection.provider}
          returnTo={RETURN_TO}
          reauthorize={{
            connectionId: pendingConnection.id,
            revision: pendingConnection.revision,
          }}
          onClose={() => setPending(null)}
          onCompleted={() => {
            refreshConnections();
            void queryClient.invalidateQueries({ queryKey: storageAccountsQueryKey });
          }}
        />
      ) : null}

      {pending?.kind === 'MUTATE' && pendingConnection !== null ? (
        <ConnectionActionDialog
          key={`${pending.action}:${pendingConnection.id}`}
          action={pending.action}
          connection={pendingConnection}
          onClose={() => setPending(null)}
          onReload={refreshConnections}
          onCompleted={() => {
            setPending(null);
            refreshConnections();
            void queryClient.invalidateQueries({ queryKey: storageAccountsQueryKey });
          }}
        />
      ) : null}

      {(pending?.kind === 'PROVISION' || pending?.kind === 'TAKEOVER_LEGACY') &&
      pendingConnection !== null ? (
        <ConnectionProvisionDialog
          key={`${pending.kind}:${pendingConnection.id}`}
          mode={pending.kind}
          connection={pendingConnection}
          legacyAccounts={legacyAccounts}
          onClose={() => setPending(null)}
          onReload={() => {
            refreshConnections();
            void queryClient.invalidateQueries({ queryKey: storageAccountsQueryKey });
          }}
          onCompleted={() => {
            refreshConnections();
            void queryClient.invalidateQueries({ queryKey: storageAccountsQueryKey });
          }}
        />
      ) : null}
    </section>
  );
}
