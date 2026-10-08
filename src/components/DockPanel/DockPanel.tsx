/**
 * DockPanel — one sidebar's panels, as After Effects panel groups.
 *
 * ## Groups: tabs and stacking at once (2026-10)
 *
 * A sidebar is a COLUMN of groups stacked top to bottom; each group is a TAB
 * STRIP with one panel in front of it, open or collapsed to the strip. So
 * Info and Audio can be two tabs of one group while Properties, Preview and
 * Effects & Presets stack below each other — how After Effects' right column
 * is organised. It replaces a per-side choice between "tabs" and "stacked
 * sections" and the fixed two-pane split, each of which could only express
 * one of the two (2026-10 review). The model is `layoutStore.dockGroups`
 * (core/layout/dockGroups.ts); this file draws it and turns gestures into its
 * actions:
 *
 *   • click a tab              → that panel in front, its group open;
 *   • twirl ▶/▼ or double-click → collapse / expand the group;
 *   • drag a tab               → onto another strip: join that group; onto a
 *                                gap between groups: a group of its own — on
 *                                either side, so a tab crosses sidebars too;
 *   • drag a divider           → share the height between two open groups;
 *   • ≡ / right-click a tab    → the panel's rows, then panel, group and side
 *                                verbs (the same moves without a drag).
 *
 * ## No tab is ever out of reach
 *
 * A strip whose tabs do not fit scrolls sideways (the wheel scrolls it), fades
 * at the edge that has more, and shows a » that lists every tab of the group,
 * marking the ones that are scrolled out of view. The front tab is kept in
 * view. A sidebar's closed panels are one "+" away (the last strip).
 *
 * ## One title per panel
 *
 * The tab is the panel's only title: a panel never repeats its name inside.
 * What the panel is showing follows the name in the tab — "Properties: Logo",
 * the way After Effects names the subject (`setTitleDetail`). Panel-wide
 * actions go in the group's ≡ menu (`setCustomMenuItems`).
 */

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent,
} from 'react';
import { useLayoutStore, type DockGroupState, type DockSide, type RegionId } from '@stores/layoutStore';
import { bottomRegionOf, reconcileGroups, sideOfRegion } from '@core/layout/dockGroups';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { panelDef, availablePanelDefs } from '@layout/EditorLayout/panelDefs';
import styles from './DockPanel.module.css';

export interface DockPanelHeaderContextValue {
  /** A slot in the group's strip for the front panel's own compact controls. */
  target: HTMLDivElement | null;
  /** The front panel's rows for its group's ≡ menu. Hand a memoised array. */
  setCustomMenuItems?: (items: DropdownItem[]) => void;
  /**
   * What the panel is showing, printed after its title in the tab —
   * "Properties: Logo". `null` clears it. Display only: the tab's accessible
   * name stays the panel's title.
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
  /** The sidebar this column draws: `leftSidebar` or `rightInspector` (a `_bottom` region means the same side). */
  region: RegionId;
  renderers: Record<string, (() => ReactNode) | (() => JSX.Element)>;
  /** Extra controls at the end of the FIRST group's strip. */
  headerExtras?: ReactNode;
  className?: string;
  /**
   * Which edge of the window the sidebar sits on, so menus open toward the
   * inside. Defaults from the region: the left sidebar left, the inspector
   * right; a sidebar re-docked to the other side passes the other value.
   */
  railSide?: 'left' | 'right';
}

/**
 * Panels offered for THIS side that are not docked anywhere on it.
 *
 * Shared by the ≡ menu's "Open Panel" block and the "+" button, so the two can
 * never offer different lists. Checks the side's old bottom pane too, for a
 * layout that has not been re-saved since groups replaced the split.
 */
