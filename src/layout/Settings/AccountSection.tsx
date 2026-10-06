/**
 * Account — who the signed-in person is and how they get in.
 *
 * Name (inline), email (a two-step change: code to the NEW address), password
 * (change, or set one on a Google-only account), the devices with a live
 * session, and the one irreversible thing: deleting the account.
 *
 * Everything the panel shows is server state (`AccountRecord`, `/auth/sessions`,
 * `/billing/me`); it decides nothing about eligibility. Every write goes
 * through `api.*` and ends in `onAccountChanged`, which re-reads `/auth/me`,
 * so a row never shows a value the server has not confirmed.
 *
 * A password change or set returns a fresh session (every other device is
 * signed out server-side). That `AuthResult` goes through `setSession` and
 * `adoptSession` exactly like the reset-password page, so the desktop keystore
 * and the auth store both learn the new tokens before the dialog closes.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useAuthStore } from '@stores/authStore';
import { useUIStore } from '@stores/uiStore';
import { api, type AccountRecord, type AuthResult, type BillingRefundState, type SessionRecord } from '@core/api/client';
import { setSession } from '@core/api/session';
import { t } from '@core/i18n/t';
import { PasswordRules } from '../../pages/AuthShell';
import { cn } from '@utils/cn';
import styles from './AccountSection.module.css';

export interface AccountSectionProps {
  account: AccountRecord;
  /** Re-read `/auth/me` — called after every successful write. */
  onAccountChanged: () => void | Promise<void>;
  /** Open the Billing tab (the refund-first link in the delete dialog). */
  onOpenBilling: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Server-authored `{ code, message }` if there is one, else the raw error. */
function readError(err: unknown): string {
  const body = (err as { body?: { message?: string | { message?: string } } }).body;
  const msg = typeof body?.message === 'object' ? body.message.message : body?.message;
  return msg || (err instanceof Error ? err.message : t('account.error.generic', 'Something went wrong.'));
}

function toast(level: 'success' | 'error' | 'info', message: string): void {
  useUIStore.getState().notify({ level, message, durationMs: level === 'error' ? 6000 : 3500 });
}

