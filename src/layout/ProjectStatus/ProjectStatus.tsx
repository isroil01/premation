/**
 * ProjectStatus — which project is open, and whether it has unsaved edits.
 *
 * The editor had no such indicator. `TitleBar.module.css` carried a fully
 * styled `.projectName` and `.dirtyDot` that no component ever rendered, so
 * there was nothing on screen naming the current project or showing that a save
 * had (or had not) landed. That is what let a Save which wrote nothing pass for
 * one: the toast said "Saved" and no other surface disagreed.
 *
 * Two sources, because the project's identity and its dirty flag genuinely live
 * apart: the name comes from the ProjectManager, and the unsaved marker from
 * the active workspace tab — the flag `hasUnsavedChanges` and the discard
 * prompt read.
 */

import { useSyncExternalStore } from 'react';
import { onCoreServicesReady, tryCoreServices } from '@core/services/coreServices';
import { useProjectStore } from '@stores/projectStore';
import styles from './ProjectStatus.module.css';

export function ProjectStatus(): JSX.Element {
  /*
    TOLERATES AN UNBOOTED CORE, and must.

    `TitleBar` renders OUTSIDE the Providers boot gate — `AppRouter` mounts it
    above `<Routes>`, so it paints on every route including `/editor`, where the
    core is booted by a provider further down the tree. `getProjectManager()`
    throws when nothing has registered yet ("Core services not registered"), and
    `useSyncExternalStore` reads its snapshot DURING RENDER, so the first paint
    of the editor took that throw before the provider had a chance to run.

    `tryCoreServices` is the non-throwing peek this exact situation exists for
    (see its docstring). The subscription then upgrades itself: it listens for
    the core becoming ready, and swaps onto the real ProjectManager the moment
    it is, so a project opened later still updates this indicator.
  */
  const current = useSyncExternalStore(
    (cb) => {
      let unsubscribe = tryCoreServices()?.project.subscribe(cb);
      const unsubscribeReady = onCoreServicesReady((refs) => {
        unsubscribe?.();
        unsubscribe = refs.project.subscribe(cb);
        cb(); // the snapshot changed from "no core" to the real project
      });
      return () => {
        unsubscribe?.();
        unsubscribeReady();
      };
    },
    () => tryCoreServices()?.project.getState().current ?? null,
  );
  const dirty = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.dirty === true : false));

  const name = current?.name;
  const title = current?.path
    ? `${name} — ${current.path}${dirty ? ' (unsaved changes)' : ''}`
    : 'Not saved yet — Save will ask where to put it';

  return (
    <div className={styles.status} title={title}>
      <span className={name ? styles.name : `${styles.name} ${styles.unnamed}`}>
        {name ?? 'No project'}
      </span>
      {/* Decorative: the accessible statement is the `title` above, so a screen
          reader gets "unsaved changes" as words rather than a bare dot. */}
      {dirty ? <span className={styles.dirtyDot} aria-hidden /> : null}
    </div>
  );
}

export default ProjectStatus;