export function closedPanelDefsForSide(
  side: DockSide,
  panelOrder: Partial<Record<RegionId, ReadonlyArray<string>>>,
): ReturnType<typeof availablePanelDefs> {
  const docked = new Set([...(panelOrder[side] ?? []), ...(panelOrder[bottomRegionOf(side)] ?? [])]);
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

// ── The tab being dragged ─────────────────────────────────────────────
//
// Shared by both columns, so a gap in the OTHER sidebar lights up as a drop
// target too. Not React state: one value, written on drag start and end.

let draggingPanel: string | null = null;
const dragListeners = new Set<() => void>();

function setDraggingPanel(id: string | null): void {
  if (draggingPanel === id) return;
  draggingPanel = id;
  for (const fn of [...dragListeners]) fn();
}

function subscribeDragging(fn: () => void): () => void {
  dragListeners.add(fn);
  return () => {
    dragListeners.delete(fn);
  };
}

function useDraggingPanel(): string | null {
  return useSyncExternalStore(subscribeDragging, () => draggingPanel, () => null);
}

/** A panel id carried by a drag — the shared value, or the drag's own payload. */
function draggedId(e: DragEvent): string | null {
  if (draggingPanel) return draggingPanel;
  try {
    return e.dataTransfer.getData('text/plain') || null;
  } catch {
    return null;
  }
}

/** The smallest height a divider drag leaves an open group: its strip and a few rows. */
const MIN_GROUP_PX = 88;

interface TabDescriptor {
  id: string;
  label: string;
  closable: boolean;
}

export function DockPanel({ region, renderers, headerExtras, className, railSide }: DockPanelProps): JSX.Element | null {
  const side: DockSide = sideOfRegion(region) ?? 'rightInspector';
  const isLeft = side === 'leftSidebar';
  const edge = railSide ?? (isLeft ? 'left' : 'right');

  const storedGroups = useLayoutStore((s) => s.dockGroups[side]);
  const order = useLayoutStore((s) => s.panelOrder[side]);
  const orderBottom = useLayoutStore((s) => s.panelOrder[bottomRegionOf(side)]);
  // The whole map, for the "+" — which of this side's panels are closed.
  const allPanelOrder = useLayoutStore((s) => s.panelOrder);
  const panels = useLayoutStore((s) => s.panels);
  const focusId = useLayoutStore((s) => s.activePanelByRegion[side]);
  const isRegionCollapsed = useLayoutStore((s) => s.regions[side]?.collapsed ?? false);
  const isCollapsed = isRegionCollapsed || className?.includes('collapsed-view') || false;
  const dragging = useDraggingPanel();

  /*
    The groups as drawn: reconciled with what is docked (a test or an import
    may seed `panelOrder` alone — the store reconciles the same way on its next
    action, with the same ids), limited to registered panels.
  */
  const groups = useMemo(() => {
    const members = [...new Set([...(order ?? []), ...(orderBottom ?? [])])];
    return reconcileGroups(side, members, storedGroups)
      .map((g) => {
        const ids = g.panels.filter((id) => !!panels[id]);
        return { ...g, panels: ids, active: g.active && ids.includes(g.active) ? g.active : (ids[0] ?? null) };
      })
      .filter((g) => g.panels.length > 0);
  }, [side, order, orderBottom, storedGroups, panels]);

  const describe = useCallback((id: string): TabDescriptor => {
    const p = panels[id];
    const def = panelDef(id);
    return {
      id,
      label: p && typeof p.title === 'string' ? p.title : (def?.title ?? id),
      closable: def ? def.closable : (p?.closable ?? false),
    };
  }, [panels]);

  /** This side's closed panels as menu rows (the "+" and the ≡ menu's Open Panel). */
  const closedDefs = useMemo(() => closedPanelDefsForSide(side, allPanelOrder), [side, allPanelOrder]);

  // ── Divider drags: the share of height between two open groups ──────
  const groupEls = useRef(new Map<string, HTMLElement>());
  const bindGroupEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) groupEls.current.set(id, el);
    else groupEls.current.delete(id);
  }, []);
  const startResize = useCallback((above: DockGroupState, below: DockGroupState, e: ReactPointerEvent<HTMLDivElement>) => {
    const elA = groupEls.current.get(above.id);
    const elB = groupEls.current.get(below.id);
    if (!elA || !elB) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    // Every open group's flex-grow becomes its on-screen height for the drag,
    // so moving the divider changes exactly these two and nothing else jumps.
    const open = groups.filter((g) => !g.collapsed);
    const heights = new Map<string, number>();
    for (const g of open) {
      const el = groupEls.current.get(g.id);
      if (!el) continue;
      const h = el.getBoundingClientRect().height;
      heights.set(g.id, h);
      el.style.flexGrow = String(h);
    }
    const hA = heights.get(above.id) ?? 0;
    const hB = heights.get(below.id) ?? 0;
    const total = hA + hB;
    if (total < 2 * MIN_GROUP_PX) return;
    const startY = e.clientY;
    const onMove = (ev: PointerEvent): void => {
      const a = Math.min(total - MIN_GROUP_PX, Math.max(MIN_GROUP_PX, hA + (ev.clientY - startY)));
      heights.set(above.id, a);
      heights.set(below.id, total - a);
      elA.style.flexGrow = String(a);
      elB.style.flexGrow = String(total - a);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      useLayoutStore.getState().setGroupWeights(side, Object.fromEntries(heights));
      // The store's (normalised) weights take over the inline values.
      for (const g of open) {
        const el = groupEls.current.get(g.id);
        if (el) el.style.flexGrow = '';
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [groups, side]);

  // All hooks must run before this guard — bail out only once they have.
  if (groups.length === 0) return null;

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
          onClick={() => useLayoutStore.getState().setCollapsed(side, false)}
        >
          <span className={styles.edgeGrip} aria-hidden />
        </button>
      </div>
    );
  }

  const lastIndex = groups.length - 1;
  return (
    <div className={cn(styles.root, styles.column, className)} data-dock-column={side}>
      {groups.map((g, i) => {
        const above = groups[i - 1];
        return (
          <Fragment key={g.id}>
            <Seam
              side={side}
              index={i}
              dragging={dragging}
              resize={above && !above.collapsed && !g.collapsed ? (e) => startResize(above, g, e) : undefined}
            />
            <DockGroup
              group={g}
              index={i}
              side={side}
              isLeft={isLeft}
              edge={edge}
              focused={!!focusId && g.panels.includes(focusId)}
              describe={describe}
              renderer={g.active ? renderers[g.active] : undefined}
              headerExtras={i === 0 ? headerExtras : undefined}
              closedDefs={i === lastIndex ? closedDefs : null}
              dragging={dragging}
              bindEl={bindGroupEl}
            />
          </Fragment>
        );
      })}
      <Seam side={side} index={groups.length} dragging={dragging} />
    </div>
  );
}

