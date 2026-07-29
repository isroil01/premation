/**
 * VersionHistorySection — local-first version history.
 *
 * A self-contained inspector section that lists the `.motion` bundle's version
 * snapshots and lets the user save a named version or restore an older one. All
 * behaviour comes from the tested `useProjectVersions` hook; this is pure
 * presentation. Renders nothing unless LOCAL_FIRST is on and a bundle is open,
 * so it is safe to mount unconditionally.
 */

import { useProjectVersions } from '@hooks/useProjectVersions';
import { useUIStore } from '@stores/uiStore';
import styles from './VersionHistorySection.module.css';

function formatWhen(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

export function VersionHistorySection(): JSX.Element | null {
  const { available, versions, loading, saveVersion, restore } = useProjectVersions();
  const notify = useUIStore((s) => s.notify);

  if (!available) return null;

  const onRestore = async (rev: number, label: string): Promise<void> => {
    const ok = await restore(rev);
    if (ok) notify({ level: 'success', message: `Restored ${label}`, durationMs: 2000 });
    else notify({ level: 'warning', message: `Could not restore ${label}`, durationMs: 2500 });
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span>Version History</span>
        <button
          type="button"
          className={styles.saveBtn}
          onClick={() => void saveVersion()}
          title="Snapshot the current state as a version"
        >
          Save version
        </button>
      </div>

      {loading ? (
        <div className={styles.empty}>Loading…</div>
      ) : versions.length === 0 ? (
        <div className={styles.empty}>No versions yet — save one to start history.</div>
      ) : (
        <div className={styles.list}>
          {versions.map((v) => (
            <div key={v.rev} className={styles.row}>
              <div className={styles.meta}>
                <span className={styles.label}>{v.label ?? `Version ${v.rev}`}</span>
                <span className={styles.sub}>
                  <span className={styles.kind}>{v.kind}</span> · {formatWhen(v.createdAt)}
                </span>
              </div>
              <button
                type="button"
                className={styles.restore}
                onClick={() => void onRestore(v.rev, v.label ?? `Version ${v.rev}`)}
                title={`Restore version ${v.rev}`}
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
