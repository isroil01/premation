/**
 * EditorLayout — the full professional editor frame.
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ TopToolbar                                            │
 *   ├──────────┬───────────────────────────────┬───────────┤
 *   │          │                               │           │
 *   │ Left     │     Workspace (viewport)      │ Right     │
 *   │ Sidebar  │                               │ Inspector │
 *   │          │                               │           │
 *   ├──────────┴───────────────────────────────┴───────────┤
 *   │  Bottom Timeline                                     │
 *   ├──────────────────────────────────────────────────────┤
 *   │  StatusBar                                           │
 *   └──────────────────────────────────────────────────────┘
 *
 * Layout regions are resizable (SplitPane) and collapsible (region store).
 * When a region is collapsed, the SplitPane's primary size becomes 0 and
 * the splitter remains visible so the user can drag it back.
 *
 * This component is purely structural. It composes the layout primitives
 * and wires them to the layout store. Engines inject their UI by passing
 * the `sidebarRenderers`, `inspectorRenderers`, and `timeline` props.
 */

import { type ReactNode } from 'react';
import { SplitPane } from '@components/SplitPane';
import { LeftSidebar } from '@layout/LeftSidebar';
import { RightInspector } from '@layout/RightInspector';
import { WorkspaceViewport, type WorkspaceViewportProps } from '@layout/Workspace';
import { useLayoutStore } from '@stores/layoutStore';
import styles from './EditorLayout.module.css';

export interface EditorLayoutProps {
  /** Full-width top chrome: the AE-style menu bar + tool row. */
  topNav: ReactNode;
  /** Pre-rendered bottom status bar element. */
  statusBar: ReactNode;
  /** Pre-rendered timeline element. */
  timeline: ReactNode;
  sidebarRenderers: Record<string, () => ReactNode>;
  inspectorRenderers: Record<string, () => ReactNode>;
  /** Top-of-inspector chrome (primary actions). */
  inspectorHeader?: ReactNode;
  workspaceExtras?: WorkspaceViewportProps;
}

