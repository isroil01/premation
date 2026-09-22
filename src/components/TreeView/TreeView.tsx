/**
 * TreeView — generic, virtualized tree of nodes.
 *
 * Renders only the visible scroll window (± overscan) so a composition with
 * thousands of layers stays interactive. Collapse still filters the flat list;
 * virtualization then windows that list. Keyboard navigation scrolls the
 * focused row into view when it sits outside the painted window.
 *
 * Selection: controlled `selectedIds`. Multi-select with Ctrl/Shift, by mouse
 * and by keyboard (Shift+Arrow extends, Ctrl+A selects all).
 *
 * Keyboard: Arrow Up/Down move, Arrow Right expands, Arrow Left collapses,
 * Home/End jump to first/last, Enter toggles expand, F2 renames, Delete
 * removes, Space selects.
 *
 * ── Drag ──────────────────────────────────────────────────────────────
 * A drag carries the whole SELECTION when the row it started on is part of it,
 * and just that row otherwise — the rule every other multi-row gesture in this
 * app follows. It used to carry one id no matter what, so selecting five layers
 * and dragging them into a group moved one and left four behind.
 *
 * Dragging near the top or bottom edge scrolls the list, because a virtualized
 * list is exactly the case where the drop target is usually off screen; and the
 * area BELOW the last row is a drop zone of its own, which is how you move a
 * layer back out to the root without having a root row to aim at.
 *
 * ── Accessibility ─────────────────────────────────────────────────────
 * One tab stop (the tree), `aria-activedescendant` naming the focused row, and
 * the disclosure triangle is a real button. Rows previously each carried their
 * own tabIndex and the triangle was a `<span>` with an onClick — so the only
 * way down a 200-layer tree was 200 Tab presses, and the triangle could not be
 * operated or announced at all.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '@utils/cn';
import { Icon, type IconName } from '@components/Icon';
import styles from './TreeView.module.css';

/** Matches `--control-height-row` (26px). Fixed for O(1) window math. */
export const ROW_HEIGHT = 26;
const OVERSCAN = 8;
/** How close to an edge a drag has to get before the list scrolls, and by how
 *  much per frame. Slow enough to aim with, fast enough to cross a long list. */
const AUTOSCROLL_EDGE = 28;
const AUTOSCROLL_STEP = 10;

export interface TreeNode<T> {
  id: string;
  label: ReactNode;
  /**
   * The plain-text name behind `label`.
   *
   * `label` may be a ReactNode — a host that dims hidden rows or badges
   * plugin-managed ones wraps it in an element — and the inline rename field
   * has to be seeded with TEXT. It used to fall back to `''` for any non-string
   * label, so renaming a hidden layer opened an empty box, and an empty box
   * commits as a cancel: the rename silently did nothing. Hosts that pass a
   * plain string label need not set this.
   */
  name?: string;
  icon?: IconName;
  /** Optional icon color. */
  iconColor?: string;
  /** Optional label color — renders a small color dot before the label. */
  labelColor?: string;
  /** Optional thumbnail (image URL) drawn in place of the kind glyph. */
  thumbnail?: string;
  children?: ReadonlyArray<TreeNode<T>>;
  hasChildren?: boolean;
  /** When true, this branch is lazy-loaded by the parent engine. */
  lazy?: boolean;
  data?: T;
}

