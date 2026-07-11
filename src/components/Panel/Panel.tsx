/**
 * Panel — a docked container with a header (title, icon, optional actions)
 * and a content body. Used everywhere a side panel is needed.
 *
 * Panels are:
 *   - Resizable via the parent SplitPane
 *   - Collapsible via the header action
 *   - Closable (when registered with closable: true)
 *   - Stackable: when multiple panels live in a region, they form a Tabs group
 *
 * This component does NOT handle docking; it just renders one panel.
 * Docking is the orchestrator's job (see DockPanel).
 */

import { type ReactNode } from 'react';
import { cn } from '@utils/cn';
import { Icon, type IconName } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import styles from './Panel.module.css';

export interface PanelProps {
  id: string;
  title: ReactNode;
  icon?: IconName;
  /** Show in a compact header (used when stacked in a tab group). */
  compact?: boolean;
  /** Hide the panel's own header — e.g. when a DockPanel tab already labels it. */
  hideHeader?: boolean;
  /** When provided, an "x" close button is shown. */
  onClose?: () => void;
  /** Header actions rendered to the left of the close button. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Optional content for the panel footer (e.g. status text). */
  footer?: ReactNode;
  /** When true, content scroll is disabled (parent ScrollArea handles it). */
  noScroll?: boolean;
}

export function Panel({
  title,
  icon,
  compact = false,
  hideHeader = false,
  onClose,
  actions,
  children,
  className,
  footer,
  noScroll = false,
}: PanelProps): JSX.Element {
  return (
    <section
      className={cn(styles.root, compact && styles.compact, className)}
      data-compact={compact || undefined}
    >
      {hideHeader ? null : (
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            {icon ? <Icon name={icon} size={14} className={styles.icon} /> : null}
            <span className={styles.title}>{title}</span>
          </div>
          <div className={styles.actions}>
            {actions}
            {onClose ? (
              <IconButton aria-label="Close panel" size="xs" onClick={onClose}>
                <Icon name="close" size={12} />
              </IconButton>
            ) : null}
          </div>
        </header>
      )}
      <div className={cn(styles.body, noScroll && styles.noScroll)}>
        {children}
      </div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </section>
  );
}
