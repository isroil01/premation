/**
 * NotificationHost — renders the toast stack from uiStore.notifications.
 * The data model + auto-dismiss already live in uiStore; this is the visual
 * surface. Mounted once near the app root.
 */

import { Icon, type IconName } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { useUIStore } from '@stores/uiStore';
import type { Notification } from '@stores/uiStore';
import styles from './overlays.module.css';

const LEVEL_ICON: Record<Notification['level'], IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  error: 'error',
};

export function NotificationHost(): JSX.Element | null {
  const notifications = useUIStore((s) => s.notifications);
  const dismiss = useUIStore((s) => s.dismissNotification);

  if (notifications.length === 0) return null;

  return (
    <div className={styles.toaster} role="region" aria-label="Notifications">
      {notifications.map((n) => (
        <div key={n.id} className={styles.toast} data-level={n.level} role="status">
          <span className={styles.toastIcon}>
            <Icon name={LEVEL_ICON[n.level]} size={14} />
          </span>
          <span className={styles.toastMessage}>{n.message}</span>
          <IconButton aria-label="Dismiss" size="sm" onClick={() => dismiss(n.id)}>
            <Icon name="close" size={12} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
