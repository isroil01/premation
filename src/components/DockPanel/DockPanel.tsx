/**
 * DockPanel — a region's panels as a vertical ICON RAIL beside one content pane.
 *
 * ## Why a rail and not a tab strip
 *
 * This used to be a horizontal tab strip that showed the first three panels and
 * hid the rest behind a ≡ menu. The right inspector registers fourteen panels,
 * so eleven of them — Align, Swatches, Scopes, Preview, Source, Tracker,
 * Rigging, Effects, Graph, Presets, Paragraph — were invisible until the user
 * guessed that the hamburger held them. A tab that cannot be seen is a feature
 * that does not exist; the two "Where is X?" reports that prompted this were
 * both about panels that were open the whole time.
 *
 * A rail scales: at 28px a tab, fourteen panels take 420px of the sidebar's
 * height and every one of them is a single click with its name a hover away.
 * It is also what the COLLAPSED sidebar already drew — so collapsing now simply
 * hides the content column, and no icon moves.
 *
 * ## One header, one menu
 *
 * The strip carried a split button, a ≡ menu with "Split View" in it, a
 * right-click menu on every tab with "Move / Undock" in it, and the ≡ menu with
 * "Move / Undock" in it again — four homes for six actions. Now:
 *
 *   • the header names the ACTIVE panel and holds ONE options menu (⋯) — what
 *     you can do with this panel, then what you can do with this sidebar, then
 *     which registered panels are not docked yet;
 *   • a rail tab's right-click offers the same per-panel verbs for THAT panel,
 *     so a panel need not be activated to be moved or closed;
 *   • the collapse toggle sits at the foot of the rail, where it also reads as
 *     the way back when the sidebar is collapsed to the rail alone.
 *
 * Reordering is still drag-and-drop along the rail.
 */

import { useMemo, type ReactNode, type DragEvent } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import type { RegionId } from '@stores/layoutStore';
import type { IconName } from '@components/Icon';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { Icon } from '@components/Icon';
import { Tooltip } from '@components/Tooltip';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { panelDef, availablePanelDefs } from '@layout/EditorLayout/panelDefs';
import styles from './DockPanel.module.css';

export interface DockPanelProps {
  region: RegionId;
  renderers: Record<string, (() => ReactNode) | (() => JSX.Element)>;
  headerExtras?: ReactNode;
  className?: string;
  isSplit?: boolean;
  splitPosition?: 'top' | 'bottom';
  onToggleSplit?: () => void;
  /**
   * Which edge of the sidebar the rail sits on. The OUTER edge — the one at
   * the window's side — so the pointer can overshoot onto it and the content
   * pane stays adjacent to the viewport. Defaults from the region: the left
   * sidebar puts it left, the inspector puts it right; a sidebar the user has
   * re-docked to the other side passes the other value.
   */
  railSide?: 'left' | 'right';
}

interface TabDescriptor {
  id: string;
  label: string;
  icon?: IconName;
  closable: boolean;
}

function spawnPopout(panelId: string): void {
  useLayoutStore.getState().popoutPanel(panelId);
  if (window.motionEditor?.popout?.spawnWindow) {
    window.motionEditor.popout.spawnWindow(panelId);
  } else {
    const url = `${window.location.origin}${window.location.pathname}#/popout/${panelId}`;
    window.open(url, `popout-${panelId}`, 'width=900,height=650,resizable=yes');
  }
}

