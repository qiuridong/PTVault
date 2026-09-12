import type { CloudConnection } from '@ptvault/contracts';
import { CircleDashed, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { ACTION_LABELS } from './connectionLabels.js';
import type { ConnectionMutationAction } from './cloudConnectionViewModel.js';
import { useConnectionAction } from './useConnectionAction.js';

const ACTION_COPY: Record<ConnectionMutationAction, string> = {
  TEST: '由服务端使用已保存授权检查账户身份与可用性；不会向浏览器返回凭据。',
  EDIT: '只修改管理员可见名称。并发更新会被 revision 门拒绝，不会静默覆盖。',
  ENABLE: '恢复服务端允许的新任务使用；现有绑定与授权保持不变。',
  DISABLE: '停止这个连接被新的工作使用，但保留授权与业务绑定，可稍后重新启用。',
  DISCONNECT: '丢弃服务端保存的授权。存在任务、挂载、目录、恢复副本或存储绑定时服务端会拒绝。',
};

export type ConnectionActionDialogProps = {
  action: ConnectionMutationAction;
  connection: CloudConnection;
  onClose: () => void;
  onReload: () => void;
  onCompleted: (connection: CloudConnection) => void;
};

export function ConnectionActionDialog({
  action,
  connection,
  onClose,
  onReload,
  onCompleted,
}: ConnectionActionDialogProps) {
  const controller = useConnectionAction({ action, connection, onReload, onCompleted });
  const panelRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);
  const titleId = `connection-action-${action.toLowerCase()}-title`;

  useEffect(() => {
    openerRef.current = document.activeElement;
    (firstRef.current ?? closeRef.current)?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !controller.pending) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled])',
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
  }, [controller.pending, onClose]);

  return (
    <div className="command-overlay connection-flow-overlay" role="presentation">
      <div
        ref={panelRef}
        className="connection-flow-panel connection-action-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="connection-flow-head">
          <h2 id={titleId}>
            {ACTION_LABELS[action]} · {connection.label}
          </h2>
          <p>{ACTION_COPY[action]}</p>
        </header>

        <form
          className="connection-action-form"
          onSubmit={(event) => {
            event.preventDefault();
            controller.submit();
          }}
        >
          {action === 'EDIT' ? (
            <div className="field-stack">
              <label htmlFor="connection-action-label">连接名称</label>
              <input
                ref={firstRef}
                id="connection-action-label"
                value={controller.label}
                maxLength={64}
                disabled={controller.pending}
                onChange={(event) => controller.setLabel(event.target.value)}
                autoComplete="off"
              />
            </div>
          ) : null}

          <div className="field-stack">
            <label htmlFor="connection-action-mfa">动态验证码</label>
            <input
              ref={action === 'EDIT' ? undefined : firstRef}
              id="connection-action-mfa"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={controller.mfaCode}
              disabled={controller.pending}
              onChange={(event) => controller.setMfaCode(event.target.value)}
              aria-describedby="connection-action-mfa-note"
            />
            <small id="connection-action-mfa-note">
              所有云盘连接变更都需要最近 MFA；验证码不会进入幂等请求指纹。
            </small>
          </div>

          {controller.revisionRefreshed ? (
            <p className="inline-message" role="status">
              <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
              已加载连接的最新 revision；名称草稿仍保留，请核对后重新提交。
            </p>
          ) : null}

          {controller.error === null ? null : (
            <div className="connection-action-error" role="alert">
              <p>
                <TriangleAlert size={15} strokeWidth={1.8} aria-hidden="true" />
                {controller.error.message}
              </p>
              {controller.error.references.length > 0 ? (
                <ul>
                  {controller.error.references.map((reference) => (
                    <li key={reference}>{reference}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}

          <div className="connection-flow-actions">
            <button
              type="submit"
              className={action === 'DISCONNECT' ? 'danger-button' : 'primary-action'}
              disabled={controller.pending}
            >
              {controller.pending ? (
                <CircleDashed size={15} strokeWidth={1.8} aria-hidden="true" />
              ) : null}
              {controller.pending ? '正在提交…' : ACTION_LABELS[action]}
            </button>
            <button
              ref={closeRef}
              type="button"
              className="ghost-button"
              disabled={controller.pending}
              onClick={onClose}
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
