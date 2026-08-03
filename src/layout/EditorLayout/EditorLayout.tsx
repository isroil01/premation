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
import { Icon } from '@components/Icon';
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
  const externalPanels = useLayoutStore((s) => s.externalPanels);
  const dockPanel = useLayoutStore((s) => s.dockPanel);

  /**
   * Which edge each dock sits on.
   *
   * The store has carried these three since workspaces were added — they
   * persist, they ride along in saved layouts, and Customize → Appearance has
   * had buttons for them — but this component laid itself out with the order
   * hardcoded, so every one of those buttons was inert. It highlighted, it
   * saved, and the panel did not move.
   *
   * A dock is expressed here as (pane order, which pane `size` applies to).
   * `primary` must follow the order: it names the sized pane, so swapping the
   * children without swapping it resizes the wrong side of the splitter.
   */
  const leftSidebarPos = useLayoutStore((s) => s.leftSidebarPosition);
  const inspectorPos = useLayoutStore((s) => s.rightInspectorPosition);
  const timelinePos = useLayoutStore((s) => s.timelinePosition);

  const sidebarFirst = leftSidebarPos !== 'right';
  const inspectorLast = inspectorPos !== 'left';
  const timelineLast = timelinePos !== 'top';

  const isViewportExternal = externalPanels.includes('viewport');
  const isTimelineExternal = externalPanels.includes('timeline');

  /**
   * Every pane carries a stable `key`.
   *
   * They are handed to SplitPane as an array whose ORDER changes when a dock
   * moves. Without keys React reconciles by index, so flipping the inspector
   * from right to left would re-mount both panes — remounting the viewport
   * means tearing down and rebuilding the WebGL context, which is both slow
   * and visible as a flash.
   */
  const leftSidebarEl = (
    <LeftSidebar key="sidebar" renderers={sidebarRenderers} className={left.collapsed ? 'sidebar-collapsed-view' : ''} />
  );
  const rightInspectorEl = (
    <RightInspector key="inspector" renderers={inspectorRenderers} header={inspectorHeader} className={right.collapsed ? 'inspector-collapsed-view' : ''} />
  );

  const viewportPane = (
    <div className={styles.workspacePane} key="viewport">
      {isViewportExternal ? (
          <div className={styles.detached}>
            <Icon name="export" size={24} />
            <span className={styles.detachedLabel}>Preview Canvas is open in an external window</span>
            <button className={styles.detachedAction} onClick={() => dockPanel('viewport')}>
              Re-dock preview
            </button>
          </div>
        ) : (
          <WorkspaceViewport {...(workspaceExtras ?? {})} />
        )}
    </div>
  );

  // Viewport and inspector, in whichever order the inspector is docked.
  // Typed as a tuple because SplitPane takes exactly two children — a plain
  // array would widen to ReactNode[] and stop being checked.
  const inspectorRow: [ReactNode, ReactNode] = inspectorLast
    ? [viewportPane, rightInspectorEl]
    : [rightInspectorEl, viewportPane];

  const topContent = (
    <SplitPane
      key="viewport-row"
      className={styles.split}
      direction="horizontal"
      primary={inspectorLast ? 'last' : 'first'}
      defaultSize={right.size}
      minSize={right.collapsed ? 44 : right.minSize}
      maxSize={Math.min(right.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : right.maxSize)}
      size={right.collapsed ? 44 : right.size}
      collapsed={right.collapsed}
      storageKey="rightInspector"
      onResizeEnd={(s) => setRightSize('rightInspector', s)}
    >
      {inspectorRow}
    </SplitPane>
  );

  const timelinePane = (
    <div className={styles.timelinePane} key="timeline">
      {isTimelineExternal ? (
          <div className={`${styles.detached} ${styles.detachedRow}`}>
            <Icon name="export" size={16} />
            <span className={styles.detachedLabel}>Timeline is open in an external window</span>
            <button className={styles.detachedAction} onClick={() => dockPanel('timeline')}>
              Re-dock timeline
            </button>
          </div>
        ) : (
          timeline
        )}
    </div>
  );

  // Viewport row and timeline, in whichever order the timeline is docked.
  const timelineColumn: [ReactNode, ReactNode] = timelineLast
    ? [topContent, timelinePane]
    : [timelinePane, topContent];

  const mainContent = (
    <SplitPane
      key="main-column"
      className={styles.split}
      direction="vertical"
      primary={timelineLast ? 'last' : 'first'}
      defaultSize={bottom.size}
      minSize={44}
      maxSize={bottom.maxSize}
      size={bottom.collapsed ? 44 : bottom.size}
      collapsed={bottom.collapsed}
      storageKey="bottomTimeline"
      onResizeEnd={(s) => setBottomSize('bottomTimeline', s)}
    >
      {timelineColumn}
    </SplitPane>
  );

  const bodyRow: [ReactNode, ReactNode] = sidebarFirst
    ? [leftSidebarEl, mainContent]
    : [mainContent, leftSidebarEl];

  return (
    <div className={styles.root}>
      {/* Full-width AE-style top chrome (menu bar + tool row). */}
      {topNav}

      {/* Body row: the sidebar on whichever edge it is docked to. */}
      <div className={styles.body}>
        <SplitPane
          className={styles.split}
          direction="horizontal"
          primary={sidebarFirst ? 'first' : 'last'}
          defaultSize={left.size}
          minSize={left.collapsed ? 44 : left.minSize}
          maxSize={Math.min(left.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : left.maxSize)}
          size={left.collapsed ? 44 : left.size}
          collapsed={left.collapsed}
          storageKey="leftSidebar"
          onResizeEnd={(s) => setLeftSize('leftSidebar', s)}
        >
          {bodyRow}
        </SplitPane>
      </div>

      {statusBar}
    </div>
  );
}

