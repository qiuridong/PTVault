import type { CloudConnectionAction, CloudConnectionAuthState } from '@ptvault/contracts';
import {
  ChevronDown,
  CircleCheck,
  CircleOff,
  CircleSlash,
  DatabaseZap,
  Edit3,
  FolderOpen,
  KeyRound,
  Power,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  Unplug,
  Workflow,
  Zap,
} from 'lucide-react';
import { useId, useState } from 'react';

import type { ConnectionCardViewModel } from './cloudConnectionViewModel.js';

function AuthIcon({ state }: { state: CloudConnectionAuthState }) {
  switch (state) {
    case 'CONNECTED':
      return <CircleCheck size={14} strokeWidth={1.9} aria-hidden="true" />;
    case 'REAUTH_REQUIRED':
      return <ShieldAlert size={14} strokeWidth={1.9} aria-hidden="true" />;
    case 'DISABLED':
      return <CircleSlash size={14} strokeWidth={1.9} aria-hidden="true" />;
    case 'DISCONNECTED':
      return <CircleOff size={14} strokeWidth={1.9} aria-hidden="true" />;
    case 'ERROR':
      return <TriangleAlert size={14} strokeWidth={1.9} aria-hidden="true" />;
  }
}

function ActionIcon({ action }: { action: CloudConnectionAction }) {
  switch (action) {
    case 'BROWSE':
      return <FolderOpen size={15} strokeWidth={1.9} aria-hidden="true" />;
    case 'PROVISION':
      return <DatabaseZap size={15} strokeWidth={1.9} aria-hidden="true" />;
    case 'TAKEOVER_LEGACY':
      return <Workflow size={15} strokeWidth={1.9} aria-hidden="true" />;
    case 'TEST':
      return <RefreshCw size={15} strokeWidth={1.9} aria-hidden="true" />;
    case 'EDIT':
      return <Edit3 size={15} strokeWidth={1.9} aria-hidden="true" />;
    case 'REAUTHORIZE':
    case 'START_OAUTH':
      return <KeyRound size={15} strokeWidth={1.9} aria-hidden="true" />;
    case 'ENABLE':
    case 'DISABLE':
      return <Power size={15} strokeWidth={1.9} aria-hidden="true" />;
    case 'DISCONNECT':
      return <Unplug size={15} strokeWidth={1.9} aria-hidden="true" />;
  }
}

export type ConnectionRowProps = {
  model: ConnectionCardViewModel;
  busy?: boolean;
  onAction: (action: CloudConnectionAction) => void;
};

/**
 * Dense operator row. It receives the already intersected server-authority view
 * model and performs no request, provider inference or client-side permission
 * invention of its own. Scannable facts stay on the row; the verbose evidence
 * (capability rationale, references, throttle arithmetic) sits behind an
 * explicit disclosure so a long connection list stays readable.
 */