export function DockPanel({
  region,
  renderers,
  headerExtras,
  className,
  isSplit = false,
  splitPosition,
  onToggleSplit,
  railSide,
}: DockPanelProps): JSX.Element | null {
  const isLeft = region.startsWith('leftSidebar');
  const isTop = splitPosition ? splitPosition === 'top' : (region === 'leftSidebar' || region === 'rightInspector');
  const regionKey = isLeft ? 'leftSidebar' : 'rightInspector';
  const side = railSide ?? (isLeft ? 'left' : 'right');

  const panelOrder = useLayoutStore((s) => s.panelOrder[region] ?? []);
  const activeTabId = useLayoutStore((s) => s.activePanelByRegion[region]);
  const panels = useLayoutStore((s) => s.panels);
  const isRegionCollapsed = useLayoutStore((s) => s.regions[regionKey]?.collapsed ?? false);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const closePanel = useLayoutStore((s) => s.closePanel);
  const movePanel = useLayoutStore((s) => s.movePanel);

  const isCollapsed = isRegionCollapsed || className?.includes('collapsed-view') || false;

  const allItems: TabDescriptor[] = useMemo(() => {
    return panelOrder
      .map((id) => panels[id])
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => {
        const def = panelDef(p.id);
        return {
          id: p.id,
          label: typeof p.title === 'string' ? p.title : p.id,
          icon: p.icon as IconName | undefined,
          closable: def ? def.closable : (p.closable ?? false),
        };
      });
  }, [panelOrder, panels]);

  // Guard against a stale persisted active id that no longer has a tab.
  const effectiveActiveId = allItems.some((i) => i.id === activeTabId) ? activeTabId : allItems[0]?.id;
  const activeItem = allItems.find((i) => i.id === effectiveActiveId);

  const otherSide: RegionId = isLeft ? 'rightInspector' : 'leftSidebar';
  const otherSideLabel = isLeft ? 'Move to Right Inspector' : 'Move to Left Sidebar';
  const paneDest: RegionId = isTop
    ? (isLeft ? 'leftSidebar_bottom' : 'rightInspector_bottom')
    : (isLeft ? 'leftSidebar' : 'rightInspector');
  const paneLabel = isTop ? 'Move to Bottom Pane' : 'Move to Top Pane';

  const moveTo = (panelId: string, dest: RegionId): void => {
    const destLen = useLayoutStore.getState().panelOrder[dest]?.length ?? 0;
    movePanel(panelId, dest, destLen);
  };

  /**
   * The per-panel verbs, as plain data so the header menu and the rail's
   * right-click draw the SAME list for their respective panel. One source, so
   * the two cannot drift into offering different things.
   */
  const panelVerbs = (item: TabDescriptor): Array<{ id: string; label: string; icon: IconName; onSelect: () => void }> => [
    ...(isSplit ? [{ id: 'move-pane', label: paneLabel, icon: 'layout' as IconName, onSelect: () => moveTo(item.id, paneDest) }] : []),
    { id: 'move-side', label: otherSideLabel, icon: (isLeft ? 'panel-right' : 'panel-left') as IconName, onSelect: () => moveTo(item.id, otherSide) },
    { id: 'popout', label: 'Undock into Window', icon: 'pop-out', onSelect: () => spawnPopout(item.id) },
    ...(item.closable ? [{ id: 'close', label: `Close “${item.label}”`, icon: 'close' as IconName, onSelect: () => closePanel(item.id) }] : []),
  ];

  const menuItems: DropdownItem[] = useMemo(() => {
    const items: DropdownItem[] = [];
    if (activeItem) {
      items.push({ type: 'label', label: activeItem.label });
      for (const v of panelVerbs(activeItem)) {
        items.push({ type: 'item', id: v.id, label: v.label, icon: v.icon, onSelect: v.onSelect });
      }
    }

    items.push(
      { type: 'separator' },
      { type: 'label', label: isLeft ? 'Sidebar' : 'Inspector' },
      {
        type: 'item',
        id: 'toggle-collapse',
        label: 'Collapse to Rail',
        icon: (side === 'left' ? 'chevron-left' : 'chevron-right') as IconName,
        onSelect: () => useLayoutStore.getState().setCollapsed(regionKey, true),
      },
    );
    if (onToggleSplit) {
      items.push({
        type: 'item',
        id: 'split-view',
        label: isSplit ? 'Merge Panes' : 'Split into Two Panes',
        icon: (isSplit ? 'minimize' : 'panel-bottom') as IconName,
        onSelect: onToggleSplit,
      });
    }

    // Registered for this side but not docked — the on-demand panels (History,
    // Render) and anything the user closed. The only place they can be opened
    // from inside the sidebar itself; the Window menu is the other door.
    const currentIds = new Set(allItems.map((item) => item.id));
    const otherDefs = availablePanelDefs().filter((def) => def.region === regionKey && !currentIds.has(def.id));
    if (otherDefs.length > 0) {
      items.push({ type: 'separator' }, { type: 'label', label: 'Open Panel' });
      for (const def of otherDefs) {
        items.push({ type: 'item', id: `open-${def.id}`, label: def.title, icon: def.icon, onSelect: () => openPanel(def.id) });
      }
    }
    return items;
    // `panelVerbs` is a closure over the same inputs listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allItems, activeItem, onToggleSplit, isSplit, isTop, isLeft, side, regionKey, paneDest, paneLabel, otherSide, otherSideLabel]);

  // All hooks must run before this guard — bail out only once they have.
  if (allItems.length === 0) return null;

  const activeRenderer = effectiveActiveId ? renderers[effectiveActiveId] : undefined;

  /** Drag handlers — plain HTML5 DnD for rail reordering. */
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
    let targetIdx = panelOrder.length;
    if (targetId !== null) {
      targetIdx = panelOrder.indexOf(targetId);
      if (targetIdx === -1) targetIdx = panelOrder.length;
    }
    movePanel(src, region, targetIdx);
  };

  const onRailContextMenu = (item: TabDescriptor) => (e: React.MouseEvent) => {
    e.preventDefault();
    const verbs = panelVerbs(item);
    const entries: ContextMenuItem[] = [];
    for (const v of verbs) {
      if (v.id === 'close') entries.push({ id: 'sep-close', separator: true });
      entries.push({ id: v.id, label: v.label, onSelect: v.onSelect });
    }
    openContextMenu(e.clientX, e.clientY, entries);
  };

  const tooltipSide = side === 'right' ? 'left' : 'right';
  // Only the LAST rail in a region carries the collapse toggle: a split region
  // stacks two DockPanels, and two toggles for one action is one too many. The
  // collapsed region renders a single DockPanel, which is therefore also last.
  const showCollapseToggle = !isSplit || splitPosition === 'bottom';

  const rail = (
    <div
      className={styles.rail}
      role="tablist"
      aria-orientation="vertical"
      aria-label={isLeft ? 'Sidebar panels' : 'Inspector panels'}
      onDragOver={onDragOver}
      onDrop={onDrop(null)}
    >
      {allItems.map((item) => {
        const isActive = item.id === effectiveActiveId && !isCollapsed;
        return (
          <div
            key={item.id}
            draggable
            onDragStart={onDragStart(item.id)}
            onDragOver={onDragOver}
            onDrop={onDrop(item.id)}
            className={styles.railSlot}
            onContextMenu={onRailContextMenu(item)}
          >
            <Tooltip label={item.label} placement={tooltipSide}>
              <button
                type="button"
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                aria-label={item.label}
                className={cn(styles.railTab, isActive && styles.railTabActive)}
                onClick={() => {
                  openPanel(item.id);
                  if (isCollapsed) useLayoutStore.getState().setCollapsed(regionKey, false);
                }}
              >
                <Icon name={item.icon ?? 'layers'} size="md" />
              </button>
            </Tooltip>
          </div>
        );
      })}
      <div className={styles.railSpacer} />
      {showCollapseToggle && (
        <Tooltip label={isCollapsed ? 'Expand' : 'Collapse to rail'} placement={tooltipSide}>
          <button
            type="button"
            className={styles.railToggle}
            aria-label={isCollapsed ? (isLeft ? 'Expand sidebar' : 'Expand inspector') : (isLeft ? 'Collapse sidebar' : 'Collapse inspector')}
            aria-expanded={!isCollapsed}
            onClick={() => useLayoutStore.getState().setCollapsed(regionKey, !isCollapsed)}
          >
            <Icon
              name={(isCollapsed ? (side === 'left' ? 'chevron-right' : 'chevron-left') : (side === 'left' ? 'chevron-left' : 'chevron-right')) as IconName}
              size="sm"
            />
          </button>
        </Tooltip>
      )}
    </div>
  );

  return (
    <div className={cn(styles.root, side === 'left' && styles.railLeft, isCollapsed && styles.collapsed, className)}>
      {!isCollapsed && (
        <div className={styles.pane}>
          <div className={styles.header}>
            <span className={styles.title} title={activeItem?.label}>{activeItem?.label ?? ''}</span>
            <div className={styles.headerActions}>
              {headerExtras}
              <Dropdown
                placement={side === 'right' ? 'bottom-end' : 'bottom-start'}
                offset={{ x: 0, y: 4 }}
                noScroll
                trigger={
                  <button type="button" className={styles.actionBtn} aria-label="Panel options" title="Panel options">
                    <Icon name="more-horizontal" size="sm" />
                  </button>
                }
                items={menuItems}
              />
              {activeItem?.closable && (
                <button
                  type="button"
                  className={styles.actionBtn}
                  aria-label={`Close ${activeItem.label}`}
                  title={`Close ${activeItem.label}`}
                  onClick={() => closePanel(activeItem.id)}
                >
                  <Icon name="close" size="sm" />
                </button>
              )}
            </div>
          </div>
          <div className={styles.content}>{activeRenderer ? activeRenderer() : null}</div>
        </div>
      )}
      {rail}
    </div>
  );
}
