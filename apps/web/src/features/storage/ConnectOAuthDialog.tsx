import type { CloudOAuthReturnTo, CloudProvider } from '@ptvault/contracts';
import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  ExternalLink,
  KeyRound,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { PROVIDER_LABELS } from './connectionLabels.js';
import { useOAuthFlow, type OAuthCompletion, type OAuthUiState } from './useOAuthFlow.js';

export type ConnectOAuthDialogProps = {
  provider: CloudProvider;
  returnTo: CloudOAuthReturnTo;
  reauthorize?: { connectionId: string; revision: number } | undefined;
  onClose: () => void;
  onCompleted: (completion: OAuthCompletion) => void;
};

function canStart(state: OAuthUiState): boolean {
  return ['IDLE', 'POPUP_CLOSED', 'CANCELLED', 'EXPIRED', 'USED', 'FAILED'].includes(state.kind);
}

function tone(state: OAuthUiState): 'progress' | 'good' | 'warn' | 'absent' {
  switch (state.kind) {
    case 'IDLE':
    case 'STARTING':
    case 'AWAITING_AUTHORIZATION':
    case 'PROCESSING':
    case 'POPUP_BLOCKED':
      return 'progress';
    case 'COMPLETED':
      return 'good';
    case 'ROUTE_ABSENT':
    case 'NOT_ENABLED':
      return 'absent';
    default:
      return 'warn';
  }
}

function StateMessage({ state }: { state: OAuthUiState }) {
  switch (state.kind) {
    case 'IDLE':
      return (
        <p className="connection-flow-note">
          输入动态验证码后，本站会创建一次性流程并打开服务商页面。凭据始终只由服务端处理。
        </p>
      );
    case 'STARTING':
      return <p className="connection-flow-note">正在创建一次性授权流程…</p>;
    case 'AWAITING_AUTHORIZATION':
      return (
        <p className="connection-flow-note" role="status">
          正在等待服务商页面完成授权；本站会持续向服务端轮询结果。
        </p>
      );
    case 'PROCESSING':
      return (
        <p className="connection-flow-note" role="status">
          服务端已收到回调，正在交换令牌并物化连接；关闭服务商窗口不会中断这一步。
        </p>
      );
    case 'POPUP_BLOCKED':
      return (
        <p className="connection-flow-note" role="status">
          浏览器拦截了弹窗。用下面的链接打开服务商页面即可；原页面仍在轮询服务端结果。
        </p>
      );
    case 'POPUP_CLOSED':
      return (
        <p className="connection-flow-note" role="status">
          服务商窗口在回调前关闭；请发起新的授权流程。
        </p>
      );
    case 'CANCELLED':
      return <p className="connection-flow-note">你取消了这次授权；可在需要时发起新流程。</p>;
    case 'COMPLETED':
      return <p className="connection-flow-note">授权完成，连接列表正在刷新。</p>;
    case 'PROVISION_FAILED':
      return (
        <p className="connection-flow-note" role="alert">
          授权回调已完成，但服务端物化目的地失败。连接已经保留供诊断，重新登录不会修复物化配置。
        </p>
      );
    case 'EXPIRED':
      return <p className="connection-flow-note">一次性授权流程已过期，请发起新流程。</p>;
    case 'USED':
      return <p className="connection-flow-note">一次性授权流程已经使用过，请发起新流程。</p>;
    case 'ROUTE_ABSENT':
      return (
        <p className="connection-flow-note">这台服务端还没有云盘 OAuth 路由，流程没有创建。</p>
      );
    case 'NOT_ENABLED':
      return (
        <p className="connection-flow-note">
          这台服务端尚未启用云盘 OAuth（HTTP {state.status}），流程没有创建。
        </p>
      );
    case 'FAILED':
      return (
        <p className="connection-flow-note" role="alert">
          {state.message}
        </p>
      );
  }
}

function StateIcon({ state }: { state: OAuthUiState }) {
  switch (tone(state)) {
    case 'good':
      return <CircleCheck size={16} strokeWidth={1.9} aria-hidden="true" />;
    case 'warn':
      return <TriangleAlert size={16} strokeWidth={1.9} aria-hidden="true" />;
    case 'absent':
      return <CircleSlash size={16} strokeWidth={1.9} aria-hidden="true" />;
    case 'progress':
      return <CircleDashed size={16} strokeWidth={1.9} aria-hidden="true" />;
  }
}

export function ConnectOAuthDialog({
  provider,
  returnTo,
  reauthorize,
  onClose,
  onCompleted,
}: ConnectOAuthDialogProps) {
  const flow = useOAuthFlow({ provider, returnTo, reauthorize, onCompleted });
  const [mfaCode, setMfaCode] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const mfaRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);
  const name = PROVIDER_LABELS[provider];
  const titleId = 'connect-oauth-title';

  useEffect(() => {
    openerRef.current = document.activeElement;
    (mfaRef.current ?? closeRef.current)?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), a[href], button:not([disabled])',
      );
      if (!nodes?.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [onClose]);

  const start = (): void => {
    const current = mfaCode;
    setMfaCode('');
    flow.begin(current);
  };

  return (
    <div className="command-overlay connection-flow-overlay" role="presentation">
      <div
        ref={panelRef}
        className="connection-flow-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="connection-flow-head">
          <h2 id={titleId}>{reauthorize === undefined ? `连接${name}` : `重新授权${name}`}</h2>
          <p>
            浏览器只保存内存中的 flowId 并轮询结果；authorization code、access token、refresh token
            与 PKCE verifier 均由服务端处理，不写入 URL 或浏览器存储。
          </p>
        </header>

        <div className={`connection-flow-state connection-flow-${tone(flow.state)}`}>
          <StateIcon state={flow.state} />
          <StateMessage state={flow.state} />
        </div>

        {canStart(flow.state) ? (
          <label className="field" htmlFor="oauth-mfa-code">
            <span>动态验证码</span>
            <input
              ref={mfaRef}
              id="oauth-mfa-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
        ) : null}

        {flow.state.kind === 'POPUP_BLOCKED' ? (
          <a
            className="primary-button"
            href={flow.state.authorizationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={15} strokeWidth={1.9} aria-hidden="true" />
            在新标签页打开服务商页面
          </a>
        ) : null}

        <div className="connection-flow-actions">
          {canStart(flow.state) ? (
            <button type="button" className="primary-action" onClick={start}>
              <KeyRound size={15} strokeWidth={1.9} aria-hidden="true" />
              {flow.state.kind === 'IDLE' ? '创建并打开授权流程' : '发起新的授权流程'}
            </button>
          ) : null}
          <button ref={closeRef} type="button" className="ghost-button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
