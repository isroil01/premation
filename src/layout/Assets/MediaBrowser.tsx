/**
 * MediaBrowser — the Assets panel's Media Browser tab (id `browse`): folders on disk, listed
 * lazily, whose media rows can be dragged straight into the composition.
 *
 * Premiere's Media Browser is the model. Import without an OS dialog: add a
 * folder once, then drag from it. Every row is a path until the moment it is
 * used — nothing is copied into the project for browsing, only for a drop,
 * a double-click or an explicit Import. A file the project already holds is
 * marked "In project" and is never imported twice (`footageDedupe.ts`): a
 * second drag places the same item again.
 *
 * ── Folders: several, per project, live ────────────────────────────────────
 * Any number of folders sit side by side as top-level rows (Add Folder, whose
 * menu offers the recently used ones; Remove from Media Browser on a folder's
 * menu). They are remembered PER PROJECT (`assetsViewStore.browseRoots`), so
 * opening another project does not show this one's footage folders. Every
 * folder on screen — the added ones and each opened under them — is watched
 * (`shell.watchDirs`, electron/dirWatch.ts): a file rendered, saved or deleted
 * there appears or goes without a Refresh, and window focus re-reads them all
 * (a network share may never send events).
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
import { useCurrentProjectRef } from '@hooks/useCurrentProjectRef';
import { useMirrorItems } from '@hooks/useMirror';
import { browseKey, useAssetsViewStore } from '@stores/assetsViewStore';
import { useUIStore } from '@stores/uiStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { insertMediaEdit } from '@layout/Workspace/footageEdits';
import { mintAssetId } from '@core/assets/local/importFromDisk';
import { importPathsEdit } from './assetEdits';
import { formatLabel, getAssetVisualInfo } from './assetVisuals';
import { formatBytes } from './assetListLogic';
import { baseName, flattenMediaRoots, mediaKindOf, type DirEntry, type MediaRow } from './mediaBrowserTree';
import { footageByIdentity, pathKey } from './footageDedupe';
import { revealLabel } from './assetCommands';
import styles from '@layout/EditorLayout/panels.module.css';
import { t } from '@core/i18n';

const ROW_H = 24;
const NO_ROOTS: readonly string[] = [];

/** Whether this build can list folders — the tab's own gate. */
export function canBrowseMedia(): boolean {
  const shell = typeof window !== 'undefined' ? window.motionEditor?.shell : undefined;
  return typeof shell?.listDir === 'function' && typeof shell?.pickFolder === 'function';
}

/**
 * Import a path through the engine (`importFiles`: one undo entry, the record
 * keeps the path) and add it to the comp. `at` picks the insert verb: the
 * playhead for a timeline-shaped gesture, the default placement otherwise. A
 * file already in the project is reused — no second item, no Import entry.
 *
 * No drop target handles the `mediaFile` drag kind yet, so the drag-end
 * fallback always lands here; the engine mints the item id, so a target that
 * learns the kind must import through `importFiles` itself rather than reuse
 * the payload's pre-minted id.
 */
async function importAndInsert(path: string, at: 'default' | 'playhead'): Promise<void> {
  // Two entries, as before: Import File (the item stays in the project if the insert is undone), then the insert.
  const { imported } = await importPathsEdit([path]);
  const asset = imported[0];
  if (!asset) {
    useUIStore.getState().notify({ level: 'error', message: t('assets.browser.importFailedOne', 'Could not import “{name}”.', { name: baseName(path) }), durationMs: 4000 });
    return;
  }
  await insertMediaEdit([asset], { atPlayhead: at === 'playhead' });
}

