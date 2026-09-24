/**
 * AssetsPanel — the project's imported files AND the media browser.
 *
 * Two sub-tabs. **Project** (tab id `bin`) is the library: the files this
 * project has imported, persisted in the bundle — one unified media list
 * (images, video and audio together, no type tabs) organised into user
 * folders, shown as a list or a thumbnail grid, sortable, filterable, tagged
 * and colour-labelled, with a metadata drawer underneath describing the
 * selected file and the layers using it. **Media Browser** (tab id `browse`,
 * desktop only) lists a folder on disk so footage can be dragged in without
 * an import dialog — see `MediaBrowser.tsx`.
 *
 * What lives in the project list is MEDIA. Compositions are the Layers
 * panel's, deliberately: a list that holds both is a list where "delete"
 * means two different things.
 *
 * ── Import never inserts ────────────────────────────────────────────────────
 * AE and Premiere semantics: importing fills the PROJECT, placing a file in
 * the composition is a separate, explicit gesture. Every route in here — the
 * Import button, Import Folder, an OS drop on the panel — adds to the library
 * only, then offers ONE toast ("Imported N files ▸ Add to composition") for
 * the people who did mean both. Insertion stays where it is explicit: a drag
 * onto the canvas or the timeline, the row menu ("Add to Composition", "Add
 * at Playhead", "Use as Source for …"), the preview's commit verbs, and New
 * Comp from Footage. The old handler inserted every import as it landed,
 * which read as "my import went to the scene instead of the list" — and under
 * a persisted Unused filter the freshly-used file vanished from the list
 * outright.
 *
 * ── A fresh import is always visible ────────────────────────────────────────
 * Whatever route created it, an asset that has just arrived is selected,
 * scrolled to, its folder opened, and any filter or search that would hide
 * it is cleared with an inline note. The panel notices arrivals by diffing
 * the store's ids (`importedAt` within the last few seconds — hydration from
 * IndexedDB and a restored bundle carry old stamps and are left alone), so
 * the Media Browser's import and a canvas drop reveal the same way.
 *
 * It owns four routes in — loose files, a whole directory (whose structure it
 * mirrors as folders), a 3D model, and drag-and-drop between folders — plus
 * the verbs that put a clip into the edit: add, add at playhead, new comp from
 * footage, assemble, interpret, source monitor, and replace-a-layer's-source.
 *
 * 3D models take their own door on purpose. A `.glb`/`.gltf` does not become a
 * library asset; it becomes a LAYER TREE (nulls + mesh layers) — see
 * `core/scene/modelImport`. A `.gltf` additionally references sidecar files
 * (.bin, textures) by name, so a selection holding one is imported WHOLE
 * through `importModelFiles`, which picks the model out and resolves the rest
 * against it. `handleFileChange` routes all of that, and the Import menu's
 * "Import 3D Model…" hands it the same selection with a model-shaped
 * `accept` — one routing, two entry points.
 *
 * One Import affordance: the header's Import button (files) with a ▾ menu for
 * "Import Folder…" and "Import 3D Model…". The three hidden `<input>`s stay —
 * they are the mechanism — but nothing else in the panel opens a picker.
 *
 * ── Where the rules live ────────────────────────────────────────────────────
 * Sorting, filtering, search, tag parsing and the readouts are pure functions
 * in `assetListLogic.ts`; how the panel is looked at (view, sort, filters,
 * sub-tab, drawer) is `assetsViewStore`. This file only wires them to state
 * and draws rows. Both lists are virtualised (`VirtualList`) — a bin with a
 * thousand clips must scroll like one with ten.
 *
 * Panel chrome comes from the shared `EditorLayout/panels.module.css`, which
 * the Layers, Assets and Inspector panels all draw from.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from '@components/Panel';
import { Button } from '@components/Button';
import { SearchField } from '@components/SearchField';
import { Icon } from '@components/Icon';
import { Chip } from '@components/Chip';
import { Segmented } from '@components/Segmented';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { VirtualList } from '@components/VirtualList';
import { customConfirm, customPrompt } from '@components/Modal';
import { isLibraryAsset, useAssetStore, type AssetFolder, type ImportedAsset } from '@stores/assetStore';
import { useAssetsViewStore, type AssetSortKey } from '@stores/assetsViewStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { getAssetVisualInfo, FOLDER_COLOR } from '@layout/Assets/assetVisuals';
import { openSourceMonitor } from '@stores/sourceMonitorStore';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { useUIStore } from '@stores/uiStore';
import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { replaceableSelectedLayer } from '@core/scene/footageWorkflow';
import { replaceSourceWithAsset } from '@layout/Timeline/timelineEdits';
import { insertMediaEdit, newCompFromFootageEdit } from '@layout/Workspace/footageEdits';
import { setPanelAssetSelection } from '@core/composition/assetSelection';
import { assetIdOf } from '@core/source/sourceInfo';
import { LABEL_COLORS } from '@core/scene/labelColor';
import type { SceneNode } from '@core/types';
import { openFootagePreview } from '@layout/Assets/FootagePreviewDialog';
import { openInterpretFootage } from '@layout/Assets/InterpretFootageModal';
import { runNewCompFromClips, runAssembleFromFootage } from '@layout/Assets/footageAssembly';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { ScrollableStrip } from '@components/ScrollableStrip';
import { AssetThumb } from './AssetThumb';
import { AssetDrawer } from './AssetDrawer';
import { MediaBrowser, canBrowseMedia } from './MediaBrowser';
import { installAssetCommands, revealLabel, setAssetImportOpeners } from './assetCommands';
import { assetDiskPath, canRevealAssets, revealAsset } from './assetReveal';
import {
  createFolderEdit,
  createFolderTreeEdit,
  importBrowserFilesEdit,
  importPathsEdit,
  layersUsingItems,
  moveItemsEdit,
  removeItemsEdit,
  renameItemEdit,
  setItemLabelEdit,
  setItemTagsEdit,
} from './assetEdits';
import {
  filterAssets,
  formatBytes,
  isFilterActive,
  parseTags,
  sortAssets,
  usageByAsset,
} from './assetListLogic';
import styles from '@layout/EditorLayout/panels.module.css';

const LIST_ROW_H = 26;
const FOLDER_ROW_H = 26;
/** Narrowest a grid card gets before the grid drops a column. */
const CARD_MIN_W = 104;
const GRID_GAP = 8;
const GRID_PAD = 16;
/** Name line + meta line + card padding + border + vertical gaps. */
const CARD_CHROME_H = 54;
/** How old an `importedAt` may be and still count as "just imported". Wide
 *  enough for a slow batch (thumbnails, probes) to land after the first file
 *  is stamped; narrow enough that a bundle restored with last week's stamps
 *  is not mistaken for one. */
const IMPORT_REVEAL_WINDOW_MS = 30_000;
/** How long "Filters cleared to show the import" stays under the filter row. */
const FILTER_NOTE_MS = 6000;

const SORT_LABEL: Record<AssetSortKey, string> = {
  name: 'Name',
  type: 'Type',
  size: 'Size',
  date: 'Date added',
  used: 'Times used',
};

/** One rendered line. `depth` drives the hierarchy indent and guide line. */
type AssetRow =
  | { kind: 'folder'; key: string; depth: number; folder: AssetFolder; count: number }
  | { kind: 'empty-folder'; key: string; depth: number; folder: AssetFolder }
  | { kind: 'section'; key: string; depth: number; title: string }
  | { kind: 'asset'; key: string; depth: number; asset: ImportedAsset }
  | { kind: 'cards'; key: string; depth: number; folderId: string | null; assets: ImportedAsset[] };

