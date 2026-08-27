/**
 * AccountButton — StatusBar affordance that shows the session state and opens
 * the auth modal (signed out) or a small account menu (signed in).
 */

import { Icon } from '@components/Icon';
import { useAuthStore } from '@stores/authStore';
import { cloudAccountsEnabled } from '@core/config/edition';
import { openAuthModal } from './AuthPanel';
import { openModal } from '@stores/modalStore';
import styles from './AccountButton.module.css';

function openAccountMenu(email: string): void {
  openModal({
    title: 'Account',
    size: 'sm',
    render: (close) => (
      <div className={styles.modalContent}>
        <p className={styles.userEmail}>
          Signed in as <strong>{email}</strong>
        </p>
        <p className={styles.subText}>
          Your projects and assets sync to the cloud. Open/Save uses your account.
        </p>
        <button
          type="button"
          onClick={() => {
            useAuthStore.getState().logout();
            close();
          }}
          className={styles.signOutBtn}
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
      <button type="button" onClick={() => openAccountMenu(user.email)} title={user.email} className={styles.pill}>
        <Icon name="user" size="sm" />
        {label}
      </button>
    );
  }

  return (
    <button type="button" onClick={() => openAuthModal()} title="Sign in to sync to the cloud" className={styles.pill}>
      <Icon name="user" size="sm" />
      Sign in
    </button>
  );
}
