/**
 * LeftSidebar — host for the left region. Uses DockPanel to render the
 * tabbed panel set defined in the layout store. Future engine panels
 * (scene graph, asset library,...) register their panel id + renderers
 * via the DockPanel renderers prop.
 */

import { DockPanel } from '@components/DockPanel';
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

export function LeftSidebar({ renderers, headerExtras, header, className }: LeftSidebarProps): JSX.Element {
  const isCollapsed = className?.includes('collapsed-view') || false;
  return (
    <aside className={cn(styles.root, className)}>
      {!isCollapsed && header ? <div className={styles.header}>{header}</div> : null}
      <DockPanel region="leftSidebar" renderers={renderers} headerExtras={headerExtras} className={className} />
    </aside>
  );
}
