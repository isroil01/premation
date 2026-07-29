/**
 * RightInspector — host for the right region. Uses DockPanel and is
 * optimized for property editing via the Inspector component.
 */

import { DockPanel } from '@components/DockPanel';
import type { ReactNode } from 'react';
import { cn } from '@utils/cn';
import styles from './RightInspector.module.css';

export interface RightInspectorProps {
  renderers: Record<string, (() => ReactNode) | (() => JSX.Element)>;
  headerExtras?: ReactNode;
  /** Top-of-inspector chrome (primary actions: Preview / Export). */
  header?: ReactNode;
  className?: string;
}

export function RightInspector({ renderers, headerExtras, header, className }: RightInspectorProps): JSX.Element {
  const isCollapsed = className?.includes('collapsed-view') || false;
  return (
    <aside className={cn(styles.root, className)}>
      {!isCollapsed && header ? <div className={styles.header}>{header}</div> : null}
      <DockPanel region="rightInspector" renderers={renderers} headerExtras={headerExtras} className={className} />
    </aside>
  );
}
