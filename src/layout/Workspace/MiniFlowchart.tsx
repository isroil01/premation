/**
 * MiniFlowchart — After Effects' Composition Mini-Flowchart.
 *
 * A transient control for moving around a composition network: the comp in
 * view in the middle, the comps it is placed in (downstream) on the left and
 * the comps placed in it (upstream) on the right, arrows running the way the
 * pixels flow — the same "Flow Right To Left" order as the Composition
 * Navigator bar. A comp used several times is one entry with its count.
 *
 * AE's keys: arrows move, Enter opens, S switches the upstream sort between
 * name and layer order, Esc (or Tab again, or a click outside) closes. The
 * popup takes focus and CLAIMS those chords (`data-shortcut-claim`): the global
 * shortcut dispatcher runs first on every key, and Esc would otherwise deselect,
 * S pick a tool and Tab close the sidebars underneath it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useDismissOnOutside } from '@hooks/useDismissOnOutside';
import { useMiniFlowchartStore } from '@stores/miniFlowchartStore';
import { useProjectStore } from '@stores/projectStore';
import { useMirrorRevision } from '@hooks/useMirror';
import { compNetworkOf, type NetworkEntry, type UpstreamSort } from '@core/composition/compNetwork';
import { openContainingComposition, openLayerComposition } from '@core/composition/compNavigation';
import styles from './MiniFlowchart.module.css';

type Column = 'down' | 'up';

const CLAIMED = 'arrowup arrowdown arrowleft arrowright enter escape tab s Shift+s';

export function MiniFlowchart(): JSX.Element | null {
  const open = useMiniFlowchartStore((s) => s.open);
  const hide = useMiniFlowchartStore((s) => s.hide);
  const compId = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined));
  // Any document revision can change the network (compNetworkOf walks the scene).
  const rev = useMirrorRevision();
  const [sort, setSort] = useState<UpstreamSort>('name');
  const [sel, setSel] = useState<{ col: Column; i: number }>({ col: 'up', i: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  const net = useMemo(
    () => (open && compId ? compNetworkOf(compId, sort) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, compId, sort, rev],
  );

  // Start on the side that has something, and take focus so the keys land here.
  useEffect(() => {
    if (!open) return;
    const n = compId ? compNetworkOf(compId) : null;
    setSel({ col: n && n.upstream.length === 0 && n.downstream.length > 0 ? 'down' : 'up', i: 0 });
    requestAnimationFrame(() => rootRef.current?.focus());
  }, [open, compId]);

  useDismissOnOutside(open, [rootRef], hide);

  const activate = useCallback((col: Column, entry: NetworkEntry | undefined): void => {
    if (!entry) return;
    hide();
    const via = entry.layerIds[0];
    if (!via) return;
    if (col === 'up') openLayerComposition(via);
    else openContainingComposition(entry.compId, via);
  }, [hide]);

  if (!open || !net) return null;

  const lists: Record<Column, NetworkEntry[]> = { down: net.downstream, up: net.upstream };
  const current = lists[sel.col];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const move = (col: Column, i: number): void => {
      const list = lists[col];
      if (list.length === 0) return;
      setSel({ col, i: Math.max(0, Math.min(list.length - 1, i)) });
    };
    switch (e.key) {
      case 'ArrowUp': move(sel.col, sel.i - 1); break;
      case 'ArrowDown': move(sel.col, sel.i + 1); break;
      case 'ArrowLeft': move('down', sel.col === 'down' ? sel.i : 0); break;
      case 'ArrowRight': move('up', sel.col === 'up' ? sel.i : 0); break;
      case 'Enter':
      case ' ':
        activate(sel.col, current[sel.i]);
        break;
      case 'Escape':
      case 'Tab':
        hide();
        break;
      case 's':
      case 'S':
        setSort((s) => (s === 'name' ? 'layer' : 'name'));
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const column = (col: Column, label: string, empty: string): JSX.Element => (
    <div className={styles.column} role="group" aria-label={label}>
      <span className={styles.columnLabel}>{label}</span>
      {lists[col].length === 0 ? (
        <span className={styles.empty}>{empty}</span>
      ) : (
        lists[col].map((entry, i) => (
          <button
            key={entry.compId}
            type="button"
            className={cn(styles.entry, sel.col === col && sel.i === i && styles.entrySelected)}
            onMouseEnter={() => setSel({ col, i })}
            onClick={() => activate(col, entry)}
            title={col === 'up' ? `Open ${entry.name}` : `Open ${entry.name}, which contains ${net.name}`}
          >
            <Icon name="layers" size="sm" />
            <span className={styles.entryName}>{entry.name}</span>
            {entry.layerIds.length > 1 ? <span className={styles.count}>({entry.layerIds.length})</span> : null}
          </button>
        ))
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={styles.root}
      role="dialog"
      aria-label="Composition Mini-Flowchart"
      tabIndex={-1}
      data-shortcut-claim={CLAIMED}
      onKeyDown={onKeyDown}
    >
      <div className={styles.flow}>
        {column('down', 'Contains this', 'Not placed in any composition')}
        <Icon name="chevron-left" size="sm" className={styles.arrow} />
        <div className={styles.current}>
          <span className={styles.columnLabel}>Composition</span>
          <span className={styles.currentName}>{net.name}</span>
        </div>
        <Icon name="chevron-left" size="sm" className={styles.arrow} />
        {column('up', 'Nested in this', 'No compositions inside')}
      </div>
      <div className={styles.hint}>
        ↑↓←→ move · Enter open · S sort by {sort === 'name' ? 'layer order' : 'name'} · Esc close
      </div>
    </div>
  );
}

export default MiniFlowchart;
