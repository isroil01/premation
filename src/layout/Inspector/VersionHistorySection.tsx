/**
 * VersionHistorySection — local-first version history.
 *
 * A self-contained inspector section that lists the `.motion` bundle's version
 * snapshots and lets the user save a named version or restore an older one. All
 * behaviour comes from the tested `useProjectVersions` hook; this is pure
 * presentation. Renders nothing unless LOCAL_FIRST is on and a bundle is open,
 * so it is safe to mount unconditionally.
 *
 * ## Not the same thing as `VersionHistoryPanel`
 *
 * `@layout/History/VersionHistoryPanel` is the CLOUD history: it reads
 * `versionHistoryStore`, which talks to motion-back, and it lists autosaves and
 * checkpoints the server holds. This reads the `.motion` BUNDLE on disk through
 * `@core/project/bundle/*`. In a local-first build with no cloud project the
 * panel has nothing to show and this has everything — which is why deleting
 * this as a duplicate would have deleted the only local surface for the
 * content-addressed version store that already exists and is already tested.
 *
 * It is project-scoped rather than layer-scoped, so its registry row ignores
 * the `nodeId` every other section is keyed on. `versionHistoryAvailable`
 * keeps that from being noise: outside a local-first bundle the row is not
 * offered at all.
 */

import { getProjectManager } from '@core/services/coreServices';
import { isLocalFirst } from '@core/config/flags';
import { isBundlePath } from '@core/project/bundle/bundleProjectIO';
import { useProjectVersions } from '@hooks/useProjectVersions';
import { useUIStore } from '@stores/uiStore';
import styles from './VersionHistorySection.module.css';

/**
 * Whether local bundle versions exist to show — the registry's `appliesTo`.
 *
 * Deliberately the same two conditions `useProjectVersions` uses for
 * `available`, and it lives beside the section for the reason
 * `hasMaterialSection` and `hasAudioDriverSection` do: the list of sections and
 * the section itself must not be able to disagree about whether it applies.
 */
export function versionHistoryAvailable(): boolean {
  if (!isLocalFirst()) return false;
  const path = getProjectManager().getState().current?.path ?? null;
  return !!path && isBundlePath(path);
}

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
