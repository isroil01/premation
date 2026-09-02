/**
 * VersionHistoryPanel — browse and restore the current cloud project's saved
 * versions (autosave snapshots + manual checkpoints from motion-back).
 *
 * Opened from File → Version History (or the Command Palette). Lists newest
 * first, lets the user capture a named checkpoint, and restores any entry back
 * into the running editor via the server (which also rewinds the project head).
 */

import { useEffect, useState } from 'react';
import { Icon } from '@components/Icon';
import { Pagination } from '@components/Pagination';
import { EmptyState } from '@components/EmptyState';
import { cn } from '@utils/cn';
import { openModal } from '@stores/modalStore';
import { useVersionHistoryStore } from '@stores/versionHistoryStore';
import type { VersionKind } from '@core/api/client';
import styles from './VersionHistoryPanel.module.css';

const KIND_LABEL: Record<VersionKind, string> = {
  manual: 'Checkpoint',
  autosave: 'Autosave',
  recovery: 'Recovery',
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function VersionHistory(): JSX.Element {
  const { versions, total, limit, offset, status, error, restoringId, load, saveCheckpoint, restore } =
    useVersionHistoryStore();
  const [label, setLabel] = useState('');

  // Always open on page 1: the modal outlives its own state, so reopening it
  // after a week of autosaves would otherwise land on a page number from then.
  useEffect(() => {
    void load({ limit, offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const onSave = async (): Promise<void> => {
    await saveCheckpoint(label.trim() || undefined);
    setLabel('');
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.saveRow}>
        <input
          className={styles.input}
          placeholder="Name this checkpoint (optional)…"
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onSave();
          }}
        />
        <button type="button" className={styles.saveBtn} onClick={() => void onSave()}>
          <Icon name="marker" size="sm" />
          Save version
        </button>
      </div>

      {status === 'loading' && <p className={styles.note}>Loading history…</p>}
      {status === 'error' && <p className={styles.error}>{error}</p>}
      {status === 'ready' && versions.length === 0 && (
        <EmptyState
          icon="history"
          title="No versions yet"
          message="Autosave captures snapshots as you work — or name a checkpoint above to keep one deliberately."
        />
      )}

      <div className={styles.list}>
        {versions.map((v) => {
          const isRestoring = restoringId === v.id;
          return (
            <div key={v.id} className={styles.row}>
              <div className={cn(styles.badge, styles[`kind_${v.kind}`])}>
                {KIND_LABEL[v.kind] ?? v.kind}
              </div>
              <div className={styles.body}>
                <span className={styles.name}>
                  {v.label || `Revision ${v.revision}`}
                </span>
                <span className={styles.meta}>
                  {formatWhen(v.createdAt)} · rev {v.revision} · {v.time.toFixed(1)}s
                </span>
              </div>
              <button
                type="button"
                className={styles.restore}
                disabled={isRestoring}
                onClick={() => void restore(v.id)}
              >
                {isRestoring ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          );
        })}
      </div>

      <Pagination
        total={total}
        limit={limit}
        offset={offset}
        busy={status === 'loading'}
        onChange={(page) => void load(page)}
        itemLabel="version"
        pageSizes={[10, 20, 50]}
      />
    </div>
  );
}

export function openVersionHistory(): void {
  openModal({
    id: 'version-history',
    title: 'Version History',
    size: 'md',
    render: () => <VersionHistory />,
  });
}
