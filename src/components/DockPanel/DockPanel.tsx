/**
 * DockPanel — orchestrator for a region.
 *
 * Reads the layout store for the ordered list of panel ids in this region
 * and renders a Tabs strip + the active panel's content. Tabs can be closed
 * (removing from the region) and reordered (future).
 */

import { useMemo, type ReactNode } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import { Tabs } from '@components/Tabs';
import type { RegionId } from '@stores/layoutStore';
import type { IconName } from '@components/Icon';
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

export function DockPanel({ region, renderers, headerExtras, className }: DockPanelProps): JSX.Element | null {
  const panelOrder = useLayoutStore((s) => s.panelOrder[region]);
  const activeId = useLayoutStore((s) => s.activePanelByRegion[region]);
  const panels = useLayoutStore((s) => s.panels);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const closePanel = useLayoutStore((s) => s.closePanel);
  const toggleRegion = useLayoutStore((s) => s.toggleRegion);
  const collapseIcon = region === 'rightInspector' ? 'panel-right' : 'panel-left';

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

  const activeRenderer = activeId ? renderers[activeId] : undefined;
  const isRightInspector = region === 'rightInspector';
  const isLeftSidebar = region === 'leftSidebar';

  // Check if this sidebar is collapsed (collapsed means we don't render content pane)
  const isCollapsed = className?.includes('collapsed-view') || false;

  const tabsElement = (
    <div className={styles.tabsCol}>
      <div className={styles.extras}>
        <button
          type="button"
          className={styles.collapse}
          aria-label="Collapse panel"
          title="Collapse panel"
          onClick={() => toggleRegion(region)}
        >
          <Icon name={collapseIcon} size={14} />
        </button>
        {headerExtras}
      </div>
      <div className={styles.tabsScroll}>
        <Tabs
          value={activeId ?? items[0]!.id}
          onChange={(id) => openPanel(id)}
          items={items.map((i) => ({
            id: i.id,
            label: '', // Always hide labels on sidebars to save space
            icon: i.icon ? <Icon name={i.icon} size={14} /> : undefined,
            closable: false, // Force false so close icons do not show
            onClose: () => closePanel(i.id),
          }))}
          size="sm"
          variant="default"
          orientation="vertical"
        />
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
