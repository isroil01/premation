/**
 * MediaBrowser — the Assets panel's Media Browser tab (id `browse`): a folder on disk, listed
 * lazily, whose media rows can be dragged straight into the composition.
 *
 * Premiere's Media Browser is the model. Import without an OS dialog: pick a
 * folder once, then drag from it. Every row is a path until the moment it is
 * used — nothing is copied into the project for browsing, only for a drop,
 * a double-click or an explicit Import.
 *
 * ── Drag, and what happens on drop ──────────────────────────────────────────
 * A row's drag carries a `mediaFile` payload (`core/dnd/canvasDrag`) with a
 * PRE-MINTED asset id. The viewport accepts the drag (it carries the shared
 * MIME) but does not yet know this kind, so on `dragend` — which fires on the
 * source after the drop, with `dropEffect` saying whether anything took it —
 * the row imports the file through the engine (`importFiles`, one undo entry)
 * and adds it to the composition itself. A drop target that learns the kind
 * later must import through `importFiles` too (the engine mints item ids, so
 * the payload's pre-minted id is not the item's) and this fallback must then
 * learn to stand aside.
 *
 * Desktop only: the tab is not rendered without `window.motionEditor.shell`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { VirtualList } from '@components/VirtualList';
import { useAssetsViewStore } from '@stores/assetsViewStore';
import { useUIStore } from '@stores/uiStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { insertMedia } from '@core/scene/sceneInsert';
import { insertMediaAtPlayhead } from '@core/scene/footageWorkflow';
import { mintAssetId } from '@core/assets/local/importFromDisk';
import { importPathsEdit } from './assetEdits';
import { getAssetVisualInfo } from './assetVisuals';
import { formatBytes } from './assetListLogic';
import { baseName, flattenMediaTree, mediaKindOf, type DirEntry, type MediaRow } from './mediaBrowserTree';
import { revealLabel } from './assetCommands';
import styles from '@layout/EditorLayout/panels.module.css';

const ROW_H = 24;

/** Whether this build can list folders — the tab's own gate. */
export function canBrowseMedia(): boolean {
  const shell = typeof window !== 'undefined' ? window.motionEditor?.shell : undefined;
  return typeof shell?.listDir === 'function' && typeof shell?.pickFolder === 'function';
}

/**
 * Import a path through the engine (`importFiles`: one undo entry, the record
 * keeps the path) and add it to the comp. `at` picks the insert verb: the
 * playhead for a timeline-shaped gesture, the default placement otherwise.
 *
 * No drop target handles the `mediaFile` drag kind yet, so the drag-end
 * fallback always lands here; the engine mints the item id, so a target that
 * learns the kind must import through `importFiles` itself rather than reuse
 * the payload's pre-minted id.
 */
async function importAndInsert(path: string, at: 'default' | 'playhead'): Promise<void> {
  const { imported } = await importPathsEdit([path]);
  const asset = imported[0];
  if (!asset) {
    useUIStore.getState().notify({ level: 'error', message: `Could not import “${baseName(path)}”.`, durationMs: 4000 });
    return;
  }
  // B3-legacy: engine gap — `createLayer` has no media fitting (contain-fit, PAR, SVG paths, sequences, audio routing, playhead placement) that `insertMedia` applies.
  if (at === 'playhead') await insertMediaAtPlayhead(asset);
  else await insertMedia(asset);
}

