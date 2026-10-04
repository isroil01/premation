/**
 * HistoryPanel — Photoshop-style visual history.
 *
 * Lists every recorded state oldest → newest with the current one highlighted
 * and future (redoable) states dimmed. Click a row to jump there
 * (non-destructive). Double-click a label to rename it ("Client v1 look").
 * The camera button pins a named snapshot of the current state.
 */

import { useState, useEffect } from 'react';
import { Icon } from '@components/Icon';
import { EmptyState } from '@components/EmptyState';
import { cn } from '@utils/cn';
import { historyView, performJumpTo, subscribeHistory } from '@stores/historyStore';
import { engine } from '@core/engine/engineInstance';
import styles from './HistoryPanel.module.css';

/**
 * Names given to rows this session ("Client v1 look"). The engine's entries
 * carry their command label only, so a rename is the page's: keyed by the
 * row and its label, so another entry landing at that row does not inherit it.
 */
const renamed = new Map<string, string>();
const renameKey = (i: number, label: string): string => `${i}\u0000${label}`;

export function HistoryPanel(): JSX.Element {
  const [view, setView] = useState(historyView);
  useEffect(() => subscribeHistory(() => setView(historyView())), []);
  const [, setRenames] = useState(0);
  const index = view.index;
  const entries = view.entries.map((e, i) => {
    const name = renamed.get(renameKey(i, e.label));
    return { label: name ?? e.label, named: name !== undefined || e.label === 'Snapshot', raw: e.label };
  });

  const jumpTo = (i: number) => performJumpTo(i);

  const rename = (i: number, label: string) => {
    const raw = entries[i]?.raw;
    if (raw === undefined) return;
    renamed.set(renameKey(i, raw), label);
    setRenames((n) => n + 1);
  };
  // "Snapshot current state": a named entry that changes nothing (B3z `addHistoryCheckpoint`).
  const snapshot = (): void => { void engine().execute({ type: 'addHistoryCheckpoint', label: 'Snapshot' }); };

  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const commitRename = (i: number): void => {
    const label = draft.trim();
    if (label) rename(i, label);
    setEditing(null);
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>History</span>
        <button
          type="button"
          className={styles.snapshot}
          title="Snapshot current state"
          aria-label="Snapshot current state"
          onClick={snapshot}
        >
          <Icon name="marker" size="sm" />
        </button>
      </div>

      <div className={styles.list} role="listbox" aria-label="History states">
        {entries.length === 0 ? (
          <EmptyState
            icon="undo"
            title="Nothing to undo yet"
            message="Every edit lands here as a state you can click back to — including the ones you have already undone."
            action={{ label: 'Snapshot current state', onClick: snapshot }}
          />
        ) : (
          entries.map((e, i) => {
            const isCurrent = i === index;
            const isFuture = i > index;
            return (
              <div
                key={i}
                role="option"
                aria-selected={isCurrent}
                tabIndex={isCurrent ? 0 : -1}
                className={cn(styles.row, isCurrent && styles.rowCurrent, isFuture && styles.rowFuture)}
                onClick={() => jumpTo(i)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    jumpTo(i);
                  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Home' || ev.key === 'End') {
                    ev.preventDefault();
                    const last = entries.length - 1;
                    const to = ev.key === 'Home' ? 0
                      : ev.key === 'End' ? last
                      : Math.max(0, Math.min(last, i + (ev.key === 'ArrowDown' ? 1 : -1)));
                    const rows = ev.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="option"]');
                    rows?.[to]?.focus();
                  }
                }}
              >
                <Icon
                  name={e.named ? 'marker' : 'keyframe'}
                  size="sm"
                  className={cn(styles.rowIcon, e.named && styles.rowIconNamed)}
                />
                {editing === i ? (
                  <input
                    className={styles.renameInput}
                    value={draft}
                    autoFocus
                    spellCheck={false}
                    onClick={(ev) => ev.stopPropagation()}
                    onChange={(ev) => setDraft(ev.currentTarget.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') commitRename(i);
                      else if (ev.key === 'Escape') setEditing(null);
                    }}
                    onBlur={() => commitRename(i)}
                  />
                ) : (
                  <span
                    className={styles.rowLabel}
                    onDoubleClick={(ev) => {
                      ev.stopPropagation();
                      setDraft(e.label);
                      setEditing(i);
                    }}
                  >
                    {e.label}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default HistoryPanel;
