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
 * ── Finding one ──────────────────────────────────────────────────────────
 * Search matches the name or the path; sort is by last opened (the MRU order)
 * or by name; a PIN keeps a project at the top through both. Pins live in the
 * preference store (`pinnedProjects`, by path) rather than in the MRU, which
 * is rewritten by every open and would lose them. The Templates row is the
 * third way in: a new project built from one of the shipped templates.
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getRecentProjects, getProjectManager } from '@core/services/coreServices';
import type { RecentProjectEntry } from '@core/project/RecentProjects';
import { openProjectPath } from '@core/project/openProjectPath';
import { bundleDirPickerAvailable, chooseBundleDir } from '@core/project/bundle/bundleProjectIO';
import { getLocalIndex } from '@core/localIndex/LocalIndex';
import type { ProjectIndexRow } from '@core/localIndex/types';
import { thumbUrl } from '@core/localIndex/thumbCache';
import { isLocalFirst } from '@core/config/flags';
import { TEMPLATES } from '@core/template/registry';
import { ProjectCommands } from '@layout/Menu';
import { useAssetStore } from '@stores/assetStore';
import { useTemplateStore } from '@stores/templateStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { createCompositionFromFootage } from '@core/composition/compositionOps';
import { asCommandId } from '@app-types/common';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { Segmented } from '@components/Segmented';
import { EmptyState } from '@components/EmptyState';
import { cn } from '@utils/cn';
import { useUIStore } from '@stores/uiStore';
import { useOnboardingStore } from '@stores/onboardingStore';
import { noteNextProjectSource } from '@core/analytics/productEvents';
import styles from './StartScreen.module.css';

/** One card: an index row, an MRU entry, or both — joined on the path. */
export interface ProjectCardModel {
  /** The path is the identity; it is also the open argument. */
  path: string;
  name: string;
  /** MRU id, when the MRU knows this path (drives Remove). */
  recentId?: string;
  row?: ProjectIndexRow;
  /** Epoch ms of the last open, from whichever source knows it. */
  openedAt: number;
}

export type StartSort = 'recent' | 'name';

/**
 * Filter, then order: pinned first (in the chosen order among themselves),
 * then the rest. Pure, so the ordering rules can be pinned by a test without
 * the index or the MRU.
 */
