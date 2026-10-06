/**
 * DockPanel — a region's panels, in the chrome that region calls for.
 *
 * ## Three chromes (2026-10, the After Effects direction)
 *
 *   • LEFT sidebar, open  → a TAB STRIP across the top (Project · Effect
 *     Controls…), the active panel under it. Names, not icons.
 *   • RIGHT inspector, open → a STACK of bars, one per panel, each a click
 *     away and each showing its name; the active panel's body opens under its
 *     own bar. This keeps what the rail was built for (below): no panel is
 *     ever hidden behind an overflow menu.
 *   • Either side, CLOSED → hidden behind a thin edge with a grip (2026-10;
 *     it was an icon rail). Click the edge, or open any panel, to bring it back.
 *
 * The rail's history, which is why the right side is a stack and not tabs:
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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type DragEvent } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import type { RegionId } from '@stores/layoutStore';
import type { IconName } from '@components/Icon';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { panelDef, availablePanelDefs } from '@layout/EditorLayout/panelDefs';
import styles from './DockPanel.module.css';

export interface DockPanelHeaderContextValue {
  target: HTMLDivElement | null;
  setCustomMenuItems?: (items: DropdownItem[]) => void;
  /**
   * What the panel is showing, printed after its title — "Properties: Logo",
   * the way After Effects names the subject in the panel's tab. `null` clears
   * it. Display only: the panel's accessible name stays its title.
   */
  setTitleDetail?: (detail: string | null) => void;
}

export const DockPanelHeaderContext = createContext<DockPanelHeaderContextValue | null>(null);

/** One shared empty list, so "no custom rows" never changes identity. */
const NO_ITEMS: DropdownItem[] = [];

export function useDockPanelHeader(): DockPanelHeaderContextValue | null {
  return useContext(DockPanelHeaderContext);
}

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
  /** What the rail prints under the glyph — `shortTitle` when the def has one. */
  railLabel: string;
  icon?: IconName;
  closable: boolean;
}

/**
 * Panels offered for THIS side that are not docked anywhere on it.
 *
 * Shared by the ⋯ menu's "Open Panel" block and the rail's "+" button, so the
 * two can never offer different lists. Checks both panes of a split side: a
 * panel sitting in the bottom pane is open, and offering to "open" it from the
 * top pane would only move focus, which is not what a "+" promises.
 */
