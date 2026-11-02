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
import { useLayoutStore, type DockDragSource, type DockDropTarget, type DockGroupState, type DockSide, type RegionId } from '@stores/layoutStore';
import { bottomRegionOf, clampColumnWeights, groupsByColumn, reconcileGroups, sideOfRegion } from '@core/layout/dockGroups';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { panelDef, availablePanelDefs } from '@layout/EditorLayout/panelDefs';
import { popOutPanel } from '@layout/EditorLayout/popoutWindows';
import { t } from '@core/i18n';
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
  popOutPanel(panelId);
}

/** Undock Frame: every panel of a group in a window of its own. */
function spawnPopoutGroup(panels: ReadonlyArray<string>): void {
  for (const id of panels) spawnPopout(id);
}

// ── The tab being dragged ─────────────────────────────────────────────
//
// Shared by both columns, so a gap in the OTHER sidebar lights up as a drop
// target too. Not React state: one value, written on drag start and end.
// A panel's id, or `group:<group id>` when the group grip is dragged.

const GROUP_DRAG_PREFIX = 'group:';

let draggingPanel: string | null = null;
const dragListeners = new Set<() => void>();

function setDraggingPanel(id: string | null): void {
  if (startTimer !== null) {
    clearTimeout(startTimer);
    startTimer = null;
  }
  if (draggingPanel === id) return;
  draggingPanel = id;
  for (const fn of [...dragListeners]) fn();
}

let startTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start a drag: the drop zones, edge strips and wider seams appear one tick
 * LATER. Chromium ends a drag at once when the page lays itself out again
 * inside `dragstart` and moves the element being dragged — which the seams and
 * strips do — so the group grip's drags died the moment they began.
 */