/** "just now", "5 min ago", "3 h ago", "12 d ago" — a session's last use. */
export function formatRelative(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 60) return t('account.time.justNow', 'just now');
  const min = Math.round(sec / 60);
  if (min < 60) return t('account.time.minutesAgo', '{n} min ago', { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t('account.time.hoursAgo', '{n} h ago', { n: hr });
  return t('account.time.daysAgo', '{n} d ago', { n: Math.round(hr / 24) });
}

const CODE_RE = /^\d{6}$/;

/** The two rules the server applies (mirrors `PasswordRules`). */
function passwordOk(password: string): boolean {
  return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

/** After a password change/set: the desktop keystore first, then the store. */
async function adoptAuthResult(result: AuthResult): Promise<void> {
  await setSession(result);
  await useAuthStore.getState().adoptSession(result.user);
}

/** Keep the header's name/email current without waiting for the next `/auth/me`. */
function patchAuthUser(patch: { name?: string | null; email?: string }): void {
  useAuthStore.setState((s) => (s.user ? { user: { ...s.user, ...patch } } : {}));
}

// ── Email change dialog ────────────────────────────────────────────────

interface EmailChangeDialogProps {
  account: AccountRecord;
  /** Start on the code step — the request was already made (a pending change). */
  startAtCode: boolean;
  close: () => void;
  onChanged: () => void;
}

function EmailChangeDialog({ account, startAtCode, close, onChanged }: EmailChangeDialogProps): JSX.Element {
  const [step, setStep] = useState<'request' | 'code'>(startAtCode ? 'code' : 'request');
  const [pending, setPending] = useState(account.pendingEmail ?? '');
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, [step]);

  const canRequest = newEmail.trim().includes('@') && (!account.hasPassword || password.length > 0);
  const canConfirm = CODE_RE.test(code);

  const request = async (): Promise<void> => {
    if (!canRequest || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.requestEmailChange(newEmail.trim(), account.hasPassword ? password : undefined);
      setPending(res.pendingEmail);
      setCode('');
      setStep('code');
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (!canConfirm || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.confirmEmailChange(code);
      patchAuthUser({ email: res.email });
      toast('success', t('account.email.changed', 'Email changed to {email}.', { email: res.email }));
      close();
      onChanged();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  };

  const resend = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.resendEmailChange();
      toast('info', t('account.email.resent', 'A new code is on its way to {email}.', { email: pending }));
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  };

  const cancelChange = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.cancelEmailChange();
      toast('info', t('account.email.cancelled', 'Email change cancelled.'));
      close();
      onChanged();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  };

  useDialogPrimaryAction(step === 'request' ? (canRequest ? () => void request() : null) : canConfirm ? () => void confirm() : null);

  if (step === 'request') {
    return (
      <div className={styles.stack}>
        <p className={styles.message}>
          {t(
            'account.email.requestIntro',
            'We will send a 6-digit code to the new address. Your email stays {email} until you enter it.',
            { email: account.email },
          )}
        </p>
        <Input
          ref={firstRef}
          fullWidth
          type="email"
          label={t('account.email.newLabel', 'New email')}
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          autoComplete="email"
        />
        {account.hasPassword && (
          <Input
            fullWidth
            type="password"
            label={t('account.email.passwordLabel', 'Current password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <DialogFooter
          secondary={
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t('account.dialog.cancel', 'Cancel')}
            </Button>
          }
          primary={
            <Button variant="primary" onClick={() => void request()} disabled={!canRequest} loading={busy}>
              {t('account.email.sendCode', 'Send code')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <p className={styles.message}>
        {t('account.email.codeIntro', 'Enter the 6-digit code we sent to {email}.', { email: pending })}
      </p>
      <Input
        ref={firstRef}
        fullWidth
        inputMode="numeric"
        label={t('account.code.label', 'Code')}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        autoComplete="one-time-code"
        placeholder="000000"
      />
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.linkRow}>
        <Button variant="ghost" size="sm" onClick={() => void resend()} disabled={busy}>
          {t('account.email.resend', 'Resend code')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void cancelChange()} disabled={busy}>
          {t('account.email.cancelChange', 'Cancel change')}
        </Button>
      </div>
      <DialogFooter
        secondary={
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('account.dialog.later', 'Later')}
          </Button>
        }
        primary={
          <Button variant="primary" onClick={() => void confirm()} disabled={!canConfirm} loading={busy}>
            {t('account.email.confirm', 'Confirm new email')}
          </Button>
        }
      />
    </div>
  );
}

function openEmailChange(account: AccountRecord, startAtCode: boolean, onChanged: () => void): void {
  openModal({
    title: startAtCode
      ? t('account.email.enterCodeTitle', 'Confirm your new email')
      : t('account.email.changeTitle', 'Change email'),
    size: 'sm',
    persistent: true,
    render: (close) => (
      <EmailChangeDialog account={account} startAtCode={startAtCode} close={close} onChanged={onChanged} />
    ),
  });
}

// ── Password dialog ────────────────────────────────────────────────────

interface PasswordDialogProps {
  hasPassword: boolean;
  close: () => void;
  onChanged: () => void;
}

function PasswordDialog({ hasPassword, close, onChanged }: PasswordDialogProps): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit = passwordOk(next) && confirm === next && (!hasPassword || current.length > 0);

  const submit = async (): Promise<void> => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = hasPassword ? await api.changePassword(current, next) : await api.setPassword(next);
      await adoptAuthResult(result);
      toast(
        'success',
        hasPassword
          ? t('account.password.changed', 'Password changed. Other devices were signed out.')
          : t('account.password.set', 'Password set. You can now sign in with it.'),
      );
      close();
      onChanged();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  };

  useDialogPrimaryAction(canSubmit ? () => void submit() : null);

  return (
    <div className={styles.stack}>
      <p className={styles.message}>
        {hasPassword
          ? t('account.password.changeIntro', 'Every other device is signed out when the password changes.')
          : t('account.password.setIntro', 'Add a password so you can sign in without Google.')}
      </p>
      {hasPassword && (
        <Input
          ref={firstRef}
          fullWidth
          type="password"
          label={t('account.password.currentLabel', 'Current password')}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
      )}
      <Input
        ref={hasPassword ? undefined : firstRef}
        fullWidth
        type="password"
        label={t('account.password.newLabel', 'New password')}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        autoComplete="new-password"
      />
      <PasswordRules password={next} />
      <Input
        fullWidth
        type="password"
        label={t('account.password.confirmLabel', 'Confirm new password')}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        error={mismatch ? t('account.password.mismatch', 'Passwords do not match.') : undefined}
      />
      {error && <p className={styles.error} role="alert">{error}</p>}
      <DialogFooter
        secondary={
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('account.dialog.cancel', 'Cancel')}
          </Button>
        }
        primary={
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit} loading={busy}>
            {hasPassword ? t('account.password.changeAction', 'Change password') : t('account.password.setAction', 'Set password')}
          </Button>
        }
      />
    </div>
  );
}

function openPasswordDialog(hasPassword: boolean, onChanged: () => void): void {
  openModal({
    title: hasPassword ? t('account.password.changeTitle', 'Change password') : t('account.password.setTitle', 'Set a password'),
    size: 'sm',
    persistent: true,
    render: (close) => <PasswordDialog hasPassword={hasPassword} close={close} onChanged={onChanged} />,
  });
}

// ── Delete account dialog ──────────────────────────────────────────────

interface DeleteAccountDialogProps {
  account: AccountRecord;
  close: () => void;
  onOpenBilling: () => void;
  onDeleted: () => void;
}

function DeleteAccountDialog({ account, close, onOpenBilling, onDeleted }: DeleteAccountDialogProps): JSX.Element {
  const [step, setStep] = useState<'explain' | 'confirm'>('explain');
  const [billing, setBilling] = useState<{ hasSubscription: boolean; refund: BillingRefundState | null } | 'loading' | 'unknown'>('loading');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [typedEmail, setTypedEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .getBilling()
      .then((s) => {
        if (alive) setBilling({ hasSubscription: s.hasSubscription, refund: s.refund ?? null });
      })
      .catch(() => {
        if (alive) setBilling('unknown');
      });
    return () => {
      alive = false;
    };
  }, []);

  const emailMatches = typedEmail.trim().toLowerCase() === account.email.toLowerCase();
  const canDelete = emailMatches && CODE_RE.test(code) && (!account.hasPassword || password.length > 0);

  const requestCode = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.requestAccountDeletion();
      setStep('confirm');
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!canDelete || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.confirmAccountDeletion(code, account.hasPassword ? password : undefined);
      close();
      onDeleted();
    } catch (err) {
      setError(readError(err));
      setBusy(false);
    }
  };

  // Enter never deletes: the red button is a click, deliberately.
  useDialogPrimaryAction(step === 'explain' && billing !== 'loading' ? () => void requestCode() : null);

  const subscriptionNote = (): JSX.Element | null => {
    if (billing === 'loading') {
      return <p className={styles.note}>{t('account.delete.checkingBilling', 'Checking your subscription…')}</p>;
    }
    if (billing === 'unknown' || !billing.hasSubscription) return null;
    if (billing.refund?.eligible) {
      return (
        <p className={cn(styles.note, styles.noteWarning)}>
          {t('account.delete.refundFirst', 'You can still get a refund for your subscription — ')}
          <button type="button" className={styles.inlineLink} onClick={() => { close(); onOpenBilling(); }}>
            {t('account.delete.goToBilling', 'go to Billing first')}
          </button>
          {t('account.delete.refundFirstTail', '. Deleting the account now forfeits it.')}
        </p>
      );
    }
    return (
      <p className={cn(styles.note, styles.noteWarning)}>
        {t('account.delete.noRefund', 'Your subscription is cancelled with no refund.')}
      </p>
    );
  };

  if (step === 'explain') {
    return (
      <div className={styles.stack}>
        <p className={styles.message}>
          {t(
            'account.delete.explain',
            'This permanently deletes your account, every cloud project and its version history, your renders, uploaded assets and shared links. There is no undo.',
          )}
        </p>
        {subscriptionNote()}
        <p className={styles.message}>
          {t('account.delete.codeNotice', 'To continue, we will send a 6-digit code to {email}.', { email: account.email })}
        </p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <DialogFooter
          secondary={
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t('account.dialog.cancel', 'Cancel')}
            </Button>
          }
          primary={
            <Button variant="primary" onClick={() => void requestCode()} disabled={billing === 'loading'} loading={busy}>
              {t('account.delete.continue', 'Send code and continue')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <p className={styles.message}>
        {t('account.delete.confirmIntro', 'Enter the code we sent to {email}, then type your email to confirm.', { email: account.email })}
      </p>
      <Input
        fullWidth
        inputMode="numeric"
        label={t('account.code.label', 'Code')}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        autoComplete="one-time-code"
        placeholder="000000"
      />
      {account.hasPassword && (
        <Input
          fullWidth
          type="password"
          label={t('account.email.passwordLabel', 'Current password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      )}
      <Input
        fullWidth
        type="email"
        label={t('account.delete.typeEmail', 'Type {email} to confirm', { email: account.email })}
        value={typedEmail}
        onChange={(e) => setTypedEmail(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {error && <p className={styles.error} role="alert">{error}</p>}
      <DialogFooter
        secondary={
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('account.dialog.cancel', 'Cancel')}
          </Button>
        }
        destructive={
          <Button variant="danger" onClick={() => void confirmDelete()} disabled={!canDelete} loading={busy}>
            {t('account.delete.action', 'Delete my account')}
          </Button>
        }
      />
    </div>
  );
}

function openDeleteAccount(account: AccountRecord, onOpenBilling: () => void, onDeleted: () => void): void {
  openModal({
    title: t('account.delete.title', 'Delete account'),
    size: 'sm',
    persistent: true,
    render: (close) => (
      <DeleteAccountDialog account={account} close={close} onOpenBilling={onOpenBilling} onDeleted={onDeleted} />
    ),
  });
}

// ── Sessions ───────────────────────────────────────────────────────────

function SessionsList(): JSX.Element {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setSessions(await api.listSessions());
      setError('');
    } catch (err) {
      setError(readError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      await api.revokeSession(id);
      toast('success', t('account.sessions.signedOut', 'Device signed out.'));
      await load();
    } catch (err) {
      toast('error', readError(err));
    } finally {
      setBusy(null);
    }
  };

  const others = (sessions ?? []).filter((s) => !s.current);

  const revokeOthers = async (): Promise<void> => {
    if (others.length === 0) return;
    setBusy('all');
    try {
      await Promise.all(others.map((s) => api.revokeSession(s.id)));
      toast('success', t('account.sessions.othersSignedOut', 'Signed out of {n} other devices.', { n: others.length }));
      await load();
    } catch (err) {
      toast('error', readError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.sessions}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {sessions === null && !error && <p className={styles.note}>{t('account.sessions.loading', 'Loading devices…')}</p>}
      {sessions !== null && sessions.length === 0 && (
        <p className={styles.note}>{t('account.sessions.none', 'No other devices are signed in.')}</p>
      )}
      {sessions?.map((s) => (
        <div key={s.id} className={styles.sessionRow} data-current={s.current ? '' : undefined}>
          <div className={styles.sessionMeta}>
            <div className={styles.sessionDevice}>
              <span>{s.device || t('account.sessions.unknownDevice', 'Unknown device')}</span>
              {s.current && <span className={styles.tag}>{t('account.sessions.thisDevice', 'This device')}</span>}
            </div>
            <div className={styles.sessionDetail}>
              {[s.ip, formatRelative(s.lastUsedAt)].filter(Boolean).join(' · ')}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void revoke(s.id)}
            loading={busy === s.id}
            disabled={busy !== null && busy !== s.id}
            aria-label={t('account.sessions.signOutDevice', 'Sign out {device}', {
              device: s.device || t('account.sessions.unknownDevice', 'Unknown device'),
            })}
          >
            {t('account.sessions.signOut', 'Sign out')}
          </Button>
        </div>
      ))}
      {others.length > 0 && (
        <div className={styles.sessionsFooter}>
          <Button variant="secondary" size="sm" onClick={() => void revokeOthers()} loading={busy === 'all'} disabled={busy !== null && busy !== 'all'}>
            {t('account.sessions.signOutOthers', 'Sign out of all other devices')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Name row ───────────────────────────────────────────────────────────

function NameField({ account, onChanged }: { account: AccountRecord; onChanged: () => void }): JSX.Element {
  const [value, setValue] = useState(account.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The server's value wins when it changes under us (a refresh after save).
  const serverName = account.name ?? '';
  const lastServer = useRef(serverName);
  useEffect(() => {
    if (lastServer.current !== serverName) {
      lastServer.current = serverName;
      setValue(serverName);
    }
  }, [serverName]);

  const save = async (): Promise<void> => {
    const next = value.trim();
    if (next === serverName || busy) {
      setValue(serverName);
      return;
    }
    if (next.length > 80) {
      setError(t('account.name.tooLong', 'Keep the name under 80 characters.'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const updated = await api.updateProfile(next);
      patchAuthUser({ name: updated.name });
      toast('success', t('account.name.saved', 'Name saved.'));
      onChanged();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      setValue(serverName);
      setError('');
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <Input
      fullWidth
      size="sm"
      aria-label={t('account.name.label', 'Name')}
      value={value}
      placeholder={t('account.name.placeholder', 'Your name')}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={onKeyDown}
      disabled={busy}
      error={error || undefined}
      maxLength={120}
      autoComplete="name"
    />
  );
}

// ── Section ────────────────────────────────────────────────────────────

export function AccountSection({ account, onAccountChanged, onOpenBilling }: AccountSectionProps): JSX.Element {
  const navigate = useNavigate();
  const [pendingBusy, setPendingBusy] = useState<'resend' | 'cancel' | null>(null);
  const changed = (): void => {
    void onAccountChanged();
  };

  const resendPending = async (): Promise<void> => {
    setPendingBusy('resend');
    try {
      await api.resendEmailChange();
      toast('info', t('account.email.resent', 'A new code is on its way to {email}.', { email: account.pendingEmail ?? '' }));
    } catch (err) {
      toast('error', readError(err));
    } finally {
      setPendingBusy(null);
    }
  };

  const cancelPending = async (): Promise<void> => {
    setPendingBusy('cancel');
    try {
      await api.cancelEmailChange();
      toast('info', t('account.email.cancelled', 'Email change cancelled.'));
      changed();
    } catch (err) {
      toast('error', readError(err));
    } finally {
      setPendingBusy(null);
    }
  };

  const onDeleted = (): void => {
    toast('info', t('account.delete.done', 'Your account has been deleted.'));
    useAuthStore.getState().logout();
    // The root route resolves per edition (dashboard or editor); after the
    // account is gone the app lands wherever a signed-out user lands.
    navigate('/', { replace: true });
  };

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <div className={styles.rowLabel}>{t('account.name.label', 'Name')}</div>
        <div className={styles.rowBody}>
          <NameField account={account} onChanged={changed} />
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.rowLabel}>{t('account.email.label', 'Email')}</div>
        <div className={styles.rowBody}>
          <div className={styles.valueLine}>
            <span className={styles.value}>{account.email}</span>
            {!account.pendingEmail && (
              <Button variant="secondary" size="sm" onClick={() => openEmailChange(account, false, changed)}>
                {t('account.email.change', 'Change…')}
              </Button>
            )}
          </div>
          {account.pendingEmail && (
            <div className={styles.pending}>
              <span className={styles.pendingText}>
                {t('account.email.pending', 'Pending: {email}', { email: account.pendingEmail })}
              </span>
              <div className={styles.linkRow}>
                <Button variant="secondary" size="sm" onClick={() => openEmailChange(account, true, changed)}>
                  {t('account.email.enterCode', 'Enter code')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void resendPending()} loading={pendingBusy === 'resend'} disabled={pendingBusy !== null}>
                  {t('account.email.resend', 'Resend code')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void cancelPending()} loading={pendingBusy === 'cancel'} disabled={pendingBusy !== null}>
                  {t('account.email.cancelChange', 'Cancel change')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.rowLabel}>{t('account.password.label', 'Password')}</div>
        <div className={styles.rowBody}>
          <div className={styles.valueLine}>
            <span className={styles.value}>
              {account.hasPassword
                ? '••••••••'
                : t('account.password.none', 'No password — you sign in with Google.')}
            </span>
            <Button variant="secondary" size="sm" onClick={() => openPasswordDialog(account.hasPassword, changed)}>
              {account.hasPassword ? t('account.password.change', 'Change…') : t('account.password.setOpen', 'Set a password')}
            </Button>
          </div>
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.rowLabel}>{t('account.sessions.label', 'Devices')}</div>
        <div className={styles.rowBody}>
          <SessionsList />
        </div>
      </div>

      <div className={cn(styles.row, styles.danger)}>
        <div className={styles.rowLabel}>{t('account.delete.zone', 'Danger zone')}</div>
        <div className={styles.rowBody}>
          <div className={styles.valueLine}>
            <span className={styles.note}>
              {t('account.delete.hint', 'Deletes your account and every cloud project. This cannot be undone.')}
            </span>
            <Button variant="danger" size="sm" onClick={() => openDeleteAccount(account, onOpenBilling, onDeleted)}>
              {t('account.delete.open', 'Delete account…')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
