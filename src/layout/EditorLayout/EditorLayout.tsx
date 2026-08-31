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
import { EditorTabs } from '@layout/Tabs/EditorTabs';
import { PluginDetailTab } from '@layout/Plugins/PluginDetailTab';
import { Icon } from '@components/Icon';
import { useLayoutStore, type RegionId } from '@stores/layoutStore';
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
  // One action, not three aliases of it — every region resizes through it.
  const setRegionSize = useLayoutStore((s) => s.setRegionSize);
  const externalPanels = useLayoutStore((s) => s.externalPanels);
  const dockPanel = useLayoutStore((s) => s.dockPanel);

  /**
   * Live resize does NOT go through the store.
   *
   * Every region here is a subscriber of this component, so a `setRegionSize`
   * per frame of a splitter drag re-rendered the sidebar, the inspector and
   * the whole viewport subtree on every frame the user was dragging — and the
   * store's persist subscriber ran a JSON.stringify of the layout alongside
   * each one. None of that is needed to SEE the drag: SplitPane paints the
   * pane width straight to the DOM while the pointer is down, and the
   * viewport's own ResizeObserver picks that up. The store is the record of
   * where the divider ended up, so it is written once, on `onResizeEnd`.
   *
   * The exception is the first frame that drags a COLLAPSED region open.
   * `setRegionSize` is what clears the collapsed flag, and that flag drives a
   * class name (`sidebar-collapsed-view`) rather than a width — nothing the
   * imperative paint can express — so the region would stay visually collapsed
   * under the pointer until release. Once it flips, this stops writing again.
   */
  const resizeRegionLive = (region: RegionId, size: number, isCollapsed: boolean): void => {
    if (isCollapsed) setRegionSize(region, size);
  };

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
            <Icon name="export" size="lg" />
            <span className={styles.detachedLabel}>Preview Canvas is open in an external window</span>
            <button className={styles.detachedAction} onClick={() => dockPanel('viewport')}>
              Re-dock preview
            </button>
          </div>
        ) : (
          // The viewport is handed to the tab strip as its permanent
          // background rather than rendered beside it. `EditorTabs` keeps it
          // mounted at all times and hides it with CSS — see the note there,
          // because rendering it conditionally destroys the GPU context.
          <EditorTabs
            scene={<WorkspaceViewport {...(workspaceExtras ?? {})} />}
            renderTab={(tab) => <PluginDetailTab pluginId={tab.ref} />}
          />
        )}
    </div>
  );

  // Top row: Left Sidebar and Viewport Canvas
  const topRowChildren: [ReactNode, ReactNode] = sidebarFirst
    ? [leftSidebarEl, viewportPane]
    : [viewportPane, leftSidebarEl];

  const topRow = (
    <SplitPane
      key="top-row"
      className={styles.split}
      direction="horizontal"
      primary={sidebarFirst ? 'first' : 'last'}
      defaultSize={left.size}
      minSize={left.collapsed ? 44 : left.minSize}
      maxSize={Math.min(left.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : left.maxSize)}
      size={left.collapsed ? 44 : left.size}
      collapsed={left.collapsed}
      storageKey="leftSidebar"
      onResize={(s) => resizeRegionLive('leftSidebar', s, left.collapsed)}
      onResizeEnd={(s) => setRegionSize('leftSidebar', s)}
    >
      {topRowChildren}
    </SplitPane>
  );

  const timelinePane = (
    <div className={styles.timelinePane} key="timeline">
      {isTimelineExternal ? (
        <div className={`${styles.detached} ${styles.detachedRow}`}>
          <Icon name="export" size="md" />
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

  // Main area: Top Row (Sidebar + Viewport) and Bottom Timeline
  const mainCenterChildren: [ReactNode, ReactNode] = timelineLast
    ? [topRow, timelinePane]
    : [timelinePane, topRow];

  const mainCenterArea = (
    <SplitPane
      key="main-center-area"
      className={styles.split}
      direction="vertical"
      primary={timelineLast ? 'last' : 'first'}
      defaultSize={bottom.size}
      minSize={bottom.collapsed ? 44 : bottom.minSize}
      maxSize={bottom.maxSize}
      size={bottom.collapsed ? 44 : bottom.size}
      collapsed={bottom.collapsed}
      storageKey="bottomTimeline"
      onResize={(s) => resizeRegionLive('bottomTimeline', s, bottom.collapsed)}
      onResizeEnd={(s) => setRegionSize('bottomTimeline', s)}
    >
      {mainCenterChildren}
    </SplitPane>
  );

  // Outermost body row: Main Center Area and full-height Right Inspector
  const bodyRow: [ReactNode, ReactNode] = inspectorLast
    ? [mainCenterArea, rightInspectorEl]
    : [rightInspectorEl, mainCenterArea];

  return (
    <div className={styles.root}>
      {/* Full-width AE-style top chrome (menu bar + tool row). */}
      {topNav}

      {/* Body row: full-height right inspector with main center area beside it */}
      <div className={styles.body}>
        <SplitPane
          className={styles.split}
          direction="horizontal"
          primary={inspectorLast ? 'last' : 'first'}
          defaultSize={right.size}
          minSize={right.collapsed ? 44 : right.minSize}
          maxSize={Math.min(right.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : right.maxSize)}
          size={right.collapsed ? 44 : right.size}
          collapsed={right.collapsed}
          storageKey="rightInspector"
          onResize={(s) => resizeRegionLive('rightInspector', s, right.collapsed)}
          onResizeEnd={(s) => setRegionSize('rightInspector', s)}
        >
          {bodyRow}
        </SplitPane>
      </div>

      {statusBar}
    </div>
  );
}

