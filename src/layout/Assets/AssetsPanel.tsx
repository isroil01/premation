/**
 * AssetsPanel — the project bin: one unified media list (images, video and
 * audio together, no type tabs) organised into user folders.
 *
 * What lives here is MEDIA. Compositions are the Scene panel's, deliberately:
 * a bin that lists both is a bin where "delete" means two different things.
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
 * against it. `handleFileChange` routes all of that, and the header's
 * "Import 3D model" button hands it the same selection with a model-shaped
 * `accept` — one routing, two entry points.
 *
 * Panel chrome comes from the shared `EditorLayout/panels.module.css`, which
 * the Scene, Assets and Inspector panels all draw from.
 */

import { useEffect, useRef, useState } from 'react';
import { Panel } from '@components/Panel';
import { SearchField } from '@components/SearchField';
import { Icon } from '@components/Icon';
import { customConfirm } from '@components/Modal';
import { isLibraryAsset, useAssetStore, type AssetFolder, type ImportedAsset } from '@stores/assetStore';
import { getAssetVisualInfo, FOLDER_COLOR } from '@layout/Assets/assetVisuals';
import { openSourceMonitor } from '@stores/sourceMonitorStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { useUIStore } from '@stores/uiStore';
import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertMedia } from '@core/scene/sceneInsert';
import { insertMediaAtPlayhead, retargetLayerSource, replaceableSelectedLayer } from '@core/scene/footageWorkflow';
import { createCompositionFromFootage } from '@core/composition/compositionOps';
import { setPanelAssetSelection } from '@core/composition/assetSelection';
import { openFootagePreview } from '@layout/Assets/FootagePreviewDialog';
import { openInterpretFootage } from '@layout/Assets/InterpretFootageModal';
import { runNewCompFromClips, runAssembleFromFootage } from '@layout/Assets/footageAssembly';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import styles from '@layout/EditorLayout/panels.module.css';

/** Human-readable file size for the Size column and the header card. */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + (sizes[i] ?? '');
}

