import { Check, KeyRound } from 'lucide-react';
import { useState, type ClipboardEvent, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../api/client.js';
import { ShaderBackground } from '../../showcase/ShaderBackground.js';
import {
  finishLogin,
  LoginChallengeSchema,
  sessionQueryKey,
  type LoginChallenge,
} from './authApi.js';
import { returnToFromState } from './sessionLifecycle.js';

function mfaErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Verification is unavailable. Try again.';
  if (error.status === 400) return 'Enter exactly six digits.';
  if (error.status === 401) return 'The verification code is invalid or expired.';
  if (error.status === 429) return 'Too many verification attempts. Wait before retrying.';
  return 'Verification is unavailable. Try again.';
}

export function MfaPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const parsedState = LoginChallengeSchema.safeParse(location.state);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!parsedState.success) return <Navigate to="/login" replace />;
  const challenge: LoginChallenge = parsedState.data;
  const returnTo = returnToFromState(location.state) ?? '/';

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (isSubmitting) return;
    if (!/^\d{6}$/.test(code)) {
      setError('Enter exactly six digits.');
      return;
    }

    const submittedCode = code;
    setCode('');
    setError(undefined);
    setIsSubmitting(true);
    try {
      const session = await finishLogin({
        challengeId: challenge.challengeId,
        code: submittedCode,
      });
      queryClient.setQueryData(sessionQueryKey, session);
      void navigate(returnTo, { replace: true });
    } catch (cause) {
      setError(mfaErrorMessage(cause));
    } finally {
      setIsSubmitting(false);
    }
  };

  const pasteCode = (event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = event.clipboardData.getData('text').trim();
    if (!/^\d{6}$/.test(pasted)) return;
    event.preventDefault();
    setCode(pasted);
    setError(undefined);
  };

  return (
    <main className="auth-page auth-split">
      <ShaderBackground />

      {/*
        Same stage as the login screen, different copy. Continuity matters here:
        the second factor is a step in one sign-in, not a new place, and a screen
        that looks unrelated is the one people abandon.
      */}
      <section className="auth-showcase" aria-hidden="true">
        <div className="auth-brand">
          <span className="brand-mark">
            <KeyRound size={18} strokeWidth={1.8} />
          </span>
          <span>PT Cloud Vault</span>
        </div>
        <div className="auth-showcase-copy">
          <p className="auth-eyebrow">第二道门</p>
          <h2 className="auth-display">
            一个码，
            <em>只放行一次。</em>
          </h2>
        </div>
        <ul className="auth-capabilities">
          <li>
            <span className="auth-capability-icon">
              <Check size={18} strokeWidth={2.2} />
            </span>
            <span className="auth-capability-text">
              <strong>01 · 用户名与密码</strong>
              <span>已通过</span>
            </span>
          </li>
          <li>
            <span className="auth-capability-icon">
              <KeyRound size={18} strokeWidth={1.8} />
            </span>
            <span className="auth-capability-text">
              <strong>02 · 身份验证器动态码</strong>
              <span>六位数字，30 秒一换，用过即废</span>
            </span>
          </li>
        </ul>
      </section>

      <div className="auth-stage">
        <section className="auth-panel" aria-labelledby="mfa-title">
          <div className="auth-brand auth-brand-compact" aria-label="PT Cloud Vault">
            <span className="brand-mark" aria-hidden="true">
              <KeyRound size={18} strokeWidth={1.8} />
            </span>
            <span>PT Cloud Vault</span>
          </div>
          <header className="auth-heading">
            <h1 id="mfa-title">验证登录</h1>
            <p>请输入身份验证器动态码</p>
          </header>

          <form
            className="auth-form"
            onSubmit={(event) => void submit(event)}
            aria-busy={isSubmitting}
            noValidate
          >
            <div className="field">
              <label htmlFor="mfa-code">六位动态验证码</label>
              <input
                id="mfa-code"
                name="code"
                className="code-input"
                type="text"
                aria-label="Six-digit verification code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onPaste={pasteCode}
                onChange={(event) => {
                  setCode(event.currentTarget.value.replace(/\D/g, '').slice(0, 6));
                  setError(undefined);
                }}
                disabled={isSubmitting}
                autoFocus
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
              aria-label="Verify"
            >
              {isSubmitting ? '验证中…' : '验证'}
            </button>
          </form>

          <div className="auth-actions">
            <Link to="/login" state={{ returnTo }} aria-label="Back to login">
              返回登录
            </Link>
            <Link to="/login/recovery" state={{ returnTo }} aria-label="Use a recovery code">
              使用恢复码
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