export function MediaBrowser(): JSX.Element {
  const project = useCurrentProjectRef();
  const projectKey = browseKey(project?.id);
  const roots = useAssetsViewStore((s) => s.browseRoots[projectKey]) ?? NO_ROOTS;
  const recent = useAssetsViewStore((s) => s.recentBrowseFolders);
  const addBrowseRoot = useAssetsViewStore((s) => s.addBrowseRoot);
  const removeBrowseRoot = useAssetsViewStore((s) => s.removeBrowseRoot);
  /** Listed folders: their entries, or null for a folder that could not be read. */
  const [listings, setListings] = useState<Map<string, DirEntry[] | null>>(() => new Map());
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusIndex, setFocusIndex] = useState(0);
  const [hostHeight, setHostHeight] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shell = typeof window !== 'undefined' ? window.motionEditor?.shell : undefined;
  const hasRoots = roots.length > 0;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    setHostHeight(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHostHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasRoots]);

  const listDir = useCallback(async (dir: string): Promise<DirEntry[] | null> => {
    const list = window.motionEditor?.shell?.listDir;
    if (!list) return null;
    try {
      return (await list(dir)) as DirEntry[] | null;
    } catch {
      return null;
    }
  }, []);

  /** (Re-)read folders. Open folders stay open; a re-read only swaps the entries. */
  const load = useCallback((dirs: Iterable<string>): void => {
    const list = [...dirs];
    if (list.length === 0) return;
    setPending((cur) => { const next = new Set(cur); for (const d of list) next.add(d); return next; });
    for (const dir of list) {
      void listDir(dir).then((entries) => {
        setListings((cur) => new Map(cur).set(dir, entries));
        setPending((cur) => { const next = new Set(cur); next.delete(dir); return next; });
      });
    }
  }, [listDir]);

  // Another project: its own folders, each open and read afresh. (A folder
  // added later is read by `addFolder`.)
  useEffect(() => {
    setListings(new Map());
    setPending(new Set());
    setExpanded(new Set(roots));
    setFocusIndex(0);
    load(roots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey]);

  // The latest listings for the watch callbacks, without re-subscribing per listing.
  const listingsRef = useRef(listings);
  listingsRef.current = listings;

  // Watch every folder on screen: the added ones and each one opened under them.
  const watchSet = useMemo(() => {
    const out = new Set<string>(roots);
    for (const dir of expanded) if (listings.has(dir)) out.add(dir);
    return [...out].sort();
  }, [roots, expanded, listings]);
  const watchSig = watchSet.join('\n');
  useEffect(() => {
    void shell?.watchDirs?.(watchSet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchSig]);
  useEffect(() => () => { void window.motionEditor?.shell?.watchDirs?.([]); }, []);
  useEffect(() => {
    const off = shell?.onDirsChanged?.((dirs) => load(dirs.filter((d) => listingsRef.current.has(d))));
    // Window focus re-reads what is on screen: a network share may never send a change event.
    const onFocus = (): void => load(listingsRef.current.keys());
    window.addEventListener('focus', onFocus);
    return () => {
      off?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [shell, load]);

  const toggleDir = (dir: string): void => {
    if (expanded.has(dir)) {
      setExpanded((cur) => { const next = new Set(cur); next.delete(dir); return next; });
      return;
    }
    setExpanded((cur) => new Set(cur).add(dir));
    if (listings.has(dir) || pending.has(dir)) return;
    load([dir]);
  };

  const rows = useMemo<MediaRow[]>(
    () => flattenMediaRoots(roots, expanded, listings, pending),
    [roots, expanded, listings, pending],
  );

  // Files the project already holds (by path), for the "In project" mark.
  const items = useMirrorItems();
  const inProject = useMemo(() => new Set(footageByIdentity(items.values()).keys()), [items]);

  const addFolder = (dir: string): void => {
    const known = roots.some((r) => pathKey(r) === pathKey(dir));
    addBrowseRoot(projectKey, dir);
    if (known) return;
    setExpanded((cur) => new Set(cur).add(dir));
    load([dir]);
  };
  const removeFolder = (dir: string): void => {
    removeBrowseRoot(projectKey, dir);
    setListings((cur) => { const next = new Map(cur); next.delete(dir); return next; });
  };

  const pickFolder = async (): Promise<void> => {
    const pick = window.motionEditor?.shell?.pickFolder;
    if (!pick) return;
    const chosen = await pick();
    if (chosen) addFolder(chosen);
  };

  /** Recently used folders this project does not list yet. */
  const recentToOffer = recent.filter((r) => !roots.some((x) => pathKey(x) === pathKey(r)));
  const openAddMenu = (e: React.MouseEvent<HTMLElement>): void => {
    if (recentToOffer.length === 0) {
      void pickFolder();
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    openContextMenu(box.left, box.bottom + 2, [
      { id: 'choose', label: t('assets.browser.chooseFolder', 'Choose Folder…'), icon: 'folder-open', onSelect: () => { void pickFolder(); } },
      { id: 'sep', separator: true },
      ...recentToOffer.map((dir, i) => ({ id: `recent-${i}`, label: dir, icon: 'folder' as const, onSelect: () => addFolder(dir) })),
    ]);
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
    const { imported, reused, failed } = await importPathsEdit(chosen);
    if (failed.length > 0) {
      useUIStore.getState().notify({ level: 'error', message: t('assets.browser.importFailedMany', 'Could not import {names}.', { names: failed.map(baseName).join(', ') }), durationMs: 5000 });
    }
    if (imported.length === 0) return;
    const fresh = imported.length - (reused?.length ?? 0);
    useUIStore.getState().notify({
      level: 'success',
      message: fresh === 0
        ? t('assets.browser.alreadyInProject', 'Already in the project — nothing new imported.')
        : fresh === 1
          ? t('assets.browser.importedOne', 'Imported {n} file to the project.', { n: fresh })
          : t('assets.browser.importedOther', 'Imported {n} files to the project.', { n: fresh }),
      durationMs: 6000,
      action: {
        label: t('assets.browser.addToComp', 'Add to composition'),
        onSelect: () => { void insertMediaEdit(imported); },
      },
    });
  };
  const canPickFiles = typeof window.motionEditor?.shell?.pickFiles === 'function';

  const importOnly = async (path: string): Promise<void> => {
    const { imported, reused } = await importPathsEdit([path]);
    const asset = imported[0];
    useUIStore.getState().notify(
      !asset
        ? { level: 'error', message: t('assets.browser.importFailedOne', 'Could not import “{name}”.', { name: baseName(path) }), durationMs: 4000 }
        : reused?.length
          ? { level: 'info', message: t('assets.browser.alreadyNamed', '“{name}” is already in the project.', { name: asset.name }), durationMs: 2200 }
          : { level: 'success', message: t('assets.browser.importedNamed', 'Imported “{name}” to the project.', { name: asset.name }), durationMs: 2200 },
    );
  };

  const openRowMenu = (row: MediaRow, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const { entry } = row;
    const reveal = { id: 'reveal', label: revealLabel(), onSelect: () => { void window.motionEditor?.shell?.revealInFolder?.(entry.path); } };
    const toggle = { id: 'open', label: row.expanded ? t('assets.browser.collapse', 'Collapse') : t('assets.browser.expand', 'Expand'), onSelect: () => toggleDir(entry.path) };
    if (row.root) {
      const under = `${pathKey(entry.path)}/`;
      openContextMenu(e.clientX, e.clientY, [
        toggle,
        { id: 'refresh', label: t('assets.browser.refresh', 'Refresh'), onSelect: () => load([entry.path, ...[...listings.keys()].filter((d) => pathKey(d).startsWith(under))]) },
        { id: 'sep', separator: true },
        reveal,
        { id: 'remove', label: t('assets.browser.removeFolder', 'Remove from Media Browser'), onSelect: () => removeFolder(entry.path) },
      ]);
      return;
    }
    if (entry.kind === 'dir') {
      openContextMenu(e.clientX, e.clientY, [
        toggle,
        { id: 'root', label: t('assets.browser.addThisFolder', 'Add as Media Browser Folder'), onSelect: () => addFolder(entry.path) },
        { id: 'sep', separator: true },
        reveal,
      ]);
      return;
    }
    const held = inProject.has(pathKey(entry.path));
    openContextMenu(e.clientX, e.clientY, [
      { id: 'import', label: held ? t('assets.browser.inProjectMenu', 'Already in Project') : t('assets.browser.importToProject', 'Import to Project'), disabled: held, onSelect: () => { void importOnly(entry.path); } },
      { id: 'add', label: held ? t('assets.browser.addToCompMenu', 'Add to Composition') : t('assets.browser.importAndAdd', 'Import and Add to Composition'), onSelect: () => { void importAndInsert(entry.path, 'default'); } },
      { id: 'add-playhead', label: held ? t('assets.browser.addAtPlayhead', 'Add at Playhead') : t('assets.browser.importAtPlayhead', 'Import and Add at Playhead'), onSelect: () => { void importAndInsert(entry.path, 'playhead'); } },
      { id: 'sep', separator: true },
      reveal,
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
      case 'Delete':
        if (row?.root) { e.preventDefault(); removeFolder(row.entry.path); }
        break;
      default:
        return;
    }
  };

  if (!hasRoots) {
    return (
      <div className={styles.mediaBrowserRoot}>
        <div className={styles.mediaBrowserEmpty}>
          <Icon name="folder-open" size="lg" />
          <span>{t('assets.browser.emptyHintMany', 'Add folders to browse their files without importing. Drag a file into the composition to place it — a file already in the project is reused, never imported twice.')}</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Button size="sm" variant="secondary" onClick={() => { void pickFolder(); }}>{t('assets.browser.addFolder', 'Add Folder…')}</Button>
            {canPickFiles && (
              <Button size="sm" variant="secondary" onClick={() => { void pickAndImportFiles(); }} title={t('assets.browser.importFilesTitle', 'Pick specific files and import them to the project')}>
                {t('assets.browser.importFiles', 'Import Files…')}
              </Button>
            )}
          </div>
          {recentToOffer.length > 0 && (
            <div className={styles.mediaBrowserRecent}>
              <span className={styles.mediaBrowserRecentTitle}>{t('assets.browser.recentFolders', 'Recent folders')}</span>
              {recentToOffer.map((dir) => (
                <button key={dir} type="button" className={styles.mediaBrowserRecentRow} title={dir} onClick={() => addFolder(dir)}>
                  <Icon name="folder" size="sm" className={styles.assetGlyphFolder} />
                  <span>{dir}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.mediaBrowserRoot} data-tour="media-browser">
      <div className={styles.mediaBrowserBar}>
        <span className={styles.mediaBrowserPath}>
          {roots.length === 1
            ? t('assets.browser.foldersOne', '{n} folder · updates live', { n: roots.length })
            : t('assets.browser.foldersOther', '{n} folders · update live', { n: roots.length })}
        </span>
        <button type="button" className={styles.dockBtn} title={t('assets.browser.addFolderTitle', 'Add a folder to this project’s Media Browser')} aria-label={t('assets.browser.addFolderAria', 'Add folder')} onClick={openAddMenu}>
          <Icon name="folder-plus" size="sm" />
        </button>
        <button type="button" className={styles.dockBtn} title={t('assets.browser.refresh', 'Refresh')} aria-label={t('assets.browser.refreshAria', 'Refresh folder')} onClick={() => load(new Set([...roots, ...listings.keys()]))}>
          <Icon name="refresh" size="sm" />
        </button>
        {canPickFiles && (
          <button type="button" className={styles.dockBtn} title={t('assets.browser.importSpecificTitle', 'Import specific files… (pick files, not a folder)')} aria-label={t('assets.browser.importFilesAria', 'Import files')} onClick={() => { void pickAndImportFiles(); }}>
            <Icon name="upload" size="sm" />
          </button>
        )}
      </div>
      <div
        ref={hostRef}
        className={styles.assetListHost}
        tabIndex={0}
        role="tree"
        aria-label={t('assets.browser.aria', 'Media browser')}
        onKeyDown={onKeyDown}
      >
        {hostHeight > 0 ? (
          <VirtualList
            items={rows}
            itemHeight={ROW_H}
            height={hostHeight}
            scrollToIndex={focusIndex}
            itemKey={(r) => `${r.root ? 'root:' : ''}${r.entry.path}`}
            renderItem={(row, i) => {
              const { entry } = row;
              const isDir = entry.kind === 'dir';
              const kind = isDir ? null : mediaKindOf(entry.name);
              const visual = isDir ? null : getAssetVisualInfo({ name: entry.name, type: kind ?? undefined });
              const glyphClass = visual ? (styles as Record<string, string>)[visual.className] ?? styles.assetGlyphFile : '';
              const held = !isDir && inProject.has(pathKey(entry.path));
              const listing = isDir && row.expanded ? listings.get(entry.path) : undefined;
              let typeCell: React.ReactNode;
              if (!isDir) {
                typeCell = held
                  ? <span className={styles.mediaRowInProject} aria-label={t('assets.browser.inProject', 'In project')}><Icon name="check" size="sm" />{formatLabel(entry)}</span>
                  : formatLabel(entry);
              } else if (row.loading && !listing) {
                typeCell = <span className={styles.mediaRowLoading}>{t('assets.browser.loading', 'loading…')}</span>;
              } else if (row.unreadable) {
                typeCell = <span className={styles.mediaRowMissing}>{t('assets.browser.unreadable', 'Cannot read')}</span>;
              } else if (row.root && listing && listing.length === 0) {
                typeCell = t('assets.browser.noMediaShort', 'Empty');
              } else {
                typeCell = t('assets.browser.folder', 'Folder');
              }
              return (
                <div
                  role="treeitem"
                  aria-expanded={isDir ? row.expanded : undefined}
                  aria-selected={i === focusIndex}
                  className={`${styles.assetRow}${i === focusIndex ? ` ${styles.assetRowActive}` : ''}${row.root ? ` ${styles.mediaRootRow}` : ''}`}
                  style={{ paddingLeft: 8 + row.depth * 16 + (isDir ? 0 : 16) }}
                  title={held ? t('assets.browser.inProjectTitle', '{path} — already in the project; placing it reuses that item', { path: entry.path }) : entry.path}
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
                  <span className={styles.assetRowType}>{typeCell}</span>
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