// ── The gap between two groups ────────────────────────────────────────

interface SeamProps {
  side: DockSide;
  /** Where a dropped tab's new group goes: before the group at this index. */
  index: number;
  dragging: string | null;
  /** Present when both neighbours are open: the seam is a height divider. */
  resize?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * The gap between two groups. While a tab is being dragged it is a drop zone
 * that makes the tab a group of its own; between two open groups it is the
 * divider that shares their height; otherwise just the frame showing through.
 */
function Seam({ side, index, dragging, resize }: SeamProps): JSX.Element {
  const [over, setOver] = useState(false);
  if (dragging) {
    return (
      <div
        className={cn(styles.seam, styles.seamDrop, over && styles.seamDropOver)}
        data-dock-seam={index}
        aria-hidden
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!over) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const id = draggedId(e);
          setDraggingPanel(null);
          if (id) useLayoutStore.getState().movePanelToNewGroup(id, side, index);
        }}
      />
    );
  }
  if (resize) {
    return (
      <div
        className={cn(styles.seam, styles.seamResize)}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize panel groups"
        onPointerDown={resize}
      />
    );
  }
  return <div className={cn(styles.seam, index === 0 && styles.seamFirst)} aria-hidden />;
}

// ── One group ─────────────────────────────────────────────────────────

interface DockGroupProps {
  group: DockGroupState;
  index: number;
  side: DockSide;
  isLeft: boolean;
  edge: 'left' | 'right';
  /** The side's focused panel is in this group (AE outlines the panel in use). */
  focused: boolean;
  describe: (id: string) => TabDescriptor;
  renderer: (() => ReactNode) | undefined;
  headerExtras?: ReactNode;
  /** The side's closed panels, for the "+" — only the last group carries it. */
  closedDefs: ReturnType<typeof availablePanelDefs> | null;
  dragging: string | null;
  bindEl: (id: string, el: HTMLElement | null) => void;
}

