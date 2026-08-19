/**
 * StartScreen — the local edition's "which project" surface.
 *
 * The OSS edition opened straight into an untitled scene with no way to reach
 * yesterday's work except the Open dialog and a remembered folder path. The MRU
 * behind this has existed and been persisted the whole time (`RecentProjects`,
 * written on every open and save-as); nothing rendered it.
 *
 * ── Two sources, one list ────────────────────────────────────────────────
 * Cards come from the LOCAL INDEX first (SQLite on desktop — comp facts,
 * save revision, thumbnail hash, written on every bundle save/open by
 * indexWriter) and from the MRU for anything the index doesn't know
 * (pre-index history, packed .motion files). Same identity key: the path.
 * The index read is gated on LOCAL_FIRST because only bundle saves write it —
 * without the flag the list is exactly the MRU it always was.
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
import { getLocalIndex } from '@core/localIndex/LocalIndex';
import type { ProjectIndexRow } from '@core/localIndex/types';
import { thumbUrl } from '@core/localIndex/thumbCache';
import { isLocalFirst } from '@core/config/flags';
import { ProjectCommands } from '@layout/Menu';
import { asCommandId } from '@app-types/common';
import { Button } from '@components/Button';
import { useUIStore } from '@stores/uiStore';
import styles from './StartScreen.module.css';

/** One card: an index row, an MRU entry, or both — joined on the path. */
interface ProjectCardModel {
  /** The path is the identity; it is also the open argument. */
  path: string;
  name: string;
  /** MRU id, when the MRU knows this path (drives Remove). */
  recentId?: string;
  row?: ProjectIndexRow;
}

function factsLine(row: ProjectIndexRow): string | null {
  if (!row.width || !row.height) return null;
  const parts = [`${row.width}×${row.height}`];
  if (row.fps > 0) parts.push(`${row.fps}fps`);
  if (row.durationSeconds > 0) parts.push(`${Math.round(row.durationSeconds * 10) / 10}s`);
  parts.push(`${row.layerCount} layer${row.layerCount === 1 ? '' : 's'}`);
  if (row.rev > 0) parts.push(`v${row.rev}`);
  return parts.join(' · ');
}

/** The card's picture, resolved from the content-addressed cache. Absent
 *  hash or browser tab → facts-only card, no broken image box. */
function CardThumb({ hash, name }: { hash: string; name: string }): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void thumbUrl(hash).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [hash]);
  if (!url) return null;
  return <img className={styles.thumb} src={url} alt={`${name} thumbnail`} />;
}

export function StartScreen({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  const [recents, setRecents] = useState<RecentProjectEntry[]>(() => getRecentProjects().list());
  const [rows, setRows] = useState<ProjectIndexRow[]>([]);
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [busy, setBusy] = useState<string | null>(null);

  const refreshRows = useCallback(() => {
    // Only bundle saves write the index, and those are LOCAL_FIRST-gated —
    // without the flag this read could only ever return [].
    if (!isLocalFirst()) return;
    void getLocalIndex()
      .listProjects({ limit: 40 })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(refreshRows, [refreshRows]);

  // The MRU is observable, so a New/Open performed from the menu while this is
  // up keeps the list honest rather than showing a snapshot from mount. Every
  // MRU write is also a moment the index may have changed (opens and save-as
  // both touch both stores), so the rows refresh on the same signal.
  useEffect(
    () =>
      getRecentProjects().subscribe((list) => {
        setRecents(list);
        refreshRows();
      }),
    [refreshRows],
  );

  const openCard = useCallback(async (card: ProjectCardModel) => {
    setBusy(card.path);
    try {
      const ref = await openProjectPath(card.path);
      if (ref) {
        onDismiss();
        return;
      }
      // Mark the card rather than raise a toast: the failure is ABOUT this
      // card, and the user's next move is to remove it or pick another. The
      // index remembers, so next launch says so without another failed open.
      setMissing((prev) => new Set(prev).add(card.path));
      if (card.row) void getLocalIndex().markMissing(card.row.id, true);
    } catch (err) {
      setMissing((prev) => new Set(prev).add(card.path));
      if (card.row) void getLocalIndex().markMissing(card.row.id, true);
      useUIStore.getState().notify({
        level: 'error',
        message: `Couldn't open “${card.name}”: ${(err as Error).message}`,
        durationMs: 4000,
      });
    } finally {
      setBusy(null);
    }
  }, [onDismiss]);

  const removeCard = useCallback((card: ProjectCardModel) => {
    if (card.recentId) getRecentProjects().remove(card.recentId);
    if (card.row) void getLocalIndex().removeProject(card.row.id);
    setRecents(getRecentProjects().list());
    setRows((prev) => prev.filter((r) => r.bundlePath !== card.path));
  }, []);

  const run = useCallback(async (commandId: string) => {
    // Reuse the real commands rather than re-implementing New/Open here — they
    // carry the unsaved-changes confirmation, the bundle-vs-file routing and
    // the notifications, none of which should exist twice.
    await getCommandSystem().execute(asCommandId(commandId));
    if (getProjectManager().getState().current) {
      onDismiss();
      return;
    }
    refreshRows();
  }, [onDismiss, refreshRows]);

  // Join: index rows first (already MRU-ordered by openedAt/updatedAt), then
  // MRU-only paths the index has never seen.
  const recentByPath = new Map<string, RecentProjectEntry>();
  for (const r of recents) if (r.path) recentByPath.set(r.path, r);
  const cards: ProjectCardModel[] = rows.map((row) => ({
    path: row.bundlePath,
    name: row.name,
    row,
    ...(recentByPath.get(row.bundlePath) ? { recentId: recentByPath.get(row.bundlePath)!.id } : {}),
  }));
  const indexed = new Set(rows.map((r) => r.bundlePath));
  for (const r of recents) {
    if (r.path && !indexed.has(r.path)) {
      cards.push({ path: r.path, name: r.name, recentId: r.id });
    }
  }

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
        <div className={styles.grid}>
          {cards.length === 0 && (
            <div className={styles.empty}>
              Nothing yet. Projects you open or save appear here.
            </div>
          )}
          {cards.map((card) => {
            const gone = missing.has(card.path) || card.row?.missing === true;
            const facts = card.row ? factsLine(card.row) : null;
            return (
              <div key={card.path} className={styles.card}>
                <button
                  type="button"
                  className={styles.cardBody}
                  disabled={busy !== null || gone}
                  onClick={() => void openCard(card)}
                >
                  {card.row?.thumbHash ? (
                    <CardThumb hash={card.row.thumbHash} name={card.name} />
                  ) : null}
                  <span className={styles.name}>{card.name}</span>
                  {facts && <span className={styles.facts}>{facts}</span>}
                  <span className={`${styles.path} ${gone ? styles.missing : ''}`}>
                    {gone ? 'Missing — moved or deleted' : card.path}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove ${card.name} from recent projects`}
                  onClick={() => removeCard(card)}
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
