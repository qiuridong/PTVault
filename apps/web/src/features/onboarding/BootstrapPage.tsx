import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BootstrapEnrollment } from '@ptvault/contracts';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { ApiError } from '../../api/client.js';
import { finishLogin, sessionQueryKey, startLogin } from '../auth/authApi.js';
import {
  beginBootstrap,
  bootstrapQueryKey,
  completeBootstrap,
  getBootstrapStatus,
} from './bootstrapApi.js';

/** Keep the one-time claim in memory, never query strings, localStorage or request URLs. */
export function BootstrapPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [setupToken] = useState(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('setup') ?? '';
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<BootstrapEnrollment>();
  const [qr, setQr] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);
  const status = useQuery({ queryKey: bootstrapQueryKey, queryFn: getBootstrapStatus, retry: false });

  useEffect(() => {
    if (location.hash) void navigate({ pathname: location.pathname, search: location.search }, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  useEffect(() => {
    let current = true;
    setQr(undefined);
    if (enrollment) {
      void QRCode.toString(enrollment.otpauthUrl, { type: 'svg', width: 240, margin: 2 })
        .then((svg) => {
          if (current) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
        })
        .catch(() => undefined); // Manual authenticator key remains available without a QR renderer.
    }
    return () => { current = false; };
  }, [enrollment]);

  const begin = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) { setError('两次输入的密码不一致。'); return; }
    setError(undefined);
    setBusy(true);
    try {
      setEnrollment(await beginBootstrap({ setupToken, username: username.trim() }));
      setConfirmation('');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '暂时无法继续，请检查连接后再试。');
    } finally { setBusy(false); }
  };

  const complete = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || enrollment === undefined) return;
    setBusy(true);
    setError(undefined);
    let accountCreated = false;
    try {
      const result = await completeBootstrap({ setupToken, enrollmentId: enrollment.enrollmentId, password, code });
      accountCreated = true;
      setCreated(true);
      // Normal password + MFA endpoints issue the session; setup never invents a bypass cookie.
      const challenge = await startLogin({ username: result.username, password });
      const session = await finishLogin({ challengeId: challenge.challengeId, code });
      client.setQueryData(sessionQueryKey, session);
      client.setQueryData(bootstrapQueryKey, { required: false, available: false });
      setPassword('');
      setCode('');
      setEnrollment(undefined);
      void navigate('/settings/setup', { replace: true });
    } catch (cause) {
      const uncertain = !(cause instanceof ApiError) || cause.status >= 500 || cause.code === 'SETUP_CLOSED';
      if (!accountCreated && uncertain) {
        try {
          const current = await getBootstrapStatus();
          client.setQueryData(bootstrapQueryKey, current);
          accountCreated = !current.required;
        } catch {
          setError('暂时无法确认账号是否已创建。恢复连接后重试，不需要重新安装。');
          return;
        }
      }
      if (accountCreated) {
        setCreated(true);
        setEnrollment(undefined);
        setPassword('');
        setCode('');
        setError('账号已经创建，暂时未能完成登录。点击“继续设置”正常登录即可。');
      } else {
        setError(cause instanceof ApiError ? cause.message : '暂时无法继续，请检查连接后再试。');
      }
    } finally { setBusy(false); }
  };

  const secret = enrollment ? new URL(enrollment.otpauthUrl).searchParams.get('secret') : null;
  const alreadyCreated = created || status.data?.required === false;

  return (
    <main className="auth-page setup-auth-page">
      <section className="auth-panel setup-auth-panel" aria-labelledby="setup-account-title">
        <header className="auth-heading">
          <p className="page-kicker">PTVault · 首次使用</p>
          <h1 id="setup-account-title">{alreadyCreated ? '管理员已创建' : '先创建你的管理员账号'}</h1>
          <p>账号和设置保存在这台服务器。完成这一步不会开始迁移文件。</p>
        </header>
        {status.isPending ? <p role="status">正在检查安装状态…</p> : null}
        {status.isError ? <p role="alert">暂时连不上服务。确认服务启动后，可以刷新此页重试。</p> : null}
        {error ? <p role="alert" className="inline-message error-message">{error}</p> : null}
        {alreadyCreated ? (
          <div className="setup-next-step">
            <p>如果没有自动进入设置页，正常登录后就能继续。</p>
            <Link className="primary-button" to="/settings/setup">继续设置</Link>
          </div>
        ) : status.data && (!status.data.available || !setupToken) ? (
          <div className="setup-next-step">
            <p>请使用安装完成时显示的完整链接。链接过期后，在服务器运行下面的命令获取新链接。</p>
            <code>ptvault setup-link</code>
            <p>已有账号？<Link to="/login">前往登录</Link></p>
          </div>
        ) : status.data && !enrollment ? (
          <form className="auth-form" onSubmit={(event) => void begin(event)} aria-busy={busy}>
            <div className="field"><label htmlFor="setup-username">用户名</label>
              <input id="setup-username" autoComplete="username" required maxLength={64} value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
            </div>
            <div className="field"><label htmlFor="setup-password">密码</label>
              <input id="setup-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
              <p className="field-help">至少12个字符，建议用密码管理器生成并保存。</p>
            </div>
            <div className="field"><label htmlFor="setup-confirmation">再输入一次密码</label>
              <input id="setup-confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={busy} />
            </div>
            <button className="primary-button" type="submit" disabled={busy}>{busy ? '正在准备…' : '下一步：添加验证器'}</button>
          </form>
        ) : enrollment ? (
          <form className="auth-form" onSubmit={(event) => void complete(event)} aria-busy={busy}>
            <p>用手机上的身份验证器扫描二维码，再输入它显示的6位数字。验证成功后才会创建账号。</p>
            {qr ? <img className="setup-qr" src={qr} width={240} height={240} alt="添加 PTVault 身份验证器的二维码" draggable={false} /> : null}
            <details className="setup-manual-key"><summary>无法扫描？手动添加</summary>
              <p>类型选择“基于时间”，账号填写 {username}，密钥如下。请勿把密钥或二维码发给别人。</p>
              <code>{secret}</code>
              <p><a href={enrollment.otpauthUrl}>在本机验证器中打开</a></p>
            </details>
            <div className="field"><label htmlFor="setup-code">验证器中的6位数字</label>
              <input id="setup-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} disabled={busy} />
            </div>
            <button className="primary-button" type="submit" disabled={busy || code.length !== 6}>{busy ? '正在验证并创建…' : '创建账号并继续'}</button>
            <button className="ghost-button" type="button" disabled={busy} onClick={() => { setEnrollment(undefined); setCode(''); setConfirmation(password); setError(undefined); }}>返回修改账号</button>
          </form>
        ) : null}
      </section>
    </main>
  );
}