export function EditorLayout({
  topNav,
  statusBar,
  timeline,
  sidebarRenderers,
  inspectorRenderers,
  inspectorHeader,
  workspaceExtras,
}: EditorLayoutProps): JSX.Element {
  const left = useLayoutStore((s) => s.regions.leftSidebar);
  const right = useLayoutStore((s) => s.regions.rightInspector);
  const bottom = useLayoutStore((s) => s.regions.bottomTimeline);
  const setLeftSize = useLayoutStore((s) => s.setRegionSize);
  const setRightSize = useLayoutStore((s) => s.setRegionSize);
  const setBottomSize = useLayoutStore((s) => s.setRegionSize);

  const leftSidebarPos = useLayoutStore((s) => s.leftSidebarPosition ?? 'left');
  const rightInspectorPos = useLayoutStore((s) => s.rightInspectorPosition ?? 'right');
  const timelinePosition = useLayoutStore((s) => s.timelinePosition ?? 'bottom');

  const leftSidebarEl = (
    <LeftSidebar renderers={sidebarRenderers} className={left.collapsed ? 'sidebar-collapsed-view' : ''} />
  );
  const rightInspectorEl = (
    <RightInspector renderers={inspectorRenderers} header={inspectorHeader} className={right.collapsed ? 'inspector-collapsed-view' : ''} />
  );

  const centerContent = (
    <SplitPane
      className={styles.split}
      direction="vertical"
      primary={timelinePosition === 'bottom' ? 'last' : 'first'}
      defaultSize={bottom.size}
      minSize={38}
      maxSize={bottom.maxSize}
      size={bottom.collapsed ? 38 : bottom.size}
      collapsed={bottom.collapsed}
      storageKey="bottomTimeline"
      onResizeEnd={(s) => setBottomSize('bottomTimeline', s)}
    >
      {timelinePosition === 'bottom' ? (
        <div className={styles.workspacePane}>
          <WorkspaceViewport {...(workspaceExtras ?? {})} />
        </div>
      ) : (
        <div className={styles.timelinePane}>{timeline}</div>
      )}
      {timelinePosition === 'bottom' ? (
        <div className={styles.timelinePane}>{timeline}</div>
      ) : (
        <div className={styles.workspacePane}>
          <WorkspaceViewport {...(workspaceExtras ?? {})} />
        </div>
      )}
    </SplitPane>
  );

  // Define column definitions
  const colL = {
    id: 'leftSidebar' as const,
    el: leftSidebarEl,
    state: left,
    setSize: setLeftSize,
    collapsed: left.collapsed,
    size: left.size,
    maxSize: left.maxSize,
    storageKey: 'leftSidebar',
  };

  const colR = {
    id: 'rightInspector' as const,
    el: rightInspectorEl,
    state: right,
    setSize: setRightSize,
    collapsed: right.collapsed,
    size: right.size,
    maxSize: right.maxSize,
    storageKey: 'rightInspector',
  };

  const colC = {
    id: 'center' as const,
    el: centerContent,
  };

  // Determine the column order [col1, col2, col3]
  let colOrder: [
    typeof colL | typeof colR | typeof colC,
    typeof colL | typeof colR | typeof colC,
    typeof colL | typeof colR | typeof colC
  ];
  if (leftSidebarPos === 'left' && rightInspectorPos === 'right') {
    colOrder = [colL, colC, colR];
  } else if (leftSidebarPos === 'right' && rightInspectorPos === 'right') {
    colOrder = [colC, colL, colR];
  } else if (leftSidebarPos === 'left' && rightInspectorPos === 'left') {
    colOrder = [colL, colR, colC];
  } else {
    colOrder = [colR, colC, colL];
  }

  const [col1, col2, col3] = colOrder;

  // Render the inner split (col1 vs col2)
  const renderInnerSplit = () => {
    const isCol1Center = col1.id === 'center';
    const isCol2Center = col2.id === 'center';
    
    if (isCol1Center) {
      const sidebar = col2 as typeof colL;
      return (
        <SplitPane
          className={styles.split}
          direction="horizontal"
          primary="last"
          defaultSize={sidebar.size}
          minSize={36}
          maxSize={Math.min(sidebar.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : sidebar.maxSize)}
          size={sidebar.collapsed ? 36 : sidebar.size}
          collapsed={sidebar.collapsed}
          storageKey={sidebar.storageKey}
          onResizeEnd={(s) => sidebar.setSize(sidebar.id, s)}
        >
          {col1.el}
          {col2.el}
        </SplitPane>
      );
    } else if (isCol2Center) {
      const sidebar = col1 as typeof colL;
      return (
        <SplitPane
          className={styles.split}
          direction="horizontal"
          primary="first"
          defaultSize={sidebar.size}
          minSize={36}
          maxSize={Math.min(sidebar.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : sidebar.maxSize)}
          size={sidebar.collapsed ? 36 : sidebar.size}
          collapsed={sidebar.collapsed}
          storageKey={sidebar.storageKey}
          onResizeEnd={(s) => sidebar.setSize(sidebar.id, s)}
        >
          {col1.el}
          {col2.el}
        </SplitPane>
      );
    } else {
      const sidebar = col1 as typeof colL;
      return (
        <SplitPane
          className={styles.split}
          direction="horizontal"
          primary="first"
          defaultSize={sidebar.size}
          minSize={36}
          maxSize={Math.min(sidebar.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : sidebar.maxSize)}
          size={sidebar.collapsed ? 36 : sidebar.size}
          collapsed={sidebar.collapsed}
          storageKey={sidebar.storageKey}
          onResizeEnd={(s) => sidebar.setSize(sidebar.id, s)}
        >
          {col1.el}
          {col2.el}
        </SplitPane>
      );
    }
  };

  const innerSplit = renderInnerSplit();

  // Render the outer split (innerSplit vs col3)
  const renderOuterSplit = () => {
    const isCol3Center = col3.id === 'center';
    
    if (isCol3Center) {
      const sidebar = colR; // rightInspector
      return (
        <SplitPane
          className={styles.split}
          direction="horizontal"
          primary="first"
          defaultSize={sidebar.size}
          minSize={36}
          maxSize={Math.min(sidebar.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : sidebar.maxSize)}
          size={sidebar.collapsed ? 36 : sidebar.size}
          collapsed={sidebar.collapsed}
          storageKey={sidebar.storageKey}
          onResizeEnd={(s) => sidebar.setSize(sidebar.id, s)}
        >
          {innerSplit}
          {col3.el}
        </SplitPane>
      );
    } else {
      const sidebar = col3 as typeof colL;
      return (
        <SplitPane
          className={styles.split}
          direction="horizontal"
          primary="last"
          defaultSize={sidebar.size}
          minSize={36}
          maxSize={Math.min(sidebar.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : sidebar.maxSize)}
          size={sidebar.collapsed ? 36 : sidebar.size}
          collapsed={sidebar.collapsed}
          storageKey={sidebar.storageKey}
          onResizeEnd={(s) => sidebar.setSize(sidebar.id, s)}
        >
          {innerSplit}
          {col3.el}
        </SplitPane>
      );
    }
  };

  return (
    <div className={styles.root}>
      {/* Full-width AE-style top chrome (menu bar + tool row). */}
      {topNav}

      {/* Body row: dynamically ordered columns */}
      <div className={styles.body}>
        {renderOuterSplit()}
      </div>

      {statusBar}
    </div>
  );
}
