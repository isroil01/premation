/**
 * EmptyState — the one way to say "nothing here yet" (spec v2.1).
 *
 * Icon tile + one short sentence + optional action. Panels must use this
 * instead of a bare centered string so empty surfaces still look designed.
 */

import { type ReactNode } from 'react';
import { cn } from '@utils/cn';
import { Icon, type IconName } from '@components/Icon';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  icon?: IconName;
  message: ReactNode;
  /** Optional action (e.g. a ghost button) rendered under the message. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon = 'layers', message, action, className }: EmptyStateProps): JSX.Element {
  return (
    <div className={cn(styles.root, className)}>
      <span className={styles.tile} aria-hidden>
        <Icon name={icon} size={15} />
      </span>
      <div className={styles.message}>{message}</div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
