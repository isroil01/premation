import { DockPanel } from '@components/DockPanel';
import { SplitPane } from '@components/SplitPane';
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

export function LeftSidebar({ renderers, headerExtras, header, className }: LeftSidebarProps): JSX.Element {
  const isCollapsed = className?.includes('collapsed-view') || false;
  const isSplit = useLayoutStore((s) => s.leftSidebarSplit);
  const toggleSplit = () => useLayoutStore.getState().toggleSidebarSplit('left');
  // Rail on the outer edge — left unless the sidebar has been re-docked right.
  const railSide = useLayoutStore((s) => (s.leftSidebarPosition === 'right' ? 'right' : 'left'));

  return (
    <aside className={cn(styles.root, className)}>
      {!isCollapsed && header ? <div className={styles.header}>{header}</div> : null}
      {isSplit && !isCollapsed ? (
        <SplitPane
          direction="vertical"
          defaultSize={320}
          minSize={100}
          maxSize={750}
          storageKey="leftSidebarSplit"
          className={styles.splitContainer}
        >
          <DockPanel
            region="leftSidebar"
            renderers={renderers}
            headerExtras={headerExtras}
            className={className}
            isSplit
            splitPosition="top"
            onToggleSplit={toggleSplit}
            railSide={railSide}
          />
          <DockPanel
            region="leftSidebar_bottom"
            renderers={renderers}
            className={className}
            isSplit
            splitPosition="bottom"
            onToggleSplit={toggleSplit}
            railSide={railSide}
          />
        </SplitPane>
      ) : (
        <DockPanel
          region="leftSidebar"
          renderers={renderers}
          headerExtras={headerExtras}
          className={className}
          isSplit={false}
          onToggleSplit={toggleSplit}
          railSide={railSide}
        />
      )}
    </aside>
  );
}

