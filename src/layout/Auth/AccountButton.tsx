/**
 * AccountButton — StatusBar affordance that shows the session state and opens
 * the auth modal (signed out) or a small account menu (signed in).
 */

import { Icon } from '@components/Icon';
import { useAuthStore } from '@stores/authStore';
import { cloudAccountsEnabled } from '@core/config/edition';
import { openAuthModal } from './AuthPanel';
import { openModal } from '@stores/modalStore';

const pill: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 8px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text-secondary)',
  cursor: 'pointer',
  font: 'inherit',
};

function openAccountMenu(email: string): void {
  openModal({
    title: 'Account',
    size: 'sm',
    render: (close) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 260 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Signed in as <strong style={{ color: 'var(--color-text-primary)' }}>{email}</strong>
        </p>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Your projects and assets sync to the cloud. Open/Save uses your account.
        </p>
        <button
          type="button"
          onClick={() => {
            useAuthStore.getState().logout();
            close();
          }}
          style={{
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-primary)',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </div>
    ),
  });
}

export function AccountButton(): JSX.Element | null {
  const user = useAuthStore((s) => s.user);
  const authed = useAuthStore((s) => s.status === 'authenticated');

  // No accounts in the local edition — and "Sign in to sync to the cloud" is
  // exactly the kind of dead-end this edition exists to avoid, since the modal
  // it opens has no server to authenticate against.
  if (!cloudAccountsEnabled()) return null;

  if (authed && user) {
    const label = user.name || user.email.split('@')[0];
    return (
      <button type="button" onClick={() => openAccountMenu(user.email)} title={user.email} style={pill}>
        <Icon name="user" size={11} />
        {label}
      </button>
    );
  }

  return (
    <button type="button" onClick={() => openAuthModal()} title="Sign in to sync to the cloud" style={pill}>
      <Icon name="user" size={11} />
      Sign in
    </button>
  );
}
