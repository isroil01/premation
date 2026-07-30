/**
 * AuthPanel — Auth Modal synced with Motion Studio editor design tokens.
 */

import { useEffect, useState, type FormEvent, type CSSProperties } from 'react';
import { openModal } from '@stores/modalStore';
import { useAuthStore } from '@stores/authStore';
import { api } from '@core/api/client';
import { startSocialAuth } from '@core/auth/startSocialAuth';
import { Icon } from '@components/Icon/Icon';

type Mode = 'login' | 'register';

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 'var(--radius-control, 6px)',
  background: 'var(--color-surface-0, #161616)',
  border: '1px solid var(--color-field-border, rgba(255, 255, 255, 0.08))',
  color: 'var(--color-text-primary, #e1e1e1)',
  font: 'inherit',
  fontSize: '13px',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color var(--motion-duration-fast, 120ms) ease',
};

const labelStyle: CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--color-text-secondary, #a6a6a6)',
  marginBottom: '4px',
  display: 'block',
};

const socialBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  padding: '8px 12px',
  borderRadius: 'var(--radius-control, 6px)',
  background: 'var(--color-surface-0, #161616)',
  border: '1px solid var(--color-field-border, rgba(255, 255, 255, 0.08))',
  color: 'var(--color-text-primary, #e1e1e1)',
  fontSize: '12px',
  fontWeight: 500,
  cursor: 'pointer',
  flex: 1,
};

function AuthForm({ onDone }: { onDone: () => void }): JSX.Element {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState('');
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const busy = status === 'loading';

  /**
   * Social sign-in, only for providers this server is configured for.
   *
   * These two buttons used to call `alert('Google sign-in placeholder')`. They
   * now either start a real OAuth flow or are not rendered at all — the same
   * rule the sign-in page follows, from the same `/auth/providers` endpoint.
   */
  const [providers, setProviders] = useState<{ id: 'google' | 'github'; label: string }[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .authProviders()
      .then((r) => { if (alive) setProviders(r.providers); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

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
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: '300px', padding: '2px 0' }}>
      <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-text-secondary, #a6a6a6)', lineHeight: 1.4 }}>
        {mode === 'login'
          ? 'Sign in to access cloud sync and export assets.'
          : 'Create an account to get started with Motion Studio.'}
      </p>

      {/* Social login — Google only for now. Full-width single button. */}
      {providers.some((p) => p.id === 'google') && (
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          style={socialBtnStyle}
          disabled={busy}
          onClick={() => startSocialAuth('google')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </button>
      </div>
      )}

      {/* The divider only means something when there is something above it. */}
      {providers.some((p) => p.id === 'google') && (
      <div style={{ display: 'flex', alignItems: 'center', margin: '2px 0', color: 'var(--color-text-tertiary, #7e7e7e)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
        <div style={{ flex: 1, borderBottom: '1px solid var(--color-divider, #1a1a1a)' }} />
        <span style={{ padding: '0 8px' }}>OR</span>
        <div style={{ flex: 1, borderBottom: '1px solid var(--color-divider, #1a1a1a)' }} />
      </div>
      )}

      {mode === 'register' ? (
        <div>
          <label style={labelStyle} htmlFor="auth-name">Name</label>
          <input
            id="auth-name"
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            autoComplete="name"
            placeholder="Jane Doe"
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
          placeholder="you@domain.com"
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="auth-password">Password</label>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input
            id="auth-password"
            type={showPassword ? 'text' : 'password'}
            required
            minLength={mode === 'register' ? 8 : 1}
            style={{ ...inputStyle, paddingRight: '34px' }}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            placeholder={mode === 'register' ? 'At least 8 characters' : '••••••••'}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            style={{
              position: 'absolute',
              right: '8px',
              background: 'none',
              border: 'none',
              color: 'var(--color-text-tertiary, #7e7e7e)',
              cursor: 'pointer',
              padding: '2px',
              display: 'flex',
            }}
            tabIndex={-1}
          >
            <Icon name={showPassword ? 'eye-off' : 'eye'} size={14} />
          </button>
        </div>
      </div>

      {error ? (
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-danger, #f43f5e)', background: 'rgba(244, 63, 94, 0.12)', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(244,63,94,0.3)' }}>{error}</p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        style={{
          marginTop: '4px',
          padding: '10px 14px',
          borderRadius: 'var(--radius-control, 6px)',
          background: 'var(--color-primary, #2988ff)',
          border: 'none',
          color: 'var(--color-primary-foreground, #ffffff)',
          font: 'inherit',
          fontSize: '13px',
          fontWeight: 600,
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.5 : 1,
          transition: 'all var(--motion-duration-fast, 120ms) ease',
        }}
      >
        {busy ? 'Please wait...' : mode === 'login' ? 'Sign in' : 'Create account'}
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
          color: 'var(--color-primary, #2988ff)',
          font: 'inherit',
          fontSize: '12px',
          fontWeight: 600,
          cursor: 'pointer',
          textAlign: 'center',
          marginTop: '2px',
        }}
      >
        {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
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