export interface TreeViewProps<T> {
  nodes: ReadonlyArray<TreeNode<T>>;
  selectedIds?: ReadonlyArray<string>;
  onSelect?: (ids: ReadonlyArray<string>) => void;
  defaultExpandedIds?: ReadonlyArray<string>;
  expandedIds?: ReadonlyArray<string>;
  onToggleExpand?: (id: string, expanded: boolean) => void;
  /**
   * Branches to force open, so a row the host just made relevant is actually on
   * screen. Merged INTO the expansion set rather than replacing it, and only
   * when the array's identity changes — so it opens a branch once and never
   * fights the user re-closing it.
   *
   * Exists because a collapsed branch hides its contents completely: parenting
   * a layer under a Null that had no children until that moment moved the layer
   * into a branch that renders shut, and the layer simply vanished from the
   * panel. Pass the new parent's ancestor chain and it stays visible.
   */
  revealIds?: ReadonlyArray<string>;
  /**
   * A row to scroll into view. Unlike `revealIds` this does not change the
   * expansion set — pass both when the row may also be inside a shut branch.
   */
  scrollToId?: string;
  /** Render extra UI on the right of a row (badges, drag handles,...). */
  renderActions?: (node: TreeNode<T>) => ReactNode;
  /** Render UI between the disclosure triangle and the glyph (a pick-whip). */
  renderLead?: (node: TreeNode<T>) => ReactNode;
  /** Right-click a row. Receives the node id and the mouse event. */
  onNodeContextMenu?: (id: string, e: React.MouseEvent) => void;
  /**
   * Enables drag-to-reorder/reparent. Called on drop with EVERY dragged row (a
   * multi-selection drags as one), the row dropped onto, and where relative to
   * it. `targetId` is null for a drop on the empty space below the list, which
   * means "out to the root".
   */
  onReorder?: (dragIds: ReadonlyArray<string>, targetId: string | null, pos: 'before' | 'after' | 'inside') => void;
  /** Id of the row currently being renamed (inline edit). */
  renamingId?: string;
  /** Commit an inline rename. */
  onRename?: (id: string, name: string) => void;
  /** Cancel the inline rename (Escape / blur with empty value). */
  onRenameCancel?: () => void;
  /** F2 / double-click on a row asks the host to start a rename. */
  onRenameRequest?: (id: string) => void;
  /** Delete pressed with rows selected. */
  onDelete?: (ids: ReadonlyArray<string>) => void;
  /** Double-click a row (after `onRenameRequest` has had its chance). */
  onActivate?: (id: string) => void;
  className?: string;
  /** Indent step in px. */
  indent?: number;
  /** Row height in px. Must match what the host's CSS draws or the virtual
   *  window and the painted rows disagree. */
  rowHeight?: number;
  /** Accessible name for the tree itself. */
  ariaLabel?: string;
}

interface FlatRow<T> {
  node: TreeNode<T>;
  depth: number;
  isLast: boolean;
  hasChildren: boolean;
  expanded: boolean;
}

function flatten<T>(
  nodes: ReadonlyArray<TreeNode<T>>,
  expanded: ReadonlySet<string>,
  depth: number,
): FlatRow<T>[] {
  const rows: FlatRow<T>[] = [];
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;
    const hasChildren = (node.children && node.children.length > 0) || node.hasChildren || !!node.lazy;
    const expandedNow = expanded.has(node.id) && hasChildren;
    rows.push({ node, depth, isLast, hasChildren, expanded: expandedNow });
    if (expandedNow && node.children) {
      rows.push(...flatten(node.children, expanded, depth + 1));
    }
  });
  return rows;
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/** The text to seed a rename field with — see `TreeNode.name`. */
export function renameSeed<T>(node: TreeNode<T>): string {
  if (typeof node.name === 'string') return node.name;
  if (typeof node.label === 'string') return node.label;
  return '';
}

