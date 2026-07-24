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

  const isViewportExternal = externalPanels.includes('viewport');
  const isTimelineExternal = externalPanels.includes('timeline');

  const leftSidebarEl = (
    <LeftSidebar renderers={sidebarRenderers} className={left.collapsed ? 'sidebar-collapsed-view' : ''} />
  );
  const rightInspectorEl = (
    <RightInspector renderers={inspectorRenderers} header={inspectorHeader} className={right.collapsed ? 'inspector-collapsed-view' : ''} />
  );

  // Top Content: Viewport (left) and RightInspector (right)
  const topContent = (
    <SplitPane
      className={styles.split}
      direction="horizontal"
      primary="last"
      defaultSize={right.size}
      minSize={right.collapsed ? 36 : right.minSize}
      maxSize={Math.min(right.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : right.maxSize)}
      size={right.collapsed ? 36 : right.size}
      collapsed={right.collapsed}
      storageKey="rightInspector"
      onResizeEnd={(s) => setRightSize('rightInspector', s)}
    >
      <div className={styles.workspacePane}>
        {isViewportExternal ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'rgba(255,255,255,0.6)', gap: 12 }}>
            <Icon name="export" size={24} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>Preview Canvas is open in an external window</span>
            <button onClick={() => dockPanel('viewport')} style={{ padding: '6px 16px', background: 'var(--color-primary, #2b7eff)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
              Re-dock Preview to Main Window
            </button>
          </div>
        ) : (
          <WorkspaceViewport {...(workspaceExtras ?? {})} />
        )}
      </div>
      {rightInspectorEl}
    </SplitPane>
  );

  // Main Right Pane: topContent (top) and Timeline (bottom)
  const mainContent = (
    <SplitPane
      className={styles.split}
      direction="vertical"
      primary="last"
      defaultSize={bottom.size}
      minSize={44}
      maxSize={bottom.maxSize}
      size={bottom.collapsed ? 44 : bottom.size}
      collapsed={bottom.collapsed}
      storageKey="bottomTimeline"
      onResizeEnd={(s) => setBottomSize('bottomTimeline', s)}
    >
      {topContent}
      <div className={styles.timelinePane}>
        {isTimelineExternal ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'rgba(255,255,255,0.6)', gap: 12, background: 'var(--color-surface-2, #181819)' }}>
            <Icon name="export" size={16} />
            <span style={{ fontSize: 12 }}>Timeline is open in an external window</span>
            <button onClick={() => dockPanel('timeline')} style={{ padding: '4px 12px', background: 'var(--color-primary, #2b7eff)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
              Re-dock Timeline
            </button>
          </div>
        ) : (
          timeline
        )}
      </div>
    </SplitPane>
  );

  return (
    <div className={styles.root}>
      {/* Full-width AE-style top chrome (menu bar + tool row). */}
      {topNav}

      {/* Body row: LeftSidebar (left) and mainContent (right) */}
      <div className={styles.body}>
        <SplitPane
          className={styles.split}
          direction="horizontal"
          primary="first"
          defaultSize={left.size}
          minSize={left.collapsed ? 36 : left.minSize}
          maxSize={Math.min(left.maxSize, typeof window !== 'undefined' ? window.innerWidth - 100 : left.maxSize)}
          size={left.collapsed ? 36 : left.size}
          collapsed={left.collapsed}
          storageKey="leftSidebar"
          onResizeEnd={(s) => setLeftSize('leftSidebar', s)}
        >
          {leftSidebarEl}
          {mainContent}
        </SplitPane>
      </div>

      {statusBar}
    </div>
  );
}

