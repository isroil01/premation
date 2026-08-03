/**
 * EmptyState — the one way to say "nothing here yet" (spec v2.1).
 *
 * Icon tile + optional title + one short sentence + optional action. Panels
 * must use this instead of a bare centered string so empty surfaces still look
 * designed.
 *
 * `title` exists because the richest empty states in the app were hand-rolled
 * to get one: the Rigging panel built its own heading, paragraph and pair of
 * tool buttons inline rather than use this component, because this component
 * could only render a single grey sentence. Anything a panel needs in order to
 * say "nothing here, and here is what to do about it" belongs here, not in a
 * one-off div.
 */

import { type ReactNode } from 'react';
import { cn } from '@utils/cn';
import { Icon, type IconName } from '@components/Icon';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  icon?: IconName;
  /** Optional heading naming the surface, shown above the message. */
  title?: ReactNode;
  message: ReactNode;
  /**
   * Optional next step(s). Multiple buttons stack full-width; pass them as a
   * fragment. Prefer an action whenever the user can actually do something
   * here without selecting anything first.
   */
  action?: ReactNode;
  /** For an empty SECTION inside a populated panel — tighter, smaller tile. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon = 'layers',
  title,
  message,
  action,
  compact = false,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div className={cn(styles.root, compact && styles.compact, className)}>
      <span className={styles.tile} aria-hidden>
        <Icon name={icon} size={compact ? 14 : 18} />
      </span>
      {title ? <div className={styles.title}>{title}</div> : null}
      <div className={styles.message}>{message}</div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
