import type { BaiduDeviceFlow, BaiduDeviceInfo, BaiduDeviceStart } from '@ptvault/contracts';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client.js';
import {
  cancelBaiduDevice,
  getBaiduDeviceInfo,
  pollBaiduDevice,
  startBaiduDevice,
} from './baiduDeviceApi.js';

export function BaiduDeviceDialog({
  target,
  onClose,
  onCompleted,
}: {
  target?: { id: string; revision: number };
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [info, setInfo] = useState<BaiduDeviceInfo | null>(null);
  const [flow, setFlow] = useState<BaiduDeviceFlow | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const intent = useRef<{ body: BaiduDeviceStart; key: string } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const completed = useRef(new Set<string>());
  const callbacks = useRef({ onClose, onCompleted });
  callbacks.current = { onClose, onCompleted };
  const accept = (value: BaiduDeviceFlow) => {
    setFlow(value);
    setError(null);
    if (value.status === 'COMPLETED' && !completed.current.has(value.flowId)) {
      completed.current.add(value.flowId);
      callbacks.current.onCompleted();
    }
  };
  useEffect(() => {
    let closed = false;
    void getBaiduDeviceInfo()
      .then((value) => {
        if (!closed) setInfo(value);
      })
      .catch(() => {
        if (!closed) setError('暂时无法读取授权配置，请重试；尚未申请授权码。');
      });
    return () => {
      closed = true;
    };
  }, [reload]);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!flow || flow.status !== 'PENDING' || busy) return;
    let closed = false;
    const timer = window.setTimeout(
      () => {
        void pollBaiduDevice(flow.flowId)
          .then((value) => {
            if (!closed) accept(value);
          })
          .catch(() => {
            if (!closed) {
              setError('暂时无法取得结果，将继续查询原授权，不会重复申请。');
              setFlow({ ...flow, nextPollAt: Date.now() + 5000 });
            }
          });
      },
      Math.max(1000, Math.min(flow.nextPollAt, flow.expiresAt) - Date.now()),
    );
    return () => {
      closed = true;
      window.clearTimeout(timer);
    };
  }, [flow, busy]);
  const close = async () => {
    if (busy) return;
    if (flow?.status === 'PENDING') {
      setBusy(true);
      setError(null);
      try {
        accept(await cancelBaiduDevice(flow.flowId));
        callbacks.current.onClose();
      } catch {
        setError('未能确认取消结果。请重试取消；不会擅自断开已保存的账户。');
      } finally {
        setBusy(false);
      }
    } else callbacks.current.onClose();
  };
  const start = async () => {
    if (!info || busy) return;
    if (!intent.current)
      intent.current = {
        key: crypto.randomUUID(),
        body: { instanceId: info.instanceId, mfaCode, target: target ?? null },
      };
    else if (/^\d{6}$/.test(mfaCode)) intent.current.body.mfaCode = mfaCode;
    setBusy(true);
    setError(null);
    try {
      const value = await startBaiduDevice(intent.current.body, intent.current.key);
      accept(value);
      setMfaCode('');
      intent.current = null;
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'DEVICE_FLOW_RESTARTED') {
        intent.current = null;
        setMfaCode('');
        setInfo(null);
        setReload((value) => value + 1);
        setError('服务已重新加载。请用新的动态验证码重新开始，不会复用旧授权。');
      } else if (cause instanceof ApiError && cause.code === 'MFA_STEP_UP_FAILED') {
        setMfaCode('');
        if (intent.current) intent.current.body.mfaCode = '';
        setError('动态验证码无效或已使用，请输入验证器中的新验证码。');
      } else setError('暂时未取得授权码。可重试同一次申请，不会重复消费已经通过的验证。');
    } finally {
      setBusy(false);
    }
  };
  const restart = () => {
    intent.current = null;
    setFlow(null);
    setMfaCode('');
    setError(null);
  };
  return (
    <div className="command-overlay connection-flow-overlay" role="presentation">
      <div
        className="connection-flow-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="baidu-device-title"
        ref={panel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            void close();
          }
          if (event.key !== 'Tab') return;
          const focusable = [
            ...(panel.current?.querySelectorAll<HTMLElement>(
              'a[href], button:not(:disabled), input:not(:disabled)',
            ) ?? []),
          ];
          const first = focusable[0],
            last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="connection-flow-head">
          <h2 id="baidu-device-title">{target ? '重新授权百度网盘' : '连接百度网盘'}</h2>
          <p>{info?.clientLabel ?? '正在读取授权配置…'}</p>
          <p>
            登录只在百度官方页面进行，本站不收集百度密码、Cookie 或
            BDUSS。请核对官方页面展示的应用名称与权限，再决定是否授权。
          </p>
          {info?.profileId ? (
            <p>
              内置客户端来自 AList 公共客户端配置，不是以 PTVault
              名义注册的应用；可在首次设置的高级选项中换用自己的客户端。
            </p>
          ) : null}
        </header>
        {error ? (
          <p role="alert" className="connection-flow-note">
            {error}
          </p>
        ) : null}
        {!info && error ? (
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setError(null);
              setReload((value) => value + 1);
            }}
          >
            重新读取授权配置
          </button>
        ) : null}
        {flow === null ? (
          <>
            <p className="connection-flow-note">
              输入本站动态验证码后获取一次性授权码；接下来查询结果不需要再次验证。
            </p>
            <label className="field">
              <span>动态验证码</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                disabled={busy}
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
            <button
              type="button"
              className="primary-button"
              disabled={
                !info ||
                busy ||
                (!/^\d{6}$/.test(mfaCode) && !/^\d{6}$/.test(intent.current?.body.mfaCode ?? ''))
              }
              onClick={() => void start()}
            >
              {busy ? '正在申请…' : intent.current ? '重试获取授权码' : '获取授权码'}
            </button>
          </>
        ) : flow.status === 'PENDING' ? (
          <div className="connection-flow-state connection-flow-progress">
            <p>在百度官方页面输入此授权码：</p>
            <strong className="baidu-device-user-code">{flow.userCode}</strong>
            <a
              className="primary-button"
              href={flow.verificationUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              打开百度官方授权页
            </a>
            <p role="status">
              等待授权并核对账户与目录权限…有效期至 {new Date(flow.expiresAt).toLocaleTimeString()}
              。
            </p>
            {flow.failureCode === 'NETWORK_RETRYABLE' ? (
              <p>服务商暂时不可用，正在按间隔重试原授权。</p>
            ) : null}
            {flow.failureCode === 'SAVE_RETRYABLE' ? (
              <p>百度授权已返回，但本机保存尚未完成，正在重试保存；此时不能算账户已接入。</p>
            ) : null}
          </div>
        ) : (
          <div
            className={`connection-flow-state connection-flow-${flow.status === 'COMPLETED' ? 'good' : 'warn'}`}
          >
            <p role="status">
              {flow.status === 'COMPLETED'
                ? '授权完成，账户已保存，可以浏览并选择来源。登录核对不代表文件已下载或迁移。'
                : flow.status === 'EXPIRED'
                  ? '本次授权已过期或服务重新加载，请重新开始。'
                  : flow.status === 'CANCELLED'
                    ? '本次授权已取消。'
                    : flow.failureCode === 'IDENTITY_MISMATCH'
                      ? '返回的账户与原连接不一致，未替换原账户。请核对后重新授权。'
                      : flow.failureCode === 'SESSION_EXPIRED'
                        ? '本站登录已失效，未保存账户，请重新登录。'
                        : '授权未完成或缺少所需权限，未保存账户。请核对百度官方页面后重试。'}
            </p>
            {flow.status !== 'COMPLETED' ? (
              <button type="button" className="ghost-button" onClick={restart}>
                重新开始授权
              </button>
            ) : null}
          </div>
        )}
        <div className="connection-flow-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={() => void close()}
          >
            {flow?.status === 'PENDING' ? '取消本次授权并关闭' : '关闭'}
          </button>
        </div>
      </div>
    </div>
  );
}
