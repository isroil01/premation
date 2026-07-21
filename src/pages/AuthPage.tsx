/**
 * AuthPage — the routed sign-in / create-account / password-reset screen.
 * Drives the existing `authStore`; on success it returns the user to wherever
 * RequireAuth sent them from, or the dashboard.
 *
 * All four states share one component because they are one form with different
 * fields — splitting them would mean four copies of the same layout, and the
 * brand aside drifting between them.
 */

import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@stores/authStore';
import { api, setToken } from '@core/api/client';
import styles from './AuthPage.module.css';

export type AuthMode = 'login' | 'register' | 'forgot' | 'reset';

export function AuthPage({ mode }: { mode: AuthMode }): JSX.Element {
  const status = useAuthStore((s) => s.status);
  const storeError = useAuthStore((s) => s.error);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  /** Reset-flow state, kept local — the auth store has no say in it. */
  const [localBusy, setLocalBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [sent, setSent] = useState(false);

  const isLogin = mode === 'login';
  const isRegister = mode === 'register';
  const isForgot = mode === 'forgot';
  const isReset = mode === 'reset';
  const resetToken = searchParams.get('token') ?? '';

  const submitting = status === 'loading' || localBusy;
  const error = localError || (isForgot || isReset ? '' : storeError);

  // Already signed in → skip the form. Not during a reset: someone with a live
  // session may be resetting precisely because they think it's compromised.
  if (status === 'authenticated' && !isReset) return <Navigate to={from} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError('');

    if (isForgot) {
      setLocalBusy(true);
      try {
        await api.forgotPassword(email);
        // Shown whatever the answer — the server won't say whether the address
        // exists, and neither should this screen.
        setSent(true);
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'Could not send that. Try again.');
      } finally {
        setLocalBusy(false);
      }
      return;
    }

    if (isReset) {
      setLocalBusy(true);
      try {
        const result = await api.resetPassword(resetToken, password);
        // The server signs us in as part of the reset; adopt that session.
        setToken(result.token);
        useAuthStore.setState({ status: 'authenticated', user: result.user, error: null });
        navigate('/dashboard', { replace: true });
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'Could not reset your password.');
      } finally {
        setLocalBusy(false);
      }
      return;
    }

    try {
      if (isLogin) await login(email, password);
      else await register(email, password, name || undefined);
      navigate(from, { replace: true });
    } catch {
      /* error surfaced via the store */
    }
  };

  const title = isLogin ? 'Welcome back'
    : isRegister ? 'Create your account'
    : isForgot ? 'Reset your password'
    : 'Choose a new password';

  const subtitle = isLogin ? 'Sign in to open your projects.'
    : isRegister ? 'Start building motion graphics in minutes.'
    : isForgot ? "Enter your email and we'll send you a link."
    : 'This link works once, and only for the next hour.';

  return (
    <div className={styles.root}>
      <div className={styles.aside} aria-hidden>
        <span className={styles.mark}>◆</span>
        <h1 className={styles.brand}>Motion&nbsp;Editor</h1>
        <p className={styles.tagline}>AI-assisted motion graphics — design, animate, and render in the cloud.</p>
      </div>

      <div className={styles.panel}>
        <form className={styles.card} onSubmit={onSubmit}>
          <h2 className={styles.title}>{title}</h2>
          <p className={styles.subtitle}>{subtitle}</p>

          {/* A reset link with no token in it can't do anything — say so
              rather than showing a form that is guaranteed to fail. */}
          {isReset && !resetToken ? (
            <>
              <p className={styles.error} role="alert">
                This link is missing its token. Request a new one.
              </p>
              <p className={styles.switch}>
                <Link to="/forgot-password">Send a new link</Link>
              </p>
            </>
          ) : sent ? (
            <>
              {/* Deliberately does not say "sent" — the server won't confirm
                  whether the address has an account, so neither can we. */}
              <p className={styles.subtitle} role="status">
                If <strong>{email}</strong> has an account, a reset link is on its way. It expires in
                an hour. Check your spam folder if it doesn't appear.
              </p>
              <p className={styles.switch}>
                <Link to="/login">Back to sign in</Link>
              </p>
            </>
          ) : (
            <>
              {isRegister && (
                <label className={styles.field}>
                  <span>Name</span>
                  <input
                    type="text"
                    autoComplete="name"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              )}

              {!isReset && (
                <label className={styles.field}>
                  <span>Email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="you@studio.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
              )}

              {!isForgot && (
                <label className={styles.field}>
                  <span>{isReset ? 'New password' : 'Password'}</span>
                  <input
                    type="password"
                    autoComplete={isLogin ? 'current-password' : 'new-password'}
                    required
                    minLength={isLogin ? undefined : 8}
                    placeholder={isLogin ? '••••••••' : 'At least 8 characters'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              )}

              {error && <p className={styles.error} role="alert">{error}</p>}

              <button type="submit" className={styles.submit} disabled={submitting}>
                {submitting ? 'Please wait…'
                  : isLogin ? 'Sign in'
                  : isRegister ? 'Create account'
                  : isForgot ? 'Send reset link'
                  : 'Set new password'}
              </button>

              <p className={styles.switch}>
                {isLogin ? (
                  <>
                    <Link to="/forgot-password">Forgot your password?</Link>
                    <br />
                    New here? <Link to="/register">Create an account</Link>
                  </>
                ) : isRegister ? (
                  <>Already have an account? <Link to="/login">Sign in</Link></>
                ) : (
                  <>Remembered it? <Link to="/login">Sign in</Link></>
                )}
              </p>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

export default AuthPage;