/** Measured box size, for the virtual list's height and the grid's columns. */
function useHostSize(): [React.RefObject<HTMLDivElement>, { width: number; height: number }] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (): void => setSize({ width: el.clientWidth, height: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function AssetsPanel(): JSX.Element {
  useEffect(() => installAssetCommands(), []);

  const assets = useAssetStore((s) => s.assets);
  const folders = useAssetStore((s) => s.folders);
  // The label menu through the engine (B3z): setItemLabel stores the palette id this panel reads.
  const setLabel = (ids: string[], labelId: string | null): void => {
    const items = ids.filter((id) => useAssetStore.getState().assets.some((a) => a.id === id));
    void setItemLabelEdit(items, labelId);
  };
  const setTags = (assetId: string, tags: string[]): void => { void setItemTagsEdit([{ id: assetId, tags }]); };

  const view = useAssetsViewStore((s) => s.view);
  const setView = useAssetsViewStore((s) => s.setView);
  const sortKey = useAssetsViewStore((s) => s.sortKey);
  const sortDir = useAssetsViewStore((s) => s.sortDir);
  const sortBy = useAssetsViewStore((s) => s.sortBy);
  const setSort = useAssetsViewStore((s) => s.setSort);
  const unusedOnly = useAssetsViewStore((s) => s.unusedOnly);
  const typeFilter = useAssetsViewStore((s) => s.typeFilter);
  const tagFilter = useAssetsViewStore((s) => s.tagFilter);
  const setTagFilter = useAssetsViewStore((s) => s.setTagFilter);
  const labelFilter = useAssetsViewStore((s) => s.labelFilter);
  const clearFilters = useAssetsViewStore((s) => s.clearFilters);
  const tab = useAssetsViewStore((s) => s.tab);
  const setTab = useAssetsViewStore((s) => s.setTab);
  const drawerOpen = useAssetsViewStore((s) => s.drawerOpen);
  const setDrawerOpen = useAssetsViewStore((s) => s.setDrawerOpen);

  // Which layers use which asset — re-derived per scene revision, which is
  // the only thing that can change the answer.
  const sceneRev = useSceneRevision((s) => s.rev);
  const usage = useMemo(() => {
    const nodes: SceneNode[] = [];
    defaultSceneGraph.traverse((n) => nodes.push(n));
    return usageByAsset(nodes, assetIdOf);
  }, [sceneRev]);
  const usedCount = (assetId: string): number => usage.get(assetId)?.length ?? 0;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  /*
    A THIRD input, not a third importer. It shares `handleFileChange` — the one
    place that knows a `.gltf` selection is a model plus its sidecars and a
    `.glb` is a model on its own. What it does not share is `accept`: the media
    picker's filter buries a `.bin` and every texture the `.gltf` needs behind
    "Custom files", so picking a model correctly required knowing to switch the
    dialog's own filter. That is the entire reason this is a separate button.
  */
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  // The pickers as COMMANDS ("Assets: Import Files…" in the palette, a File
  // menu row when one is added) — they can only open while the inputs exist.
  const [searchQuery, setSearchQuery] = useState('');
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  /*
    Import Files… On the desktop the OS dialog hands back PATHS, which is what
    the engine's `importFiles` takes: the import is one undo entry and every
    record keeps the file's path (Reveal, Collect Files). The browser build —
    and a desktop without the bridge — keeps the <input> picker. 3D models are
    not media: the path dialog filters them out, and "Import 3D Model…" keeps
    its own <input> (a .gltf needs its sidecars as bytes).
  */
  const currentFolderRef = useRef<string | null>(null);
  currentFolderRef.current = currentFolderId;
  const openImportFiles = (): void => {
    const pick = typeof window !== 'undefined' ? window.motionEditor?.shell?.pickFiles : undefined;
    if (typeof pick !== 'function') {
      fileInputRef.current?.click();
      return;
    }
    void (async () => {
      const chosen = await pick();
      if (!chosen || chosen.length === 0) return;
      const folder = currentFolderRef.current;
      const { imported, failed } = await importPathsEdit(
        chosen,
        folder && useAssetStore.getState().folders.some((f) => f.id === folder) ? folder : null,
      );
      if (failed.length > 0) {
        const names = failed.map((p) => p.replace(/^.*[\\/]/, ''));
        useUIStore.getState().notify({ level: 'error', message: `Could not import ${names.join(', ')}.`, durationMs: 5000 });
      }
      announceImport(imported);
    })();
  };
  const openImportFilesRef = useRef(openImportFiles);
  openImportFilesRef.current = openImportFiles;
  useEffect(() => {
    setAssetImportOpeners({
      files: () => openImportFilesRef.current(),
      folder: () => folderInputRef.current?.click(),
    });
    return () => setAssetImportOpeners(null);
  }, []);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [scrollToKey, setScrollToKey] = useState<string | null>(null);
  /** Which folders are open. The root has no row, so it is always open. */
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const toggleFolder = (id: string): void => {
    setExpandedFolders((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Multi-select: clicking asset rows toggles them into this set; the bulk bar
  // then adds them together.
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(() => new Set());
  /** Off by default: the shelf is the user's imports, not the app's output. */
  const [showDerived, setShowDerived] = useState(false);
  const [dockCompDropActive, setDockCompDropActive] = useState(false);
  /** The row keyboard traversal is on. Also the one the list scrolls to. */
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);

  /** Anchor for Shift-range selection — the last row clicked without Shift. */
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  /** "Filters cleared to show the import" — shown under the filter row, briefly. */
  const [filterNote, setFilterNote] = useState<string | null>(null);
  /** OS files are over the list. */
  const [osDropActive, setOsDropActive] = useState(false);

  const [hostRef, hostSize] = useHostSize();

  /*
   * Click semantics, as every file manager has them.
   *
   * A bare click used to TOGGLE into the set, so clicking one file and then
   * another left both highlighted and nothing ever deselected except clicking
   * the same row twice. That is multi-select as the default and single-select
   * as the impossible case — backwards from what a click means everywhere else.
   *
   *   click            → select ONLY this one
   *   Ctrl/Cmd + click → add or remove this one
   *   Shift + click    → select the range from the anchor to here
   */
  const selectAsset = (id: string, e: React.MouseEvent, ordered: string[]): void => {
    e.stopPropagation();
    setScrollToKey(null);
    setCurrentFolderId(null);
    setFocusedAssetId(id);
    if (e.shiftKey && selectionAnchor) {
      const a = ordered.indexOf(selectionAnchor);
      const b = ordered.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedAssetIds(new Set(ordered.slice(lo, hi + 1)));
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelectedAssetIds((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setSelectionAnchor(id);
      return;
    }
    setSelectedAssetIds(new Set([id]));
    setSelectionAnchor(id);
  };

  /*
    The one toast an import produces. Import fills the project; this is the
    offer for the people who meant "and put it in the comp" — the old
    always-on insert loop, now behind a verb. One insert of every file (one
    undo entry, the last file's layer selected), not N racing ones.
  */
  const announceImport = (created: ImportedAsset[]): void => {
    if (created.length === 0) return;
    useUIStore.getState().notify({
      level: 'success',
      message: `Imported ${created.length} file${created.length === 1 ? '' : 's'}`,
      durationMs: 6000,
      action: {
        label: 'Add to composition',
        onSelect: () => { void insertMediaEdit(created); },
      },
    });
  };

  /** Media files out of an OS drop or a picker; models and non-media skipped. */
  const isMediaFile = (f: File): boolean =>
    /^(video|image|audio)\//.test(f.type)
    || /\.(mp4|mov|webm|m4v|png|jpe?g|gif|svg|webp|exr|dpx|psd|dng|cr2|cr3|nef|arw|mp3|wav|m4a|aac|ogg|mxf|avi|wmv|flv|mts|m2ts|mpg|mpeg|vob|ts|mkv|r3d|braw)$/i.test(f.name);

  /** OS files dropped on the panel: import to the current folder, never insert. */
  const handleOsDrop = async (files: FileList): Promise<void> => {
    const media = Array.from(files).filter(isMediaFile);
    if (media.length === 0) {
      useUIStore.getState().notify({ level: 'info', message: 'Drop video, image or audio files.', durationMs: 2600 });
      return;
    }
    const { imported } = await importBrowserFilesEdit(media.map((file) => ({ file, folderId: currentFolderId })));
    announceImport(imported);
  };

  // Import loose files into the current folder. Library only — see the
  // header comment; the toast's action is the way into the comp.
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const items: Array<{ file: File; folderId: string | null }> = [];
    // A `.gltf` references sidecar files (.bin, textures) by name, so a
    // selection holding one is a MODEL drop as a whole: every file goes to the
    // importer, which picks the model out and resolves the rest against it.
    const all = Array.from(files);
    const gltfDrop = all.some((f) => /\.gltf$/i.test(f.name));
    if (gltfDrop) {
      try {
        const { importModelFiles } = await import('@core/scene/modelImport');
        const sources = await Promise.all(all.map(async (f) => ({
          name: f.name,
          path: f.webkitRelativePath || undefined,
          bytes: await f.arrayBuffer(),
        })));
        const result = importModelFiles(sources);
        const modelName = all.find((f) => /\.gltf$/i.test(f.name))?.name ?? 'model';
        useUIStore.getState().notify({
          level: result.warning ? 'warning' : 'success',
          message: result.warning ?? `Imported “${modelName}” — ${result.layerCount} layer${result.layerCount === 1 ? '' : 's'}`,
          durationMs: result.warning ? 6000 : 3200,
        });
      } catch (err) {
        useUIStore.getState().notify({
          level: 'error',
          message: `3D import failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: 6000,
        });
      }
      e.target.value = '';
      return;
    }
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      // 3D models take their own door: they become a LAYER TREE (nulls +
      // mesh layers) rather than a library asset — see modelImport.ts.
      if (/\.(glb|gltf)$/i.test(file.name)) {
        try {
          const { importGltfModel } = await import('@core/scene/modelImport');
          const result = importGltfModel(await file.arrayBuffer(), file.name);
          const clipNote = result.clip
            ? ` · clip “${result.clip.name}” baked as keyframes (${result.clip.duration.toFixed(1)}s${result.clip.extraClips > 0 ? `, ${result.clip.extraClips} more clip${result.clip.extraClips === 1 ? '' : 's'} in file` : ''})`
            : '';
          useUIStore.getState().notify({
            level: result.warning ? 'warning' : 'success',
            message: result.warning ?? `Imported “${file.name}” — ${result.layerCount} layer${result.layerCount === 1 ? '' : 's'}${clipNote}`,
            durationMs: result.warning || result.clip ? 6000 : 3200,
          });
        } catch (err) {
          useUIStore.getState().notify({
            level: 'error',
            message: `3D import failed: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: 6000,
          });
        }
        continue;
      }
      items.push({ file, folderId: currentFolderId });
    }
    const { imported } = await importBrowserFilesEdit(items);
    announceImport(imported);
    e.target.value = '';
  };

  // Import a whole directory: recreate its folder structure under the current
  // folder (via webkitRelativePath) and file each asset into the matching leaf.
  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // Recreate the full picked structure: "MyPack/logos/a.png" → folders
    // "MyPack" then "MyPack/logos", with a.png filed in the leaf. Every folder
    // path, parents first, created as ONE engine entry.
    const picked = Array.from(files).map((file) => ({
      file,
      dir: ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).split('/').slice(0, -1).join('/'),
    }));
    const folderPaths: string[] = [];
    for (const { dir } of picked) {
      const segs = dir ? dir.split('/') : [];
      for (let i = 1; i <= segs.length; i++) {
        const key = segs.slice(0, i).join('/');
        if (!folderPaths.includes(key)) folderPaths.push(key);
      }
    }
    const pathToId = await createFolderTreeEdit(folderPaths, currentFolderId);
    const items: Array<{ file: File; folderId: string | null }> = picked.map(({ file, dir }) => ({
      file,
      folderId: dir ? pathToId.get(dir) ?? currentFolderId : currentFolderId,
    }));
    if (items.length > 0) {
      announceImport((await importBrowserFilesEdit(items)).imported);
    }
    e.target.value = '';
  };

  const handleNewFolder = () => {
    // Auto-name (Electron has no window.prompt); rename inline afterwards.
    const validParentId = currentFolderId && folders.some((f) => f.id === currentFolderId) ? currentFolderId : null;
    if (validParentId) {
      setExpandedFolders((cur) => new Set(cur).add(validParentId));
    }
    if (searchQuery) setSearchQuery('');
    if (filtering) clearFilters();

    const siblings = folders.filter((f) => (f.parentId ?? null) === validParentId);
    const base = 'New Folder';
    let name = base;
    let n = 2;
    while (siblings.some((f) => f.name === name)) name = `${base} ${n++}`;
    void createFolderEdit(name, validParentId).then((id) => {
      if (!id) return;
      setCurrentFolderId(id);
      setRenamingId(id);
      setScrollToKey(id);
      setSelectedAssetIds(new Set());
      setSelectionAnchor(null);
    });
  };

  /*
   * Confirmed deletes.
   *
   * Removing an item is an engine edit (`removeItems`): one undo entry, and
   * undo brings the item — and any layer that used it — back with the same
   * ids. The confirm stays because a delete also takes the LAYERS that show
   * the file (AE asks the same), and it says how many.
   */
  const usageNote = (ids: readonly string[]): string => {
    const n = layersUsingItems(ids);
    return n === 0 ? '' : ` ${n} layer${n === 1 ? ' uses' : 's use'} ${ids.length === 1 ? 'it' : 'them'} and will be deleted too.`;
  };
  const deleteAsset = async (asset: ImportedAsset): Promise<void> => {
    const ok = await customConfirm(
      `Delete “${asset.name}”`,
      `This removes the asset from the project.${usageNote([asset.id])} Undo brings it back.`,
      { confirmLabel: 'Delete', isDanger: true },
    );
    if (ok) await removeItemsEdit([asset.id], 'Delete Asset');
  };

  /**
   * Delete the whole selection.
   *
   * Names are listed up to a point and then counted. A confirm that renders
   * fifty filenames is a confirm nobody reads.
   */
  const deleteSelectedAssets = async (): Promise<void> => {
    const ids = [...selectedAssetIds];
    if (ids.length === 0) return;
    if (ids.length === 1) {
      const only = assets.find((a) => a.id === ids[0]);
      if (only) await deleteAsset(only);
      return;
    }
    const names = ids
      .map((id) => assets.find((a) => a.id === id)?.name)
      .filter((n): n is string => Boolean(n));
    const shown = names.slice(0, 5).map((n) => `• ${n}`).join('\n');
    const rest = names.length - Math.min(names.length, 5);
    const ok = await customConfirm(
      `Delete ${ids.length} assets`,
      `${shown}${rest > 0 ? `\n…and ${rest} more` : ''}\n\nThis removes them from the project.${usageNote(ids)} Undo brings them back.`,
      { confirmLabel: `Delete ${ids.length}`, isDanger: true },
    );
    if (!ok) return;
    if (!(await removeItemsEdit(ids, `Delete ${ids.length} Assets`))) return;
    setSelectedAssetIds(new Set());
    setSelectionAnchor(null);
  };

  const deleteFolder = async (folder: AssetFolder): Promise<void> => {
    const assetCount = assets.filter((a) => a.folderId === folder.id).length;
    const subCount = folders.filter((f) => f.parentId === folder.id).length;
    const ok = await customConfirm(
      `Delete “${folder.name}”`,
      assetCount || subCount
        ? `This deletes the folder and everything inside it (${assetCount} asset${assetCount === 1 ? '' : 's'}${subCount ? `, ${subCount} subfolder${subCount === 1 ? '' : 's'}` : ''}). Undo brings it back.`
        : 'Delete this empty folder?',
      { confirmLabel: 'Delete', isDanger: true },
    );
    if (ok) {
      if (currentFolderId === folder.id) setCurrentFolderId(null);
      if (scrollToKey === folder.id) setScrollToKey(null);
      await removeItemsEdit([folder.id], 'Delete Folder');
    }
  };

  /** Tags for one asset or the whole selection, edited as one comma list. */
  const editTags = async (targets: ImportedAsset[]): Promise<void> => {
    const first = targets[0];
    if (!first) return;
    const shared = targets.length === 1
      ? first.tags ?? []
      : (first.tags ?? []).filter((t) => targets.every((a) => (a.tags ?? []).includes(t)));
    const text = await customPrompt(
      targets.length === 1 ? `Tags for “${first.name}”` : `Tags for ${targets.length} assets`,
      'Comma-separated. Search matches tags as well as names.',
      shared.join(', '),
      { placeholder: 'b-roll, interview, logo', confirmLabel: 'Save' },
    );
    if (text === null || text === undefined) return;
    const next = parseTags(text);
    // One entry for the whole selection.
    await setItemTagsEdit(targets.map((a) => {
      // Multi-edit replaces only the SHARED tags; each asset keeps its own.
      const own = targets.length === 1 ? [] : (a.tags ?? []).filter((t) => !shared.includes(t));
      return { id: a.id, tags: parseTags([...own, ...next].join(',')) };
    }));
  };

  /** "Label" submenu — the same palette the Layers panel uses. */
  const labelMenuItems = (ids: string[], current: string | undefined): ContextMenuItem[] => [
    {
      id: 'label-none',
      label: 'None',
      icon: current === undefined ? 'check' : undefined,
      onSelect: () => setLabel(ids, null),
    },
    { id: 'label-sep', separator: true },
    ...LABEL_COLORS.map((c): ContextMenuItem => ({
      id: `label-${c.id}`,
      label: (
        <>
          <span className={styles.labelSwatch} style={{ background: c.color }} aria-hidden />
          {c.label}
        </>
      ),
      icon: current === c.id ? 'check' : undefined,
      onSelect: () => setLabel(ids, c.id),
    })),
  ];

  /*
   * Right-click menus — these REPLACE the per-row buttons.
   *
   * Right-click is where a file manager puts this, and where this editor's own
   * layer tree already puts it.
   */
  const openAssetMenu = (asset: ImportedAsset, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    /*
      Right-clicking INSIDE a selection acts on the selection; right-clicking
      outside one replaces it with the row under the cursor first. That is what
      every file manager does, and the alternative — a menu that silently
      targets one row while twenty look selected — is how a user loses the
      other nineteen without noticing.
    */
    const inSelection = selectedAssetIds.has(asset.id);
    if (!inSelection) {
      setSelectedAssetIds(new Set([asset.id]));
      setSelectionAnchor(asset.id);
    }
    const count = inSelection ? selectedAssetIds.size : 1;
    const many = count > 1;
    const targetIds = many ? orderedAssetIds.filter((id) => selectedAssetIds.has(id)) : [asset.id];
    const targets = targetIds.map((id) => assets.find((x) => x.id === id)).filter((a): a is ImportedAsset => !!a);
    openContextMenu(e.clientX, e.clientY, [
      {
        id: 'add',
        label: many ? `Add ${count} to Composition` : 'Add to Composition',
        // In the panel's own row order, so what lands in the comp matches what
        // the user sees rather than the order they happened to click. One
        // entry for the whole selection.
        onSelect: () => { void insertMediaEdit(many ? targets : [asset]); },
      },
      {
        // The clip starts where the playhead is parked — assembling order, AE's
        // drag-to-timeline behaviour. Kept as a second verb rather than a mode:
        // both start points are legitimate, and a toggle that silently changes
        // what "Add" means is how a clip lands 40s away from where you looked.
        id: 'add-at-playhead',
        label: many ? `Add ${count} at Playhead` : 'Add at Playhead',
        onSelect: () => { void insertMediaEdit(many ? targets : [asset], { atPlayhead: true }); },
      },
      {
        // AE's canonical first move: the comp takes the clip's size (PAR-
        // corrected), duration and probed frame rate, and the clip lands at
        // full frame. Single-selection only — one comp per gesture; a batch
        // version would open N tabs and bury the user.
        id: 'comp-from-footage',
        label: 'New Comp from Footage',
        disabled: many,
        onSelect: () => { void newCompFromFootageEdit(asset); },
      },
      {
        // The multi-clip counterpart of the row above: the comp still takes the
        // FIRST clip's size, duration and rate, but every selected clip lands
        // in it end-to-end rather than stacked at frame 0.
        id: 'comp-from-clips',
        label: many ? `New Composition from ${count} Clips…` : 'New Composition from Clip…',
        onSelect: () => {
          const chosen = targets.filter((a) => a.type === 'video' || a.type === 'image');
          void runNewCompFromClips(chosen.length > 0 ? chosen : [asset]);
        },
      },
      {
        // Single VIDEO only: the detector needs frames to compare, and a batch
        // version would open N comps and run N decode passes off one click.
        id: 'assemble-from-footage',
        label: 'Assemble from Footage…',
        disabled: many || asset.type !== 'video',
        onSelect: () => { void runAssembleFromFootage({ kind: 'asset', asset }); },
      },
      {
        id: 'open-source-monitor',
        label: 'Open in Source Monitor',
        disabled: many || asset.type === 'image',
        onSelect: () => { openSourceMonitor(asset); },
      },
      {
        id: 'preview',
        label: 'Preview…',
        disabled: many,
        onSelect: () => openFootagePreview(asset),
      },
      {
        id: 'interpret-footage',
        label: 'Interpret Footage… (Ctrl+Alt+G)',
        disabled: many,
        onSelect: () => openInterpretFootage(asset),
      },
      // Offered ONLY when exactly one image/video layer is selected — an entry
      // that is always present and usually fails teaches people not to open
      // the menu. Keyframes, effects and masks on the layer survive; only the
      // pixels change. AE's Alt-drag replace, as a click.
      ...(() => {
        const target = replaceableSelectedLayer();
        if (!target || many || asset.type === 'audio') return [];
        const name = defaultSceneGraph.getNode(target)?.name ?? 'layer';
        return [{
          id: 'use-as-source',
          label: `Use as Source for “${name}”`,
          // `replaceLayerSource` (keep size): undoable, where the old direct write was not.
          onSelect: () => { void replaceSourceWithAsset(target, asset.id); },
        }];
      })(),
      { id: 'sep-org', separator: true },
      { id: 'label', label: 'Label', children: labelMenuItems(targetIds, many ? undefined : asset.label) },
      { id: 'tags', label: 'Edit Tags…', onSelect: () => { void editTags(targets); } },
      // Desktop only — the browser build has no file manager to reveal in,
      // and an item that can never work is worse than no item.
      ...(canRevealAssets()
        ? [{
            id: 'reveal',
            label: revealLabel(),
            disabled: many || !assetDiskPath(asset),
            onSelect: () => { void revealAsset(asset); },
          }]
        : []),
      { id: 'sep-a', separator: true },
      {
        id: 'delete',
        label: many ? `Delete ${count} Assets` : 'Delete',
        danger: true,
        onSelect: () => { void (many ? deleteSelectedAssets() : deleteAsset(asset)); },
      },
    ]);
  };

  const openFolderMenu = (folder: AssetFolder, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { id: 'rename', label: 'Rename', onSelect: () => setRenamingId(folder.id) },
      {
        id: 'new',
        label: 'New Subfolder',
        onSelect: () => {
          void createFolderEdit('New Folder', folder.id).then((id) => {
            if (!id) return;
            // Open the parent, or the folder just created is filed somewhere the
            // user cannot see and the rename box appears attached to nothing.
            setExpandedFolders((cur) => new Set(cur).add(folder.id));
            setRenamingId(id);
          });
        },
      },
      { id: 'sep-f', separator: true },
      { id: 'delete', label: 'Delete', danger: true, onSelect: () => { void deleteFolder(folder); } },
    ]);
  };

  // ── The tree ─────────────────────────────────────────────────────
  //
  // Folders expand IN PLACE, the way Explorer and AE's project panel work.
  const childFolders = (parentId: string | null): AssetFolder[] =>
    folders.filter((f) => (f.parentId ?? null) === parentId);
  /*
   * What the shelf shows.
   *
   * The library means "media I brought in". Operations that duplicate or
   * rasterize scene content still have to create real assets — `source:
   * 'derived'` is that distinction; see `AssetSource`. Hidden rather than
   * removed, and revealable rather than hidden outright.
   */
  const shelfAssets = showDerived ? assets : assets.filter(isLibraryAsset);
  const derivedCount = assets.length - assets.filter(isLibraryAsset).length;

  const q = searchQuery.trim().toLowerCase();
  const filters = { query: q, unusedOnly, type: typeFilter, tag: tagFilter, label: labelFilter };
  const filtering = isFilterActive(filters);
  const searching = q.length > 0;
  // A search or a filter FLATTENS: a tree hides matches inside closed
  // folders, and the one thing a search must not do is answer "no results"
  // because the result was behind a disclosure triangle.
  const flat = searching || filtering;
  const visibleAssets = useMemo(
    () => sortAssets(filterAssets(shelfAssets, filters, usedCount), sortKey, sortDir, usedCount),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shelfAssets, q, unusedOnly, typeFilter, tagFilter, labelFilter, sortKey, sortDir, usage],
  );

  /*
   * Reveal what just arrived — see the header comment. The diff is against
   * the ids seen on the previous render, so the FIRST render (whatever the
   * store already holds) reveals nothing; after that, a library asset with a
   * fresh `importedAt` is an import, wherever it came from.
   */
  const seenIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const prev = seenIdsRef.current;
    seenIdsRef.current = new Set(assets.map((a) => a.id));
    if (!prev) return;
    const now = Date.now();
    const fresh = assets.filter((a) =>
      !prev.has(a.id) && isLibraryAsset(a) && a.importedAt !== undefined && now - a.importedAt < IMPORT_REVEAL_WINDOW_MS);
    if (fresh.length === 0) return;
    const first = fresh[0];
    if (!first) return;

    // A filter or search that would drop any of them is cleared — the one
    // thing an import must not do is disappear — and the row says why.
    if (filterAssets(fresh, filters, usedCount).length < fresh.length) {
      clearFilters();
      setSearchQuery('');
      setFilterNote('Filters cleared to show the import');
    }
    // Open every folder on the way down to each file.
    const toOpen = new Set<string>();
    for (const a of fresh) {
      let id = a.folderId ?? null;
      while (id) {
        toOpen.add(id);
        id = folders.find((f) => f.id === id)?.parentId ?? null;
      }
    }
    if (toOpen.size > 0) setExpandedFolders((cur) => new Set([...cur, ...toOpen]));
    setSelectedAssetIds(new Set(fresh.map((a) => a.id)));
    setSelectionAnchor(first.id);
    // The focused row is the one the list scrolls to.
    setFocusedAssetId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets]);

  // The note is transient: long enough to read, gone before it nags.
  useEffect(() => {
    if (!filterNote) return;
    const t = setTimeout(() => setFilterNote(null), FILTER_NOTE_MS);
    return () => clearTimeout(t);
  }, [filterNote]);

  // Grid geometry from the measured host. Columns first, then the card
  // height that a 16:9 well at that width implies.
  const cols = view === 'grid' ? Math.max(2, Math.floor((hostSize.width - GRID_PAD + GRID_GAP) / (CARD_MIN_W + GRID_GAP))) : 1;
  const cardW = view === 'grid' && hostSize.width > 0 ? (hostSize.width - GRID_PAD - (cols - 1) * GRID_GAP) / cols : 120;
  const cardRowH = Math.round((cardW * 9) / 16 + CARD_CHROME_H);

  const rows = useMemo<AssetRow[]>(() => {
    const out: AssetRow[] = [];
    const pushAssets = (list: ImportedAsset[], depth: number, folderId?: string | null): void => {
      if (view === 'grid') {
        for (let i = 0; i < list.length; i += cols) {
          const chunk = list.slice(i, i + cols);
          out.push({
            kind: 'cards',
            key: `cards:${depth}:${folderId ?? 'root'}:${chunk[0]!.id}`,
            depth,
            folderId: folderId ?? null,
            assets: chunk,
          });
        }
      } else {
        for (const a of list) out.push({ kind: 'asset', key: a.id, depth, asset: a });
      }
    };
    if (flat) {
      pushAssets(visibleAssets, 0, null);
      return out;
    }
    const build = (parentId: string | null, depth: number): void => {
      for (const f of childFolders(parentId)) {
        const folderAssets = visibleAssets.filter((a) => (a.folderId ?? null) === f.id);
        out.push({ kind: 'folder', key: f.id, depth, folder: f, count: folderAssets.length });
        // Closed folders contribute nothing — that is what makes this a tree
        // rather than an indented flat list.
        if (expandedFolders.has(f.id)) {
          build(f.id, depth + 1);
          if (view === 'grid' && folderAssets.length === 0) {
            out.push({ kind: 'empty-folder', key: `empty:${f.id}`, depth: depth + 1, folder: f });
          } else {
            pushAssets(folderAssets, depth + 1, f.id);
          }
        }
      }
      if (parentId === null) {
        const rootAssets = visibleAssets.filter((a) => (a.folderId ?? null) === null);
        if (rootAssets.length > 0) {
          if (view === 'grid' && folders.length > 0) {
            out.push({ kind: 'section', key: 'section:root-media', depth: 0, title: `Media (${rootAssets.length})` });
          }
          pushAssets(rootAssets, 0, null);
        }
      }
    };
    build(null, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleAssets, folders, expandedFolders, flat, view, cols]);

  const isEmpty = rows.length === 0;
  /** Asset ids in the order they are DRAWN — what Shift-range walks over. */
  const orderedAssetIds = useMemo(
    () => rows.flatMap((r) => (r.kind === 'asset' ? [r.key] : r.kind === 'cards' ? r.assets.map((a) => a.id) : [])),
    [rows],
  );
  const rowIndexOfAsset = (id: string | null): number =>
    id === null ? -1 : rows.findIndex((r) => (r.kind === 'asset' && r.key === id) || (r.kind === 'cards' && r.assets.some((a) => a.id === id)));

  const scrollToIndex = useMemo(() => {
    if (scrollToKey) {
      const idx = rows.findIndex((r) => r.key === scrollToKey);
      if (idx !== -1) return idx;
    }
    return rowIndexOfAsset(focusedAssetId);
  }, [rows, scrollToKey, focusedAssetId]);

  const singleSelectedAsset = selectedAssetIds.size === 1
    ? assets.find((x) => x.id === [...selectedAssetIds][0]) ?? null
    : null;

  /*
    Publish the selection for the commands that act on it — "New Composition
    from Selected Clips", "Assemble from Footage", "Reveal in Explorer" are
    registry commands, so they run from the palette and the menu bar.
    Published in ROW order, the same order "Add N to Composition" uses.
  */
  const selectionKey = orderedAssetIds.filter((id) => selectedAssetIds.has(id)).join(',');
  useEffect(() => {
    setPanelAssetSelection(selectionKey ? selectionKey.split(',') : []);
  }, [selectionKey]);

  /** Keyboard traversal: Up/Down walk rows; in the grid Left/Right walk cards. */
  const moveFocus = (delta: number): void => {
    setScrollToKey(null);
    if (orderedAssetIds.length === 0) return;
    const cur = focusedAssetId ? orderedAssetIds.indexOf(focusedAssetId) : -1;
    const next = cur === -1 ? (delta > 0 ? 0 : orderedAssetIds.length - 1) : Math.min(orderedAssetIds.length - 1, Math.max(0, cur + delta));
    const id = orderedAssetIds[next];
    if (!id) return;
    setFocusedAssetId(id);
    setSelectedAssetIds(new Set([id]));
    setSelectionAnchor(id);
  };

  const usedBy = singleSelectedAsset
    ? (usage.get(singleSelectedAsset.id) ?? []).map((id) => ({ id, name: defaultSceneGraph.getNode(id)?.name ?? id }))
    : [];

  const sortItems: DropdownItem[] = [
    { type: 'label', label: 'Sort by' },
    ...(Object.keys(SORT_LABEL) as AssetSortKey[]).map((key): DropdownItem => ({
      type: 'item',
      id: key,
      label: SORT_LABEL[key],
      icon: sortKey === key ? 'check' : undefined,
      onSelect: () => sortBy(key),
    })),
    { type: 'separator' },
    {
      type: 'item',
      id: 'dir',
      label: sortDir === 'asc' ? 'Ascending' : 'Descending',
      icon: sortDir === 'asc' ? 'arrow-up' : 'arrow-down',
      onSelect: () => setSort(sortKey, sortDir === 'asc' ? 'desc' : 'asc'),
    },
  ];

  const headBtn = (key: AssetSortKey, label: string, className: string | undefined): JSX.Element => (
    <button
      type="button"
      className={`${className} ${styles.assetHeadBtn}${sortKey === key ? ` ${styles.assetHeadBtnActive}` : ''}`}
      onClick={() => sortBy(key)}
      title={`Sort by ${SORT_LABEL[key].toLowerCase()}`}
      aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      {label}
      {sortKey === key && <Icon name={sortDir === 'asc' ? 'chevron-up' : 'chevron-down'} size="sm" />}
    </button>
  );

  const renderFolderRow = (row: Extract<AssetRow, { kind: 'folder' }>): JSX.Element => {
    const isGrid = view === 'grid';
    const isExpanded = expandedFolders.has(row.folder.id);
    const isDropTarget = dropFolderId === row.folder.id;
    const isCurrent = currentFolderId === row.folder.id;

    if (isGrid) {
      return (
        <div
          role="treeitem"
          aria-expanded={isExpanded}
          className={`${styles.assetGridFolder}${isDropTarget ? ` ${styles.dropActive}` : ''}${isCurrent ? ` ${styles.assetGridFolderActive}` : ''}`}
          style={{ marginLeft: 8 + row.depth * 12, marginRight: 8 }}
          title={row.folder.name}
          onClick={() => {
            if (renamingId === row.folder.id) return;
            setCurrentFolderId(row.folder.id);
            toggleFolder(row.folder.id);
            setSelectedAssetIds(new Set());
            setSelectionAnchor(null);
          }}
          onContextMenu={(e) => openFolderMenu(row.folder, e)}
          onDragOver={(e) => { e.preventDefault(); setDropFolderId(row.folder.id); }}
          onDragLeave={() => setDropFolderId((cur) => (cur === row.folder.id ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            const assetId = e.dataTransfer.getData('text/asset-id');
            if (assetId) void moveItemsEdit([assetId], row.folder.id);
            setDropFolderId(null);
          }}
        >
          <Icon
            name={isExpanded ? 'chevron-down' : 'chevron-right'}
            size="sm"
            className={styles.assetTwisty}
          />
          <Icon
            name={isExpanded ? 'folder-open' : 'folder'}
            size="md"
            className={styles.assetGlyphFolder}
            style={{ color: FOLDER_COLOR }}
          />
          {renamingId === row.folder.id ? (
            <input
              ref={(el) => {
                if (el) {
                  el.focus();
                  el.select();
                }
              }}
              defaultValue={row.folder.name}
              className={styles.assetRename}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const val = e.target.value.trim();
                if (val) void renameItemEdit(row.folder.id, val);
                setRenamingId(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) void renameItemEdit(row.folder.id, val);
                  setRenamingId(null);
                }
                if (e.key === 'Escape') setRenamingId(null);
              }}
            />
          ) : (
            <span className={styles.assetRowName} title={row.folder.name}>{row.folder.name}</span>
          )}
          <span className={styles.assetGridFolderBadge}>
            {row.count > 0 ? `${row.count} ${row.count === 1 ? 'item' : 'items'}` : 'Empty'}
          </span>
        </div>
      );
    }

    return (
      <div
        role="treeitem"
        aria-expanded={isExpanded}
        className={`${styles.assetRow}${isDropTarget ? ` ${styles.dropActive}` : ''}${isCurrent ? ` ${styles.assetRowActive}` : ''}`}
        style={{ paddingLeft: 8 + row.depth * 16 }}
        title={row.folder.name}
        onClick={() => {
          if (renamingId === row.folder.id) return;
          setCurrentFolderId(row.folder.id);
          toggleFolder(row.folder.id);
          setSelectedAssetIds(new Set());
          setSelectionAnchor(null);
        }}
        onContextMenu={(e) => openFolderMenu(row.folder, e)}
        onDragOver={(e) => { e.preventDefault(); setDropFolderId(row.folder.id); }}
        onDragLeave={() => setDropFolderId((cur) => (cur === row.folder.id ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          const assetId = e.dataTransfer.getData('text/asset-id');
          if (assetId) void moveItemsEdit([assetId], row.folder.id);
          setDropFolderId(null);
        }}
      >
        <Icon
          name={isExpanded ? 'chevron-down' : 'chevron-right'}
          size="sm"
          className={styles.assetTwisty}
        />
        <Icon
          name={isExpanded ? 'folder-open' : 'folder'}
          size="md"
          className={styles.assetGlyphFolder}
          style={{ color: FOLDER_COLOR }}
        />
        {renamingId === row.folder.id ? (
          <input
            ref={(el) => {
              if (el) {
                el.focus();
                el.select();
              }
            }}
            defaultValue={row.folder.name}
            className={styles.assetRename}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const val = e.target.value.trim();
              if (val) void renameItemEdit(row.folder.id, val);
              setRenamingId(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                const val = (e.target as HTMLInputElement).value.trim();
                if (val) void renameItemEdit(row.folder.id, val);
                setRenamingId(null);
              }
              if (e.key === 'Escape') setRenamingId(null);
            }}
          />
        ) : (
          <span className={styles.assetRowName} title={row.folder.name}>{row.folder.name}</span>
        )}
        <span className={styles.assetRowType}>Folder</span>
        <span className={styles.assetRowSize} />
      </div>
    );
  };

  const renderEmptyFolderRow = (row: Extract<AssetRow, { kind: 'empty-folder' }>): JSX.Element => (
    <div
      className={`${styles.assetGridEmptyFolder}${dropFolderId === row.folder.id ? ` ${styles.dropActive}` : ''}`}
      style={{ marginLeft: 8 + (row.depth - 1) * 12, marginRight: 8 }}
      onDragOver={(e) => { e.preventDefault(); setDropFolderId(row.folder.id); }}
      onDragLeave={() => setDropFolderId((cur) => (cur === row.folder.id ? null : cur))}
      onDrop={(e) => {
        e.preventDefault();
        const assetId = e.dataTransfer.getData('text/asset-id');
        if (assetId) void moveItemsEdit([assetId], row.folder.id);
        setDropFolderId(null);
      }}
    >
      <Icon name="folder-open" size="sm" />
      <span>Folder is empty · Drop files here</span>
    </div>
  );

  const renderSectionHeaderRow = (row: Extract<AssetRow, { kind: 'section' }>): JSX.Element => (
    <div className={styles.assetGridSectionHeader}>
      <span>{row.title}</span>
      <span className={styles.assetGridSectionHeaderLine} aria-hidden />
    </div>
  );

  const labelColorOf = (asset: ImportedAsset): string | undefined =>
    asset.label ? LABEL_COLORS.find((c) => c.id === asset.label)?.color : undefined;

  const dragHandlers = (asset: ImportedAsset) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/asset-id', asset.id);
      setCanvasDrag(e, { kind: 'asset', assetId: asset.id });
    },
  });

  const renderAssetRow = (row: Extract<AssetRow, { kind: 'asset' }>): JSX.Element => {
    const { asset } = row;
    const visual = getAssetVisualInfo(asset);
    const label = labelColorOf(asset);
    return (
      <div
        role="treeitem"
        aria-selected={selectedAssetIds.has(asset.id)}
        className={`${styles.assetRow}${selectedAssetIds.has(asset.id) ? ` ${styles.assetRowSelected}` : ''}`}
        style={{ paddingLeft: 8 + row.depth * 16 + (flat ? 0 : 16) }}
        title={asset.tags?.length ? `${asset.name}\nTags: ${asset.tags.join(', ')}` : asset.name}
        data-focused={focusedAssetId === asset.id || undefined}
        onClick={(e) => selectAsset(asset.id, e, orderedAssetIds)}
        onDoubleClick={() => openFootagePreview(asset)}
        onContextMenu={(e) => openAssetMenu(asset, e)}
        {...dragHandlers(asset)}
      >
        <AssetThumb asset={asset} variant="row" />
        {label && <span className={styles.assetLabelDot} style={{ background: label }} aria-hidden />}
        <span className={styles.assetRowName}>{asset.name}</span>
        {asset.tags && asset.tags.length > 0 && (
          <span className={styles.assetRowTags} aria-label={`Tags: ${asset.tags.join(', ')}`}>
            {asset.tags.slice(0, 2).map((t) => (
              <Chip key={t} size="sm" selected={tagFilter === t} onSelect={() => setTagFilter(tagFilter === t ? null : t)}>{t}</Chip>
            ))}
            {asset.tags.length > 2 && <span className={styles.assetRowUsed}>+{asset.tags.length - 2}</span>}
          </span>
        )}
        <span className={styles.assetRowType}>{visual.label}</span>
        <span className={styles.assetRowSize}>{formatBytes(asset.size)}</span>
      </div>
    );
  };

  const renderCardsRow = (row: Extract<AssetRow, { kind: 'cards' }>): JSX.Element => {
    const inFolder = row.depth > 0 || row.folderId !== null;
    return (
      <div
        className={`${styles.assetGridRow}${inFolder ? ` ${styles.assetGridRowFolder}` : ''}`}
        style={{ '--asset-grid-cols': cols } as React.CSSProperties}
        role="row"
      >
        {row.assets.map((asset) => {
          const visual = getAssetVisualInfo(asset);
          const label = labelColorOf(asset);
          const selected = selectedAssetIds.has(asset.id);
          return (
            <div
              key={asset.id}
              role="treeitem"
              aria-selected={selected}
              className={`${styles.assetCard}${selected ? ` ${styles.assetCardSelected}` : ''}`}
              title={asset.tags?.length ? `${asset.name}\nTags: ${asset.tags.join(', ')}` : asset.name}
              data-focused={focusedAssetId === asset.id || undefined}
              onClick={(e) => selectAsset(asset.id, e, orderedAssetIds)}
              onDoubleClick={() => openFootagePreview(asset)}
              onContextMenu={(e) => openAssetMenu(asset, e)}
              {...dragHandlers(asset)}
            >
              {label && <span className={styles.assetCardStripe} style={{ background: label }} aria-hidden />}
              <AssetThumb asset={asset} variant="card" scrub />
              <span className={styles.assetCardName}>{asset.name}</span>
              <span className={styles.assetCardMeta}>
                <span>{visual.label}</span>
                <span>·</span>
                <span>{formatBytes(asset.size)}</span>
                {usedCount(asset.id) > 0 && <span title={`Used by ${usedCount(asset.id)} layer${usedCount(asset.id) === 1 ? '' : 's'}`}>· ×{usedCount(asset.id)}</span>}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  const browseAvailable = canBrowseMedia();

  return (
    <Panel
      id="assets"
      title="Assets"
      icon="media"
      hideHeader
      noScroll
      className={styles.assetPanelRoot}
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'assets' })}
    >
      {/* Project / Media Browser. The Media Browser needs the desktop shell;
          the web build never renders the strip at all rather than showing one
          tab. Ids stay `bin` / `browse` — the stores and the tour key on them. */}
      {browseAvailable && (
        <ScrollableStrip
          role="tablist"
          ariaLabel="Assets views"
          className={styles.libTabsWrap}
          scrollClassName={styles.libTabs}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'bin'}
            className={tab === 'bin' ? styles.libTabActive : styles.libTab}
            title="Assets — the files this project has imported. Saved with the project."
            onClick={() => setTab('bin')}
          >
            <Icon name="media" size="sm" />
            <span>Assets</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'browse'}
            className={tab === 'browse' ? styles.libTabActive : styles.libTab}
            title="Media Browser — a folder on disk you can drag from. Nothing is imported until you drop it."
            onClick={() => setTab('browse')}
          >
            <Icon name="folder" size="sm" />
            <span>Media Browser</span>
          </button>
        </ScrollableStrip>
      )}

      {browseAvailable && tab === 'browse' ? (
        <MediaBrowser />
      ) : (
        <div className={styles.assetShell}>
          <div className={styles.assetSearchRow}>
            <SearchField
              placeholder="Search assets…"
              ariaLabel="Search assets"
              fullWidth
              size="sm"
              value={searchQuery}
              onChange={setSearchQuery}
            />
          </div>

          <div className={styles.assetToolbarRow}>
            <div className={styles.assetToolbarGroup}>
              <span className={styles.assetImportSplit} role="group" aria-label="Import">
                <button
                  type="button"
                  className={styles.assetImportMain}
                  title="Import files into the project (they are not added to the composition)"
                  onClick={openImportFiles}
                >
                  <Icon name="upload" size="sm" />
                  <span>Import</span>
                </button>
                <div className={styles.assetImportDivider} />
                <Dropdown
                  placement="bottom-start"
                  trigger={
                    <button
                      type="button"
                      className={styles.assetImportMore}
                      aria-label="More import options"
                      title="More import options"
                    >
                      <Icon name="chevron-down" size="sm" />
                    </button>
                  }
                  items={[
                    { type: 'item', id: 'files', label: 'Import Files…', icon: 'upload', onSelect: openImportFiles },
                    { type: 'item', id: 'folder', label: 'Import Folder…', icon: 'folder-open', onSelect: () => folderInputRef.current?.click() },
                    { type: 'separator' },
                    { type: 'item', id: 'model', label: 'Import 3D Model…', icon: 'cube', onSelect: () => modelInputRef.current?.click() },
                    { type: 'separator' },
                    // Also in the bottom dock and the list's right-click menu;
                    // here because the dock is the first thing a short panel
                    // scrolls out of view, and "I can't make a folder" was the
                    // report that followed.
                    { type: 'item', id: 'new-folder', label: 'New Folder', icon: 'folder-plus', onSelect: handleNewFolder },
                  ]}
                />
              </span>
            </div>

            <div className={styles.assetToolbarGroup}>
              <Dropdown
                placement="bottom-end"
                trigger={
                  <button
                    type="button"
                    className={styles.assetToolbarBtn}
                    title={`Sorted by ${SORT_LABEL[sortKey].toLowerCase()}, ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
                    aria-label="Sort assets"
                  >
                    <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" />
                  </button>
                }
                items={sortItems}
              />
              <Segmented
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { value: 'list', label: <Icon name="menu" size="sm" />, ariaLabel: 'List view' },
                  { value: 'grid', label: <Icon name="grid" size="sm" />, ariaLabel: 'Grid view' },
                ]}
              />
            </div>
          </div>
          {filterNote && (
            <div className={styles.assetNote} role="status">{filterNote}</div>
          )}

          {/* Hidden file inputs for media and folder imports */}
          <input
            type="file"
            ref={fileInputRef}
            className={styles.fileInput}
            multiple
            accept="image/*,video/*,audio/*,.exr,.dpx,.psd,.dng,.cr2,.cr3,.nef,.arw,.mxf,.mkv,.avi,.mts,.m2ts,.r3d,.braw,.glb,.gltf"
            onChange={handleFileChange}
          />
          <input
            type="file"
            ref={folderInputRef}
            className={styles.fileInput}
            multiple
            onChange={handleFolderChange}
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          />
          {/* `multiple` and the sidecar extensions, because a .gltf is never one
              file — see the note on `modelInputRef`. Same handler as the media
              input above; only the filter differs. */}
          <input
            type="file"
            ref={modelInputRef}
            className={styles.fileInput}
            multiple
            accept=".glb,.gltf,.bin,image/png,image/jpeg,image/webp,image/ktx2"
            onChange={handleFileChange}
          />

          {/* Column headings, as in Explorer's details view. Buttons: click sorts. */}
          {view === 'list' && (
            <div className={styles.assetHead}>
              {headBtn('name', 'Name', styles.assetHeadName)}
              {headBtn('type', 'Type', styles.assetHeadType)}
              {headBtn('size', 'Size', styles.assetHeadSize)}
            </div>
          )}

          {/*
            Del deletes the selection, Ctrl/Cmd+A takes all of it, Escape drops it,
            the arrows walk it.
          */}
          <div
            ref={hostRef}
            className={`${styles.assetListHost}${osDropActive ? ` ${styles.assetListHostDrop}` : ''}`}
            tabIndex={0}
            role="tree"
            aria-label="Assets"
            data-shortcut-claim="delete backspace Ctrl+a Meta+a Ctrl+Alt+g Meta+Alt+g"
            data-tour="assets-panel"
            // OS files onto the list = import to the project, no insert.
            // Folder rows handle their own asset-move drops; they carry no
            // files, so the guard below leaves them alone.
            onDragOver={(e) => {
              if (!Array.from(e.dataTransfer.types).includes('Files')) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setOsDropActive(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setOsDropActive(false);
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget || (styles.empty && (e.target as HTMLElement).classList.contains(styles.empty))) {
                setSelectedAssetIds(new Set());
                setSelectionAnchor(null);
                setCurrentFolderId(null);
                setScrollToKey(null);
              }
            }}
            onContextMenu={(e) => {
              if (e.target === e.currentTarget || (styles.empty && (e.target as HTMLElement).classList.contains(styles.empty))) {
                e.preventDefault();
                e.stopPropagation();
                openContextMenu(e.clientX, e.clientY, [
                  { id: 'new-folder', label: 'New Folder', onSelect: handleNewFolder },
                  { id: 'sep-e1', separator: true },
                  { id: 'import-files', label: 'Import Files…', onSelect: openImportFiles },
                  { id: 'import-folder', label: 'Import Folder…', onSelect: () => folderInputRef.current?.click() },
                ]);
              }
            }}
            onDrop={(e) => {
              setOsDropActive(false);
              const files = e.dataTransfer.files;
              if (!files || files.length === 0) return;
              e.preventDefault();
              void handleOsDrop(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selectedAssetIds.size === 0 && !currentFolderId) return;
                e.preventDefault();
                e.stopPropagation();
                if (selectedAssetIds.size > 0) {
                  void deleteSelectedAssets();
                } else if (currentFolderId) {
                  const f = folders.find((x) => x.id === currentFolderId);
                  if (f) void deleteFolder(f);
                }
                return;
              }
              if (e.key === 'F2' && currentFolderId && selectedAssetIds.size === 0) {
                e.preventDefault();
                e.stopPropagation();
                setRenamingId(currentFolderId);
                return;
              }
              if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'g' || e.key === 'G')) {
                if (singleSelectedAsset) {
                  e.preventDefault();
                  e.stopPropagation();
                  openInterpretFootage(singleSelectedAsset);
                  return;
                }
              }
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                e.stopPropagation();
                setSelectedAssetIds(new Set(orderedAssetIds));
                return;
              }
              if (e.key === 'Escape' && selectedAssetIds.size > 0) {
                e.preventDefault();
                setSelectedAssetIds(new Set());
                setSelectionAnchor(null);
                return;
              }
              if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(view === 'grid' ? cols : 1); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(view === 'grid' ? -cols : -1); return; }
              if (view === 'grid' && e.key === 'ArrowRight') { e.preventDefault(); moveFocus(1); return; }
              if (view === 'grid' && e.key === 'ArrowLeft') { e.preventDefault(); moveFocus(-1); return; }
              if (e.key === 'Enter' && singleSelectedAsset) { e.preventDefault(); openFootagePreview(singleSelectedAsset); }
            }}
          >
            {isEmpty ? (
              <div className={styles.empty}>
                {flat ? (
                  'No matching assets found.'
                ) : (
                  <>
                    <p className={styles.emptyLead}>Nothing imported yet. Import files, or drag them here.</p>
                    <p className={styles.emptyNote}>
                      Imports go to this list; add them to the composition by dragging onto the canvas or the timeline.
                    </p>
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Icon name="upload" size="sm" />}
                      onClick={openImportFiles}
                    >
                      Import
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <VirtualList
                items={rows}
                itemHeight={LIST_ROW_H}
                getItemHeight={(row) => {
                  if (row.kind === 'cards') return cardRowH;
                  if (row.kind === 'folder') return view === 'grid' ? 34 : FOLDER_ROW_H;
                  if (row.kind === 'empty-folder') return 38;
                  if (row.kind === 'section') return 28;
                  return LIST_ROW_H;
                }}
                height={hostSize.height > 0 ? hostSize.height : '100%'}
                scrollToIndex={scrollToIndex}
                itemKey={(row) => row.key}
                renderItem={(row) => {
                  switch (row.kind) {
                    case 'folder':
                      return renderFolderRow(row);
                    case 'empty-folder':
                      return renderEmptyFolderRow(row);
                    case 'section':
                      return renderSectionHeaderRow(row);
                    case 'asset':
                      return renderAssetRow(row);
                    case 'cards':
                      return renderCardsRow(row);
                  }
                }}
              />
            )}
          </div>

          <div className={styles.assetBottomSection}>
            <AssetDrawer
              asset={singleSelectedAsset}
              selectionCount={selectedAssetIds.size}
              open={drawerOpen}
              onToggle={() => setDrawerOpen(!drawerOpen)}
              usedBy={usedBy}
              onSelectLayer={(id) => useSelectionStore.getState().set([id])}
              onSetTags={setTags}
            />

            {/* AE Project Bottom Action Dock */}
            <div className={styles.assetBottomDock}>
              <button
                type="button"
                className={`${styles.dockBtn}${dockCompDropActive ? ` ${styles.dockBtnDropActive}` : ''}`}
                disabled={!singleSelectedAsset || singleSelectedAsset.type === 'audio'}
                title="Create New Composition from Footage (or drag & drop footage here)"
                onClick={() => {
                  if (singleSelectedAsset) void newCompFromFootageEdit(singleSelectedAsset);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDockCompDropActive(true);
                }}
                onDragLeave={() => setDockCompDropActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDockCompDropActive(false);
                  const assetId = e.dataTransfer.getData('text/asset-id');
                  const dropped = assets.find((a) => a.id === assetId);
                  if (dropped && dropped.type !== 'audio') void newCompFromFootageEdit(dropped);
                }}
              >
                <Icon name="component" size="sm" className={singleSelectedAsset && singleSelectedAsset.type !== 'audio' ? styles.assetGlyphComp : undefined} />
              </button>

              <button
                type="button"
                className={styles.dockBtn}
                title="New Folder"
                aria-label="New Folder"
                onClick={handleNewFolder}
              >
                <Icon name="folder-plus" size="sm" style={{ color: FOLDER_COLOR }} />
              </button>

              {/* The two verbs that put a clip in the edit, as buttons. They
                  existed only in the right-click menu and the footage dialog,
                  and "I imported it but can't add it" was the result: a bin
                  with no visible way from the list to the comp. */}
              <button
                type="button"
                className={styles.dockBtn}
                disabled={selectedAssetIds.size === 0}
                title={selectedAssetIds.size > 1 ? `Add ${selectedAssetIds.size} selected to composition` : 'Add selected asset to composition'}
                aria-label="Add to composition"
                onClick={() => {
                  void insertMediaEdit(assets.filter((a) => selectedAssetIds.has(a.id)));
                }}
              >
                <Icon name="plus" size="sm" />
              </button>
              <button
                type="button"
                className={styles.dockBtn}
                disabled={selectedAssetIds.size === 0}
                title={selectedAssetIds.size > 1 ? `Add ${selectedAssetIds.size} selected at playhead` : 'Add selected asset at the playhead'}
                aria-label="Add at playhead"
                onClick={() => {
                  void insertMediaEdit(assets.filter((a) => selectedAssetIds.has(a.id)), { atPlayhead: true });
                }}
              >
                <Icon name="stopwatch" size="sm" />
              </button>

              {/* No import buttons here: the header's Import is the one door. */}

              {derivedCount > 0 && (
                <button
                  type="button"
                  className={`${styles.dockBtn}${showDerived ? ` ${styles.dockBtnDropActive}` : ''}`}
                  onClick={() => setShowDerived((v) => !v)}
                  title={
                    showDerived
                      ? 'Hide generated images (duplicates and rasterized copies)'
                      : `Show ${derivedCount} generated image${derivedCount === 1 ? '' : 's'} — duplicates and rasterized copies made by effects and plugins`
                  }
                >
                  <Icon name="sparkles" size="sm" />
                </button>
              )}

              <button
                type="button"
                className={styles.dockBtn}
                disabled={!singleSelectedAsset}
                title="Interpret Footage… (Ctrl+Alt+G)"
                onClick={() => {
                  if (singleSelectedAsset) openInterpretFootage(singleSelectedAsset);
                }}
              >
                <Icon name="sliders-h" size="sm" />
              </button>

              <button
                type="button"
                className={`${styles.dockBtn} ${styles.dockBtnEnd}`}
                disabled={selectedAssetIds.size === 0 && !currentFolderId}
                title={
                  selectedAssetIds.size === 0
                    ? currentFolderId
                      ? 'Delete selected folder (Del)'
                      : 'Delete selected asset(s) (Del)'
                    : `Delete Selected Asset${selectedAssetIds.size > 1 ? 's' : ''} (Del)`
                }
                onClick={() => {
                  if (selectedAssetIds.size > 0) {
                    void deleteSelectedAssets();
                  } else if (currentFolderId) {
                    const f = folders.find((x) => x.id === currentFolderId);
                    if (f) void deleteFolder(f);
                  }
                }}
              >
                <Icon name="trash" size="sm" />
              </button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
