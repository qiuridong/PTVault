import { LockKeyhole, ShieldCheck, CloudUpload, KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { ApiError } from '../../api/client.js';
import { ShaderBackground } from '../../showcase/ShaderBackground.js';
import { returnToFromState } from './sessionLifecycle.js';
import { startLogin } from './authApi.js';

const CAPABILITIES: ReadonlyArray<{ icon: typeof ShieldCheck; label: string; detail: string }> = [
  { icon: ShieldCheck, label: '零信任删除门', detail: '云端验证副本前，本地原件字节不动' },
  { icon: CloudUpload, label: '加密离线归档', detail: 'crypt 全盘加密名与内容，解密回读校验' },
  { icon: KeyRound, label: '恢复优先', detail: '离线恢复演练解锁后才允许清理' },
];

/**
 * The invariants this system is built on, scrolling.
 *
 * Decorative and `aria-hidden`: none of it is a live reading, and a marquee that
 * looked like telemetry on the one screen where nobody is signed in yet would be
 * the worst possible place to blur that line. Listed twice so the track can loop
 * on a half-turn without a seam.
 */
const TICKER = [
  'SHA-256 三方一致',
  'crypt 文件名加密',
  '双云端副本',
  '解密回读校验',
  '一次性步进 MFA',
  '离线恢复包',
];

function loginErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Authentication is unavailable. Try again.';
  if (error.status === 400) return 'Check the account details and try again.';
  if (error.status === 401) return 'Username or password is incorrect.';
  if (error.status === 429) return 'Too many attempts. Wait before trying again.';
  return 'Authentication is unavailable. Try again.';
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (isSubmitting) return;

    const submittedPassword = password;
    setPassword('');
    setError(undefined);
    setIsSubmitting(true);
    try {
      const challenge = await startLogin({
        username: username.trim(),
        password: submittedPassword,
      });
      const returnTo = returnToFromState(location.state) ?? '/';
      void navigate('/login/mfa', { replace: true, state: { ...challenge, returnTo } });
    } catch (cause) {
      setError(loginErrorMessage(cause));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="auth-page auth-split">
      <ShaderBackground />

      <section className="auth-showcase" aria-hidden="true">
        <div className="auth-brand">
          <span className="brand-mark">
            <LockKeyhole size={18} strokeWidth={1.8} />
          </span>
          <span>PT Cloud Vault</span>
        </div>
        <div className="auth-showcase-copy">
          <p className="auth-eyebrow">加密离线 · 恢复优先</p>
          <h2 className="auth-display">
            把种子交给云端，
            <em>本地永远有据可退。</em>
          </h2>
        </div>
        <ul className="auth-capabilities">
          {CAPABILITIES.map(({ icon: Icon, label, detail }) => (
            <li key={label}>
              <span className="auth-capability-icon">
                <Icon size={18} strokeWidth={1.8} />
              </span>
              <span className="auth-capability-text">
                <strong>{label}</strong>
                <span>{detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="auth-ticker">
          <div className="auth-ticker-track">
            {[...TICKER, ...TICKER].map((entry, index) => (
              <span key={`${entry}-${index}`}>{entry}</span>
            ))}
          </div>
        </div>
      </section>

      <div className="auth-stage">
        <section className="auth-panel" aria-labelledby="login-title">
          <div className="auth-brand auth-brand-compact" aria-label="PT Cloud Vault">
            <span className="brand-mark" aria-hidden="true">
              <LockKeyhole size={18} strokeWidth={1.8} />
            </span>
            <span>PT Cloud Vault</span>
          </div>
          <header className="auth-heading">
            <h1 id="login-title">管理员登录</h1>
            <p>安全运维控制台</p>
          </header>

          <form
            className="auth-form"
            onSubmit={(event) => void submit(event)}
            aria-busy={isSubmitting}
          >
            <div className="field">
              <label htmlFor="username">用户名</label>
              <input
                id="username"
                name="username"
                type="text"
                aria-label="Username"
                autoComplete="username"
                required
                maxLength={64}
                value={username}
                onChange={(event) => setUsername(event.currentTarget.value)}
                disabled={isSubmitting}
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="password">密码</label>
              <input
                id="password"
                name="password"
                type="password"
                aria-label="Password"
                autoComplete="current-password"
                required
                minLength={username.trim() === 'test' ? 6 : 12}
                maxLength={256}
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                disabled={isSubmitting}
              />
            </div>

            {error ? (
              <p className="inline-message error-message" role="alert">
                {error}
              </p>
            ) : null}

            <button
              className="primary-button"
              type="submit"
              disabled={isSubmitting}
              aria-label="Continue"
            >
              {isSubmitting ? '登录中…' : '登录'}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
