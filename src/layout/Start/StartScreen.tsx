/**
 * StartScreen — the local edition's "which project" surface.
 *
 * The OSS edition opened straight into an untitled scene with no way to reach
 * yesterday's work except the Open dialog and a remembered folder path. The MRU
 * behind this has existed and been persisted the whole time (`RecentProjects`,
 * written on every open and save-as); nothing rendered it.
 *
 * ── Why it lives INSIDE the editor route ────────────────────────────────
 * Opening a project is `openPath` + a viewport bump + a history re-baseline,
 * and all three need a booted engine. A browser mounted before Providers would
 * have to defer the actual open into the editor anyway, so it would be a
 * navigation pretending to be a load. This mounts behind Providers, over the
 * editor, and opens directly.
 *
 * ── Why it is not a modal ───────────────────────────────────────────────
 * There is nothing behind it to interact with yet. A dialog implies a document
 * underneath that you are choosing to ignore; this is the state before there is
 * one.
 *
 * It is deliberately dismissible. Somebody who just wants to start moving
 * shapes without naming a project should not have to name a project — the
 * editor works perfectly well with `current === null`, which is exactly how it
 * behaved before this screen existed.
 */

import { useCallback, useEffect, useState } from 'react';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getRecentProjects, getProjectManager } from '@core/services/coreServices';
import type { RecentProjectEntry } from '@core/project/RecentProjects';
import { openProjectPath } from '@core/project/openProjectPath';
import { ProjectCommands } from '@layout/Menu';
import { asCommandId } from '@app-types/common';
import { Button } from '@components/Button';
import { useUIStore } from '@stores/uiStore';
import styles from './StartScreen.module.css';

/** A recent whose bundle no longer opens, so the row can say so instead of
 *  failing silently the next time it is clicked. */
type Missing = ReadonlySet<string>;

export function StartScreen({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  const [recents, setRecents] = useState<RecentProjectEntry[]>(() => getRecentProjects().list());
  const [missing, setMissing] = useState<Missing>(() => new Set<string>());
  const [busy, setBusy] = useState<string | null>(null);

  // The MRU is observable, so a New/Open performed from the menu while this is
  // up keeps the list honest rather than showing a snapshot from mount.
  useEffect(() => getRecentProjects().subscribe(setRecents), []);

  const openRecent = useCallback(async (entry: RecentProjectEntry) => {
    if (!entry.path) return;
    setBusy(entry.id);
    try {
      const ref = await openProjectPath(entry.path);
      if (ref) {
        onDismiss();
        return;
      }
      // Mark the row rather than raise a toast: the failure is ABOUT this row,
      // and the user's next move is to remove it or pick another.
      setMissing((prev) => new Set(prev).add(entry.id));
    } catch (err) {
      setMissing((prev) => new Set(prev).add(entry.id));
      useUIStore.getState().notify({
        level: 'error',
        message: `Couldn't open “${entry.name}”: ${(err as Error).message}`,
        durationMs: 4000,
      });
    } finally {
      setBusy(null);
    }
  }, [onDismiss]);

  const run = useCallback(async (commandId: string) => {
    // Reuse the real commands rather than re-implementing New/Open here — they
    // carry the unsaved-changes confirmation, the bundle-vs-file routing and
    // the notifications, none of which should exist twice.
    await getCommandSystem().execute(asCommandId(commandId));
    if (getProjectManager().getState().current) onDismiss();
  }, [onDismiss]);

  const withPath = recents.filter((r) => !!r.path);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Open a project">
      <div className={styles.panel}>
        <div className={styles.head}>
          <h1 className={styles.title}>Premation</h1>
          <p className={styles.subtitle}>Open a recent project, or start a new one.</p>
        </div>

        <div className={styles.actions}>
          <Button variant="primary" onClick={() => void run(ProjectCommands.New)}>New Project</Button>
          <Button variant="secondary" onClick={() => void run(ProjectCommands.Open)}>Open…</Button>
        </div>

        <div className={styles.sectionLabel}>Recent</div>
        <div className={styles.list}>
          {withPath.length === 0 && (
            <div className={styles.empty}>
              Nothing yet. Projects you open or save appear here.
            </div>
          )}
          {withPath.map((entry) => {
            const gone = missing.has(entry.id);
            return (
              <div key={entry.id} className={styles.row}>
                <button
                  type="button"
                  className={styles.rowText}
                  style={{ background: 'none', border: 0, padding: 0, cursor: gone ? 'default' : 'pointer' }}
                  disabled={busy !== null || gone}
                  onClick={() => void openRecent(entry)}
                >
                  <span className={styles.name}>{entry.name}</span>
                  <span className={`${styles.path} ${gone ? styles.missing : ''}`}>
                    {gone ? 'Missing — moved or deleted' : entry.path}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove ${entry.name} from recent projects`}
                  onClick={() => {
                    getRecentProjects().remove(entry.id);
                    setRecents(getRecentProjects().list());
                  }}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>

        <button type="button" className={styles.dismiss} onClick={onDismiss}>
          Continue without a project
        </button>
      </div>
    </div>
  );
}
