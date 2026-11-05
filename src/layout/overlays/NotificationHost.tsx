/**
 * NotificationHost — renders the toast stack from uiStore.notifications.
 * The data model + auto-dismiss already live in uiStore; the card itself is
 * the shared <Toast> primitive. This is only the stack. Mounted once near the
 * app root.
 *
 * Warnings and errors are cards. Routine notices (`isQuietNotification`) go to
 * the status bar and job progress to its tray while the editor's status bar is
 * up; a screen without one, or a blocking dialog covering it, still gets a card
 * so the feedback is never lost.
 */

import { Toast } from '@components/Toast';
import { isQuietNotification, useUIStore } from '@stores/uiStore';
import { useModalStore } from '@stores/modalStore';
import styles from './overlays.module.css';
import { t } from '@core/i18n';

export function NotificationHost(): JSX.Element | null {
  const notifications = useUIStore((s) => s.notifications);
  const dismiss = useUIStore((s) => s.dismissNotification);

  const lineUp = useUIStore((s) => s.noticeLineMounted);
  const dialogOver = useModalStore((s) => s.stack.some((m) => (m.variant ?? 'blocking') === 'blocking'));
  const shown = !lineUp
    ? notifications
    : notifications.filter((n) => !isQuietNotification(n) || (dialogOver && n.progress === undefined));

  if (shown.length === 0) return null;

  return (
    <div className={styles.toaster} role="region" aria-label={t('overlay.notifications.label', 'Notifications')}>
      {shown.map((n) => (
        <Toast
          key={n.id}
          level={n.level}
          message={n.message}
          detail={n.detail}
          progress={n.progress}
          sticky={n.sticky}
          action={n.action}
          onDismiss={() => dismiss(n.id)}
        />
      ))}
    </div>
  );
}
