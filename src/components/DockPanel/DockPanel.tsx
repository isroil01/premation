/**
 * DockPanel — orchestrator for a region.
 *
 * Reads the layout store for the ordered list of panel ids in this region
 * and renders a Tabs strip + the active panel's content. Tabs can be closed
 * (removing from the region) and reordered (future).
 */

import { useMemo, useRef, useState, useEffect, type ReactNode, type DragEvent } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import { Tabs } from '@components/Tabs';
import type { RegionId } from '@stores/layoutStore';
import type { IconName } from '@components/Icon';
import { openContextMenu } from '@stores/contextMenuStore';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import styles from './DockPanel.module.css';

export interface DockPanelProps {
  region: RegionId;
  renderers: Record<string, (() => ReactNode) | (() => JSX.Element)>;
  headerExtras?: ReactNode;
  className?: string;
}

interface TabDescriptor {
  id: string;
  label: ReactNode;
  icon?: IconName;
  closable: boolean;
}

const REGION_LABELS: Record<RegionId, string> = {
  leftSidebar: 'Left Sidebar',
  rightInspector: 'Right Inspector',
  bottomTimeline: 'Bottom Timeline',
  centerWorkspace: 'Center',
};

export function DockPanel({ region, renderers, headerExtras, className }: DockPanelProps): JSX.Element | null {
  const panelOrder = useLayoutStore((s) => s.panelOrder[region]);
  const activeTabId = useLayoutStore((s) => s.activePanelByRegion[region]);
  const panels = useLayoutStore((s) => s.panels);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const closePanel = useLayoutStore((s) => s.closePanel);
  const movePanel = useLayoutStore((s) => s.movePanel);

  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!moveMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setMoveMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [moveMenuOpen]);

  const items: TabDescriptor[] = useMemo(() => {
    return panelOrder
      .map((id) => panels[id])
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({
        id: p.id,
        label: p.title,
        icon: p.icon as IconName | undefined,
        closable: p.closable ?? false,
      }));
  }, [panelOrder, panels]);

  if (items.length === 0) return null;

  const activeRenderer = activeTabId ? renderers[activeTabId] : undefined;
  const isRightInspector = region === 'rightInspector';
  const isLeftSidebar = region === 'leftSidebar';

  // Check if this sidebar is collapsed (collapsed means we don't render content pane)
  const isCollapsed = className?.includes('collapsed-view') || false;

  /** Drag handlers — plain HTML5 DnD, no library needed for tab reorder. */
  const onDragStart = (id: string) => (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDrop = (targetId: string | null) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const src = e.dataTransfer.getData('text/plain');
    if (!src || src === targetId) return;
    
    // If dropping on a specific tab, insert before it.
    // If dropping on the empty space, append to the end.
    let targetIdx = panelOrder.length;
    if (targetId !== null) {
      targetIdx = panelOrder.indexOf(targetId);
      if (targetIdx === -1) targetIdx = panelOrder.length;
    }
    
    movePanel(src, region, targetIdx);
  };

  // Only the two sidebar regions host arbitrary panels (they render the full
  // renderer map, so a moved panel's CONTENT always follows). The bottom region
  // is a dedicated timeline, not a generic dock — moving a panel there would
  // orphan it (nothing renders it), so it is not offered as a destination.
  const DOCKABLE_REGIONS: RegionId[] = ['leftSidebar', 'rightInspector'];
  const destinations = DOCKABLE_REGIONS.filter((r) => r !== region);

  // The panel the grip acts on: the one the user is looking at (active tab),
  // falling back to the first. We move ONE panel at a time so the source region
  // isn't emptied out from under the user.
  const targetPanelId = activeTabId ?? items[0]?.id ?? null;
  const targetPanel = targetPanelId ? panels[targetPanelId] : undefined;
  const targetLabel =
    typeof targetPanel?.title === 'string' ? (targetPanel.title as string) : 'panel';

  const moveActiveTo = (dest: RegionId) => {
    if (targetPanelId) {
      // Append after any panels already in the destination (splice clamps to end).
      const destLen = useLayoutStore.getState().panelOrder[dest]?.length ?? 0;
      movePanel(targetPanelId, dest, destLen);
    }
    setMoveMenuOpen(false);
  };

  const gripButton = (
    <div className={styles.gripWrap} ref={popoverRef}>
      <button
        type="button"
        className={cn(styles.gripBtn, moveMenuOpen && styles.gripBtnActive)}
        title={`Move “${targetLabel}” to another region`}
        aria-label="Move panel to another region"
        aria-haspopup="true"
        aria-expanded={moveMenuOpen}
        onClick={() => setMoveMenuOpen((v) => !v)}
      >
        <Icon name="grip-vertical" size={12} />
      </button>
      {moveMenuOpen && (
        <ul className={styles.moveMenu} role="menu">
          <li className={styles.moveMenuLabel} role="none">Move “{targetLabel}” to…</li>
          {destinations.map((dest) => (
            <li key={dest} role="none">
              <button
                type="button"
                role="menuitem"
                className={styles.moveMenuItem}
                onClick={() => moveActiveTo(dest)}
              >
                {REGION_LABELS[dest]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const tabsElement = (
    <div className={styles.tabsCol}>
      {gripButton}
      {headerExtras && (
        <div className={styles.extras}>
          {headerExtras}
        </div>
      )}
      <div 
        className={styles.tabsScroll} 
        onDragOver={onDragOver} 
        onDrop={onDrop(null)}
      >
        {items.map((item) => (
          <div
            key={item.id}
            draggable
            onDragStart={onDragStart(item.id)}
            onDragOver={onDragOver}
            onDrop={onDrop(item.id)}
            className={styles.draggableTab}
            title={typeof item.label === 'string' ? item.label : undefined}
            onContextMenu={(e) => {
              e.preventDefault();
              // Per-panel move — only between the two sidebar docks (the bottom
              // region is the dedicated timeline and can't host panels).
              openContextMenu(e.clientX, e.clientY, [
                {
                  id: 'move-left',
                  label: 'Move to Left Sidebar',
                  disabled: region === 'leftSidebar',
                  onSelect: () => movePanel(item.id, 'leftSidebar', useLayoutStore.getState().panelOrder.leftSidebar.length),
                },
                {
                  id: 'move-right',
                  label: 'Move to Right Inspector',
                  disabled: region === 'rightInspector',
                  onSelect: () => movePanel(item.id, 'rightInspector', useLayoutStore.getState().panelOrder.rightInspector.length),
                },
              ]);
            }}
          >
            <Tabs
              value={activeTabId ?? items[0]!.id}
              onChange={(id) => openPanel(id)}
              items={[{
                id: item.id,
                label: '',
                icon: item.icon ? <Icon name={item.icon} size={14} /> : undefined,
                closable: false,
                onClose: () => closePanel(item.id),
              }]}
              size="sm"
              variant="default"
              orientation="vertical"
            />
          </div>
        ))}
      </div>
    </div>
  );

  if (isCollapsed) {
    return (
      <div className={cn(styles.root, isRightInspector ? styles.rightInspectorRoot : styles.leftSidebarRoot, className)}>
        {tabsElement}
      </div>
    );
  }

  return (
    <div className={cn(styles.root, isRightInspector ? styles.rightInspectorRoot : isLeftSidebar ? styles.leftSidebarRoot : '', className)}>
      {isLeftSidebar && tabsElement}
      <div className={styles.content}>
        {activeRenderer ? activeRenderer() : null}
      </div>
      {isRightInspector && tabsElement}
    </div>
  );
}
