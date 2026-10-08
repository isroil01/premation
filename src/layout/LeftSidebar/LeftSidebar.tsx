import { DockPanel } from '@components/DockPanel';
import { useLayoutStore } from '@stores/layoutStore';
import type { ReactNode } from 'react';
import { cn } from '@utils/cn';
import styles from './LeftSidebar.module.css';

export interface LeftSidebarProps {
  renderers: Record<string, (() => ReactNode) | (() => JSX.Element)>;
  headerExtras?: ReactNode;
  /** Top-of-sidebar chrome (back button + primary app actions). */
  header?: ReactNode;
  className?: string;
}

/**
 * The left sidebar: one column of panel groups (DockPanel). Groups replaced the
 * fixed two-pane split (2026-10) — stacking panels is dragging a tab into a gap
 * between groups, or a group's ≡ ▸ Move to New Group.
 */
export function LeftSidebar({ renderers, headerExtras, header, className }: LeftSidebarProps): JSX.Element {
  const isCollapsed = className?.includes('collapsed-view') || false;
  // Menus open toward the inside: left unless the sidebar has been re-docked right.
  const railSide = useLayoutStore((s) => (s.leftSidebarPosition === 'right' ? 'right' : 'left'));

  return (
    <aside className={cn(styles.root, className)}>
      {!isCollapsed && header ? <div className={styles.header}>{header}</div> : null}
      <DockPanel
        region="leftSidebar"
        renderers={renderers}
        headerExtras={headerExtras}
        className={className}
        railSide={railSide}
      />
    </aside>
  );
}
