/**
 * Confirm your email — the code gate.
 *
 * This is a DESKTOP app, so verification is a 6-digit code the user types here,
 * not a link that would open a browser away from the app. New email/password
 * accounts land here right after signup and cannot reach anything else until they
 * enter the code (see RequireAuth) — the trial clock only starts once a real
 * mailbox is proven. OAuth accounts arrive verified and never see this page.
 *
 * Confirming does NOT establish the session — the user already has one from
 * signup. It flips their state, and `markEmailVerified` lets RequireAuth open the
 * rest of the app on the next render.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '@core/api/client';
import { useAuthStore } from '@stores/authStore';
import { useEntitlementStore } from '@stores/entitlementStore';
import styles from './AuthPage.module.css';

const RESEND_COOLDOWN_S = 60;

/** Pull the server's `{ code, message }` out of a failed request. */
function messageOf(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string | { message?: string } } }).body;
  const msg = typeof body?.message === 'object' ? body.message.message : body?.message;
  return msg || (err instanceof Error ? err.message : fallback);
}

export function VerifyEmailPage(): JSX.Element {
  const navigate = useNavigate();
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const markEmailVerified = useAuthStore((s) => s.markEmailVerified);
  const logout = useAuthStore((s) => s.logout);

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Count the resend cooldown down to zero, one second at a time.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Hooks are all above these returns, so the order never changes.
  if (status !== 'authenticated') return <Navigate to="/login" replace />;
  if (user?.emailVerified) return <Navigate to="/dashboard" replace />;

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting || code.length !== 6) return;
    setError('');
    setSubmitting(true);
    try {
      await api.confirmEmail(code);
      markEmailVerified();
      await useEntitlementStore.getState().refresh({ force: true });
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(messageOf(err, 'That code did not work. Check it and try again.'));
      setCode('');
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async (): Promise<void> => {
    if (cooldown > 0) return;
    setError('');
    setNotice('');
    try {
      await api.resendVerification();
      setNotice('A new code is on its way.');
      setCooldown(RESEND_COOLDOWN_S);
    } catch (err) {
      setError(messageOf(err, 'Could not send a new code just now.'));
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>Confirm your email</h1>
          <p className={styles.subtitle}>
            We sent a 6-digit code to <strong>{user?.email}</strong>. Enter it below to
            start your trial. You’ll need to confirm before you can continue.
          </p>
        </div>

        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="code">Confirmation code</label>
            <input
              ref={inputRef}
              id="code"
              className={styles.input}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => {
                // Digits only, capped at 6 — the field can never hold a non-code.
                setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                if (error) setError('');
              }}
            />
          </div>

          {error && <p className={styles.error}>{error}</p>}
          {notice && !error && <p className={styles.alert}>{notice}</p>}

          <button
            type="submit"
            className={styles.primaryBtn}
            disabled={submitting || code.length !== 6}
          >
            {submitting ? 'Confirming…' : 'Confirm email'}
          </button>
        </form>

        <div className={styles.footerLink}>
          <button
            type="button"
            className={styles.link}
            onClick={resend}
            disabled={cooldown > 0}
          >
            {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
          </button>
          {' · '}
          <button type="button" className={styles.link} onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export default VerifyEmailPage;
