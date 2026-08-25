import { DockPanel } from '@components/DockPanel';
import { SplitPane } from '@components/SplitPane';
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

export function RightInspector({ renderers, headerExtras, header, className }: RightInspectorProps): JSX.Element {
  const isCollapsed = className?.includes('collapsed-view') || false;
  const isSplit = useLayoutStore((s) => s.rightInspectorSplit);
  const toggleSplit = () => useLayoutStore.getState().toggleSidebarSplit('right');

  return (
    <aside className={cn(styles.root, className)}>
      {!isCollapsed && header ? <div className={styles.header}>{header}</div> : null}
      {isSplit && !isCollapsed ? (
        <SplitPane
          direction="vertical"
          defaultSize={340}
          minSize={100}
          maxSize={750}
          storageKey="rightInspectorSplit"
          className={styles.splitContainer}
        >
          <DockPanel
            region="rightInspector"
            renderers={renderers}
            headerExtras={headerExtras}
            className={className}
            isSplit
            splitPosition="top"
            onToggleSplit={toggleSplit}
          />
          <DockPanel
            region="rightInspector_bottom"
            renderers={renderers}
            className={className}
            isSplit
            splitPosition="bottom"
            onToggleSplit={toggleSplit}
          />
        </SplitPane>
      ) : (
        <DockPanel
          region="rightInspector"
          renderers={renderers}
          headerExtras={headerExtras}
          className={className}
          isSplit={false}
          onToggleSplit={toggleSplit}
        />
      )}
    </aside>
  );
}

