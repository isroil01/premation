/**
 * AuthPanel — sign in / register form for the motion-back backend.
 *
 * Opened as a modal via `openAuthModal()`. On success it closes itself; the
 * authStore then holds the session and the StatusBar account button reflects it.
 */

import { useState, type FormEvent } from 'react';
import { openModal } from '@stores/modalStore';
import { useAuthStore } from '@stores/authStore';

type Mode = 'login' | 'register';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text-primary)',
  font: 'inherit',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  marginBottom: 5,
  display: 'block',
};

function AuthForm({ onDone }: { onDone: () => void }): JSX.Element {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const busy = status === 'loading';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (mode === 'login') {
        await useAuthStore.getState().login(email.trim(), password);
      } else {
        await useAuthStore.getState().register(email.trim(), password, name.trim() || undefined);
      }
      onDone();
    } catch {
      /* error is surfaced via the store */
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 320 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
        {mode === 'login'
          ? 'Sign in to sync projects and assets to the cloud.'
          : 'Create an account to save your work to the cloud.'}
      </p>

      {mode === 'register' ? (
        <div>
          <label style={labelStyle} htmlFor="auth-name">Name (optional)</label>
          <input
            id="auth-name"
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            autoComplete="name"
          />
        </div>
      ) : null}

      <div>
        <label style={labelStyle} htmlFor="auth-email">Email</label>
        <input
          id="auth-email"
          type="email"
          required
          style={inputStyle}
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          autoComplete="email"
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="auth-password">Password</label>
        <input
          id="auth-password"
          type="password"
          required
          minLength={mode === 'register' ? 8 : 1}
          style={inputStyle}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />
      </div>

      {error ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--color-danger, #ff5c5c)' }}>{error}</p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        style={{
          padding: '9px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-accent, #3b82f6)',
          border: 'none',
          color: '#fff',
          font: 'inherit',
          fontWeight: 600,
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
      </button>

      <button
        type="button"
        onClick={() => {
          useAuthStore.getState().clearError();
          setMode(mode === 'login' ? 'register' : 'login');
        }}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-text-secondary)',
          font: 'inherit',
          fontSize: 12,
          cursor: 'pointer',
          textAlign: 'center',
        }}
      >
        {mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Sign in'}
      </button>
    </form>
  );
}

export function openAuthModal(): string {
  useAuthStore.getState().clearError();
  return openModal({
    title: 'Account',
    size: 'sm',
    render: (close) => <AuthForm onDone={close} />,
  });
}
