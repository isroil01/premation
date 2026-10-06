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
import { Icon } from '@components/Icon';
import { AuthShell } from './AuthShell';
import styles from './AuthPage.module.css';

const RESEND_COOLDOWN_S = 60;
const CODE_LENGTH = 6;
const BOXES = Array.from({ length: CODE_LENGTH }, (_, i) => i);

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
  const boxRefs = useRef<(HTMLInputElement | null)[]>([]);
  const focusBox = (i: number): void =>
    boxRefs.current[Math.max(0, Math.min(CODE_LENGTH - 1, i))]?.focus();

  // Count the resend cooldown down to zero, one second at a time.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    boxRefs.current[0]?.focus();
  }, []);

  // Hooks are all above these returns, so the order never changes.
  if (status !== 'authenticated') return <Navigate to="/login" replace />;
  if (user?.emailVerified) return <Navigate to="/dashboard" replace />;

  const confirm = async (value: string): Promise<void> => {
    if (submitting || value.length !== CODE_LENGTH) return;
    setError('');
    setSubmitting(true);
    try {
      await api.confirmEmail(value);
      markEmailVerified();
      await useEntitlementStore.getState().refresh({ force: true });
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(messageOf(err, 'That code did not work. Check it and try again.'));
      setCode('');
      boxRefs.current[0]?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void confirm(code);
  };

  /**
   * Every edit funnels through here: digits only, capped at six, so the boxes
   * can never hold a non-code. A complete code submits itself — the sixth
   * digit is the user saying "that is it", and a button press after it is a
   * step that carries no information.
   */
  const applyCode = (next: string): void => {
    const digits = next.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (error) setError('');
    focusBox(digits.length);
    if (digits.length === CODE_LENGTH) void confirm(digits);
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
    <AuthShell
      title="Check your inbox"
      subtitle={
        <>
          We sent a 6-digit code to <strong>{user?.email}</strong>. Enter it to start your trial.
        </>
      }
    >
      <form className={styles.form} onSubmit={onSubmit}>
        <fieldset className={styles.codeGroup}>
          <legend className={styles.label}>Confirmation code</legend>
          <div className={styles.codeBoxes}>
            {BOXES.map((i) => (
              <input
                key={i}
                ref={(el) => {
                  boxRefs.current[i] = el;
                }}
                className={`${styles.input} ${styles.codeBox}`}
                inputMode="numeric"
                // The whole code is offered to the first box; applyCode spreads it.
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                aria-label={`Digit ${i + 1} of ${CODE_LENGTH}`}
                value={code[i] ?? ''}
                disabled={submitting}
                onChange={(e) => applyCode(code.slice(0, i) + e.target.value + code.slice(i + 1))}
                onKeyDown={(e) => {
                  if (e.key === 'Backspace' && !code[i] && i > 0) {
                    e.preventDefault();
                    applyCode(code.slice(0, i - 1));
                  } else if (e.key === 'ArrowLeft') focusBox(i - 1);
                  else if (e.key === 'ArrowRight') focusBox(i + 1);
                }}
                onPaste={(e) => {
                  e.preventDefault();
                  applyCode(e.clipboardData.getData('text'));
                }}
              />
            ))}
          </div>
        </fieldset>

        {error && (
          <div className={styles.errorAlert} role="alert">
            <Icon name="warning" size="sm" aria-hidden />
            <span>{error}</span>
          </div>
        )}
        {notice && !error && (
          <p className={styles.alert} role="status">
            {notice}
          </p>
        )}

        <button
          type="submit"
          className={styles.primaryBtn}
          disabled={submitting || code.length !== CODE_LENGTH}
        >
          {submitting ? 'Confirming…' : 'Confirm email'}
        </button>
      </form>

      <div className={styles.footerLink}>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => void resend()}
          disabled={cooldown > 0}
        >
          {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
        </button>
        <button type="button" className={styles.linkBtn} onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </AuthShell>
  );
}

export default VerifyEmailPage;