/** Where tabs are clipped in a strip, for the fades and the ». */
interface StripOverflow {
  any: boolean;
  left: boolean;
  right: boolean;
}

const NO_OVERFLOW: StripOverflow = { any: false, left: false, right: false };

function DockGroup({
  group, index, side, isLeft, edge, focused, describe, renderer, headerExtras, closedDefs, dragging, bindEl,
}: DockGroupProps): JSX.Element {
  const active = group.active;
  const tabs = useMemo(() => group.panels.map(describe), [group.panels, describe]);
  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0]!;

  // The front panel's own rows and subject, tagged with the panel that handed
  // them over: rows from a panel no longer in front are ignored, so switching
  // tabs drops them without a reset effect (a parent's effect runs AFTER the
  // child's on the same commit, and clearing there wiped what the newly
  // mounted panel had just set — the v0.8.1 lesson).
  const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null);
  const [custom, setCustom] = useState<{ owner: string | null; items: DropdownItem[] }>({ owner: null, items: NO_ITEMS });
  const [detail, setDetail] = useState<{ owner: string | null; text: string | null }>({ owner: null, text: null });
  const setCustomMenuItems = useCallback((items: DropdownItem[]) => setCustom({ owner: active, items }), [active]);
  const setTitleDetail = useCallback((text: string | null) => setDetail({ owner: active, text }), [active]);
  const ctx = useMemo(
    () => ({ target: headerEl, setCustomMenuItems, setTitleDetail }),
    [headerEl, setCustomMenuItems, setTitleDetail],
  );
  const customItems = custom.owner === active ? custom.items : NO_ITEMS;
  const titleDetail = detail.owner === active ? detail.text : null;

  // ── Overflow: fades, the », the front tab kept in view ───────────────
  const tabsRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<StripOverflow>(NO_OVERFLOW);
  const measure = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    const any = el.scrollWidth > el.clientWidth + 1;
    const next: StripOverflow = {
      any,
      left: any && el.scrollLeft > 1,
      right: any && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    };
    setOverflow((cur) => (cur.any === next.any && cur.left === next.left && cur.right === next.right ? cur : next));
  }, []);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  useLayoutEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>('[data-dock-tab][aria-selected="true"]');
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [active, tabs.length, titleDetail, measure]);

  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
  };

  const isHidden = (i: number): boolean => {
    const el = tabsRef.current;
    const t = el?.querySelectorAll<HTMLElement>('[data-dock-tab]')[i];
    if (!el || !t) return false;
    const slot = t.parentElement ?? t;
    return slot.offsetLeft < el.scrollLeft || slot.offsetLeft + slot.offsetWidth > el.scrollLeft + el.clientWidth + 1;
  };

  // ── Actions ───────────────────────────────────────────────────────────
  const store = useLayoutStore.getState;
  /** Whether the group was collapsed when a double-click's first press landed. */
  const collapsedAtPress = useRef(false);
  const sideLabel = isLeft ? 'Left Sidebar' : 'Right Inspector';
  const otherSide: DockSide = isLeft ? 'rightInspector' : 'leftSidebar';
  const otherLabel = isLeft ? 'Move to Right Inspector' : 'Move to Left Sidebar';
  const show = (id: string): void => store().openPanel(id);

  /** Panel verbs for one tab — the ≡ menu and the right-click draw the same list. */
  const panelVerbs = (t: TabDescriptor): Array<{ id: string; label: string; icon: 'layout' | 'panel-right' | 'panel-left' | 'pop-out' | 'close'; onSelect: () => void }> => [
    ...(group.panels.length > 1
      ? [{ id: 'own-group', label: 'Move to New Group', icon: 'layout' as const, onSelect: () => store().movePanelToNewGroup(t.id, side, index + 1) }]
      : []),
    { id: 'move-side', label: otherLabel, icon: isLeft ? 'panel-right' : 'panel-left', onSelect: () => store().movePanel(t.id, otherSide, 0) },
    { id: 'popout', label: 'Undock Panel', icon: 'pop-out', onSelect: () => spawnPopout(t.id) },
    ...(t.closable ? [{ id: 'close', label: 'Close Panel', icon: 'close' as const, onSelect: () => store().closePanel(t.id) }] : []),
    ...(tabs.some((o) => o.id !== t.id && o.closable)
      ? [{
          id: 'close-others',
          label: 'Close Other Panels in Group',
          icon: 'close' as const,
          onSelect: () => {
            for (const o of tabs) if (o.id !== t.id && o.closable) store().closePanel(o.id);
          },
        }]
      : []),
  ];

  /** Group verbs — collapse, merge, close. */
  const groupVerbs = (): Array<{ id: string; label: string; onSelect: () => void }> => [
    {
      id: 'collapse',
      label: group.collapsed ? 'Expand Group' : 'Collapse Group',
      onSelect: () => store().toggleGroupCollapsed(group.id),
    },
    ...(index > 0 ? [{ id: 'merge-up', label: 'Merge with Group Above', onSelect: () => store().mergeGroupUp(group.id) }] : []),
    ...(tabs.some((t) => t.closable) ? [{ id: 'close-group', label: 'Close Group', onSelect: () => store().closeGroup(group.id) }] : []),
  ];

  /** Open a closed panel INTO this group, as a tab. */
  const openHere = (id: string): void => {
    store().openPanel(id);
    store().movePanelToGroup(id, group.id);
  };

  const menuItems = (): DropdownItem[] => {
    const items: DropdownItem[] = [{ type: 'label', label: activeTab.label }];
    if (customItems.length > 0) items.push(...customItems, { type: 'separator' });
    for (const v of panelVerbs(activeTab)) items.push({ type: 'item', id: v.id, label: v.label, icon: v.icon, onSelect: v.onSelect });
    items.push({ type: 'separator' }, { type: 'label', label: 'Group' });
    for (const v of groupVerbs()) items.push({ type: 'item', id: v.id, label: v.label, onSelect: v.onSelect });
    items.push(
      { type: 'separator' },
      { type: 'label', label: sideLabel },
      {
        type: 'item',
        id: 'hide-side',
        label: isLeft ? 'Hide Left Panels' : 'Hide Right Panels',
        icon: edge === 'left' ? 'chevron-left' : 'chevron-right',
        onSelect: () => store().setCollapsed(side, true),
      },
    );
    const closed = closedPanelDefsForSide(side, store().panelOrder);
    if (closed.length > 0) {
      items.push({
        type: 'item',
        id: 'open-here',
        label: 'Open Panel in This Group',
        icon: 'plus',
        submenu: closed.map((def): DropdownItem => ({ type: 'item', id: `open-${def.id}`, label: def.title, icon: def.icon, onSelect: () => openHere(def.id) })),
      });
    }
    return items;
  };

  const onTabContextMenu = (t: TabDescriptor) => (e: React.MouseEvent): void => {
    e.preventDefault();
    const entries: ContextMenuItem[] = [];
    for (const v of panelVerbs(t)) {
      if (v.id === 'close') entries.push({ id: 'sep-close', separator: true });
      entries.push({ id: v.id, label: v.label, onSelect: v.onSelect });
    }
    entries.push({ id: 'sep-group', separator: true });
    for (const v of groupVerbs()) entries.push({ id: v.id, label: v.label, onSelect: v.onSelect });
    openContextMenu(e.clientX, e.clientY, entries);
  };

  // ── Keyboard: the tablist pattern, plus Up / Down between groups ─────
  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Only this tablist's OWN tabs: a panel body may carry tabs of its own.
    if (!(e.target instanceof HTMLElement) || !e.target.hasAttribute('data-dock-tab')) return;
    const own = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-dock-tab]'));
    const current = own.findIndex((t) => t === document.activeElement);
    let target: HTMLButtonElement | undefined;
    switch (e.key) {
      case 'ArrowRight':
        target = own[current < 0 ? 0 : (current + 1) % own.length];
        break;
      case 'ArrowLeft':
        target = own[current < 0 ? own.length - 1 : (current - 1 + own.length) % own.length];
        break;
      case 'Home':
        target = own[0];
        break;
      case 'End':
        target = own[own.length - 1];
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        // To the front tab of the next / previous group in this column.
        const column = e.currentTarget.closest('[data-dock-column]');
        const lists = column ? Array.from(column.querySelectorAll<HTMLElement>('[role="tablist"][data-dock-group]')) : [];
        const at = lists.indexOf(e.currentTarget);
        const next = lists[at + (e.key === 'ArrowDown' ? 1 : -1)];
        target = next?.querySelector<HTMLButtonElement>('[data-dock-tab][aria-selected="true"]')
          ?? next?.querySelector<HTMLButtonElement>('[data-dock-tab]')
          ?? undefined;
        if (!target) return;
        e.preventDefault();
        target.focus();
        return;
      }
      case 'Enter':
      case ' ':
        if (current >= 0) {
          e.preventDefault();
          own[current]?.click();
        }
        return;
      default:
        return;
    }
    if (!target) return;
    e.preventDefault();
    // Roving tabindex: the focused tab becomes the one Tab returns to.
    for (const t of own) t.tabIndex = t === target ? 0 : -1;
    target.focus();
  };

  // ── Drag and drop into this strip ─────────────────────────────────────
  const [dropAt, setDropAt] = useState<number | null>(null);
  /** The insertion index under the pointer, counted without the dragged tab itself. */
  const insertionIndex = (clientX: number, id: string | null): number => {
    const el = tabsRef.current;
    const slots = el ? Array.from(el.querySelectorAll<HTMLElement>('[data-dock-slot]')) : [];
    let i = 0;
    for (const slot of slots) {
      if (slot.dataset.dockSlot === id) continue;
      const r = slot.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
      i++;
    }
    return i;
  };
  const stripDrag = {
    onDragOver: (e: DragEvent<HTMLDivElement>): void => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const at = insertionIndex(e.clientX, dragging);
      if (at !== dropAt) setDropAt(at);
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>): void => {
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      setDropAt(null);
    },
    onDrop: (e: DragEvent<HTMLDivElement>): void => {
      e.preventDefault();
      const id = draggedId(e);
      const at = insertionIndex(e.clientX, id);
      setDropAt(null);
      setDraggingPanel(null);
      if (id) store().movePanelToGroup(id, group.id, at);
    },
  };
  useEffect(() => {
    if (!dragging) setDropAt(null);
  }, [dragging]);

  /** The tab the drop marker sits before (a dragged tab never marks itself). */
  const visibleTabs = tabs.filter((t) => t.id !== dragging);
  const markBefore = dropAt !== null ? visibleTabs[dropAt]?.id ?? null : null;
  const markAtEnd = dropAt !== null && dropAt >= visibleTabs.length;

  const title = group.collapsed ? `Expand ${activeTab.label}` : `Collapse ${activeTab.label}`;
  const closedAdd = closedDefs && closedDefs.length > 0 ? closedDefs : null;

  return (
    <section
      ref={(el) => bindEl(group.id, el)}
      className={cn(styles.group, group.collapsed && styles.groupCollapsed, focused && styles.groupFocused)}
      style={group.collapsed ? undefined : { flexGrow: group.weight }}
      data-dock-group-id={group.id}
      aria-label={`${tabs.map((t) => t.label).join(', ')} panel group`}
    >
      <div className={cn(styles.strip, overflow.left && styles.stripMoreLeft, overflow.right && styles.stripMoreRight)} {...stripDrag}>
        <button
          type="button"
          className={styles.twirl}
          aria-expanded={!group.collapsed}
          aria-label={title}
          title={title}
          onClick={() => store().toggleGroupCollapsed(group.id)}
        >
          <span aria-hidden>{group.collapsed ? '▶' : '▼'}</span>
        </button>
        <div className={styles.tabsWrap}>
          <div
            ref={tabsRef}
            className={cn(styles.tabs, markAtEnd && styles.tabsDropEnd)}
            role="tablist"
            aria-orientation="horizontal"
            aria-label={`${isLeft ? 'Sidebar' : 'Inspector'} panel group ${index + 1}`}
            data-dock-group=""
            onKeyDown={onTabsKeyDown}
            onWheel={onWheel}
            onScroll={measure}
          >
            {tabs.map((t) => {
              const isActive = t.id === active;
              return (
                <div
                  key={t.id}
                  data-dock-slot={t.id}
                  className={cn(styles.slot, isActive && styles.slotActive, markBefore === t.id && styles.dropBefore, dragging === t.id && styles.slotDragging)}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    try { e.dataTransfer.setData('text/plain', t.id); } catch { /* no payload: the shared value carries it */ }
                    setDraggingPanel(t.id);
                  }}
                  onDragEnd={() => setDraggingPanel(null)}
                  onContextMenu={onTabContextMenu(t)}
                >
                  <button
                    type="button"
                    role="tab"
                    data-dock-tab=""
                    tabIndex={isActive ? 0 : -1}
                    aria-selected={isActive}
                    aria-label={t.label}
                    title={isActive && titleDetail ? `${t.label}: ${titleDetail}` : t.label}
                    className={cn(styles.tab, isActive && styles.tabActive)}
                    onMouseDown={(e) => {
                      if (e.detail <= 1) collapsedAtPress.current = group.collapsed;
                    }}
                    onClick={() => show(t.id)}
                    // The first click already opened a collapsed group, so a
                    // double-click flips the state the group had BEFORE it:
                    // collapsed → open (and stays open), open → collapsed.
                    onDoubleClick={() => store().setGroupCollapsed(group.id, !collapsedAtPress.current)}
                  >
                    <span className={styles.tabLabel}>
                      {t.label}
                      {isActive && titleDetail ? <span className={styles.tabDetail}>: {titleDetail}</span> : null}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          <span className={cn(styles.fade, styles.fadeLeft)} aria-hidden />
          <span className={cn(styles.fade, styles.fadeRight)} aria-hidden />
        </div>
        <div className={styles.stripEnd}>
          <div ref={setHeaderEl} className={styles.customActions} />
          {headerExtras}
          {overflow.any && (
            <Dropdown
              placement={edge === 'right' ? 'bottom-end' : 'bottom-start'}
              offset={{ x: 0, y: 4 }}
              noScroll
              trigger={
                <button type="button" className={cn(styles.iconBtn, styles.overflowBtn)} aria-label="All panels in this group" title="All panels in this group">
                  »
                </button>
              }
              items={() => tabs.map((t, i): DropdownItem => ({
                type: 'item',
                id: `tab-${t.id}`,
                label: isHidden(i) ? `${t.label}  ·  scrolled out of view` : t.label,
                icon: t.id === active ? 'check' : undefined,
                onSelect: () => show(t.id),
              }))}
            />
          )}
          {closedAdd && (
            <Dropdown
              placement={edge === 'right' ? 'bottom-end' : 'bottom-start'}
              offset={{ x: 0, y: 4 }}
              noScroll
              trigger={
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={isLeft ? 'Open a sidebar panel' : 'Open an inspector panel'}
                  title="Open panel"
                >
                  <Icon name="plus" size="sm" />
                </button>
              }
              items={[
                { type: 'label', label: 'Open Panel' },
                ...closedAdd.map((def): DropdownItem => ({
                  type: 'item', id: `open-${def.id}`, label: def.title, icon: def.icon, onSelect: () => show(def.id),
                })),
              ]}
            />
          )}
          <Dropdown
            placement={edge === 'right' ? 'bottom-end' : 'bottom-start'}
            offset={{ x: 0, y: 4 }}
            noScroll
            trigger={
              <button type="button" className={styles.iconBtn} aria-label="Panel options" title="Panel options">
                <Icon name="menu" size="sm" />
              </button>
            }
            items={menuItems}
          />
        </div>
      </div>
      {!group.collapsed && (
        <DockPanelHeaderContext.Provider value={ctx}>
          <div className={styles.content} data-dock-panel={active ?? undefined}>{renderer ? renderer() : null}</div>
        </DockPanelHeaderContext.Provider>
      )}
    </section>
  );
}
