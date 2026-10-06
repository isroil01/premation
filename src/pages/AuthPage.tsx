/**
 * AuthPage — sign in, create account, and the password reset pair.
 * Handles /login, /register, /forgot-password, and /reset-password.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@stores/authStore';
import { api } from '@core/api/client';
import { startSocialAuth } from '@core/auth/startSocialAuth';
import { setSession } from '@core/api/session';
import { Icon } from '@components/Icon/Icon';
import { cn } from '@utils/cn';
import { AuthShell, PasswordRules } from './AuthShell';
import styles from './AuthPage.module.css';

export type AuthMode = 'login' | 'register' | 'forgot' | 'reset';

const TITLES: Record<AuthMode, string> = {
  login: 'Welcome back',
  register: 'Create your account',
  forgot: 'Reset your password',
  reset: 'Set a new password',
};

const SUBTITLES: Record<AuthMode, string> = {
  login: 'Sign in to pick up where you left off.',
  register: 'Your trial starts when you confirm your email.',
  forgot: 'Enter the email you signed up with. We will send a link to set a new password.',
  reset: 'Choose a new password. You will be signed in straight after.',
};

const SUBMIT_LABELS: Record<AuthMode, string> = {
  login: 'Sign in',
  register: 'Create account',
  forgot: 'Send reset link',
  reset: 'Set password and sign in',
};

function GoogleMark(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      />
    </svg>
  );
}

export function AuthPage({ mode }: { mode: AuthMode }): JSX.Element {
  const status = useAuthStore((s) => s.status);
  const storeError = useAuthStore((s) => s.error);
  const user = useAuthStore((s) => s.user);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const clearError = useAuthStore((s) => s.clearError);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState('');

  const [localBusy, setLocalBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [sent, setSent] = useState(false);

  /**
   * Whether the server offers Google sign-in. Google is the only provider this
   * screen shows; the button is absent until the server says it is configured.
   */
  const [googleEnabled, setGoogleEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .authProviders()
      .then((r) => {
        if (alive) setGoogleEnabled(r.providers.some((p) => p.id === 'google'));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  /**
   * An error belongs to the screen it happened on. The four modes share this
   * component instance, so without this a failed sign-in is still on display
   * after the user moves to Create account. Skipped on mount: an error already
   * in the store when the page opens is one the user has not seen yet.
   */
  const shownMode = useRef(mode);
  useEffect(() => {
    if (shownMode.current === mode) return;
    shownMode.current = mode;
    clearError();
    setLocalError('');
    setSent(false);
    setShowPassword(false);
  }, [mode, clearError]);

  const isLogin = mode === 'login';
  const isRegister = mode === 'register';
  const isForgot = mode === 'forgot';
  const isReset = mode === 'reset';
  const resetToken = searchParams.get('token') ?? '';

  const submitting = status === 'loading' || localBusy;
  const error = localError || (isForgot || isReset ? '' : storeError);

  const authedDest = user && !user.emailVerified ? '/verify-email' : from;
  if (status === 'authenticated' && !isReset) return <Navigate to={authedDest} replace />;

  const sendResetLink = async (): Promise<void> => {
    setLocalError('');
    setLocalBusy(true);
    try {
      await api.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not send the link. Try again.');
    } finally {
      setLocalBusy(false);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError('');

    if (isForgot) {
      await sendResetLink();
      return;
    }

    if (isReset) {
      setLocalBusy(true);
      try {
        const result = await api.resetPassword(resetToken, password);
        await setSession(result);
        useAuthStore.setState({ status: 'authenticated', user: result.user, error: null });
        navigate(result.user.emailVerified ? '/dashboard' : '/verify-email', { replace: true });
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'Could not set the password. Try again.');
      } finally {
        setLocalBusy(false);
      }
      return;
    }

    try {
      if (isLogin) await login(email, password);
      else await register(email, password, name || undefined);
      const u = useAuthStore.getState().user;
      navigate(u && !u.emailVerified ? '/verify-email' : from, { replace: true });
    } catch {
      /* error handled via store */
    }
  };

  if (isReset && !resetToken) {
    return (
      <AuthShell title="This link is incomplete" subtitle="The reset link is missing its security token. Request a new one and use the link from that email.">
        <Link to="/forgot-password" className={styles.primaryBtn}>
          Request a new link
        </Link>
        <div className={styles.footerLink}>
          <Link to="/login">Back to sign in</Link>
        </div>
      </AuthShell>
    );
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle={
          <>
            If <strong>{email}</strong> has a Premation account, a reset link is on its way.
          </>
        }
      >
        <p className={styles.alert} role="status">
          Nothing after a few minutes? Check your spam folder, or send the link again.
        </p>
        {error && (
          <div className={styles.errorAlert} role="alert">
            <Icon name="warning" size="sm" />
            <span>{error}</span>
          </div>
        )}
        <button
          type="button"
          className={styles.secondaryBtn}
          disabled={submitting}
          onClick={() => void sendResetLink()}
        >
          {submitting ? 'Sending…' : 'Send again'}
        </button>
        <div className={styles.footerLink}>
          <Link to="/login">Back to sign in</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={TITLES[mode]} subtitle={SUBTITLES[mode]}>
      <form className={styles.form} onSubmit={onSubmit}>
        {(isLogin || isRegister) && googleEnabled && (
          <>
            <button
              type="button"
              className={styles.socialBtn}
              disabled={submitting}
              onClick={() => startSocialAuth('google')}
            >
              <GoogleMark />
              <span>Continue with Google</span>
            </button>
            <div className={styles.divider}>
              <span>or with email</span>
            </div>
          </>
        )}

        {isRegister && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="name">
              Name
            </label>
            <input
              id="name"
              type="text"
              className={styles.input}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        )}

        {!isReset && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              className={styles.input}
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        )}

        {!isForgot && (
          <div className={styles.field}>
            <div className={styles.labelRow}>
              <label className={styles.label} htmlFor="password">
                {isReset ? 'New password' : 'Password'}
              </label>
              {isLogin && (
                <Link to="/forgot-password" className={styles.forgotLink}>
                  Forgot password?
                </Link>
              )}
            </div>
            <div className={styles.inputWrapper}>
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                className={cn(styles.input, styles.inputWithToggle)}
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                required
                minLength={isLogin ? undefined : 8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className={styles.passwordToggle}
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            {/* Shown before typing, so the rule is known rather than discovered. */}
            {!isLogin && <PasswordRules password={password} />}
          </div>
        )}

        {error && (
          <div className={styles.errorAlert} role="alert">
            <Icon name="warning" size="sm" />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" className={styles.primaryBtn} disabled={submitting}>
          {submitting && <span className={styles.spinner} aria-hidden="true" />}
          <span>{submitting ? 'Please wait…' : SUBMIT_LABELS[mode]}</span>
        </button>

        {isRegister && (
          <p className={styles.termsNotice}>
            By creating an account, you agree to our Terms of Service and Privacy Policy.
          </p>
        )}

        <div className={styles.footerLink}>
          {isLogin ? (
            <span>
              New here? <Link to="/register">Create an account</Link>
            </span>
          ) : isRegister ? (
            <span>
              Have an account? <Link to="/login">Sign in</Link>
            </span>
          ) : (
            <Link to="/login">Back to sign in</Link>
          )}
        </div>
      </form>
    </AuthShell>
  );
}

export default AuthPage;