export function ConnectionRow({ model, busy = false, onAction }: ConnectionRowProps) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const detailId = useId();

  return (
    <article className="ops-row" aria-labelledby={headingId}>
      <div className="ops-row-main">
        <div className="ops-row-identity">
          <button
            type="button"
            className="ops-row-disclosure"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown
              size={15}
              strokeWidth={2}
              aria-hidden="true"
              className={open ? 'is-open' : undefined}
            />
            <span className="visually-hidden">{open ? '收起' : '展开'}详细依据</span>
          </button>
          <div className="ops-row-name">
            <h3 id={headingId}>{model.label}</h3>
            <p className="ops-row-meta">
              <span>{model.providerLabel}</span>
              <span aria-hidden="true">·</span>
              <span>{model.principalMasked}</span>
              {model.legacy ? <span className="connection-meta-tag">旧式登记</span> : null}
              {model.readOnly ? <span className="connection-meta-tag">只读</span> : null}
            </p>
            {model.clientProfile ? (
              <p className="field-hint">
                固定客户端：{model.clientProfile.id}
                。支持的下载接口不等于实际下载已验收；登录检查不读取媒体文件。
                本页“只读”指连接配置由私密文件管理，不代表百度授权是只读 scope。
                {!model.clientProfile.appIdKnown
                  ? ' 分享 AppID 尚未确认，分享能力未开放；不影响已授权的基础账户与目录浏览。'
                  : ''}
              </p>
            ) : null}
          </div>
        </div>

        <dl className="ops-row-states">
          <div>
            <dt>授权</dt>
            <dd>
              <span className={`health-tag connection-auth-${model.authState.toLowerCase()}`}>
                <AuthIcon state={model.authState} />
                {model.authLabel}
              </span>
            </dd>
          </div>
          <div>
            <dt>物化</dt>
            <dd>
              <span
                className={`connection-provision connection-provision-${model.provisionState.toLowerCase()}`}
              >
                {model.provisionLabel}
              </span>
            </dd>
          </div>
          <div>
            <dt>活动任务</dt>
            <dd>{model.activeJobCount} 笔</dd>
          </div>
          <div>
            <dt>存储目的地</dt>
            <dd>
              {model.storageDestinationCount === 0
                ? '未派生'
                : `${model.storageDestinationCount} 个`}
            </dd>
          </div>
          <div>
            <dt>最近检查</dt>
            <dd>{model.telemetryStale ? '遥测过期' : model.lastCheckedLabel}</dd>
          </div>
        </dl>

        {model.actions.length > 0 ? (
          <div className="ops-row-actions" role="group" aria-label={`${model.label} 的可用操作`}>
            {model.actions.map((action) => (
              <button
                key={action.code}
                type="button"
                className={action.code === 'DISCONNECT' ? 'danger-button' : 'ghost-button'}
                disabled={busy}
                onClick={() => onAction(action.code)}
              >
                <ActionIcon action={action.code} />
                {action.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="ops-row-noactions" role="note">
            <CircleSlash size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="note-text">服务端当前没有为这个连接授权可执行操作。</span>
          </p>
        )}
      </div>

      {model.throttle === null ? null : (
        <p className="ops-row-notice" role="status">
          <Zap size={14} strokeWidth={1.9} aria-hidden="true" />
          <span className="note-text">
            <strong>{model.throttle.codeLabel}</strong>：该连接被限速，影响{' '}
            {model.throttle.activeJobCount} 笔任务，预计
            {model.throttle.waitLabel}恢复。同一连接的任务共用这个等待，其他连接不受影响。
          </span>
        </p>
      )}

      {model.provisionState === 'PROVISION_FAILED' ? (
        <p className="ops-row-alert inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="note-text">
            登录结果与物化结果彼此独立；连接已保留，先检查服务端配置。
            {model.provisionFailureCode === null
              ? null
              : ` 原因代码：${model.provisionFailureCode}。`}
          </span>
        </p>
      ) : null}

      <div className="ops-row-detail" id={detailId} hidden={!open}>
        <div className="ops-row-detail-grid">
          <section aria-label={`${model.label} 的状态依据`}>
            <h4>状态依据</h4>
            <p className="connection-detail">{model.authDetail}</p>
            <p className="connection-detail">{model.provisionDetail}</p>
            <dl className="ops-row-facts">
              <div>
                <dt>授权到期</dt>
                <dd>{model.accessExpiresLabel}</dd>
              </div>
              <div>
                <dt>最近检查</dt>
                <dd>{model.telemetryStale ? '遥测过期' : model.lastCheckedLabel}</dd>
              </div>
            </dl>
          </section>

          <section aria-label={`${model.label} 的能力`}>
            <h4>服务端授予的能力</h4>
            {model.capabilities.length === 0 ? (
              <p className="connection-detail">
                服务端没有授予任何能力；页面不会根据服务商名称推断用途。
              </p>
            ) : (
              <ul className="capability-list">
                {model.capabilities.map((capability) => (
                  <li key={capability.code}>
                    <span
                      className={`capability-tag capability-tag-${capability.code.toLowerCase()}`}
                    >
                      {capability.label}
                    </span>
                    <span className="capability-list-detail">{capability.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label={`${model.label} 的引用`}>
            <h4>当前引用</h4>
            {model.references.length === 0 ? (
              <p className="connection-detail">没有其它对象引用这个连接。</p>
            ) : (
              <ul className="connection-references">
                {model.references.map((reference) => (
                  <li key={reference}>{reference}</li>
                ))}
              </ul>
            )}
          </section>

          {model.throttle === null ? null : (
            <section aria-label={`${model.label} 的限速详情`}>
              <h4>限速详情</h4>
              <dl className="ops-row-facts">
                <div>
                  <dt>预计恢复</dt>
                  <dd>
                    {model.throttle.waitLabel}
                    <small>{model.throttle.retryAtLabel}</small>
                  </dd>
                </div>
                <div>
                  <dt>受影响任务</dt>
                  <dd>{model.throttle.activeJobCount} 笔</dd>
                </div>
              </dl>
              <p className="connection-detail">
                限速属于这个连接；同一连接的任务共用等待，其他连接不受影响。
              </p>
            </section>
          )}
        </div>
      </div>
    </article>
  );
}

export type ConnectionsTableProps = {
  models: readonly ConnectionCardViewModel[];
  busyId?: string | null;
  onAction: (connectionId: string, action: CloudConnectionAction) => void;
};

export function ConnectionsTable({ models, busyId = null, onAction }: ConnectionsTableProps) {
  return (
    <div className="ops-rows" role="list">
      {models.map((model) => (
        <div key={model.id} role="listitem">
          <ConnectionRow
            model={model}
            busy={busyId === model.id}
            onAction={(action) => onAction(model.id, action)}
          />
        </div>
      ))}
    </div>
  );
}
