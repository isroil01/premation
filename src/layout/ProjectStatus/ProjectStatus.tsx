/**
 * ProjectStatus — which project is open, whether it has unsaved edits, and
 * how long ago it was last saved.
 *
 * The editor had no such indicator. `TitleBar.module.css` carried a fully
 * styled `.projectName` and `.dirtyDot` that no component ever rendered, so
 * there was nothing on screen naming the current project or showing that a save
 * had (or had not) landed. That is what let a Save which wrote nothing pass for
 * one: the toast said "Saved" and no other surface disagreed.
 *
 * Three sources, because they genuinely live apart: the name comes from the
 * ProjectManager, the unsaved marker from the active workspace tab — the flag
 * `hasUnsavedChanges` and the discard prompt read — and the last-saved time
 * from the `ProjectSaved` event the manager emits after a successful write.
 *
 * Mounted in the Electron title bar centre AND in the web TopNav centre.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { onCoreServicesReady, tryCoreServices } from '@core/services/coreServices';
import { getEventBus } from '@core/events/EventBus';
import { useProjectStore } from '@stores/projectStore';
import styles from './ProjectStatus.module.css';

/** Module-level so a remount (route change, pop-out) does not forget it. */
let lastSavedAt: number | null = null;

/** "just now", "3m ago", "2h ago" — coarse on purpose; this is a glance, not a log. */
export function formatAgo(savedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - savedAt) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Split a name for a MIDDLE ellipsis: CSS can only truncate an end, so the
 * name is drawn as a shrinkable head plus a fixed tail. Short names stay whole
 * (an ellipsis inside "Untitled" would be noise).
 */
export function splitForMiddleEllipsis(name: string, tailLength = 8, minLength = 20): [head: string, tail: string] {
  const chars = [...name]; // by code point — never cut a surrogate pair in half
  if (chars.length < minLength) return [name, ''];
  return [chars.slice(0, -tailLength).join(''), chars.slice(-tailLength).join('')];
}

function useLastSaved(): number | null {
  const [at, setAt] = useState<number | null>(lastSavedAt);
  useEffect(() => {
    const sub = getEventBus().on('ProjectSaved', () => {
      lastSavedAt = Date.now();
      setAt(lastSavedAt);
    });
    return () => sub.dispose();
  }, []);
  // Tick once a minute so "3m ago" ages without any other state change.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [at]);
  return at;
}

export function ProjectStatus({ compact = false }: { compact?: boolean }): JSX.Element {
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
  const savedAt = useLastSaved();

  const name = current?.name;
  const ago = savedAt !== null ? formatAgo(savedAt, Date.now()) : null;
  // Always carries the FULL name: the chip truncates, and this is where the
  // rest of it can still be read.
  const title = current?.path
    ? `${name} — ${current.path}${dirty ? ' (unsaved changes)' : ''}${ago ? ` · saved ${ago}` : ''}`
    : `${name ? `${name} — ` : ''}Not saved yet — Save will ask where to put it`;
  const [head, tail] = splitForMiddleEllipsis(name ?? 'No project');

  return (
    <div className={compact ? `${styles.status} ${styles.compact}` : styles.status} title={title}>
      <span className={name ? styles.name : `${styles.name} ${styles.unnamed}`}>
        <span className={styles.nameHead}>{head}</span>
        {tail ? <span className={styles.nameTail}>{tail}</span> : null}
      </span>
      {/* Decorative: the accessible statement is the `title` above, so a screen
          reader gets "unsaved changes" as words rather than a bare dot. */}
      {dirty ? <span className={styles.dirtyDot} aria-hidden /> : null}
      {ago && !compact ? <span className={styles.saved}>{dirty ? `saved ${ago}` : ago}</span> : null}
    </div>
  );
}

export default ProjectStatus;
