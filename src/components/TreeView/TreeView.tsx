/**
 * TreeView — generic, virtualized tree of nodes.
 *
 * Optimized for thousands of nodes by collapsing the rendered output to the
 * visible set (filtered by collapsed ancestors). Uses CSS variables for
 * indent so the rendering layer stays in the design system.
 *
 * Selection: controlled `selectedIds`. Multi-select with Ctrl/Shift.
 * Keyboard: Arrow Up/Down move, Arrow Right expands, Arrow Left collapses,
 * Home/End jump to first/last, Enter toggles expand.
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

export interface TreeNode<T> {
  id: string;
  label: ReactNode;
  icon?: IconName;
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
  /** Render extra UI on the right of a row (badges, drag handles, ...). */
  renderActions?: (node: TreeNode<T>) => ReactNode;
  /** Right-click a row. Receives the node id and the mouse event. */
  onNodeContextMenu?: (id: string, e: React.MouseEvent) => void;
  className?: string;
  /** Indent step in px. */
  indent?: number;
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

export function TreeView<T = unknown>({
  nodes,
  selectedIds,
  onSelect,
  defaultExpandedIds,
  expandedIds,
  onToggleExpand,
  renderActions,
  onNodeContextMenu,
  className,
  indent = 16,
}: TreeViewProps<T>): JSX.Element {
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(
    () => new Set(defaultExpandedIds ?? []),
  );
  const expandedSet = useMemo<Set<string>>(
    () => (expandedIds ? new Set(expandedIds) : internalExpanded),
    [expandedIds, internalExpanded],
  );
  const [internalSelected, setInternalSelected] = useState<ReadonlyArray<string>>([]);
  const selected = selectedIds ?? internalSelected;
  const lastSelected = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const flat = useMemo(
    () => flatten(nodes, expandedSet, 0),
    [nodes, expandedSet],
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

  const focusRow = useCallback(
    (i: number) => {
      const row = flat[Math.max(0, Math.min(i, flat.length - 1))];
      if (!row || !containerRef.current) return;
      const el = containerRef.current.querySelector<HTMLElement>(`[data-id="${cssEscape(row.node.id)}"]`);
      el?.focus();
    },
    [flat],
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const focused = containerRef.current.querySelector<HTMLElement>(`[data-focused="true"]`);
    if (focused && document.activeElement === containerRef.current) {
      focused.focus();
    }
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    const id = active.dataset.id;
    if (!id) return;
    const idx = flat.findIndex((r) => r.node.id === id);
    if (idx < 0) return;
    const row = flat[idx]!;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusRow(idx + 1); break;
      case 'ArrowUp':   e.preventDefault(); focusRow(idx - 1); break;
      case 'Home':      e.preventDefault(); focusRow(0); break;
      case 'End':       e.preventDefault(); focusRow(flat.length - 1); break;
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
      case ' ':
        e.preventDefault();
        setSelected([row.node.id]);
        lastSelected.current = row.node.id;
        break;
    }
  };

  const onRowClick = (e: React.MouseEvent, id: string): void => {
    if (e.ctrlKey || e.metaKey) {
      const set = new Set(selected);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      setSelected(Array.from(set));
      lastSelected.current = id;
    } else if (e.shiftKey && lastSelected.current) {
      const idx1 = flat.findIndex((r) => r.node.id === lastSelected.current);
      const idx2 = flat.findIndex((r) => r.node.id === id);
      if (idx1 >= 0 && idx2 >= 0) {
        const [a, b] = idx1 < idx2 ? [idx1, idx2] : [idx2, idx1];
        const range = flat.slice(a, b + 1).map((r) => r.node.id);
        setSelected(range);
      }
    } else {
      setSelected([id]);
      lastSelected.current = id;
    }
  };

  return (
    <div
      ref={containerRef}
      role="tree"
      tabIndex={0}
      aria-multiselectable
      className={cn(styles.root, className)}
      onKeyDown={onKeyDown}
    >
      {flat.map((row, i) => {
        const isSelected = selected.includes(row.node.id);
        const isDefaultFocus = (!lastSelected.current && i === 0) || row.node.id === lastSelected.current;
        return (
          <div
            key={row.node.id}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={isSelected}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            tabIndex={isDefaultFocus ? 0 : -1}
            data-id={row.node.id}
            data-focused={isDefaultFocus || undefined}
            data-selected={isSelected || undefined}
            className={cn(styles.row, isSelected && styles.selected)}
            style={{ paddingLeft: 8 + row.depth * indent }}
            onClick={(e) => onRowClick(e, row.node.id)}
            onDoubleClick={() => toggle(row.node.id)}
            onContextMenu={
              onNodeContextMenu
                ? (e) => {
                    e.preventDefault();
                    if (!selected.includes(row.node.id)) setSelected([row.node.id]);
                    onNodeContextMenu(row.node.id, e);
                  }
                : undefined
            }
          >
            <span
              className={styles.chevron}
              onClick={
                row.hasChildren
                  ? (e) => {
                      e.stopPropagation();
                      toggle(row.node.id);
                    }
                  : undefined
              }
            >
              {row.hasChildren ? (
                <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} size={12} />
              ) : null}
            </span>
            {row.node.icon ? <Icon name={row.node.icon} size={14} className={styles.icon} /> : null}
            <span className={styles.label}>{row.node.label}</span>
            {renderActions ? (
              <span className={styles.actions} onClick={(e) => e.stopPropagation()}>
                {renderActions(row.node)}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