function beginDrag(value: string): void {
  if (startTimer !== null) clearTimeout(startTimer);
  // The value is readable at once (a drop that beats the timer); the dock redraws next tick.
  draggingPanel = value;
  startTimer = setTimeout(() => {
    startTimer = null;
    if (draggingPanel === value) for (const fn of [...dragListeners]) fn();
  }, 0);
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

/** What a drag value carries: a panel, or a whole group. */
function sourceOf(value: string): DockDragSource {
  return value.startsWith(GROUP_DRAG_PREFIX) ? { group: value.slice(GROUP_DRAG_PREFIX.length) } : { panel: value };
}

/** The panels a drag value moves (for Ctrl-drop, which floats them instead of docking). */
function draggedPanels(value: string): string[] {
  if (!value.startsWith(GROUP_DRAG_PREFIX)) return [value];
  const id = value.slice(GROUP_DRAG_PREFIX.length);
  const s = useLayoutStore.getState();
  for (const side of ['leftSidebar', 'rightInspector'] as const) {
    const g = s.dockGroups[side].find((x) => x.id === id);
    if (g) return [...g.panels];
  }
  return [];
}

/**
 * Finish a drop: Ctrl (Cmd on macOS) held floats what was dragged in windows of
 * its own, as in After Effects; otherwise it docks at `target`.
 */
function finishDrop(e: DragEvent, value: string | null, target: DockDropTarget): void {
  setDraggingPanel(null);
  if (!value) return;
  if (e.ctrlKey || e.metaKey) {
    spawnPopoutGroup(draggedPanels(value));
    return;
  }
  useLayoutStore.getState().dockDrop(sourceOf(value), target);
}

/**
 * A drag released outside the editor window floats the panel (After Effects:
 * "drag the panel outside the application window"). Esc, or a release over
 * nothing that takes it inside the window, does nothing.
 */
function onDockDragEnd(e: DragEvent): void {
  const value = draggingPanel;
  setDraggingPanel(null);
  if (!value || e.dataTransfer.dropEffect !== 'none') return;
  // A drag the browser cancelled reports 0,0 — never a reason to float a panel.
  if (e.screenX === 0 && e.screenY === 0) return;
  const margin = 24;
  const outside =
    e.screenX < window.screenX - margin
    || e.screenY < window.screenY - margin
    || e.screenX > window.screenX + window.outerWidth + margin
    || e.screenY > window.screenY + window.outerHeight + margin;
  if (outside) spawnPopoutGroup(draggedPanels(value));
}

// ── The group under the pointer (` = Maximize Frame) ─────────────────

let pointerX = -1;
let pointerY = -1;
let pointerTracked = false;

function trackPointer(): void {
  if (pointerTracked || typeof window === 'undefined') return;
  pointerTracked = true;
  // Two numbers per move, nothing allocated: read only when ` is pressed.
  window.addEventListener('pointermove', (e) => {
    pointerX = e.clientX;
    pointerY = e.clientY;
  }, { passive: true, capture: true });
}

/** The dock group under the pointer, for ` (After Effects maximizes the panel under the pointer). */
export function dockGroupUnderPointer(): string | null {
  if (pointerX < 0 || typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;
  const el = document.elementFromPoint(pointerX, pointerY);
  return el?.closest<HTMLElement>('[data-dock-group-id]')?.dataset.dockGroupId ?? null;
}

/** A group's five drop zones: four edge trapezoids that dock beside it, the centre that groups. */
type DropZone = 'top' | 'bottom' | 'left' | 'right' | 'center';

/**
 * Which zone a point is in, After Effects' layout: the centre rectangle is the
 * middle 40% each way; outside it, the nearest edge (so the edge zones are the
 * four trapezoids between the centre and the group's border).
 */
function zoneAt(r: { left: number; top: number; width: number; height: number }, x: number, y: number): DropZone {
  const u = r.width > 0 ? (x - r.left) / r.width : 0.5;
  const v = r.height > 0 ? (y - r.top) / r.height : 0.5;
  if (u >= 0.3 && u <= 0.7 && v >= 0.3 && v <= 0.7) return 'center';
  const d = { left: u, right: 1 - u, top: v, bottom: 1 - v };
  let best: DropZone = 'left';
  for (const k of ['right', 'top', 'bottom'] as const) if (d[k] < d[best as keyof typeof d]) best = k;
  return best;
}

/** The overlay that shows the five zones while a tab is dragged over a group. */
function ZoneOverlay({ zone }: { zone: DropZone | null }): JSX.Element {
  const lit = (z: DropZone): string => (zone === z ? styles.zoneLit : styles.zoneIdle) ?? '';
  return (
    <svg className={styles.zoneSvg} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <polygon className={lit('top')} points="0,0 100,0 70,30 30,30" />
      <polygon className={lit('right')} points="100,0 100,100 70,70 70,30" />
      <polygon className={lit('bottom')} points="0,100 100,100 70,70 30,70" />
      <polygon className={lit('left')} points="0,0 30,30 30,70 0,100" />
      <rect className={lit('center')} x="30" y="30" width="40" height="40" />
    </svg>
  );
}

/** The smallest height a divider drag leaves an open group: its strip and a few rows. */
const MIN_GROUP_PX = 88;

/** The smallest width a column divider drag leaves a column. */
const MIN_COLUMN_PX = 180;

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
  const columnWeights = useLayoutStore((s) => s.dockColumns[side]);
  const maximized = useLayoutStore((s) => s.maximizedGroup);
  useEffect(trackPointer, []);

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
    const open = groups.filter((g) => !g.collapsed && g.column === above.column);
    // Measure every group before writing any (a write re-lays the column out).
    const heights = new Map<string, number>();
    for (const g of open) {
      const el = groupEls.current.get(g.id);
      if (el) heights.set(g.id, el.getBoundingClientRect().height);
    }
    for (const [id, h] of heights) {
      const el = groupEls.current.get(id);
      if (el) el.style.flexGrow = String(h);
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
    };    const onUp = (): void => {
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

  // ── Column divider drags: the share of width between two columns ──────
  /*
    The columns are read from the DOM at the moment of the drag — the divider's
    own neighbours and the side's column elements, each tagged with its column
    number. A ref map keyed by column number went stale when columns were
    renumbered (a column added or emptied): the drag then widened the live left
    column and wrote the right one's width to a detached element, and the right
    column fell to a few pixels — "the main sidebar disappears".
  */
  const startColumnResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const seam = e.currentTarget;
    const elL = seam.previousElementSibling as HTMLElement | null;
    const elR = seam.nextElementSibling as HTMLElement | null;
    const sideEl = seam.parentElement;
    const colEls = sideEl ? Array.from(sideEl.querySelectorAll<HTMLElement>(':scope > [data-dock-column-index]')) : [];
    if (!elL?.dataset.dockColumnIndex || !elR?.dataset.dockColumnIndex || colEls.length < 2) return;
    e.preventDefault();
    seam.setPointerCapture?.(e.pointerId);
    // Every column's flex-grow becomes its width for the drag, so only these two move.
    // Measure every column BEFORE writing any: a write re-lays the side out,
    // and the next measurement would read the half-changed layout.
    const widths = new Map<HTMLElement, number>(colEls.map((el) => [el, el.getBoundingClientRect().width]));
    for (const [el, w] of widths) el.style.flexGrow = String(w);
    const wL = widths.get(elL) ?? 0;
    const wR = widths.get(elR) ?? 0;
    const total = wL + wR;
    const min = Math.min(MIN_COLUMN_PX, total / 2);
    const startX = e.clientX;
    const onMove = (ev: PointerEvent): void => {
      const a = Math.min(total - min, Math.max(min, wL + (ev.clientX - startX)));
      widths.set(elL, a);
      widths.set(elR, total - a);
      elL.style.flexGrow = String(a);
      elR.style.flexGrow = String(total - a);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const n = useLayoutStore.getState().dockColumns[side].length;
      const byColumn = new Map(colEls.map((el) => [Number(el.dataset.dockColumnIndex), widths.get(el) ?? 1]));
      const raw = Array.from({ length: n }, (_, c) => byColumn.get(c) ?? 1);
      // Leave the DOM at exactly what the store will hold (setColumnWeights:
      // clamped, mean 1), so React's next render and the inline values agree.
      const clamped = clampColumnWeights(raw);
      const mean = clamped.reduce((x, y) => x + y, 0) / Math.max(1, n) || 1;
      for (const el of colEls) el.style.flexGrow = String((clamped[Number(el.dataset.dockColumnIndex)] ?? 1) / mean);
      useLayoutStore.getState().setColumnWeights(side, raw);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [side]);

  // All hooks must run before this guard — bail out only once they have.
  if (groups.length === 0) return null;

  // Closed: the sidebar is hidden. What stays is a thin edge with a grip — one
  // click (or Enter) brings the panels back, as do Window ▸ Panels and every
  // command that opens a panel (`openPanel` reopens its sidebar).
  if (isCollapsed) {
    const showLabel = isLeft ? t('ui.dockPanel.showLeft', 'Show the left panels') : t('ui.dockPanel.showRight', 'Show the right panels');
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

  /*
    Columns, left to right (After Effects docking: a panel dropped on a group's
    left or right edge stands in a column of its own). The side's first group
    carries the header extras; the home column's last group carries the "+".
  */
  const columns = groupsByColumn(groups);
  const shares = clampColumnWeights(columnWeights);
  const firstGroup = groups[0]!.id;
  const homeCol = isLeft ? columns[0] : columns[columns.length - 1];
  const plusGroup = homeCol?.[homeCol.length - 1]?.id;
  return (
    <div className={cn(styles.root, styles.side, className)} data-dock-side={side}>
      <EdgeDrop side={side} column={0} dragging={dragging} />
      {columns.map((col, ci) => {
        const column = col[0]!.column;
        const next = columns[ci + 1];
        return (
          <Fragment key={`col-${column}`}>
            <div
              className={styles.column}
              style={{ flexGrow: shares[column] ?? 1 }}
              data-dock-column={side}
              data-dock-column-index={column}
            >
              {col.map((g, i) => {
                const above = col[i - 1];
                const flat = groups.indexOf(g);
                return (
                  <Fragment key={g.id}>
                    <Seam
                      side={side}
                      column={column}
                      index={i}
                      dragging={dragging}
                      resize={above && !above.collapsed && !g.collapsed ? (e) => startResize(above, g, e) : undefined}
                    />
                    <DockGroup
                      group={g}
                      index={flat}
                      hasGroupAbove={i > 0}
                      columnIndex={i}
                      side={side}
                      isLeft={isLeft}
                      edge={edge}
                      focused={!!focusId && g.panels.includes(focusId)}
                      maximized={maximized === g.id}
                      describe={describe}
                      renderer={g.active ? renderers[g.active] : undefined}
                      headerExtras={g.id === firstGroup ? headerExtras : undefined}
                      closedDefs={g.id === plusGroup ? closedDefs : null}
                      dragging={dragging}
                      bindEl={bindGroupEl}
                    />
                  </Fragment>
                );
              })}
              <Seam side={side} column={column} index={col.length} dragging={dragging} />
            </div>
            {next ? (
              <ColumnSeam
                side={side}
                column={next[0]!.column}
                dragging={dragging}
                resize={startColumnResize}
              />
            ) : null}
          </Fragment>
        );
      })}
      <EdgeDrop side={side} column={(columns[columns.length - 1]?.[0]?.column ?? 0) + 1} dragging={dragging} />
    </div>
  );
}

// ── The edges of a side: a new column ────────────────────────────────

/**
 * While a tab is dragged, each end of a side is a strip that makes a new
 * column there — beside the viewer, or at the window's edge.
 */
function EdgeDrop({ side, column, dragging }: { side: DockSide; column: number; dragging: string | null }): JSX.Element | null {
  const [over, setOver] = useState(false);
  if (!dragging) return null;
  return (
    <div
      className={cn(styles.edgeDrop, over && styles.edgeDropOver)}
      data-dock-edge={column}
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
        finishDrop(e, draggedId(e), { kind: 'column', side, column });
      }}
    />
  );
}

/** Between two columns: the width divider, and while a tab is dragged a new column there. */
function ColumnSeam({ side, column, dragging, resize }: {
  side: DockSide;
  /** The column on the seam's right: a drop makes a new column here. */
  column: number;
  dragging: string | null;
  resize: (e: ReactPointerEvent<HTMLDivElement>) => void;
}): JSX.Element {
  const [over, setOver] = useState(false);
  if (dragging) {
    return (
      <div
        className={cn(styles.edgeDrop, over && styles.edgeDropOver)}
        data-dock-column-seam={column}
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
          finishDrop(e, draggedId(e), { kind: 'column', side, column });
        }}
      />
    );
  }
  return (
    <div
      className={styles.columnSeam}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('ui.dockPanel.resizeColumns', 'Resize panel columns')}
      onPointerDown={resize}
    />
  );
}

