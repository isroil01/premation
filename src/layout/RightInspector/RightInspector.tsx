import { DockPanel } from '@components/DockPanel';
import { useLayoutStore } from '@stores/layoutStore';
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

/**
 * The right column: After Effects' panel groups (DockPanel) — tabs within a
 * group, groups stacked, each open or collapsed to its strip.
 */
export function RightInspector({ renderers, headerExtras, header, className }: RightInspectorProps): JSX.Element {
  const isCollapsed = className?.includes('collapsed-view') || false;
  // Menus open toward the inside: right unless the inspector has been re-docked left.
  const railSide = useLayoutStore((s) => (s.rightInspectorPosition === 'left' ? 'left' : 'right'));

  return (
    <aside className={cn(styles.root, className)} data-tour="inspector">
      {!isCollapsed && header ? <div className={styles.header}>{header}</div> : null}
      <DockPanel
        region="rightInspector"
        renderers={renderers}
        headerExtras={headerExtras}
        className={className}
        railSide={railSide}
      />
    </aside>
  );
}