export function arrangeCards(
  cards: ReadonlyArray<ProjectCardModel>,
  opts: { query: string; sort: StartSort; pinned: ReadonlyArray<string> },
): ProjectCardModel[] {
  const q = opts.query.trim().toLowerCase();
  const pinned = new Set(opts.pinned);
  const kept = q
    ? cards.filter((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q))
    : [...cards];
  const by = (a: ProjectCardModel, b: ProjectCardModel): number =>
    opts.sort === 'name'
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path)
      : b.openedAt - a.openedAt || a.name.localeCompare(b.name);
  return kept.sort((a, b) => {
    const pa = pinned.has(a.path) ? 0 : 1;
    const pb = pinned.has(b.path) ? 0 : 1;
    return pa - pb || by(a, b);
  });
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
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<StartSort>('recent');
  const pinned = usePreferenceStore((s) => s.pinnedProjects);
  const setPref = usePreferenceStore((s) => s.set);

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
    // A removed project's pin would otherwise outlive it in the preferences.
    if (pinned.includes(card.path)) setPref('pinnedProjects', pinned.filter((p) => p !== card.path));
  }, [pinned, setPref]);

  const togglePin = useCallback((path: string) => {
    setPref('pinnedProjects', pinned.includes(path) ? pinned.filter((p) => p !== path) : [...pinned, path]);
  }, [pinned, setPref]);

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

  /** New project, then the template built into it — the gallery's own flow, from the start. */
  const newFromTemplate = useCallback(async (templateId: string) => {
    noteNextProjectSource('template');
    await getCommandSystem().execute(asCommandId(ProjectCommands.New));
    // New can be declined (the unsaved-changes confirmation).
    if (!getProjectManager().getState().current) return;
    useTemplateStore.getState().apply(templateId);
    onDismiss();
  }, [onDismiss]);

  /** Desktop only: a `.motion` bundle folder, straight to the bundle loader. */
  const openFolder = useCallback(async () => {
    const dir = await chooseBundleDir();
    if (!dir) return;
    setBusy(dir);
    try {
      const ref = await openProjectPath(dir);
      if (ref) {
        onDismiss();
        return;
      }
      useUIStore.getState().notify({
        level: 'error',
        message: `“${dir}” is not a project bundle.`,
        durationMs: 4000,
      });
    } finally {
      setBusy(null);
    }
  }, [onDismiss]);

  // Join: index rows first (already MRU-ordered by openedAt/updatedAt), then
  // MRU-only paths the index has never seen.
  const cards = useMemo((): ProjectCardModel[] => {
    const recentByPath = new Map<string, RecentProjectEntry>();
    for (const r of recents) if (r.path) recentByPath.set(r.path, r);
    const out: ProjectCardModel[] = rows.map((row) => {
      const mru = recentByPath.get(row.bundlePath);
      return {
        path: row.bundlePath,
        name: row.name,
        row,
        openedAt: Math.max(mru?.openedAt ?? 0, row.openedAt ?? 0, row.updatedAt ?? 0),
        ...(mru ? { recentId: mru.id } : {}),
      };
    });
    const indexed = new Set(rows.map((r) => r.bundlePath));
    for (const r of recents) {
      if (r.path && !indexed.has(r.path)) {
        out.push({ path: r.path, name: r.name, recentId: r.id, openedAt: r.openedAt });
      }
    }
    return out;
  }, [rows, recents]);

  const shown = useMemo(() => arrangeCards(cards, { query, sort, pinned }), [cards, query, sort, pinned]);
  const searching = query.trim().length > 0;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Open a project">
      <div className={styles.panel}>
        <div className={styles.head}>
          <h1 className={styles.title}>Premation</h1>
          <p className={styles.subtitle}>Open a recent project, or start a new one.</p>
        </div>

        <div className={styles.actions}>
          <Button variant="primary" onClick={() => void run(ProjectCommands.New)}>New Project</Button>
          {/* AE's second way in, visible at the start: new project, then the
              picked clip imports and the comp conforms to it (size, duration,
              probed fps) via the same createCompositionFromFootage the Assets
              panel uses. */}
          <Button
            variant="secondary"
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = 'video/*,.mp4,.mov,.webm,.m4v,.mxf,.avi,.mts,.m2ts,.mpg,.wmv,.mkv';
              input.onchange = async () => {
                const f = input.files?.[0];
                if (!f) return;
                await run(ProjectCommands.New);
                // New can be declined (the unsaved-changes confirmation) —
                // importing into no project would drop the clip on the floor.
                if (!getProjectManager().getState().current) return;
                const asset = await useAssetStore.getState().addAsset(f);
                await createCompositionFromFootage(asset);
              };
              input.click();
            }}
          >
            New from Video…
          </Button>
          <Button variant="secondary" onClick={() => void run(ProjectCommands.Open)}>Open…</Button>
          {bundleDirPickerAvailable() ? (
            <Button
              variant="secondary"
              leftIcon={<Icon name="folder-open" size="sm" />}
              onClick={() => void openFolder()}
              disabled={busy !== null}
              title="Open a .motion project folder"
            >
              Open folder…
            </Button>
          ) : null}
        </div>

        <div className={styles.sectionLabel}>Templates</div>
        <div className={styles.templates} role="list" aria-label="Templates">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="listitem"
              className={styles.template}
              onClick={() => void newFromTemplate(t.id)}
              title={t.description ?? `New project from ${t.name}`}
            >
              <span className={styles.templateArt} aria-hidden>
                <Icon name="sparkles" size="sm" />
              </span>
              <span className={styles.templateName}>{t.name}</span>
              {t.aspect ? <span className={styles.templateMeta}>{t.aspect}</span> : null}
            </button>
          ))}
        </div>

        <div className={styles.recentHead}>
          <div className={styles.sectionLabel}>Recent</div>
          <div className={styles.recentTools}>
            <Input
              size="sm"
              leftIcon="search"
              placeholder="Search projects…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              clearable
              onClear={() => setQuery('')}
              aria-label="Search projects"
            />
            <Segmented<StartSort>
              size="sm"
              aria-label="Sort projects"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'recent', label: 'Recent' },
                { value: 'name', label: 'Name' },
              ]}
            />
          </div>
        </div>

        <div className={styles.grid}>
          {shown.length === 0 && (
            <div className={styles.emptyWrap}>
              {searching ? (
                <EmptyState
                  icon="search"
                  title="No projects match"
                  message={`Nothing named or filed under “${query.trim()}”.`}
                  action={{ label: 'Clear search', onClick: () => setQuery('') }}
                  compact
                />
              ) : (
                <EmptyState
                  icon="folder"
                  title="Nothing yet"
                  message="Projects you open or save appear here."
                  action={{ label: 'New Project', onClick: () => void run(ProjectCommands.New) }}
                  compact
                />
              )}
            </div>
          )}
          {shown.map((card) => {
            const gone = missing.has(card.path) || card.row?.missing === true;
            const facts = card.row ? factsLine(card.row) : null;
            const isPinned = pinned.includes(card.path);
            return (
              <div key={card.path} className={cn(styles.card, isPinned && styles.cardPinned)}>
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
                <div className={styles.cardTools}>
                  <button
                    type="button"
                    className={cn(styles.pin, isPinned && styles.pinOn)}
                    aria-pressed={isPinned}
                    aria-label={isPinned ? `Unpin ${card.name}` : `Pin ${card.name}`}
                    title={isPinned ? 'Unpin' : 'Pin to the top'}
                    onClick={() => togglePin(card.path)}
                  >
                    <Icon name="star" size="sm" />
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
              </div>
            );
          })}
        </div>

        <div className={styles.footerRow}>
          <button type="button" className={styles.dismiss} onClick={onDismiss}>
            Continue without a project
          </button>
          {/* The tour runs OVER the editor and spotlights real controls, so it
              cannot start while this screen covers them — dismiss first, then
              start. Same `start()` the Help menu calls; it always runs when a
              person asks for it, regardless of the first-run flag. */}
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => {
              onDismiss();
              useOnboardingStore.getState().start();
            }}
          >
            Take the tour
          </button>
        </div>
      </div>
    </div>
  );
}