// ── The gap between two groups ────────────────────────────────────────

interface SeamProps {
  side: DockSide;
  column: number;
  /** Where a dropped tab's new group goes: before the column's group at this index. */
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
function Seam({ side, column, index, dragging, resize }: SeamProps): JSX.Element {
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
          finishDrop(e, draggedId(e), { kind: 'split', side, column, index });
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
        aria-label={t('ui.dockPanel.resizeGroups', 'Resize panel groups')}
        onPointerDown={resize}
      />
    );
  }
  return <div className={cn(styles.seam, index === 0 && styles.seamFirst)} aria-hidden />;
}

// ── One group ─────────────────────────────────────────────────────────

interface DockGroupProps {
  group: DockGroupState;
  /** Position in the side's flat group list. */
  index: number;
  /** Position in its column (top = 0): where a top / bottom drop inserts. */
  columnIndex: number;
  /** A group stands above it in the same column (Merge with Group Above). */
  hasGroupAbove: boolean;
  /** Maximize Frame: the group fills the editor body. */
  maximized: boolean;
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
  group, index, columnIndex, hasGroupAbove, maximized, side, isLeft, edge, focused, describe, renderer, headerExtras, closedDefs, dragging, bindEl,
}: DockGroupProps): JSX.Element {
  const active = group.active;
  const tabs = useMemo(() => group.panels.map(describe), [group.panels, describe]);
  const activeTab = tabs.find((tab) => tab.id === active) ?? tabs[0]!;

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
  // The front tab whole in view: when it changes AND when the strip is resized
  // (a narrower sidebar used to leave the front tab cut off at the edge).
  const keepFrontInView = useCallback(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>('[data-dock-tab][aria-selected="true"]');
    (el?.parentElement ?? el)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [measure]);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(keepFrontInView);
    ro.observe(el);
    return () => ro.disconnect();
  }, [keepFrontInView]);
  useLayoutEffect(() => {
    keepFrontInView();
  }, [active, tabs.length, titleDetail, keepFrontInView]);

  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
  };

  const isHidden = (i: number): boolean => {
    const el = tabsRef.current;
    const tabEl = el?.querySelectorAll<HTMLElement>('[data-dock-tab]')[i];
    if (!el || !tabEl) return false;
    const slot = tabEl.parentElement ?? tabEl;
    return slot.offsetLeft < el.scrollLeft || slot.offsetLeft + slot.offsetWidth > el.scrollLeft + el.clientWidth + 1;
  };

  // ── Actions ───────────────────────────────────────────────────────────
  const store = useLayoutStore.getState;
  /** Whether the group was collapsed when a double-click's first press landed. */
  const collapsedAtPress = useRef(false);
  const otherSide: DockSide = isLeft ? 'rightInspector' : 'leftSidebar';
  const otherLabel = isLeft ? t('ui.dockPanel.moveToRight', 'Move to Right Inspector') : t('ui.dockPanel.moveToLeft', 'Move to Left Sidebar');
  const show = (id: string): void => store().openPanel(id);

  /**
   * The ≡ menu and the right-click, After Effects' panel menu: Undock Panel /
   * Frame, Close Panel / Other Panels / Frame, Maximize Frame — then the
   * group's settings, then the panel's own rows.
   */
  const panelVerbs = (tab: TabDescriptor): Array<{ id: string; label: string; shortcut?: string; onSelect: () => void }> => [
    { id: 'popout', label: t('ui.dockPanel.undockPanel', 'Undock Panel'), onSelect: () => spawnPopout(tab.id) },
    { id: 'popout-frame', label: t('ui.dockPanel.undockFrame', 'Undock Frame'), onSelect: () => spawnPopoutGroup(group.panels) },
    ...(tab.closable ? [{ id: 'close', label: t('ui.dockPanel.closePanel', 'Close Panel'), onSelect: () => store().closePanel(tab.id) }] : []),
    ...(tabs.some((o) => o.id !== tab.id && o.closable)
      ? [{
          id: 'close-others',
          label: t('ui.dockPanel.closeOthers', 'Close Other Panels in Group'),
          onSelect: () => {
            for (const o of tabs) if (o.id !== tab.id && o.closable) store().closePanel(o.id);
          },
        }]
      : []),
    ...(tabs.some((o) => o.closable) ? [{ id: 'close-group', label: t('ui.dockPanel.closeFrame', 'Close Frame'), onSelect: () => store().closeGroup(group.id) }] : []),
    {
      id: 'maximize',
      label: maximized ? t('ui.dockPanel.restoreFrame', 'Restore Frame Size') : t('ui.dockPanel.maximizeFrame', 'Maximize Frame'),
      shortcut: '`',
      onSelect: () => {
        if (group.collapsed) store().setGroupCollapsed(group.id, false);
        store().toggleMaximizeGroup(group.id);
      },
    },
  ];

  /** Panel Group Settings — how the group sits in its column and side. */
  const groupVerbs = (tab: TabDescriptor): Array<{ id: string; label: string; onSelect: () => void }> => [
    {
      id: 'collapse',
      label: group.collapsed ? t('ui.dockPanel.expandGroup', 'Expand Group') : t('ui.dockPanel.collapseGroup', 'Collapse Group'),
      onSelect: () => store().toggleGroupCollapsed(group.id),
    },
    ...(hasGroupAbove ? [{ id: 'merge-up', label: t('ui.dockPanel.mergeUp', 'Merge with Group Above'), onSelect: () => store().mergeGroupUp(group.id) }] : []),
    ...(group.panels.length > 1
      ? [{ id: 'own-group', label: t('ui.dockPanel.newGroup', 'Move to New Group'), onSelect: () => store().dockDrop({ panel: tab.id }, { kind: 'split', side, column: group.column, index: columnIndex + 1 }) }]
      : []),
    { id: 'own-column', label: t('ui.dockPanel.newColumn', 'Move to New Column'), onSelect: () => store().dockDrop({ panel: tab.id }, { kind: 'column', side, column: group.column + (isLeft ? 1 : 0) }) },
    { id: 'move-side', label: otherLabel, onSelect: () => store().movePanel(tab.id, otherSide, 0) },
    {
      id: 'hide-side',
      label: isLeft ? t('ui.dockPanel.hideLeft', 'Hide Left Panels') : t('ui.dockPanel.hideRight', 'Hide Right Panels'),
      onSelect: () => store().setCollapsed(side, true),
    },
  ];

  /** Open a closed panel INTO this group, as a tab. */
  const openHere = (id: string): void => {
    store().openPanel(id);
    store().movePanelToGroup(id, group.id);
  };

  const menuItems = (): DropdownItem[] => {
    const items: DropdownItem[] = [];
    for (const v of panelVerbs(activeTab)) items.push({ type: 'item', id: v.id, label: v.label, onSelect: v.onSelect, ...(v.shortcut ? { shortcut: v.shortcut } : {}) });
    items.push({ type: 'separator' });
    items.push({
      type: 'item',
      id: 'group-settings',
      label: t('ui.dockPanel.groupSettings', 'Panel Group Settings'),
      submenu: groupVerbs(activeTab).map((v): DropdownItem => ({ type: 'item', id: v.id, label: v.label, onSelect: v.onSelect })),
    });
    const closed = closedPanelDefsForSide(side, store().panelOrder);
    if (closed.length > 0) {
      items.push({
        type: 'item',
        id: 'open-here',
        label: t('ui.dockPanel.openHere', 'Open Panel in This Group'),
        submenu: closed.map((def): DropdownItem => ({ type: 'item', id: `open-${def.id}`, label: def.title, icon: def.icon, onSelect: () => openHere(def.id) })),
      });
    }
    if (customItems.length > 0) items.push({ type: 'separator' }, { type: 'label', label: activeTab.label }, ...customItems);
    return items;
  };

  const onTabContextMenu = (tab: TabDescriptor) => (e: React.MouseEvent): void => {
    e.preventDefault();
    const entries: ContextMenuItem[] = [];
    for (const v of panelVerbs(tab)) {
      if (v.id === 'close') entries.push({ id: 'sep-close', separator: true });
      entries.push({ id: v.id, label: v.label, onSelect: v.onSelect });
    }
    entries.push({ id: 'sep-group', separator: true });
    for (const v of groupVerbs(tab)) entries.push({ id: v.id, label: v.label, onSelect: v.onSelect });
    openContextMenu(e.clientX, e.clientY, entries);
  };

  // ── Keyboard: the tablist pattern, plus Up / Down between groups ─────
  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Only this tablist's OWN tabs: a panel body may carry tabs of its own.
    if (!(e.target instanceof HTMLElement) || !e.target.hasAttribute('data-dock-tab')) return;
    const own = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-dock-tab]'));
    const current = own.findIndex((tabEl) => tabEl === document.activeElement);
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
    for (const tabEl of own) tabEl.tabIndex = tabEl === target ? 0 : -1;
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
      finishDrop(e, id, { kind: 'tabs', groupId: group.id, index: at });
    },
  };

  // ── The five drop zones over the group's body (After Effects) ────────
  const [zone, setZone] = useState<DropZone | null>(null);
  useEffect(() => {
    if (!dragging) setZone(null);
  }, [dragging]);
  /** Dropping on itself does nothing: no zones over the group being dragged, or a lone tab's own group. */
  const selfDrag = dragging === `${GROUP_DRAG_PREFIX}${group.id}` || (group.panels.length === 1 && dragging === group.panels[0]);
  const zoneTarget = (z: DropZone): DockDropTarget => {
    switch (z) {
      case 'center': return { kind: 'tabs', groupId: group.id };
      case 'top': return { kind: 'split', side, column: group.column, index: columnIndex };
      case 'bottom': return { kind: 'split', side, column: group.column, index: columnIndex + 1 };
      case 'left': return { kind: 'column', side, column: group.column };
      case 'right': return { kind: 'column', side, column: group.column + 1 };
    }
  };
  const zoneDrag = {
    onDragOver: (e: DragEvent<HTMLDivElement>): void => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const z = zoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
      if (z !== zone) setZone(z);
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>): void => {
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      setZone(null);
    },
    onDrop: (e: DragEvent<HTMLDivElement>): void => {
      e.preventDefault();
      const z = zoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
      setZone(null);
      finishDrop(e, draggedId(e), zoneTarget(z));
    },
  };

  // ── Maximize Frame: the group over the editor body ───────────────────
  const [maxBox, setMaxBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!maximized) {
      setMaxBox(null);
      return undefined;
    }
    const measureBody = (): void => {
      const body = document.querySelector<HTMLElement>('[data-dock-maximize-bounds]');
      const r = body?.getBoundingClientRect();
      setMaxBox(r ? { top: r.top, left: r.left, width: r.width, height: r.height } : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight });
    };
    measureBody();
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') store().toggleMaximizeGroup(null);
    };
    window.addEventListener('resize', measureBody);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', measureBody);
      window.removeEventListener('keydown', onKey);
    };
  }, [maximized, store]);
  useEffect(() => {
    if (!dragging) setDropAt(null);
  }, [dragging]);

  /** The tab the drop marker sits before (a dragged tab never marks itself). */
  const visibleTabs = tabs.filter((tab) => tab.id !== dragging);
  const markBefore = dropAt !== null ? visibleTabs[dropAt]?.id ?? null : null;
  const markAtEnd = dropAt !== null && dropAt >= visibleTabs.length;

  const title = group.collapsed
    ? t('ui.dockPanel.expandPanel', 'Expand {name}', { name: activeTab.label })
    : t('ui.dockPanel.collapsePanel', 'Collapse {name}', { name: activeTab.label });
  const closedAdd = closedDefs && closedDefs.length > 0 ? closedDefs : null;

  const maximizedStyle = maximized && maxBox
    ? { top: maxBox.top, left: maxBox.left, width: maxBox.width, height: maxBox.height }
    : undefined;
  const menu = (
    <Dropdown
      placement={edge === 'right' ? 'bottom-end' : 'bottom-start'}
      offset={{ x: 0, y: 4 }}
      noScroll
      trigger={
        <button type="button" className={styles.tabMenu} aria-label={t('ui.dockPanel.options', 'Panel options')} title={t('ui.dockPanel.options', 'Panel options')}>
          <Icon name="menu" size="sm" />
        </button>
      }
      items={menuItems}
    />
  );

  return (
    <section
      ref={(el) => bindEl(group.id, el)}
      className={cn(styles.group, group.collapsed && styles.groupCollapsed, focused && styles.groupFocused, maximized && styles.groupMaximized)}
      style={maximizedStyle ?? (group.collapsed ? undefined : { flexGrow: group.weight })}
      data-dock-group-id={group.id}
      aria-label={t('ui.dockPanel.groupLabel', '{names} panel group', { names: tabs.map((tab) => tab.label).join(', ') })}
    >
      <div className={cn(styles.strip, overflow.left && styles.stripMoreLeft, overflow.right && styles.stripMoreRight)} data-dock-strip="" {...stripDrag}>
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
            aria-label={isLeft
              ? t('ui.dockPanel.sidebarGroup', 'Sidebar panel group {n}', { n: index + 1 })
              : t('ui.dockPanel.inspectorGroup', 'Inspector panel group {n}', { n: index + 1 })}
            data-dock-group=""
            onKeyDown={onTabsKeyDown}
            onWheel={onWheel}
            onScroll={measure}
          >
            {tabs.map((tab) => {
              const isActive = tab.id === active;
              return (
                <div
                  key={tab.id}
                  data-dock-slot={tab.id}
                  className={cn(styles.slot, isActive && styles.slotActive, markBefore === tab.id && styles.dropBefore, dragging === tab.id && styles.slotDragging)}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    try { e.dataTransfer.setData('text/plain', tab.id); } catch { /* no payload: the shared value carries it */ }
                    beginDrag(tab.id);
                  }}
                  onDragEnd={onDockDragEnd}
                  onContextMenu={onTabContextMenu(tab)}
                >
                  {/* No grip or ✕ on the front tab: the tab itself drags, and
                      Close Panel is in its ≡ menu. */}
                  <button
                    type="button"
                    role="tab"
                    data-dock-tab=""
                    tabIndex={isActive ? 0 : -1}
                    aria-selected={isActive}
                    aria-label={tab.label}
                    title={isActive && titleDetail ? `${tab.label}: ${titleDetail}` : tab.label}
                    className={cn(styles.tab, isActive && styles.tabActive)}
                    onMouseDown={(e) => {
                      if (e.detail <= 1) collapsedAtPress.current = group.collapsed;
                    }}
                    onClick={() => show(tab.id)}
                    // The first click already opened a collapsed group, so a
                    // double-click flips the state the group had BEFORE it:
                    // collapsed → open (and stays open), open → collapsed.
                    onDoubleClick={() => store().setGroupCollapsed(group.id, !collapsedAtPress.current)}
                  >
                    <span className={styles.tabLabel}>
                      {tab.label}
                      {isActive && titleDetail ? <span className={styles.tabDetail}>: {titleDetail}</span> : null}
                    </span>
                  </button>
                  {isActive ? menu : null}
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
                <button type="button" className={cn(styles.iconBtn, styles.overflowBtn)} aria-label={t('ui.dockPanel.allPanels', 'All panels in this group')} title={t('ui.dockPanel.allPanels', 'All panels in this group')}>
                  »
                </button>
              }
              items={() => tabs.map((tab, i): DropdownItem => ({
                type: 'item',
                id: `tab-${tab.id}`,
                label: isHidden(i) ? t('ui.dockPanel.scrolledOut', '{name}  ·  scrolled out of view', { name: tab.label }) : tab.label,
                icon: tab.id === active ? 'check' : undefined,
                onSelect: () => show(tab.id),
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
                  aria-label={isLeft ? t('ui.dockPanel.openSidebarPanel', 'Open a sidebar panel') : t('ui.dockPanel.openInspectorPanel', 'Open an inspector panel')}
                  title={t('ui.dockPanel.openPanelTitle', 'Open panel')}
                >
                  <Icon name="plus" size="sm" />
                </button>
              }
              items={[
                { type: 'label', label: t('ui.dockPanel.openPanel', 'Open Panel') },
                ...closedAdd.map((def): DropdownItem => ({
                  type: 'item', id: `open-${def.id}`, label: def.title, icon: def.icon, onSelect: () => show(def.id),
                })),
              ]}
            />
          )}
          <span
            className={styles.groupGrip}
            draggable
            role="img"
            aria-label={t('ui.dockPanel.dragGroup', 'Drag to move the whole group')}
            title={t('ui.dockPanel.dragGroup', 'Drag to move the whole group')}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              const value = `${GROUP_DRAG_PREFIX}${group.id}`;
              try { e.dataTransfer.setData('text/plain', value); } catch { /* the shared value carries it */ }
              // The group's strip is what the pointer carries (After Effects drags the
              // frame). The grip itself is a few dots — as a drag image it came out
              // empty, and Chromium on Windows dropped the drag the moment it began.
              const strip = e.currentTarget.closest('section')?.querySelector<HTMLElement>('[data-dock-strip]');
              if (strip && typeof e.dataTransfer.setDragImage === 'function') e.dataTransfer.setDragImage(strip, 16, 12);
              beginDrag(value);
            }}
            onDragEnd={onDockDragEnd}
          />
        </div>
      </div>
      {!group.collapsed && (
        <DockPanelHeaderContext.Provider value={ctx}>
          <div className={styles.content} data-dock-panel={active ?? undefined}>{renderer ? renderer() : null}</div>
        </DockPanelHeaderContext.Provider>
      )}
      {dragging && !group.collapsed && !selfDrag && !maximized ? (
        <div className={styles.zones} data-dock-zones={group.id} {...zoneDrag}>
          <ZoneOverlay zone={zone} />
        </div>
      ) : null}
    </section>
  );
}