export function closedPanelDefsForSide(
  side: 'leftSidebar' | 'rightInspector',
  panelOrder: Partial<Record<RegionId, ReadonlyArray<string>>>,
): ReturnType<typeof availablePanelDefs> {
  const docked = new Set([...(panelOrder[side] ?? []), ...(panelOrder[`${side}_bottom`] ?? [])]);
  return availablePanelDefs().filter((def) => def.region === side && !docked.has(def.id));
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
  // The whole map, for "which of this side's panels are closed" — a split side
  // spans two regions, and the "+" must not offer a panel open in the other pane.
  const allPanelOrder = useLayoutStore((s) => s.panelOrder);
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
        const label = typeof p.title === 'string' ? p.title : p.id;
        return {
          id: p.id,
          label,
          railLabel: def?.shortTitle ?? label,
          icon: p.icon as IconName | undefined,
          closable: def ? def.closable : (p.closable ?? false),
        };
      });
  }, [panelOrder, panels]);

  // Guard against a stale persisted active id that no longer has a tab.
  const effectiveActiveId = allItems.some((i) => i.id === activeTabId) ? activeTabId : allItems[0]?.id;
  const activeItem = allItems.find((i) => i.id === effectiveActiveId);

  const [headerActionsEl, setHeaderActionsEl] = useState<HTMLDivElement | null>(null);
  // The active panel's own rows for the ⋯ menu, tagged with the panel that
  // handed them over; rows whose owner is not the active panel are ignored. A
  // tab switch therefore drops the old rows without a reset effect — and a
  // reset effect cannot work here: a parent's effects run AFTER its children's
  // on the same commit, so clearing on `effectiveActiveId` wiped the rows the
  // newly mounted panel had just set.
  const [customMenu, setCustomMenu] = useState<{ owner: string | undefined; items: DropdownItem[] }>(
    { owner: undefined, items: NO_ITEMS },
  );
  const customMenuItems = customMenu.owner === effectiveActiveId ? customMenu.items : NO_ITEMS;

  const setCustomMenuItems = useCallback(
    (items: DropdownItem[]) => setCustomMenu({ owner: effectiveActiveId, items }),
    [effectiveActiveId],
  );

  const headerContextValue = useMemo(
    () => ({
      target: headerActionsEl,
      setCustomMenuItems,
    }),
    [headerActionsEl, setCustomMenuItems],
  );

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
    { id: 'popout', label: 'Undock Panel', icon: 'pop-out', onSelect: () => spawnPopout(item.id) },
    ...(item.closable ? [{ id: 'close', label: 'Close Panel', icon: 'close' as IconName, onSelect: () => closePanel(item.id) }] : []),
    // The other panels of THIS group that can be closed (a permanent panel has no Close).
    ...(allItems.some((other) => other.id !== item.id && other.closable)
      ? [{
          id: 'close-others',
          label: 'Close Other Panels in Group',
          icon: 'close' as IconName,
          onSelect: () => {
            for (const other of allItems) if (other.id !== item.id && other.closable) closePanel(other.id);
          },
        }]
      : []),
  ];

  /** This side's closed panels as menu rows — the ⋯ menu's "Open Panel" block and the rail's "+". */
  const openItems: DropdownItem[] = useMemo(
    () => closedPanelDefsForSide(regionKey, allPanelOrder).map((def): DropdownItem => ({
      type: 'item', id: `open-${def.id}`, label: def.title, icon: def.icon, onSelect: () => openPanel(def.id),
    })),
    // `openPanel` is a stable store action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regionKey, allPanelOrder],
  );

  /** The ≡ menu for one panel: its own rows, its verbs, then the sidebar's. */
  const buildMenu = (forItem: TabDescriptor | undefined, custom: ReadonlyArray<DropdownItem>): DropdownItem[] => {
    const items: DropdownItem[] = [];
    if (forItem) {
      items.push({ type: 'label', label: forItem.label });
      if (custom.length > 0) {
        items.push(...custom, { type: 'separator' });
      }
      for (const v of panelVerbs(forItem)) {
        items.push({ type: 'item', id: v.id, label: v.label, icon: v.icon, onSelect: v.onSelect });
      }
    }

    items.push(
      { type: 'separator' },
      { type: 'label', label: isLeft ? 'Sidebar' : 'Inspector' },
      {
        type: 'item',
        id: 'toggle-collapse',
        label: isLeft ? 'Hide Left Panels' : 'Hide Right Panels',
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

    // Registered for this side but not docked — the on-demand panels and
    // anything the user closed. The same list as the rail's "+" (`openItems`).
    if (openItems.length > 0) {
      items.push({ type: 'separator' }, { type: 'label', label: 'Open Panel' }, ...openItems);
    }
    return items;
  };

  const menuItems: DropdownItem[] = useMemo(
    () => buildMenu(activeItem, customMenuItems),
    // `buildMenu` is a closure over the same inputs listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allItems, activeItem, onToggleSplit, isSplit, isTop, isLeft, side, regionKey, paneDest, paneLabel, otherSide, otherSideLabel, customMenuItems, openItems],
  );

  /*
    The stack's open sections (right inspector). Several can be open at once,
    the way a column of panels works in After Effects; the store's ACTIVE panel
    is simply the one last opened, and a panel made active from elsewhere (a
    command, a double-click on a layer) opens itself here.
  */
  const [expanded, setExpanded] = useState<ReadonlyArray<string>>(() => readExpanded(region));
  // The tab or bar a dragged panel is over (see `dropHandlers`). Up here with
  // the other hooks: everything below the empty-region guard must be hook-free.
  const [dropOn, setDropOn] = useState<string | null>(null);
  const lastActive = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!effectiveActiveId || lastActive.current === effectiveActiveId) return;
    lastActive.current = effectiveActiveId;
    setExpanded((prev) => (prev.includes(effectiveActiveId) ? prev : [...prev, effectiveActiveId]));
  }, [effectiveActiveId]);
  useEffect(() => {
    writeExpanded(region, expanded);
  }, [region, expanded]);
  const toggleSection = (id: string): void => {
    if (expanded.includes(id)) {
      setExpanded(expanded.filter((x) => x !== id));
      return;
    }
    setExpanded([...expanded, id]);
    lastActive.current = id;
    openPanel(id);
  };

  // All hooks must run before this guard — bail out only once they have.
  if (allItems.length === 0) return null;

  const activeRenderer = effectiveActiveId ? renderers[effectiveActiveId] : undefined;

  /**
   * Where a dragged panel would land: the tab or bar under the pointer shows
   * an accent edge, so a drop — within this sidebar or from the other one —
   * is never a guess.
   */
  const dropHandlers = (id: string): {
    onDragOver: (e: DragEvent<HTMLDivElement>) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent<HTMLDivElement>) => void;
  } => ({
    onDragOver: (e) => {
      onDragOver(e);
      if (dropOn !== id) setDropOn(id);
    },
    onDragLeave: () => setDropOn((cur) => (cur === id ? null : cur)),
    onDrop: (e) => {
      setDropOn(null);
      onDrop(id)(e);
    },
  });

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

  // Only the LAST rail in a region carries the add button: a split region
  // stacks two DockPanels, and one "+" per side is clean and unambiguous.
  const showRailAdd = !isSplit || splitPosition === 'bottom';

  /**
   * Keyboard traversal of the rail — the tablist pattern.
   *
   * The roving tabindex was already here (only the active tab is in the tab
   * order), but nothing MOVED it: Tab landed on the active icon and the only
   * way to the next panel was the mouse. Up/Down walk the rail (Left/Right
   * too, so a user who thinks of it as a tab strip is not wrong), Home/End
   * jump, and Enter/Space open the focused panel. Focus moves on arrow keys
   * without activating — activation on every arrow press would re-render the
   * whole content pane per step, and a user scanning icons by keyboard does
   * not want fourteen panels to flash past.
   */
  const onRailKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Only this tablist's OWN tabs: in the stack chrome the panel body sits
    // inside the same element, and a body may carry tabs (and Enter/Space
    // targets) of its own that must not be walked or swallowed here.
    if (!(e.target instanceof HTMLElement) || !e.target.hasAttribute('data-dock-tab')) return;
    const tabs = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-dock-tab]'),
    );
    if (tabs.length === 0) return;
    const current = tabs.findIndex((t) => t === document.activeElement);
    let next = -1;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = current < 0 ? 0 : (current + 1) % tabs.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = current < 0 ? tabs.length - 1 : (current - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      case 'Enter':
      case ' ':
        if (current >= 0) {
          e.preventDefault();
          tabs[current]?.click();
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    const target = tabs[next];
    if (!target) return;
    // Roving tabindex: the focused tab becomes the one Tab returns to.
    for (const t of tabs) t.tabIndex = t === target ? 0 : -1;
    target.focus();
  };

  // Closed: the sidebar is hidden. What stays is a thin edge with a grip — one
  // click (or Enter) brings the panels back, as do Window ▸ Panels and every
  // command that opens a panel (`openPanel` reopens its sidebar).
  if (isCollapsed) {
    const showLabel = isLeft ? 'Show the left panels' : 'Show the right panels';
    return (
      <div className={cn(styles.root, styles.collapsed, className)}>
        <button
          type="button"
          className={styles.edge}
          aria-label={showLabel}
          title={showLabel}
          onClick={() => useLayoutStore.getState().setCollapsed(regionKey, false)}
        >
          <span className={styles.edgeGrip} aria-hidden />
        </button>
      </div>
    );
  }

  /** The ≡ panel menu, for the tab strip's active tab. */
  const panelMenu = (
    <Dropdown
      placement={side === 'right' ? 'bottom-end' : 'bottom-start'}
      offset={{ x: 0, y: 4 }}
      noScroll
      trigger={
        <button type="button" className={styles.menuBtn} aria-label="Panel options" title="Panel options">
          <Icon name="menu" size="sm" />
        </button>
      }
      items={menuItems}
    />
  );

  /** The active panel's own header controls (a search toggle, a view switch). */
  const headerActions = (
    <div className={styles.headerActions}>
      <div ref={setHeaderActionsEl} className={styles.customActions} />
      {headerExtras}
    </div>
  );

  const addLabel = isLeft ? 'Open a sidebar panel' : 'Open an inspector panel';
  const addButton = showRailAdd && openItems.length > 0 ? (
    <Dropdown
      placement={side === 'right' ? 'bottom-end' : 'bottom-start'}
      offset={{ x: 0, y: 4 }}
      noScroll
      trigger={
        <button type="button" className={styles.actionBtn} aria-label={addLabel} title="Open panel">
          <Icon name="plus" size="sm" />
        </button>
      }
      items={[{ type: 'label', label: 'Open Panel' }, ...openItems]}
    />
  ) : null;

  const body = (
    <DockPanelHeaderContext.Provider value={headerContextValue}>
      <div className={styles.content}>{activeRenderer ? activeRenderer() : null}</div>
    </DockPanelHeaderContext.Provider>
  );

  const tabButton = (item: TabDescriptor, isActive: boolean, className: string, lead?: ReactNode): JSX.Element => (
    <button
      type="button"
      role="tab"
      data-dock-tab=""
      tabIndex={isActive ? 0 : -1}
      aria-selected={isActive}
      aria-label={item.label}
      title={item.label}
      className={className}
      onClick={() => openPanel(item.id)}
    >
      {lead}
      <span className={styles.tabLabel}>{item.label}</span>
    </button>
  );

  // LEFT, open: a tab strip over the active panel.
  if (isLeft) {
    return (
      <div className={cn(styles.root, styles.tabsRoot, className)}>
        <div className={styles.strip}>
          <div
            className={styles.stripTabs}
            role="tablist"
            aria-orientation="horizontal"
            aria-label="Sidebar panels"
            onDragOver={onDragOver}
            onDrop={onDrop(null)}
            onKeyDown={onRailKeyDown}
          >
            {allItems.map((item) => {
              const isActive = item.id === effectiveActiveId;
              return (
                <div
                  key={item.id}
                  draggable
                  onDragStart={onDragStart(item.id)}
                  {...dropHandlers(item.id)}
                  className={cn(styles.stripSlot, isActive && styles.stripSlotActive, dropOn === item.id && styles.dropBefore)}
                  onContextMenu={onRailContextMenu(item)}
                >
                  {tabButton(item, isActive, cn(styles.stripTab, isActive && styles.stripTabActive))}
                  {isActive && panelMenu}
                </div>
              );
            })}
          </div>
          {headerActions}
          {addButton && <div className={styles.stripAdd}>{addButton}</div>}
        </div>
        {body}
      </div>
    );
  }

  // RIGHT, open: a stack of bars; every open panel sits under its own bar.
  const openIds = allItems.filter((i) => expanded.includes(i.id)).map((i) => i.id);
  return (
    <div
      className={cn(styles.root, styles.stackRoot, className)}
      role="tablist"
      aria-orientation="vertical"
      aria-label="Inspector panels"
      onKeyDown={onRailKeyDown}
    >
      {allItems.map((item) => (
        <StackSection
          key={item.id}
          item={item}
          open={openIds.includes(item.id)}
          inTabOrder={item.id === effectiveActiveId}
          side={side}
          renderer={renderers[item.id]}
          headerExtras={headerExtras}
          buildMenu={buildMenu}
          onToggle={() => toggleSection(item.id)}
          onDragStart={onDragStart(item.id)}
          dropTarget={dropOn === item.id}
          {...dropHandlers(item.id)}
          onContextMenu={onRailContextMenu(item)}
        />
      ))}
      {addButton && <div className={styles.barAdd}>{addButton}</div>}
    </div>
  );
}