export function TreeView<T = unknown>({
  nodes,
  selectedIds,
  onSelect,
  defaultExpandedIds,
  expandedIds,
  onToggleExpand,
  revealIds,
  scrollToId,
  renderActions,
  renderLead,
  onNodeContextMenu,
  onReorder,
  renamingId,
  onRename,
  onRenameCancel,
  onRenameRequest,
  onDelete,
  onActivate,
  className,
  indent = 16,
  rowHeight = ROW_HEIGHT,
  ariaLabel,
}: TreeViewProps<T>): JSX.Element {
  const dragIds = useRef<ReadonlyArray<string>>([]);
  const [dropTarget, setDropTarget] = useState<{ id: string | null; pos: 'before' | 'after' | 'inside' } | null>(null);
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(
    () => new Set(defaultExpandedIds ?? []),
  );
  const expandedSet = useMemo<Set<string>>(
    () => (expandedIds ? new Set(expandedIds) : internalExpanded),
    [expandedIds, internalExpanded],
  );

  // Open whatever the host asked to reveal. Keyed on the array's identity, so a
  // host that hands over the same request twice does not re-open a branch the
  // user has since closed. No-ops while `expandedIds` drives the tree — a fully
  // controlled caller owns its own reveal.
  useEffect(() => {
    if (expandedIds || !revealIds?.length) return;
    setInternalExpanded((prev) => {
      if (revealIds.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of revealIds) next.add(id);
      return next;
    });
  }, [revealIds, expandedIds]);
  const [internalSelected, setInternalSelected] = useState<ReadonlyArray<string>>([]);
  const selected = selectedIds ?? internalSelected;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const lastSelected = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const flat = useMemo(
    () => flatten(nodes, expandedSet, 0),
    [nodes, expandedSet],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalHeight = flat.length * rowHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const endIndex = Math.min(
    flat.length,
    Math.ceil((scrollTop + Math.max(viewportHeight, rowHeight)) / rowHeight) + OVERSCAN,
  );
  const visibleRows = useMemo(
    () => flat.slice(startIndex, endIndex),
    [flat, startIndex, endIndex],
  );

  const setSelected = useCallback(
    (ids: ReadonlyArray<string>) => {
      if (!selectedIds) setInternalSelected(ids);
      onSelect?.(ids);
    },
    [selectedIds, onSelect],
  );

  const toggle = useCallback(
    (id: string, force?: boolean) => {
      const next = new Set(expandedSet);
      const willExpand = force ?? !next.has(id);
      if (willExpand) next.add(id);
      else next.delete(id);
      if (expandedIds === undefined) setInternalExpanded(next);
      onToggleExpand?.(id, willExpand);
    },
    [expandedSet, expandedIds, onToggleExpand],
  );

  /** Scroll the virtual window so row `idx` is painted. */
  const scrollIndexIntoView = useCallback(
    (idx: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rowTop = idx * rowHeight;
      const rowBottom = rowTop + rowHeight;
      if (rowTop < el.scrollTop) el.scrollTop = rowTop;
      else if (rowBottom > el.scrollTop + el.clientHeight) {
        el.scrollTop = rowBottom - el.clientHeight;
      }
    },
    [rowHeight],
  );

  const focusRow = useCallback(
    (i: number): FlatRow<T> | null => {
      const idx = Math.max(0, Math.min(i, flat.length - 1));
      const row = flat[idx];
      if (!row) return null;
      setActiveId(row.node.id);
      scrollIndexIntoView(idx);
      requestAnimationFrame(() => {
        const target = containerRef.current?.querySelector<HTMLElement>(
          `[data-id="${cssEscape(row.node.id)}"]`,
        );
        target?.focus();
      });
      return row;
    },
    [flat, scrollIndexIntoView],
  );

  /*
    Scroll a row the HOST asked for into view — a selection made somewhere else
    (the viewport, the timeline, a command) points at a layer this tree may have
    scrolled a thousand rows away from. Without this the tree simply did not
    react to selection it did not originate, which is the one thing a layer list
    is for.
  */
  useEffect(() => {
    if (!scrollToId) return;
    const idx = flat.findIndex((r) => r.node.id === scrollToId);
    if (idx < 0) return;
    setActiveId(scrollToId);
    scrollIndexIntoView(idx);
    // `flat` changes identity on every expansion or node change; keying on it
    // would re-scroll on unrelated edits and fight the user's own scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToId]);

  /** Rows between two ids in display order, inclusive. */
  const rangeBetween = useCallback(
    (fromId: string, toId: string): string[] => {
      const i1 = flat.findIndex((r) => r.node.id === fromId);
      const i2 = flat.findIndex((r) => r.node.id === toId);
      if (i1 < 0 || i2 < 0) return [toId];
      const [a, b] = i1 < i2 ? [i1, i2] : [i2, i1];
      return flat.slice(a, b + 1).map((r) => r.node.id);
    },
    [flat],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Ctrl+A is about the whole list, so it does not need a focused row.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(flat.map((r) => r.node.id));
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const id = active?.dataset.id ?? activeId;
    if (!id) return;
    const idx = flat.findIndex((r) => r.node.id === id);
    if (idx < 0) return;
    const row = flat[idx]!;

    /** Move, extending the selection when Shift is held (AE / Finder). */
    const move = (to: number): void => {
      const landed = focusRow(to);
      if (!landed) return;
      if (e.shiftKey) {
        const anchor = lastSelected.current ?? row.node.id;
        setSelected(rangeBetween(anchor, landed.node.id));
      } else {
        setSelected([landed.node.id]);
        lastSelected.current = landed.node.id;
      }
    };

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(idx + 1); break;
      case 'ArrowUp':   e.preventDefault(); move(idx - 1); break;
      case 'Home':      e.preventDefault(); move(0); break;
      case 'End':       e.preventDefault(); move(flat.length - 1); break;
      case 'ArrowRight':
        e.preventDefault();
        if (row.hasChildren) {
          if (!row.expanded) toggle(row.node.id, true);
          else focusRow(idx + 1);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (row.expanded) toggle(row.node.id, false);
        else if (row.depth > 0) {
          for (let i = idx - 1; i >= 0; i--) {
            const r = flat[i];
            if (r && r.depth === row.depth - 1) { focusRow(i); break; }
          }
        }
        break;
      case 'Enter':
        e.preventDefault();
        toggle(row.node.id);
        break;
      case 'F2':
        // AE and every file manager: F2 renames the focused row.
        if (onRenameRequest) { e.preventDefault(); onRenameRequest(row.node.id); }
        break;
      case 'Delete':
      case 'Backspace':
        if (onDelete) {
          e.preventDefault();
          onDelete(selected.length > 0 ? selected : [row.node.id]);
        }
        break;
      case ' ':
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const set = new Set(selected);
          if (set.has(row.node.id)) set.delete(row.node.id);
          else set.add(row.node.id);
          setSelected(Array.from(set));
        } else {
          setSelected([row.node.id]);
        }
        lastSelected.current = row.node.id;
        break;
    }
  };

  const onRowClick = (e: React.MouseEvent, id: string): void => {
    setActiveId(id);
    if (e.ctrlKey || e.metaKey) {
      const set = new Set(selected);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      setSelected(Array.from(set));
      lastSelected.current = id;
    } else if (e.shiftKey && lastSelected.current) {
      setSelected(rangeBetween(lastSelected.current, id));
    } else {
      setSelected([id]);
      lastSelected.current = id;
    }
  };

  /*
    Autoscroll while dragging near an edge. Native HTML drag gives no pointer
    stream of its own once the drag image is up, so this runs off `dragover`
    (which does fire continuously) and steps the scroll by a fixed amount —
    a rAF loop would keep scrolling after the cursor left the edge.
  */
  const autoscroll = (clientY: number): void => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (clientY - r.top < AUTOSCROLL_EDGE) el.scrollTop -= AUTOSCROLL_STEP;
    else if (r.bottom - clientY < AUTOSCROLL_EDGE) el.scrollTop += AUTOSCROLL_STEP;
  };

  const beginDrag = (e: React.DragEvent, id: string): void => {
    // The selection when this row is part of it, this row alone otherwise.
    const ids = selectedSet.has(id) ? [...selected] : [id];
    dragIds.current = ids;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ids.join(','));
  };

  const endDrag = (): void => {
    dragIds.current = [];
    setDropTarget(null);
  };

  const commitDrop = (targetId: string | null, pos: 'before' | 'after' | 'inside'): void => {
    const src = dragIds.current;
    endDrag();
    if (!onReorder || src.length === 0) return;
    if (targetId !== null && src.includes(targetId)) return;
    onReorder(src, targetId, pos);
  };

  return (
    <div
      ref={containerRef}
      role="tree"
      tabIndex={0}
      aria-multiselectable
      aria-label={ariaLabel}
      aria-activedescendant={activeId ? `tv-${activeId}` : undefined}
      className={cn(styles.root, className)}
      onKeyDown={onKeyDown}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      /*
        The space under the last row is the "out to the root" drop zone. Without
        it there is no gesture for un-parenting a layer in a tree whose root
        rows may all be scrolled away — you had to find a sibling of the root
        and drop beside it.
      */
      onDragOver={
        onReorder
          ? (e) => {
              if (dragIds.current.length === 0) return;
              autoscroll(e.clientY);
              // Only claim the drop when the cursor is past the painted rows;
              // a row under the cursor handles its own dragover and stops here.
              if (e.target !== e.currentTarget) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropTarget({ id: null, pos: 'inside' });
            }
          : undefined
      }
      onDrop={
        onReorder
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              e.preventDefault();
              commitDrop(null, 'inside');
            }
          : undefined
      }
      onDragLeave={onReorder ? (e) => { if (e.target === e.currentTarget) setDropTarget(null); } : undefined}
      data-root-drop={dropTarget && dropTarget.id === null ? '' : undefined}
    >
      <div className={styles.virtualSpacer} style={{ height: totalHeight }}>
        {visibleRows.map((row, vi) => {
          const i = startIndex + vi;
          const isSelected = selectedSet.has(row.node.id);
          const isActive = activeId ? row.node.id === activeId : i === 0;
          const isDragging = dragIds.current.includes(row.node.id);
          return (
            <div
              key={row.node.id}
              id={`tv-${row.node.id}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              /* Roving tab stop: the tree is the single stop, arrows move
                 within it. Every row being `tabIndex={0}` made Tab the only
                 way down a list that can be thousands of rows long. */
              tabIndex={isActive ? 0 : -1}
              data-id={row.node.id}
              data-focused={isActive || undefined}
              data-selected={isSelected || undefined}
              data-dragging={isDragging || undefined}
              data-drop={dropTarget?.id === row.node.id ? dropTarget.pos : undefined}
              draggable={onReorder ? renamingId !== row.node.id : undefined}
              className={cn(styles.row, styles.virtualRow, isSelected && styles.selected)}
              style={{
                paddingLeft: 8 + row.depth * indent,
                top: i * rowHeight,
                height: rowHeight,
              }}
              onClick={(e) => onRowClick(e, row.node.id)}
              /*
                Double-click renames, as it does in AE's timeline and in every
                file manager; it used to toggle the branch, which the triangle
                and Enter both already do. Hosts with no rename fall back to the
                old toggle so a plain tree still discloses on double-click.
              */
              onDoubleClick={() => {
                if (onRenameRequest) onRenameRequest(row.node.id);
                else if (onActivate) onActivate(row.node.id);
                else toggle(row.node.id);
              }}
              onContextMenu={
                onNodeContextMenu
                  ? (e) => {
                      e.preventDefault();
                      setActiveId(row.node.id);
                      if (!selectedSet.has(row.node.id)) setSelected([row.node.id]);
                      onNodeContextMenu(row.node.id, e);
                    }
                  : undefined
              }
              onDragStart={onReorder ? (e) => beginDrag(e, row.node.id) : undefined}
              onDragOver={
                onReorder
                  ? (e) => {
                      if (dragIds.current.length === 0) return;
                      autoscroll(e.clientY);
                      if (dragIds.current.includes(row.node.id)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'move';
                      const r = e.currentTarget.getBoundingClientRect();
                      const frac = (e.clientY - r.top) / r.height;
                      const pos = frac < 0.3 ? 'before' : frac > 0.7 ? 'after' : 'inside';
                      setDropTarget({ id: row.node.id, pos });
                    }
                  : undefined
              }
              onDragLeave={
                onReorder
                  ? () => setDropTarget((d) => (d?.id === row.node.id ? null : d))
                  : undefined
              }
              onDrop={
                onReorder
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const t = dropTarget;
                      commitDrop(t?.id ?? row.node.id, t?.pos ?? 'inside');
                    }
                  : undefined
              }
              onDragEnd={onReorder ? endDrag : undefined}
            >
              {row.hasChildren ? (
                <button
                  type="button"
                  className={styles.chevron}
                  aria-label={row.expanded ? 'Collapse' : 'Expand'}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(row.node.id);
                  }}
                >
                  <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} size="sm" />
                </button>
              ) : (
                <span className={styles.chevron} aria-hidden="true" />
              )}
              {renderLead ? (
                <span className={styles.lead} onClick={(e) => e.stopPropagation()}>
                  {renderLead(row.node)}
                </span>
              ) : null}
              {row.node.thumbnail ? (
                <img className={styles.thumb} src={row.node.thumbnail} alt="" aria-hidden="true" draggable={false} />
              ) : row.node.icon ? (
                <Icon
                  name={row.node.icon}
                  size="sm"
                  className={styles.icon}
                  style={row.node.iconColor ? { color: row.node.iconColor } : undefined}
                />
              ) : null}
              {row.node.labelColor ? (
                <span
                  className={styles.labelDot}
                  style={{ backgroundColor: row.node.labelColor }}
                  aria-hidden="true"
                />
              ) : null}
              {renamingId === row.node.id && onRename ? (
                <input
                  className={styles.renameInput}
                  autoFocus
                  aria-label="Rename"
                  defaultValue={renameSeed(row.node)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      const v = e.currentTarget.value.trim();
                      if (v) onRename(row.node.id, v);
                      else onRenameCancel?.();
                    } else if (e.key === 'Escape') {
                      onRenameCancel?.();
                    }
                  }}
                  onBlur={(e) => {
                    const v = e.currentTarget.value.trim();
                    if (v) onRename(row.node.id, v);
                    else onRenameCancel?.();
                  }}
                />
              ) : (
                // `title`: the label ellipsizes, and this is where the rest of
                // a long name can still be read.
                <span className={styles.label} title={renameSeed(row.node) || undefined}>{row.node.label}</span>
              )}
              {renderActions ? (
                <span className={styles.actions} onClick={(e) => e.stopPropagation()}>
                  {renderActions(row.node)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
