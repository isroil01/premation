/**
 * DockPanel — orchestrator for a region.
 *
 * Reads the layout store for the ordered list of panel ids in this region
 * and renders a Tabs strip + the active panel's content. Tabs can be closed
 * (removing from the region) and reordered (future).
 *
 * Architecture is intentionally simple: today this is "tabs over a stack."
 * The full docking system (drag-to-dock, floating windows, multi-region
 * graphs) can be built on top of the same shape by enhancing the
 * layoutStore, without changing the panel component contract.
 */

import { useMemo, type ReactNode } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import { Tabs } from '@components/Tabs';
import type { RegionId } from '@stores/layoutStore';
import type { IconName } from '@components/Icon';
import { Icon } from '@components/Icon';
import styles from './DockPanel.module.css';

export interface DockPanelProps {
  region: RegionId;
  /**
   * Map of panel id → content renderer. Engine plugins pass renderers in
   * for the panel ids they register. The DockPanel itself never knows
   * what's inside.
   */
  renderers: Record<string, (() => ReactNode) | (() => JSX.Element)>;
  /** Optional header extra (e.g. "Add panel" dropdown). */
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

  return (
    <div className={className ? `${styles.root} ${className}` : styles.root}>
      <div className={styles.tabsRow}>
        <div className={styles.tabsScroll}>
          <Tabs
            value={activeId ?? items[0]!.id}
            // Activate via the store action (immer set) so React re-renders —
            // a direct `activePanelByRegion[region] = id` mutation never did.
            onChange={(id) => openPanel(id)}
            items={items.map((i) => ({
              id: i.id,
              label: i.label,
              icon: i.icon ? <Icon name={i.icon} size={14} /> : undefined,
              closable: i.closable,
              onClose: () => closePanel(i.id),
            }))}
            size="sm"
            variant="default"
          />
        </div>
        <div className={styles.extras}>
          {headerExtras}
          <button
            type="button"
            className={styles.collapse}
            aria-label="Collapse panel"
            title="Collapse panel"
            onClick={() => toggleRegion(region)}
          >
            <Icon name={collapseIcon} size={14} />
          </button>
        </div>
      </div>
      <div className={styles.content}>
        {activeRenderer ? activeRenderer() : null}
      </div>
    </div>
  );
}