const EXPANDED_KEY = 'premation.dock.expanded.';

/** Which sections were open last time — a per-machine convenience, never document state. */
function readExpanded(region: RegionId): ReadonlyArray<string> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY + region);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeExpanded(region: RegionId, ids: ReadonlyArray<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY + region, JSON.stringify(ids));
  } catch {
    /* blocked storage: the open set lasts for this session only */
  }
}

interface StackSectionProps {
  item: TabDescriptor;
  open: boolean;
  /** The roving tabindex: only the store's active panel's bar is a Tab stop. */
  inTabOrder: boolean;
  side: 'left' | 'right';
  renderer: (() => ReactNode) | undefined;
  headerExtras: ReactNode;
  buildMenu: (item: TabDescriptor, custom: ReadonlyArray<DropdownItem>) => DropdownItem[];
  onToggle: () => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  /** A dragged panel is over this bar and would land above it. */
  dropTarget: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
}

/**
 * One panel of the stack: its bar and, when open, its body.
 *
 * Its own component because each open panel needs its OWN header slot and its
 * own ≡-menu rows (DockPanelHeaderContext) — with one shared slot, two open
 * panels would write their header controls into the same element.
 */
function StackSection({
  item, open, inTabOrder, side, renderer, headerExtras, buildMenu,
  onToggle, onDragStart, onDragOver, onDragLeave, onDrop, dropTarget, onContextMenu,
}: StackSectionProps): JSX.Element {
  const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null);
  const [custom, setCustom] = useState<DropdownItem[]>(NO_ITEMS);
  const [detail, setDetail] = useState<string | null>(null);
  const ctx = useMemo(
    () => ({ target: headerEl, setCustomMenuItems: setCustom, setTitleDetail: setDetail }),
    [headerEl],
  );
  return (
    <>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(styles.bar, open && styles.barActive, dropTarget && styles.dropAbove)}
        onContextMenu={onContextMenu}
      >
        <button
          type="button"
          role="tab"
          data-dock-tab=""
          tabIndex={inTabOrder ? 0 : -1}
          aria-selected={open}
          aria-label={item.label}
          title={item.label}
          className={styles.barTab}
          onClick={onToggle}
        >
          <span className={styles.barTwirl} aria-hidden>{open ? '▼' : '▶'}</span>
          <span className={styles.tabLabel}>
            {item.label}
            {open && detail ? <span className={styles.tabDetail}>: {detail}</span> : null}
          </span>
        </button>
        <div className={styles.headerActions}>
          {open && (
            <>
              <div ref={setHeaderEl} className={styles.customActions} />
              {headerExtras}
            </>
          )}
          <Dropdown
            placement={side === 'right' ? 'bottom-end' : 'bottom-start'}
            offset={{ x: 0, y: 4 }}
            noScroll
            trigger={
              <button type="button" className={styles.menuBtn} aria-label="Panel options" title="Panel options">
                <Icon name="menu" size="sm" />
              </button>
            }
            items={() => buildMenu(item, open ? custom : NO_ITEMS)}
          />
        </div>
      </div>
      {open && (
        <DockPanelHeaderContext.Provider value={ctx}>
          <div className={styles.content}>{renderer ? renderer() : null}</div>
        </DockPanelHeaderContext.Provider>
      )}
    </>
  );
}
