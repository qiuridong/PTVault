import type {
  CloudConnection,
  OneDriveLegacyTakeoverResponse,
  OneDriveProvisionResponse,
  StorageAccount,
} from '@ptvault/contracts';
import { CheckCircle2, CircleDashed, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { newIdempotencyKey } from '../../api/client.js';
import { presentConnectionError } from './cloudConnectionViewModel.js';
import { provisionOneDriveConnection, takeOverLegacyOneDriveAccount } from './connectionApi.js';

export type ConnectionProvisionMode = 'PROVISION' | 'TAKEOVER_LEGACY';

type Outcome =
  | { kind: 'PROVISION'; value: OneDriveProvisionResponse }
  | { kind: 'TAKEOVER_LEGACY'; value: OneDriveLegacyTakeoverResponse };

export type ConnectionProvisionDialogProps = {
  mode: ConnectionProvisionMode;
  connection: CloudConnection;
  legacyAccounts: readonly StorageAccount[];
  onClose: () => void;
  onReload: () => void;
  onCompleted: () => void;
};

function unavailableMessage(answer: {
  reason: 'ROUTE_ABSENT' | 'NOT_ENABLED';
  status?: 501 | 503;
}): string {
  return answer.reason === 'ROUTE_ABSENT'
    ? '这台机器上的 API 版本还没有 OneDrive 归档物化接口。'
    : '这台服务端尚未启用 OneDrive 归档物化；现有连接与目的地没有改变。';
}

/**
 * Stage 4 control panel for the two explicit OneDrive materialization paths.
 *
 * A web OAuth identity is not a destination until the server has completed its
 * escrow and crypt round-trip. Legacy adoption is even narrower: the operator
 * has to select the exact account, review its server-projected CAS revision and both
 * aliases. The browser sends aliases only; it never receives crypt secrets.
 */
export function ConnectionProvisionDialog({
  mode,
  connection,
  legacyAccounts,
  onClose,
  onReload,
  onCompleted,
}: ConnectionProvisionDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const mfaRef = useRef<HTMLInputElement>(null);
  const accountRef = useRef<HTMLSelectElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);
  const intentRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [confirmedIdentity, setConfirmedIdentity] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const selectedAccount = useMemo(
    () => legacyAccounts.find((account) => account.id === selectedAccountId) ?? null,
    [legacyAccounts, selectedAccountId],
  );
  const selectedIdentity =
    selectedAccount === null
      ? null
      : JSON.stringify([
          connection.id,
          connection.revision,
          selectedAccount.id,
          selectedAccount.revision,
          selectedAccount.rawRemote,
          selectedAccount.cryptRemote,
        ]);
  const confirmed = selectedIdentity !== null && confirmedIdentity === selectedIdentity;
  const takeoverReady = selectedAccount !== null && confirmed;
  const submitReady =
    /^[0-9]{6}$/.test(mfaCode) && (mode === 'PROVISION' || takeoverReady) && !pending;
  const titleId = `connection-${mode.toLowerCase()}-title`;

  useEffect(() => {
    openerRef.current = document.activeElement;
    (mode === 'PROVISION' ? mfaRef.current : accountRef.current)?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), button:not([disabled])',
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
  }, [onClose, pending]);

  const keyFor = (fingerprint: string): string => {
    if (intentRef.current?.fingerprint !== fingerprint) {
      intentRef.current = { fingerprint, key: newIdempotencyKey() };
    }
    return intentRef.current.key;
  };

  const submit = async (): Promise<void> => {
    if (!submitReady) return;
    setPending(true);
    setError(null);
    try {
      if (mode === 'PROVISION') {
        const fingerprint = `PROVISION:${connection.id}:${connection.revision}`;
        const answer = await provisionOneDriveConnection({
          id: connection.id,
          revision: connection.revision,
          mfaCode,
          idempotencyKey: keyFor(fingerprint),
        });
        if (!answer.supported) {
          setError(unavailableMessage(answer));
          return;
        }
        setOutcome({ kind: 'PROVISION', value: answer.data });
      } else {
        if (selectedAccount === null) return;
        const fingerprint = [
          'TAKEOVER_LEGACY',
          connection.id,
          connection.revision,
          selectedAccount.id,
          selectedAccount.revision,
          selectedAccount.rawRemote,
          selectedAccount.cryptRemote,
        ].join(':');
        const answer = await takeOverLegacyOneDriveAccount({
          id: connection.id,
          revision: connection.revision,
          mfaCode,
          accountId: selectedAccount.id,
          accountRevision: selectedAccount.revision,
          rawRemote: selectedAccount.rawRemote,
          cryptRemote: selectedAccount.cryptRemote,
          confirmTakeover: true,
          idempotencyKey: keyFor(fingerprint),
        });
        if (!answer.supported) {
          setError(unavailableMessage(answer));
          return;
        }
        setOutcome({ kind: 'TAKEOVER_LEGACY', value: answer.data });
      }
      onCompleted();
    } catch (cause) {
      const presented = presentConnectionError(cause);
      setError(presented.message);
      if (presented.revisionConflict) {
        setConfirmedIdentity(null);
        onReload();
      }
      if (presented.idempotencyConflict) intentRef.current = null;
    } finally {
      setMfaCode('');
      setPending(false);
    }
  };

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
            {mode === 'PROVISION' ? '创建受控归档目的地' : '接管旧式 OneDrive 目的地'} ·{' '}
            {connection.label}
          </h2>
          <p>
            {mode === 'PROVISION'
              ? '服务端先验证恢复 escrow 与 crypt 往返，再原子切换存储绑定；任一步失败都会回滚候选配置。'
              : '只接管精确匹配当前 drive 身份与 crypt target 的旧目的地；不会按名称或标签猜测。'}
          </p>
        </header>

        {outcome === null ? (
          <form
            className="connection-action-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {mode === 'TAKEOVER_LEGACY' ? (
              <>
                <div className="field">
                  <label htmlFor="connection-takeover-account">旧目的地</label>
                  <select
                    ref={accountRef}
                    id="connection-takeover-account"
                    value={selectedAccountId}
                    disabled={pending}
                    onChange={(event) => {
                      setSelectedAccountId(event.target.value);
                      setConfirmedIdentity(null);
                    }}
                  >
                    <option value="">请选择精确账户…</option>
                    {legacyAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.label}
                      </option>
                    ))}
                  </select>
                </div>
                {selectedAccount === null ? null : (
                  <dl className="account-card-facts connection-takeover-facts">
                    <div>
                      <dt>账户 ID</dt>
                      <dd className="is-mono">{selectedAccount.id}</dd>
                    </div>
                    <div>
                      <dt>账户修订</dt>
                      <dd className="is-mono">revision {selectedAccount.revision}</dd>
                    </div>
                    <div>
                      <dt>raw remote</dt>
                      <dd className="is-mono">{selectedAccount.rawRemote}</dd>
                    </div>
                    <div>
                      <dt>crypt remote</dt>
                      <dd className="is-mono">{selectedAccount.cryptRemote}</dd>
                    </div>
                  </dl>
                )}
                <label className="instance-form-checkbox">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={pending || selectedAccount === null}
                    onChange={(event) =>
                      setConfirmedIdentity(event.target.checked ? selectedIdentity : null)
                    }
                  />
                  <span>确认当前连接身份与这组精确 remote 属于同一个 OneDrive drive</span>
                </label>
              </>
            ) : (
              <p className="inline-message" role="note">
                <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
                <span>
                  既有账户、crypt 与加密 profile 保持原绑定；恢复授权材料不会重复创建它们。
                  旧目的地可能没有 profile ID，浏览器只接收服务端报告的标识与别名。
                </span>
              </p>
            )}

            <div className="field">
              <label htmlFor="connection-provision-mfa">动态验证码</label>
              <input
                ref={mode === 'PROVISION' ? mfaRef : undefined}
                id="connection-provision-mfa"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={mfaCode}
                disabled={pending}
                onChange={(event) =>
                  setMfaCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))
                }
              />
            </div>

            {error === null ? null : (
              <p className="inline-message error-message" role="alert">
                <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {error}
              </p>
            )}

            <div className="connection-flow-actions">
              <button type="submit" className="primary-action" disabled={!submitReady}>
                {pending ? <CircleDashed size={15} strokeWidth={1.8} aria-hidden="true" /> : null}
                {pending
                  ? '正在提交…'
                  : mode === 'PROVISION'
                    ? '创建受控归档目的地'
                    : '确认接管旧目的地'}
              </button>
              <button
                ref={closeRef}
                type="button"
                className="ghost-button"
                disabled={pending}
                onClick={onClose}
              >
                取消
              </button>
            </div>
          </form>
        ) : (
          <div className="connection-action-form">
            <p className="inline-message" role="status">
              <CheckCircle2 size={15} strokeWidth={1.9} aria-hidden="true" />
              {outcome.kind === 'PROVISION'
                ? outcome.value.profileId === null
                  ? '已有目的地的授权材料已就绪；保留既有账户与 crypt。'
                  : '受控归档目的地已就绪。'
                : '旧目的地已由网页登录连接接管。'}
            </p>
            {outcome.kind === 'PROVISION' ? (
              <dl className="account-card-facts connection-takeover-facts">
                <div>
                  <dt>账户 ID</dt>
                  <dd className="is-mono">{outcome.value.accountId}</dd>
                </div>
                <div>
                  <dt>raw remote</dt>
                  <dd className="is-mono">{outcome.value.rawRemote}</dd>
                </div>
                <div>
                  <dt>crypt remote</dt>
                  <dd className="is-mono">{outcome.value.cryptRemote}</dd>
                </div>
                <div>
                  <dt>加密 profile</dt>
                  <dd className="is-mono">
                    {outcome.value.profileId ?? '旧绑定未报告 profile ID；未创建新的加密 profile。'}
                  </dd>
                </div>
              </dl>
            ) : null}
            <div className="connection-flow-actions">
              <button ref={closeRef} type="button" className="primary-action" onClick={onClose}>
                完成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