export function AssetsPanel(): JSX.Element {
  const assets = useAssetStore((s) => s.assets);
  const folders = useAssetStore((s) => s.folders);
  const addAssetsBatch = useAssetStore((s) => s.addAssetsBatch);
  const removeAsset = useAssetStore((s) => s.removeAsset);
  const removeAssets = useAssetStore((s) => s.removeAssets);
  const createFolder = useAssetStore((s) => s.createFolder);
  const renameFolder = useAssetStore((s) => s.renameFolder);
  const removeFolder = useAssetStore((s) => s.removeFolder);
  const moveAssetToFolder = useAssetStore((s) => s.moveAssetToFolder);

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
  const [searchQuery, setSearchQuery] = useState('');
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
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

  /** Anchor for Shift-range selection — the last row clicked without Shift. */
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);

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

  // Import loose files into the current folder and drop them on the canvas.
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
    const created = await addAssetsBatch(items);
    // Sequential, awaited: insertMedia ends by selecting what it created and
    // bumping the scene, so N un-awaited inserts raced — the final selection
    // depended on decode order and failures were unhandled rejections.
    for (const a of created) await insertMedia(a);
    e.target.value = '';
  };

  // Import a whole directory: recreate its folder structure under the current
  // folder (via webkitRelativePath) and file each asset into the matching leaf.
  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // Cache of "relative path → folderId" so shared parents are created once.
    const pathToId = new Map<string, string | null>();
    pathToId.set('', currentFolderId);
    const ensureFolder = (segments: string[]): string | null => {
      let parentId = currentFolderId;
      let key = '';
      for (const seg of segments) {
        key = key ? `${key}/${seg}` : seg;
        if (!pathToId.has(key)) {
          const created = createFolder(seg, parentId);
          pathToId.set(key, created.id);
        }
        parentId = pathToId.get(key) ?? null;
      }
      return parentId;
    };
    const items: Array<{ file: File; folderId: string | null }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const parts = rel.split('/');
      // Recreate the full picked structure: "MyPack/logos/a.png" → folders
      // "MyPack" then "MyPack/logos", with a.png filed in the leaf.
      const folderSegments = parts.slice(0, -1);
      const targetFolder = ensureFolder(folderSegments);
      items.push({ file, folderId: targetFolder });
    }
    if (items.length > 0) {
      await addAssetsBatch(items);
    }
    e.target.value = '';
  };

  const handleNewFolder = () => {
    // Auto-name (Electron has no window.prompt); rename inline afterwards.
    const siblings = folders.filter((f) => f.parentId === currentFolderId);
    const base = 'New Folder';
    let name = base;
    let n = 2;
    while (siblings.some((f) => f.name === name)) name = `${base} ${n++}`;
    const created = createFolder(name, currentFolderId);
    setRenamingId(created.id);
  };

  /*
   * Confirmed deletes.
   *
   * Both are reached only from the right-click menu now, so a confirm is the
   * one guard between "opened a menu" and "the file is gone" — there is no
   * undo for an asset removal.
   */
  const deleteAsset = async (asset: ImportedAsset): Promise<void> => {
    const ok = await customConfirm(
      `Delete “${asset.name}”`,
      'This removes the asset from the project. This can’t be undone.',
      { confirmLabel: 'Delete', isDanger: true },
    );
    if (ok) removeAsset(asset.id);
  };

  /**
   * Delete the whole selection.
   *
   * The panel has supported Ctrl- and Shift-click since it was written, so a
   * user could always SELECT twenty files — there was just no way to act on
   * that selection, and the only delete on offer removed the one row under the
   * cursor. Selecting many and deleting one is the kind of gap that reads as
   * the selection not having worked.
   *
   * Names are listed up to a point and then counted. A confirm that renders
   * fifty filenames is a confirm nobody reads, and this is the dialog standing
   * in front of an action with no undo.
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
      `${shown}${rest > 0 ? `\n…and ${rest} more` : ''}\n\nThis removes them from the project. This can’t be undone.`,
      { confirmLabel: `Delete ${ids.length}`, isDanger: true },
    );
    if (!ok) return;
    removeAssets(ids);
    setSelectedAssetIds(new Set());
    setSelectionAnchor(null);
  };

  const deleteFolder = async (folder: AssetFolder): Promise<void> => {
    const assetCount = assets.filter((a) => a.folderId === folder.id).length;
    const subCount = folders.filter((f) => f.parentId === folder.id).length;
    const ok = await customConfirm(
      `Delete “${folder.name}”`,
      assetCount || subCount
        ? `This deletes the folder and everything inside it (${assetCount} asset${assetCount === 1 ? '' : 's'}${subCount ? `, ${subCount} subfolder${subCount === 1 ? '' : 's'}` : ''}). This can’t be undone.`
        : 'Delete this empty folder?',
      { confirmLabel: 'Delete', isDanger: true },
    );
    if (ok) removeFolder(folder.id);
  };

  /*
   * Right-click menus — these REPLACE the per-row buttons.
   *
   * Every row used to carry a trash icon (and each asset a plus as well), so
   * there were two permanently-visible targets per line, one of them
   * destructive, a few pixels from the row you click to select. A delete that
   * always sits under the cursor is a delete that eventually gets hit by
   * accident — and the pair cost the width the Type and Size columns now use.
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
    openContextMenu(e.clientX, e.clientY, [
      {
        id: 'add',
        label: many ? `Add ${count} to Composition` : 'Add to Composition',
        onSelect: () => {
          if (!many) { void insertMedia(asset); return; }
          // In the panel's own row order, so what lands in the comp matches
          // what the user sees rather than the order they happened to click.
          // Awaited sequentially inside one async task: concurrent inserts
          // raced the selection and scrambled stacking order.
          void (async () => {
            for (const id of orderedAssetIds) {
              if (!selectedAssetIds.has(id)) continue;
              const a = assets.find((x) => x.id === id);
              if (a) await insertMedia(a);
            }
          })();
        },
      },
      {
        // The clip starts where the playhead is parked — assembling order, AE's
        // drag-to-timeline behaviour. Kept as a second verb rather than a mode:
        // both start points are legitimate, and a toggle that silently changes
        // what "Add" means is how a clip lands 40s away from where you looked.
        id: 'add-at-playhead',
        label: many ? `Add ${count} at Playhead` : 'Add at Playhead',
        onSelect: () => {
          if (!many) { void insertMediaAtPlayhead(asset); return; }
          for (const id of orderedAssetIds) {
            if (!selectedAssetIds.has(id)) continue;
            const a = assets.find((x) => x.id === id);
            if (a) void insertMediaAtPlayhead(a);
          }
        },
      },
      {
        // AE's canonical first move: the comp takes the clip's size (PAR-
        // corrected), duration and probed frame rate, and the clip lands at
        // full frame. Single-selection only — one comp per gesture; a batch
        // version would open N tabs and bury the user.
        id: 'comp-from-footage',
        label: 'New Comp from Footage',
        disabled: many,
        onSelect: () => { void createCompositionFromFootage(asset); },
      },
      {
        // The multi-clip counterpart of the row above: the comp still takes the
        // FIRST clip's size, duration and rate, but every selected clip lands
        // in it end-to-end rather than stacked at frame 0. Offered for one clip
        // too — it is then the same comp with an overlap prompt skipped, and an
        // entry that appears only above some threshold is an entry people stop
        // looking for.
        id: 'comp-from-clips',
        label: many ? `New Composition from ${count} Clips…` : 'New Composition from Clip…',
        onSelect: () => {
          const chosen = orderedAssetIds
            .filter((id) => (many ? selectedAssetIds.has(id) : id === asset.id))
            .map((id) => assets.find((x) => x.id === id))
            .filter((a): a is ImportedAsset => !!a && (a.type === 'video' || a.type === 'image'));
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
          onSelect: () => { retargetLayerSource(target, asset); },
        }];
      })(),
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
          const created = createFolder('New Folder', folder.id);
          // Open the parent, or the folder just created is filed somewhere the
          // user cannot see and the rename box appears attached to nothing.
          setExpandedFolders((cur) => new Set(cur).add(folder.id));
          setRenamingId(created.id);
        },
      },
      { id: 'sep-f', separator: true },
      { id: 'delete', label: 'Delete', danger: true, onSelect: () => { void deleteFolder(folder); } },
    ]);
  };

  // ── The tree ─────────────────────────────────────────────────────
  //
  // Folders expand IN PLACE, the way Explorer and AE's project panel work,
  // rather than replacing the view the way the old breadcrumb drill-down did.
  // The difference is not cosmetic: drilling down shows you one folder at a
  // time, so comparing two folders or dragging between them means navigating
  // away from one of them. A tree shows the structure and the contents at once.
  const childFolders = (parentId: string | null): AssetFolder[] =>
    folders.filter((f) => f.parentId === parentId);
  /*
   * What the shelf shows.
   *
   * The library means "media I brought in". Operations that duplicate or
   * rasterize scene content — a plugin repeater, Rig Logo — still have to
   * create real assets, because the layers that use them reference them by id
   * and those bytes have to persist. But filing them as ordinary imports put a
   * row on this shelf per generated copy, mixed in with the user's own
   * footage, with nothing to tell them apart. `source: 'derived'` is that
   * distinction; see `AssetSource`.
   *
   * Hidden rather than removed, and revealable rather than hidden outright:
   * they are still assets, and a category of asset with no way to see or
   * delete it would be a storage leak the user cannot reach.
   */
  const shelfAssets = showDerived ? assets : assets.filter(isLibraryAsset);
  const derivedCount = assets.length - assets.filter(isLibraryAsset).length;

  const folderAssets = (folderId: string | null): ImportedAsset[] =>
    shelfAssets.filter((a) => (a.folderId ?? null) === folderId);

  /** One rendered line. `depth` drives only the indent. */
  type AssetRow =
    | { kind: 'folder'; key: string; depth: number; folder: AssetFolder }
    | { kind: 'asset'; key: string; depth: number; asset: ImportedAsset };

  const buildRows = (parentId: string | null, depth: number, out: AssetRow[]): void => {
    for (const f of childFolders(parentId)) {
      out.push({ kind: 'folder', key: f.id, depth, folder: f });
      // Closed folders contribute nothing — that is what makes this a tree
      // rather than an indented flat list.
      if (expandedFolders.has(f.id)) buildRows(f.id, depth + 1, out);
    }
    for (const a of folderAssets(parentId)) {
      out.push({ kind: 'asset', key: a.id, depth, asset: a });
    }
  };

  const q = searchQuery.trim().toLowerCase();
  const searching = q.length > 0;
  // While searching, flatten every asset regardless of folder; otherwise show
  // just this folder's subfolders + assets.
  //
  // Searching FLATTENS: a tree hides matches inside closed folders, and the one
  // thing a search must not do is answer "no results" because the result was
  // behind a disclosure triangle.
  const visibleAssets = searching
    ? shelfAssets.filter((a) => a.name.toLowerCase().includes(q))
    : shelfAssets;
  const rows: AssetRow[] = [];
  if (searching) {
    for (const a of visibleAssets) rows.push({ kind: 'asset', key: a.id, depth: 0, asset: a });
  } else {
    buildRows(null, 0, rows);
  }

  const isEmpty = rows.length === 0;
  /** Asset ids in the order they are DRAWN — what Shift-range walks over. */
  const orderedAssetIds = rows.filter((r) => r.kind === 'asset').map((r) => r.key);

  const singleSelectedAsset = selectedAssetIds.size === 1
    ? assets.find((x) => x.id === [...selectedAssetIds][0]) ?? null
    : null;

  /*
    Publish the selection for the commands that act on it.

    "New Composition from Selected Clips" and "Assemble from Footage" are
    registry commands, so they run from the palette and the menu bar — neither
    of which is inside this component's tree, and neither of which could
    otherwise learn what is selected here. Published in ROW order, the same
    order the panel's own "Add N to Composition" uses, so a comp built from a
    selection matches what the user is looking at.
  */
  const selectionKey = orderedAssetIds.filter((id) => selectedAssetIds.has(id)).join(',');
  useEffect(() => {
    setPanelAssetSelection(selectionKey ? selectionKey.split(',') : []);
  }, [selectionKey]);

  return (
    <Panel
      id="assets"
      title="Assets"
      icon="media"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'assets' })}
    >
      <div className={styles.toolbar} style={{ paddingBottom: 4, width: '100%' }}>
        <SearchField
          placeholder="Search all assets…"
          ariaLabel="Search assets"
          className={styles.search}
          value={searchQuery}
          onChange={setSearchQuery}
        />
        {/*
          In the header rather than only in the bottom dock: a 3D model is the
          one import whose result is not a row in this list, so a user who has
          just imported one goes looking for what happened — and the dock's
          icon-only buttons name nothing. This one says what it does.
        */}
        <button
          type="button"
          className={styles.importModelBtn}
          title="Import a .glb, or a .gltf together with its .bin and textures"
          onClick={() => modelInputRef.current?.click()}
        >
          <Icon name="cube" size="sm" />
          <span>Import 3D model</span>
        </button>
      </div>

      {/* AE Top Footage Header Card — shown when a single asset is selected */}
      {singleSelectedAsset && (() => {
        const m = singleSelectedAsset.metadata ?? {};
        const parts: string[] = [];
        if (m.width && m.height) parts.push(`${Math.round(m.width * (singleSelectedAsset.interpret?.par ?? 1))}×${m.height}`);
        if (m.duration && m.duration > 0) parts.push(`${m.duration.toFixed(2)}s`);
        if (m.fps && m.fps > 0) parts.push(`${m.fps % 1 === 0 ? m.fps : m.fps.toFixed(3)} fps`);
        if (m.hasAudioTrack) parts.push('audio');
        parts.push(formatBytes(singleSelectedAsset.size));

        const visual = getAssetVisualInfo(singleSelectedAsset);
        const glyphClass = (styles as Record<string, string>)[visual.className] ?? styles.assetGlyphFile;

        return (
          <div className={`${styles.assetHeaderCard} ${styles.assetMetaFooter}`} data-asset-meta="">
            <div className={styles.assetHeaderThumb}>
              {singleSelectedAsset.thumbSrc ? (
                <img src={singleSelectedAsset.thumbSrc} alt={singleSelectedAsset.name} className={styles.assetHeaderThumbImg} />
              ) : (
                <Icon
                  name={visual.icon}
                  size="md"
                  className={`${styles.assetGlyph} ${glyphClass}`}
                  style={{ color: visual.color }}
                />
              )}
            </div>
            <div className={styles.assetHeaderDetails}>
              <span className={styles.assetHeaderName} title={singleSelectedAsset.name}>
                {singleSelectedAsset.name}
              </span>
              <span className={styles.assetHeaderFacts} title={parts.join(' · ')}>
                {parts.join(' · ')}
              </span>
            </div>
          </div>
        );
      })()}

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

      {/* Column headings, as in Explorer's details view and AE's project panel */}
      <div className={styles.assetHead}>
        <span className={styles.assetHeadName}>Name</span>
        <span className={styles.assetHeadType}>Type</span>
        <span className={styles.assetHeadSize}>Size</span>
      </div>

      {/*
        Del deletes the selection, Ctrl/Cmd+A takes all of it, Escape drops it.
      */}
      <div
        className={styles.body}
        style={{ padding: '2px 0' }}
        tabIndex={0}
        data-shortcut-claim="delete backspace Ctrl+a Meta+a Ctrl+Alt+g Meta+Alt+g"
        data-tour="assets-panel"
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedAssetIds.size === 0) return;
            e.preventDefault();
            e.stopPropagation();
            void deleteSelectedAssets();
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
          }
        }}
      >
        {isEmpty ? (
          <div className={styles.empty}>
            <p style={{ margin: 0, color: 'var(--color-text-tertiary)', fontSize: '11px' }}>
              {searching
                ? 'No matching assets found.'
                : 'No media yet. Import files or a folder, or create a folder to organise them.'}
            </p>
          </div>
        ) : (
          <div className={styles.assetTree} role="tree">
            {rows.map((row) =>
              row.kind === 'folder' ? (
                <div
                  key={row.key}
                  role="treeitem"
                  aria-expanded={expandedFolders.has(row.folder.id)}
                  className={`${styles.assetRow}${dropFolderId === row.folder.id ? ` ${styles.dropActive}` : ''}${currentFolderId === row.folder.id ? ` ${styles.assetRowActive}` : ''}`}
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
                    if (assetId) moveAssetToFolder(assetId, row.folder.id);
                    setDropFolderId(null);
                  }}
                >
                  <Icon
                    name={expandedFolders.has(row.folder.id) ? 'chevron-down' : 'chevron-right'}
                    size="sm"
                    className={styles.assetTwisty}
                  />
                  <Icon
                    name={expandedFolders.has(row.folder.id) ? 'folder-open' : 'folder'}
                    size="md"
                    className={styles.assetGlyphFolder}
                    style={{ color: FOLDER_COLOR }}
                  />
                  {renamingId === row.folder.id ? (
                    <input
                      autoFocus
                      defaultValue={row.folder.name}
                      className={styles.assetRename}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => { renameFolder(row.folder.id, e.target.value); setRenamingId(null); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { renameFolder(row.folder.id, (e.target as HTMLInputElement).value); setRenamingId(null); }
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                    />
                  ) : (
                    <span className={styles.assetRowName}>{row.folder.name}</span>
                  )}
                  <span className={styles.assetRowType}>Folder</span>
                  <span className={styles.assetRowSize} />
                </div>
              ) : (() => {
                const visual = getAssetVisualInfo(row.asset);
                const glyphClass = (styles as Record<string, string>)[visual.className] ?? styles.assetGlyphFile;
                return (
                  <div
                    key={row.key}
                    role="treeitem"
                    className={`${styles.assetRow}${selectedAssetIds.has(row.asset.id) ? ` ${styles.assetRowSelected}` : ''}`}
                    style={{ paddingLeft: 8 + row.depth * 16 + (searching ? 0 : 16) }}
                    title={row.asset.name}
                    draggable
                    onClick={(e) => selectAsset(row.asset.id, e, orderedAssetIds)}
                    onDoubleClick={() => openFootagePreview(row.asset)}
                    onContextMenu={(e) => openAssetMenu(row.asset, e)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/asset-id', row.asset.id);
                      setCanvasDrag(e, { kind: 'asset', assetId: row.asset.id });
                    }}
                  >
                    <Icon
                      name={visual.icon}
                      size="md"
                      className={`${styles.assetGlyph} ${glyphClass}`}
                      style={{ color: visual.color }}
                    />
                    <span className={styles.assetRowName}>{row.asset.name}</span>
                    <span className={styles.assetRowType}>{visual.label}</span>
                    <span className={styles.assetRowSize}>{formatBytes(row.asset.size)}</span>
                  </div>
                );
              })(),
            )}
          </div>
        )}
      </div>

      {/* AE Project Bottom Action Dock */}
      <div className={styles.assetBottomDock}>
        <button
          type="button"
          className={`${styles.dockBtn}${dockCompDropActive ? ` ${styles.dockBtnDropActive}` : ''}`}
          disabled={!singleSelectedAsset || singleSelectedAsset.type === 'audio'}
          title="Create New Composition from Footage (or drag & drop footage here)"
          onClick={() => {
            if (singleSelectedAsset) void createCompositionFromFootage(singleSelectedAsset);
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
            if (dropped && dropped.type !== 'audio') {
              void createCompositionFromFootage(dropped);
            }
          }}
        >
          <Icon name="component" size="sm" style={{ color: singleSelectedAsset && singleSelectedAsset.type !== 'audio' ? '#818cf8' : undefined }} />
        </button>

        <button
          type="button"
          className={styles.dockBtn}
          title="New Folder"
          onClick={handleNewFolder}
        >
          <Icon name="folder-plus" size="sm" style={{ color: FOLDER_COLOR }} />
        </button>

        <button
          type="button"
          className={styles.dockBtn}
          title="Import Folder (keeps folder structure)…"
          onClick={() => folderInputRef.current?.click()}
        >
          <Icon name="folder-open" size="sm" style={{ color: FOLDER_COLOR }} />
        </button>

        <button
          type="button"
          className={styles.dockBtn}
          title="Import Media Files…"
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="upload" size="sm" style={{ color: '#38bdf8' }} />
        </button>

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
          className={styles.dockBtn}
          disabled={selectedAssetIds.size === 0}
          title={`Delete Selected Asset${selectedAssetIds.size > 1 ? 's' : ''} (Del)`}
          onClick={() => {
            void deleteSelectedAssets();
          }}
        >
          <Icon name="trash" size="sm" />
        </button>
      </div>
    </Panel>
  );
}
