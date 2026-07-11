/**
 * HistoryPanel — Photoshop-style visual history (spec §Trust Infrastructure).
 *
 * Lists every recorded state oldest → newest with the current one highlighted
 * and future (redoable) states dimmed. Click a row to jump there
 * (non-destructive). Double-click a label to rename it ("Client v1 look").
 * The camera button pins a named snapshot of the current state.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { EmptyState } from '@components/EmptyState';
import { cn } from '@utils/cn';
import { useHistoryStore } from '@stores/historyStore';
import styles from './HistoryPanel.module.css';

export function HistoryPanel(): JSX.Element {
  const entries = useHistoryStore((s) => s.entries);
  const index = useHistoryStore((s) => s.index);
  const jumpTo = useHistoryStore((s) => s.jumpTo);
  const rename = useHistoryStore((s) => s.rename);
  const record = useHistoryStore((s) => s.record);

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
          onClick={() => record('Snapshot', true)}
        >
          <Icon name="marker" size={13} />
        </button>
      </div>

      <div className={styles.list} role="listbox" aria-label="History states">
        {entries.length === 0 ? (
          <EmptyState icon="undo" message="No history yet — edits will appear here." />
        ) : (
          entries.map((e, i) => {
            const isCurrent = i === index;
            const isFuture = i > index;
            return (
              <div
                key={e.id}
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
                  size={13}
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