export function MediaBrowser(): JSX.Element {
  const root = useAssetsViewStore((s) => s.browseRoot);
  const setBrowseRoot = useAssetsViewStore((s) => s.setBrowseRoot);
  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [listings, setListings] = useState<Map<string, DirEntry[]>>(() => new Map());
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [hostHeight, setHostHeight] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    setHostHeight(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHostHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const listDir = useCallback(async (dir: string): Promise<DirEntry[] | null> => {
    const list = window.motionEditor?.shell?.listDir;
    if (!list) return null;
    try {
      return (await list(dir)) as DirEntry[] | null;
    } catch {
      return null;
    }
  }, []);

  // The root's own listing. Re-run on refresh (a bumped counter) and when
  // the root changes; a failed read clears the tree rather than showing the
  // previous folder under a new name.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setRootEntries(null);
    setListings(new Map());
    setExpanded(new Set());
    setPending(new Set());
    setError(null);
    if (!root) return;
    void listDir(root).then((entries) => {
      if (cancelled) return;
      if (!entries) setError(`Could not read ${root}`);
      setRootEntries(entries ?? []);
    });
    return () => { cancelled = true; };
  }, [root, refreshTick, listDir]);

  const toggleDir = (dir: string): void => {
    if (expanded.has(dir)) {
      setExpanded((cur) => { const next = new Set(cur); next.delete(dir); return next; });
      return;
    }
    setExpanded((cur) => new Set(cur).add(dir));
    if (listings.has(dir) || pending.has(dir)) return;
    setPending((cur) => new Set(cur).add(dir));
    void listDir(dir).then((entries) => {
      setListings((cur) => new Map(cur).set(dir, entries ?? []));
      setPending((cur) => { const next = new Set(cur); next.delete(dir); return next; });
    });
  };

  const rows = useMemo<MediaRow[]>(
    () => (rootEntries ? flattenMediaTree(rootEntries, expanded, listings, pending) : []),
    [rootEntries, expanded, listings, pending],
  );

  const pickFolder = async (): Promise<void> => {
    const pick = window.motionEditor?.shell?.pickFolder;
    if (!pick) return;
    const chosen = await pick();
    if (chosen) setBrowseRoot(chosen);
  };

  /**
   * Specific files, not a folder: the OS file dialog, then a straight import
   * of each pick into the project — AE's File ▸ Import ▸ File…. Offered here
   * because a folder is not always the unit of work; "that one clip on the
   * desktop" should not need the whole desktop browsed first.
   */
  const pickAndImportFiles = async (): Promise<void> => {
    const pick = window.motionEditor?.shell?.pickFiles;
    if (!pick) return;
    const chosen = await pick();
    if (!chosen || chosen.length === 0) return;
    const { imported, failed } = await importPathsEdit(chosen);
    if (failed.length > 0) {
      useUIStore.getState().notify({ level: 'error', message: `Could not import ${failed.map(baseName).join(', ')}.`, durationMs: 5000 });
    }
    if (imported.length === 0) return;
    useUIStore.getState().notify({
      level: 'success',
      message: `Imported ${imported.length} file${imported.length === 1 ? '' : 's'} to the project.`,
      durationMs: 6000,
      action: {
        label: 'Add to composition',
        onSelect: () => {
          void (async () => {
            // B3-legacy: engine gap — no media fitting in `createLayer` (see importAndInsert).
            for (const a of imported) await insertMedia(a);
          })();
        },
      },
    });
  };
  const canPickFiles = typeof window.motionEditor?.shell?.pickFiles === 'function';

  const importOnly = async (path: string): Promise<void> => {
    const asset = (await importPathsEdit([path])).imported[0];
    useUIStore.getState().notify(
      asset
        ? { level: 'success', message: `Imported “${asset.name}” to the project.`, durationMs: 2200 }
        : { level: 'error', message: `Could not import “${baseName(path)}”.`, durationMs: 4000 },
    );
  };

  const openRowMenu = (row: MediaRow, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const { entry } = row;
    if (entry.kind === 'dir') {
      openContextMenu(e.clientX, e.clientY, [
        { id: 'open', label: row.expanded ? 'Collapse' : 'Expand', onSelect: () => toggleDir(entry.path) },
        { id: 'root', label: 'Browse This Folder', onSelect: () => setBrowseRoot(entry.path) },
        { id: 'sep', separator: true },
        { id: 'reveal', label: revealLabel(), onSelect: () => { void window.motionEditor?.shell?.revealInFolder?.(entry.path); } },
      ]);
      return;
    }
    openContextMenu(e.clientX, e.clientY, [
      { id: 'import', label: 'Import to Project', onSelect: () => { void importOnly(entry.path); } },
      { id: 'add', label: 'Import and Add to Composition', onSelect: () => { void importAndInsert(entry.path, 'default'); } },
      { id: 'add-playhead', label: 'Import and Add at Playhead', onSelect: () => { void importAndInsert(entry.path, 'playhead'); } },
      { id: 'sep', separator: true },
      { id: 'reveal', label: revealLabel(), onSelect: () => { void window.motionEditor?.shell?.revealInFolder?.(entry.path); } },
    ]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return;
    const row = rows[focusIndex];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusIndex((i) => Math.min(rows.length - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusIndex((i) => Math.max(0, i - 1));
        break;
      case 'ArrowRight':
        if (row?.entry.kind === 'dir' && !row.expanded) { e.preventDefault(); toggleDir(row.entry.path); }
        break;
      case 'ArrowLeft':
        if (row?.entry.kind === 'dir' && row.expanded) { e.preventDefault(); toggleDir(row.entry.path); }
        break;
      case 'Home':
        e.preventDefault();
        setFocusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setFocusIndex(rows.length - 1);
        break;
      case 'Enter':
        if (!row) return;
        e.preventDefault();
        if (row.entry.kind === 'dir') toggleDir(row.entry.path);
        else void importAndInsert(row.entry.path, 'default');
        break;
      default:
        return;
    }
  };

  if (!root) {
    return (
      <div className={styles.mediaBrowserRoot}>
        <div className={styles.mediaBrowserEmpty}>
          <Icon name="folder-open" size="lg" />
          <span>Pick a folder to browse its files without importing. Drag a file into the composition to import and place it.</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Button size="sm" variant="secondary" onClick={() => { void pickFolder(); }}>Choose Folder…</Button>
            {canPickFiles && (
              <Button size="sm" variant="secondary" onClick={() => { void pickAndImportFiles(); }} title="Pick specific files and import them to the project">
                Import Files…
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.mediaBrowserRoot} data-tour="media-browser">
      <div className={styles.mediaBrowserBar}>
        <span className={styles.mediaBrowserPath} title={root}>{root}</span>
        <button type="button" className={styles.dockBtn} title="Refresh" aria-label="Refresh folder" onClick={() => setRefreshTick((t) => t + 1)}>
          <Icon name="refresh" size="sm" />
        </button>
        <button type="button" className={styles.dockBtn} title="Choose another folder…" aria-label="Choose folder" onClick={() => { void pickFolder(); }}>
          <Icon name="folder-open" size="sm" />
        </button>
        {canPickFiles && (
          <button type="button" className={styles.dockBtn} title="Import specific files… (pick files, not a folder)" aria-label="Import files" onClick={() => { void pickAndImportFiles(); }}>
            <Icon name="upload" size="sm" />
          </button>
        )}
      </div>
      <div
        ref={hostRef}
        className={styles.assetListHost}
        tabIndex={0}
        role="tree"
        aria-label="Media browser"
        onKeyDown={onKeyDown}
      >
        {error ? (
          <div className={styles.empty}>{error}</div>
        ) : rootEntries === null ? (
          <div className={styles.empty}>Reading folder…</div>
        ) : rows.length === 0 ? (
          <div className={styles.empty}>No media in this folder.</div>
        ) : hostHeight > 0 ? (
          <VirtualList
            items={rows}
            itemHeight={ROW_H}
            height={hostHeight}
            scrollToIndex={focusIndex}
            itemKey={(r) => r.entry.path}
            renderItem={(row, i) => {
              const { entry } = row;
              const isDir = entry.kind === 'dir';
              const kind = isDir ? null : mediaKindOf(entry.name);
              const visual = isDir ? null : getAssetVisualInfo({ name: entry.name, type: kind ?? undefined });
              const glyphClass = visual ? (styles as Record<string, string>)[visual.className] ?? styles.assetGlyphFile : '';
              return (
                <div
                  role="treeitem"
                  aria-expanded={isDir ? row.expanded : undefined}
                  aria-selected={i === focusIndex}
                  className={`${styles.assetRow}${i === focusIndex ? ` ${styles.assetRowActive}` : ''}`}
                  style={{ paddingLeft: 8 + row.depth * 16 + (isDir ? 0 : 16) }}
                  title={entry.path}
                  draggable={!isDir}
                  onClick={() => { setFocusIndex(i); if (isDir) toggleDir(entry.path); }}
                  onDoubleClick={() => { if (!isDir) void importAndInsert(entry.path, 'default'); }}
                  onContextMenu={(e) => openRowMenu(row, e)}
                  onDragStart={(e) => {
                    if (isDir) return;
                    const assetId = mintAssetId();
                    (e.currentTarget as HTMLDivElement).dataset.pendingAssetId = assetId;
                    setCanvasDrag(e, { kind: 'mediaFile', path: entry.path, name: entry.name, assetId });
                  }}
                  onDragEnd={(e) => {
                    if (isDir) return;
                    const el = e.currentTarget as HTMLDivElement;
                    const assetId = el.dataset.pendingAssetId;
                    delete el.dataset.pendingAssetId;
                    if (!assetId || e.dataTransfer.dropEffect === 'none') return;
                    void importAndInsert(entry.path, 'default');
                  }}
                >
                  {isDir ? (
                    <>
                      <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} size="sm" className={styles.assetTwisty} />
                      <Icon name={row.expanded ? 'folder-open' : 'folder'} size="md" className={styles.assetGlyphFolder} />
                    </>
                  ) : (
                    <Icon name={visual!.icon} size="md" className={`${styles.assetGlyph} ${glyphClass}`} />
                  )}
                  <span className={styles.assetRowName}>{entry.name}</span>
                  <span className={styles.assetRowType}>
                    {isDir ? (row.loading ? <span className={styles.mediaRowLoading}>loading…</span> : 'Folder') : visual!.label}
                  </span>
                  <span className={styles.assetRowSize}>{!isDir && entry.size != null ? formatBytes(entry.size) : ''}</span>
                </div>
              );
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
