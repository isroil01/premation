/**
 * Demo panels — UI content for the layout's sidebar / inspector regions.
 *
 * In the future these will be replaced by panels registered by the Scene
 * Graph engine, the Asset engine, the Animation engine, etc. For now
 * they exercise every primitive in the design system and prove that the
 * panel/dock architecture is wired correctly.
 */

import { useMemo, useState, useRef, useEffect, type ReactNode } from 'react';
import { Panel } from '@components/Panel';
import { Button } from '@components/Button';
import { HistoryPanel } from '@layout/History/HistoryPanel';
import { ProjectPanel } from '@layout/Project/ProjectPanel';
import { MotionEditorPanel } from '@layout/Motion/MotionEditorPanel';
import { EffectsPanel } from '@layout/Effects/EffectsPanel';
import { RenderQueuePanel } from '@layout/RenderQueue/RenderQueuePanel';
import { PluginsDockPanel } from '@layout/Plugins/PluginPanel';
import { TreeView, type TreeNode } from '@components/TreeView';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { Input } from '@components/Input';
import { Icon, type IconName } from '@components/Icon';
import { customConfirm } from '@components/Modal';
import { useAssetStore, type AssetFolder } from '@stores/assetStore';
import { ParentControl } from '@layout/Inspector/ParentControl';
import { PrecompControl } from '@layout/Inspector/PrecompControl';
import { TextAnimatorControls } from '@layout/Inspector/TextAnimatorControls';
import { AudioControls } from '@layout/Inspector/AudioControls';
import { TransformSection } from '@layout/Inspector/TransformSection';
import { AppearanceSection } from '@layout/Inspector/AppearanceSection';
import { AlignSection } from '@layout/Inspector/AlignSection';
import { TextSection } from '@layout/Inspector/TextSection';
import { StylePresetsSection } from '@layout/Inspector/StylePresetsSection';
import { MediaSection } from '@layout/Inspector/MediaSection';
import { SvgSection, RevertSvgRow } from '@layout/Inspector/SvgSection';
import { canRevertToSvg, revertSvgGroupToLayer } from '@core/svg/svgConvert';
import { svgContextMenuItems } from '@layout/Inspector/svgLayerActions';
import { ThreeDControl } from '@layout/Inspector/ThreeDControl';
import { AiChatPanel } from '@layout/AiChat/AiChatPanel';
import { ShapeEffects } from '@layout/Inspector/ShapeEffects';
import { CameraSection } from '@layout/Inspector/CameraSection';
import { LightSection } from '@layout/Inspector/LightSection';
import { ParticleSection } from '@layout/Inspector/ParticleSection';
import { VersionHistorySection } from '@layout/Inspector/VersionHistorySection';
import { ActiveTemplateFields } from '@layout/Templates/TemplateFieldsPanel';
import { useTemplateStore } from '@stores/templateStore';
import { CompositingControls } from '@layout/Inspector/CompositingControls';
import { PuppetControls } from '@layout/Inspector/PuppetControls';
import { BoneControls } from '@layout/Inspector/BoneControls';
import { readNodePuppet } from '@core/rig/puppet';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { LayerSwitchesControls } from '@layout/Inspector/LayerSwitchesControls';
import { LayerStylesControls } from '@layout/Effects/LayerStylesControls';
import { TimeControls } from '@layout/Effects/TimeControls';
import { useSelectionStore } from '@stores/selectionStore';
import { useFocusStore } from '@stores/focusStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { type SceneKind } from '@core/scene/seedDefaultScene';
import { readNodeKind } from '@core/scene/sceneDerive';
import {
  insertMedia,
  toggleSelectedLocked,
  toggleSelectedSolo,
  groupSelectedLayers,
  ungroupSelected,
  precomposeSelected,
  duplicateSelectedLayers,
  deleteSelectedLayers,
  insertShape,
  insertText,
} from '@core/scene/sceneInsert';
import { mergeSelectedPaths, liveMergeSelectedPaths } from '@core/scene/mergePaths';
import { rigLogoForAnimation } from '@core/scene/rigLogo';
import { MOGRAPH_ITEMS, insertMographItem, createMographPlayer, mographDuration, type MographItem, type MographCategory } from '@core/library/mographLibrary';
import { TRANSITION_ITEMS, applyTransitionItem, type TransitionCategory } from '@core/library/transitionLibrary';
import { SFX_ITEMS, insertSfxItem, type SfxCategory } from '@core/library/sfxLibrary';
import { LOTTIE_ITEMS, insertLottieItem, importLottieFile, type LottieCategory } from '@core/library/lottieLibrary';
import { prepareLottiePreview, drawLottiePreview } from '@core/library/lottiePreview';
import type { LottieJson } from '@core/lottie/lottieImport';
import { reportLottieImport, reportLottieImportFailure } from '@core/lottie/lottieImportReport';
import { reparentNode, moveNodeAdjacent, canReparent, moveNodeInStack } from '@core/scene/parenting';
import { componentThumb, onComponentThumbReady } from '@core/rendering/componentThumbs';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { LABEL_COLORS, readNodeLabelColor, setNodeLabelColor } from '@core/scene/labelColor';
import { useComponentStore } from '@stores/componentStore';
import { MotionPresetsPanel } from '@layout/Motion/MotionPresetsPanel';
import { useUIStore } from '@stores/uiStore';
import type { SceneNode } from '@core/types';
import styles from './DemoPanels.module.css';

// ── Scene (Left sidebar) ──────────────────────────────────────────

interface SceneNodeData {
  type: SceneKind;
}

const KIND_ICON: Record<SceneKind, IconName> = {
  group: 'layers',
  null: 'crosshair',
  shape: 'shape',
  text: 'type',
  image: 'image',
  video: 'video',
  svg: 'shape',
  audio: 'audio',
  camera: 'camera',
  light: 'light',
  adjustment: 'adjustment',
  particle: 'sparkles',
  comp: 'component',
};

function toTreeNode(node: SceneNode): TreeNode<SceneNodeData> {
  const kind = readNodeKind(node);
  // Stacking convention (matches the timeline): the TOP entry is the
  // FRONT-most layer, so children list reversed from child (paint) order.
  const children = [...defaultSceneGraph.getChildren(node.id)].reverse().map(toTreeNode);
  
  let iconName: IconName = KIND_ICON[kind];
  if (kind === 'shape') {
    const fxComp = node.components.find((c) => c.type === 'fx');
    const isSolid = fxComp?.props?.solid === true || node.name?.toLowerCase().includes('solid');
    if (isSolid) {
      iconName = 'solid';
    } else {
      const transformComp = node.components.find((c) => c.type === 'Transform');
      const shapeType = transformComp?.props?.shapeType;
      if (shapeType === 'rect') iconName = 'square';
      else if (shapeType === 'ellipse') iconName = 'circle';
      else if (shapeType === 'line') iconName = 'line';
      else if (shapeType === 'star') iconName = 'star';
      else if (shapeType === 'polygon') iconName = 'polygon';
      else if (shapeType === 'triangle') iconName = 'polygon'; // Fallback or customize
      else if (shapeType === 'arrow') iconName = 'arrow-up';
      else if (shapeType === 'heart') iconName = 'heart';
      else if (shapeType === 'cross') iconName = 'cross';
      else if (shapeType === 'diamond') iconName = 'diamond';
      else if (shapeType === 'crescent') iconName = 'crescent';
    }
  }

  return {
    id: node.id,
    label: node.name ?? node.id,
    icon: iconName,
    labelColor: readNodeLabelColor(node),
    data: { type: kind },
    children: children.length ? children : undefined,
  };
}

/** Build the Scene tree from the live scene graph (single source of truth). */
function sceneGraphToTree(): TreeNode<SceneNodeData>[] {
  return defaultSceneGraph.getRoots().map(toTreeNode);
}

/** A small round swatch shown next to a color name in the Label Color menu. */
function LabelSwatch({ color }: { color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: color,
        marginRight: 8,
        verticalAlign: 'baseline',
        flex: 'none',
      }}
    />
  );
}

/**
 * "Label Color" submenu (AE-style): the fixed swatch palette + a None entry
 * that clears back to the layer kind's default category color. Applies to the
 * whole selection when the clicked layer is part of it (AE behavior).
 */
function labelColorMenuItems(targetId: string): ContextMenuItem[] {
  const sel = useSelectionStore.getState().ids;
  const ids: string[] = sel.includes(targetId) ? [...sel] : [targetId];
  const node = defaultSceneGraph.getNode(targetId);
  const current = node ? readNodeLabelColor(node) : undefined;
  return [
    {
      id: 'label-none',
      label: 'None (Default)',
      icon: current === undefined ? 'check' : undefined,
      onSelect: () => setNodeLabelColor(ids, undefined),
    },
    { id: 'label-sep', separator: true },
    ...LABEL_COLORS.map((c): ContextMenuItem => ({
      id: `label-${c.id}`,
      label: (
        <>
          <LabelSwatch color={c.color} />
          {c.label}
        </>
      ),
      icon: current === c.color ? 'check' : undefined,
      onSelect: () => setNodeLabelColor(ids, c.color),
    })),
  ];
}

/** Filter the tree by label, keeping ancestors of any match. */
function filterTree(nodes: TreeNode<SceneNodeData>[], q: string): TreeNode<SceneNodeData>[] {
  const out: TreeNode<SceneNodeData>[] = [];
  for (const node of nodes) {
    const label = String(node.label).toLowerCase();
    const kids = node.children ? filterTree(node.children as TreeNode<SceneNodeData>[], q) : [];
    if (label.includes(q) || kids.length) {
      out.push({ ...node, children: kids.length ? kids : node.children });
    }
  }
  return out;
}

function collectIds(nodes: TreeNode<SceneNodeData>[]): string[] {
  return nodes.flatMap((n) => [n.id, ...(n.children ? collectIds(n.children as TreeNode<SceneNodeData>[]) : [])]);
}

export function ScenePanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const setSelected = useSelectionStore((s) => s.set);
  const rev = useSceneRevision((s) => s.rev);
  const [query, setQuery] = useState('');

  const tree = useMemo(() => sceneGraphToTree(), [rev]);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => (q ? filterTree(tree, q) : tree), [tree, q]);
  const expandIds = useMemo(() => collectIds(filtered), [filtered]);
  // Expand only the composition roots by default, so their LAYERS are visible
  // but groups stay shut. `collectIds` returns every descendant, so an imported
  // SVG icon — one group of dozens of paths — unfolded into dozens of rows the
  // moment it was added, burying the rest of the scene. The icon is one body on
  // canvas already (see `selectionGroup`); the tree now agrees with that.
  // Searching still expands everything, so matches stay reachable.
  const defaultExpandIds = useMemo(() => filtered.map((n) => n.id), [filtered]);
  const itemCount = defaultSceneGraph.size;

  const [renamingId, setRenamingId] = useState<string | null>(null);

  const toggleVisible = (id: string): void => {
    const n = defaultSceneGraph.getNode(id);
    if (!n) return;
    n.visible = n.visible === false;
    bumpScene();
  };

  const commitRename = (id: string, name: string): void => {
    const n = defaultSceneGraph.getNode(id);
    if (n) { n.name = name; bumpScene(); }
    setRenamingId(null);
  };

  // Drag-to-reorder / reparent from the layer tree. The tree DISPLAYS front
  // first (reversed child order), while moveNodeAdjacent speaks child order —
  // so display-before means child-after and vice versa.
  const handleReorder = (
    dragId: string,
    targetId: string,
    pos: 'before' | 'after' | 'inside',
  ): void => {
    if (pos === 'inside') {
      if (canReparent(dragId, targetId)) reparentNode(dragId, targetId);
      else moveNodeAdjacent(dragId, targetId, 'before');
    } else {
      moveNodeAdjacent(dragId, targetId, pos === 'before' ? 'after' : 'before');
    }
  };

  const openNodeMenu = (id: string, e: React.MouseEvent): void => {
    const node = defaultSceneGraph.getNode(id);
    const hidden = node?.visible === false;
    const locked = (node as { locked?: boolean } | undefined)?.locked === true;
    const solo = (node as { solo?: boolean } | undefined)?.solo === true;
    const isGroup = node ? readNodeKind(node) === 'group' : false;
    openContextMenu(e.clientX, e.clientY, [
      { id: 'rename', label: 'Rename', onSelect: () => setRenamingId(id) },
      { id: 'duplicate', label: 'Duplicate', onSelect: () => duplicateSelectedLayers() },
      { id: 'arrange', label: 'Arrange', children: [
        { id: 'arr-front', label: 'Bring to Front', onSelect: () => { for (const nid of useSelectionStore.getState().ids) moveNodeInStack(nid, 'front'); } },
        { id: 'arr-forward', label: 'Bring Forward', onSelect: () => { for (const nid of useSelectionStore.getState().ids) moveNodeInStack(nid, 'forward'); } },
        { id: 'arr-backward', label: 'Send Backward', onSelect: () => { for (const nid of useSelectionStore.getState().ids) moveNodeInStack(nid, 'backward'); } },
        { id: 'arr-back', label: 'Send to Back', onSelect: () => { for (const nid of useSelectionStore.getState().ids) moveNodeInStack(nid, 'back'); } },
      ] },
      { id: 'sep1', separator: true },
      { id: 'toggle', label: hidden ? 'Show' : 'Hide', onSelect: () => toggleVisible(id) },
      { id: 'lock', label: locked ? 'Unlock' : 'Lock', onSelect: () => toggleSelectedLocked() },
      { id: 'solo', label: solo ? 'Unsolo' : 'Solo', onSelect: () => toggleSelectedSolo() },
      { id: 'labelColor', label: 'Label Color', children: labelColorMenuItems(id) },
      { id: 'sep2', separator: true },
      { id: 'group', label: 'Group Selection', onSelect: () => groupSelectedLayers() },
      ...(isGroup ? [{ id: 'ungroup', label: 'Ungroup', onSelect: () => ungroupSelected() }] : []),
      { id: 'precompose', label: 'Pre-compose…', onSelect: () => precomposeSelected() },
      { id: 'rig-logo', label: 'Rig Logo for Animation', onSelect: () => { void rigLogoForAnimation(); } },
      ...svgContextMenuItems(id),
      ...(useSelectionStore.getState().ids.length >= 2
        ? [
            { id: 'sep_merge', separator: true },
            {
              id: 'merge-paths',
              label: 'Merge Paths',
              children: [
                { id: 'merge-live-union', label: 'Live Union (Add)', onSelect: () => liveMergeSelectedPaths('union') },
                { id: 'merge-live-subtract', label: 'Live Subtract', onSelect: () => liveMergeSelectedPaths('subtract') },
                { id: 'merge-live-intersect', label: 'Live Intersect', onSelect: () => liveMergeSelectedPaths('intersect') },
                { id: 'merge-live-exclude', label: 'Live Exclude (XOR)', onSelect: () => liveMergeSelectedPaths('exclude') },
                { id: 'merge-sep', label: '—', disabled: true },
                { id: 'merge-union', label: 'Bake Union', onSelect: () => mergeSelectedPaths('union') },
                { id: 'merge-subtract', label: 'Bake Subtract', onSelect: () => mergeSelectedPaths('subtract') },
                { id: 'merge-intersect', label: 'Bake Intersect', onSelect: () => mergeSelectedPaths('intersect') },
                { id: 'merge-exclude', label: 'Bake Exclude', onSelect: () => mergeSelectedPaths('exclude') },
              ],
            },
          ]
        : []),
      { id: 'sep3', separator: true },
      { id: 'delete', label: 'Delete', danger: true, onSelect: () => deleteSelectedLayers() },
    ]);
  };

  return (
    <Panel
      id="scene"
      title="Scene"
      icon="layers"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'scene' })}
    >
      <div className={styles.searchRow}>
        <Input
          placeholder="Search layers…"
          size="sm"
          fullWidth
          leftIcon="search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <div className={styles.body}>
        {filtered.length ? (
          <TreeView
            nodes={filtered}
            selectedIds={selected}
            onSelect={setSelected}
            defaultExpandedIds={defaultExpandIds}
            expandedIds={q ? expandIds : undefined}
            onNodeContextMenu={openNodeMenu}
            onReorder={handleReorder}
            renamingId={renamingId ?? undefined}
            onRename={commitRename}
            onRenameCancel={() => setRenamingId(null)}
            renderActions={(node) => {
              const hidden = defaultSceneGraph.getNode(node.id)?.visible === false;
              return (
                <button
                  type="button"
                  className={styles.rowAction}
                  data-on={hidden || undefined}
                  aria-label={hidden ? 'Show layer' : 'Hide layer'}
                  onClick={(e) => { e.stopPropagation(); toggleVisible(node.id); }}
                >
                  <Icon name={hidden ? 'eye-off' : 'eye'} size={12} />
                </button>
              );
            }}
          />
        ) : (
          <div className={styles.empty}>
            {q ? 'No layers match your search.' : 'No layers yet. Add one from the “+ New layer” menu in the toolbar.'}
          </div>
        )}
      </div>
      <div className={styles.footer}>
        <span>{itemCount} items</span>
        <span>·</span>
        <span>{selected.length} selected</span>
      </div>
    </Panel>
  );
}

// ── Assets (Left sidebar) ────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + (sizes[i] ?? '');
}

/**
 * A video URL that a `<video>` element will actually show a frame for.
 *
 * A `<video>` with no poster paints nothing until it holds a decoded frame, and
 * `preload="metadata"` deliberately stops before decoding one — so a plain
 * `src` renders as a black box forever. A media fragment asks for a specific
 * time, which makes the browser decode that frame and present it as the poster.
 *
 * 0.1s rather than 0: the very first frame of a clip is often black (fades,
 * slates), and a thumbnail that is technically correct but visually black is no
 * better than no thumbnail. Skipped for sources that already carry a fragment or
 * a query string, where appending one could break the URL.
 */
const VIDEO_THUMB_TIME = 0.1;

function videoThumbSrc(src: string): string {
  if (!src || src.includes('#')) return src;
  return `${src}#t=${VIDEO_THUMB_TIME}`;
}


/**
 * AssetsPanel — an After Effects–style project bin: one unified media list
 * (images, video and audio together, no type tabs) organised into user folders.
 * Supports importing files or a whole folder (which mirrors its structure), and
 * dragging assets between folders.
 */
export function AssetsPanel(): JSX.Element {
  const assets = useAssetStore((s) => s.assets);
  const folders = useAssetStore((s) => s.folders);
  const addAssetsBatch = useAssetStore((s) => s.addAssetsBatch);
  const removeAsset = useAssetStore((s) => s.removeAsset);
  const createFolder = useAssetStore((s) => s.createFolder);
  const renameFolder = useAssetStore((s) => s.renameFolder);
  const removeFolder = useAssetStore((s) => s.removeFolder);
  const moveAssetToFolder = useAssetStore((s) => s.moveAssetToFolder);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Multi-select: clicking asset rows toggles them into this set; the bulk bar
  // then adds/deletes them together.
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(() => new Set());

  // Selection is folder/search-scoped — reset it whenever the view changes so a
  // hidden asset can't be silently deleted by a bulk action.
  const goToFolder = (id: string | null): void => {
    setCurrentFolderId(id);
    setSelectedAssetIds(new Set());
  };
  const toggleAssetSelected = (id: string, e: React.MouseEvent): void => {
    e.stopPropagation();
    setSelectedAssetIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Import loose files into the current folder and drop them on the canvas.
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const items: Array<{ file: File; folderId: string | null }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file) items.push({ file, folderId: currentFolderId });
    }
    const created = await addAssetsBatch(items);
    for (const a of created) insertMedia(a);
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

  // ── Navigation / breadcrumb ──────────────────────────────────────
  const breadcrumb: AssetFolder[] = [];
  {
    let cursor = currentFolderId;
    const byId = new Map(folders.map((f) => [f.id, f] as const));
    while (cursor) {
      const f = byId.get(cursor);
      if (!f) break;
      breadcrumb.unshift(f);
      cursor = f.parentId;
    }
  }

  const q = searchQuery.trim().toLowerCase();
  const searching = q.length > 0;
  // While searching, flatten every asset regardless of folder; otherwise show
  // just this folder's subfolders + assets.
  const subfolders = searching ? [] : folders.filter((f) => f.parentId === currentFolderId);
  const visibleAssets = assets.filter((a) => {
    const inFolder = searching || (a.folderId ?? null) === currentFolderId;
    const matches = !searching || a.name.toLowerCase().includes(q);
    return inFolder && matches;
  });

  const isEmpty = subfolders.length === 0 && visibleAssets.length === 0;

  // Bulk actions operate only on selected assets that are actually visible.
  const selectedInView = visibleAssets.filter((a) => selectedAssetIds.has(a.id));
  const allVisibleSelected = visibleAssets.length > 0 && selectedInView.length === visibleAssets.length;
  const toggleSelectAll = (): void => {
    setSelectedAssetIds(allVisibleSelected ? new Set() : new Set(visibleAssets.map((a) => a.id)));
  };
  const bulkAdd = (): void => {
    for (const a of selectedInView) insertMedia(a);
    setSelectedAssetIds(new Set());
  };
  const bulkDelete = async (): Promise<void> => {
    const n = selectedInView.length;
    if (n === 0) return;
    const ok = await customConfirm(
      'Delete assets',
      `Delete ${n} selected asset${n === 1 ? '' : 's'}? This can’t be undone.`,
      { confirmLabel: 'Delete', isDanger: true },
    );
    if (!ok) return;
    for (const a of selectedInView) removeAsset(a.id);
    setSelectedAssetIds(new Set());
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

  return (
    <Panel
      id="assets"
      title="Assets"
      icon="media"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'assets' })}
    >
      <div className={styles.toolbar} style={{ paddingBottom: 4, width: '100%' }}>
        <Input
          placeholder="Search all assets…"
          size="sm"
          fullWidth
          leftIcon="search"
          className={styles.search}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className={styles.assetTools}>
        <button type="button" className={styles.toolBtnPrimary} onClick={() => fileInputRef.current?.click()} title="Import media files">
          <Icon name="upload" size={13} /> Import
        </button>
        <button type="button" className={styles.toolBtn} onClick={() => folderInputRef.current?.click()} title="Import a folder (keeps its structure)">
          <Icon name="folder-open" size={13} /> Folder
        </button>
        <button type="button" className={styles.toolBtn} onClick={handleNewFolder} title="New folder">
          <Icon name="folder-plus" size={13} /> New
        </button>
        <input
          type="file"
          ref={fileInputRef}
          className={styles.fileInput}
          multiple
          accept="image/*,video/*,audio/*"
          onChange={handleFileChange}
        />
        {/* webkitdirectory lets the user pick a whole folder to import (non-standard
            attrs spread as any — widely supported in Chromium/Electron). */}
        <input
          type="file"
          ref={folderInputRef}
          className={styles.fileInput}
          multiple
          onChange={handleFolderChange}
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        />
      </div>

      {!searching && (
        <div className={styles.breadcrumb}>
          <button
            type="button"
            className={currentFolderId === null ? styles.crumbCurrent : styles.crumb}
            onClick={() => goToFolder(null)}
          >
            Assets
          </button>
          {breadcrumb.map((f, i) => (
            <span key={f.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <span className={styles.crumbSep}>/</span>
              <button
                type="button"
                className={i === breadcrumb.length - 1 ? styles.crumbCurrent : styles.crumb}
                onClick={() => goToFolder(f.id)}
              >
                {f.name}
              </button>
            </span>
          ))}
        </div>
      )}

      {selectedInView.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface-1)' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', flex: 1 }}>
            {selectedInView.length} selected
          </span>
          <button type="button" className={styles.toolBtn} title={allVisibleSelected ? 'Deselect all' : 'Select all'} onClick={toggleSelectAll}>
            <Icon name={allVisibleSelected ? 'deselect' : 'select-all'} size={12} /> {allVisibleSelected ? 'None' : 'All'}
          </button>
          <button type="button" className={styles.toolBtn} title="Add selected to composition" onClick={bulkAdd}>
            <Icon name="plus" size={12} /> Add
          </button>
          <button type="button" className={styles.toolBtnPrimary} title="Delete selected assets" style={{ background: 'var(--color-danger)' }} onClick={() => void bulkDelete()}>
            <Icon name="trash" size={12} /> Delete
          </button>
        </div>
      )}

      <div className={styles.body} style={{ padding: '4px 0' }}>
        {isEmpty ? (
          <div className={styles.empty}>
            <p style={{ margin: 0, color: 'var(--color-text-tertiary)', fontSize: '11px' }}>
              {searching
                ? 'No matching assets found.'
                : currentFolderId === null
                  ? 'No media yet. Import files or a folder, or create a folder to organise them.'
                  : 'This folder is empty. Import here, or drag assets in.'}
            </p>
          </div>
        ) : (
          <div className={styles.assetList}>
            {/* Folders first */}
            {subfolders.map((folder) => {
              const count = assets.filter((a) => a.folderId === folder.id).length
                + folders.filter((f) => f.parentId === folder.id).length;
              return (
                <div
                  key={folder.id}
                  className={`${styles.folderItem}${dropFolderId === folder.id ? ` ${styles.dropActive}` : ''}`}
                  title={folder.name}
                  onClick={() => { if (renamingId !== folder.id) goToFolder(folder.id); }}
                  onDragOver={(e) => { e.preventDefault(); setDropFolderId(folder.id); }}
                  onDragLeave={() => setDropFolderId((cur) => (cur === folder.id ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault();
                    const assetId = e.dataTransfer.getData('text/asset-id');
                    if (assetId) moveAssetToFolder(assetId, folder.id);
                    setDropFolderId(null);
                  }}
                >
                  <div className={styles.folderIcon}>
                    <Icon name="folder" size={16} />
                  </div>
                  <div className={styles.assetInfo}>
                    {renamingId === folder.id ? (
                      <input
                        autoFocus
                        defaultValue={folder.name}
                        className={styles.assetName}
                        style={{ background: 'var(--color-surface-0)', border: '1px solid var(--color-primary)', borderRadius: 3, color: 'var(--color-text-primary)' }}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => { renameFolder(folder.id, e.target.value); setRenamingId(null); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { renameFolder(folder.id, (e.target as HTMLInputElement).value); setRenamingId(null); }
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                      />
                    ) : (
                      <span
                        className={styles.assetName}
                        onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(folder.id); }}
                      >
                        {folder.name}
                      </span>
                    )}
                    <span className={styles.assetMeta}>{count} item{count === 1 ? '' : 's'}</span>
                  </div>
                  <div className={styles.assetActions}>
                    <button
                      type="button"
                      className={styles.actionButtonRemove}
                      title="Delete folder and all its contents"
                      onClick={(e) => { e.stopPropagation(); void deleteFolder(folder); }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Then assets (unified — images, video, audio together) */}
            {visibleAssets.map((asset) => {
              const selected = selectedAssetIds.has(asset.id);
              return (
              <div
                key={asset.id}
                className={styles.assetItem}
                title={asset.name}
                draggable
                onClick={(e) => toggleAssetSelected(asset.id, e)}
                style={selected ? { outline: '2px solid var(--color-primary)', outlineOffset: -2, background: 'var(--color-primary-soft, rgba(99,102,241,0.12))' } : undefined}
                onDragStart={(e) => {
                  // Folder-move (Assets panel) reads text/asset-id; canvas drop reads the typed payload.
                  e.dataTransfer.setData('text/asset-id', asset.id);
                  setCanvasDrag(e, { kind: 'asset', assetId: asset.id });
                }}
              >
                <div className={styles.assetIcon}>
                  {asset.type === 'image' ? (
                    <img src={asset.thumbSrc ?? asset.src} alt="" className={styles.assetThumbImg} loading="lazy" decoding="async" />
                  ) : asset.type === 'video' ? (
                    // The `#t=0.1` media fragment is what makes this show a
                    // PICTURE. With a bare src and `preload="metadata"` the
                    // browser fetches the header and no frame, so the element
                    // paints nothing and every clip in the library looked like a
                    // black rectangle. Asking for a time makes it decode that
                    // frame and display it as the poster.
                    <video
                      src={videoThumbSrc(asset.src)}
                      className={styles.assetThumbVideo}
                      preload="metadata"
                      muted
                      playsInline
                    />
                  ) : (
                    <Icon name="audio" size={14} />
                  )}
                </div>
                <div className={styles.assetInfo}>
                  <span className={styles.assetName}>{asset.name}</span>
                  <span className={styles.assetMeta}>
                    {formatBytes(asset.size)}
                    {asset.metadata?.width && asset.metadata?.height && (
                      ` · ${asset.metadata.width}×${asset.metadata.height}`
                    )}
                  </span>
                </div>
                <div className={styles.assetActions}>
                  <button
                    type="button"
                    className={styles.actionButtonAdd}
                    title="Add to composition"
                    onClick={(e) => { e.stopPropagation(); insertMedia(asset); }}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                  <button
                    type="button"
                    className={styles.actionButtonRemove}
                    title="Delete asset"
                    onClick={(e) => { e.stopPropagation(); removeAsset(asset.id); }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
      <div className={styles.footer}>
        <span>{visibleAssets.length} asset{visibleAssets.length === 1 ? '' : 's'}{subfolders.length ? ` · ${subfolders.length} folder${subfolders.length === 1 ? '' : 's'}` : ''}</span>
      </div>
    </Panel>
  );
}

// ── Properties (Right inspector) ─────────────────────────────────

export function PropertiesPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? null;
  const [query, setQuery] = useState('');

  return (
    <Panel
      id="properties"
      title="Properties"
      icon="settings"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'properties' })}
    >
      {primary && (
        <div className={styles.searchRow}>
          <Input
            placeholder="Search properties…"
            size="sm"
            fullWidth
            leftIcon="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      )}
      <InspectorContent nodeId={primary} query={query} />
    </Panel>
  );
}

/**
 * Keywords per section id so the Properties search matches on intent, not just
 * the visible title (e.g. searching "color" surfaces Appearance). Motion and
 * effects intentionally aren't here — they live in the dedicated Motion / Effects
 * tabs now, not the Properties accordion.
 */
const SECTION_KEYWORDS: Record<string, string> = {
  transform: 'position scale rotation opacity anchor size 3d',
  parenting: 'parent link pick whip',
  appearance: 'fill stroke color gradient background border',
  text: 'font typography size weight letter spacing line height align',
  media: 'source trim speed fit crop volume',
  geometry: 'path trim repeater round corners wiggle stroke',
  align: 'align distribute center',
  precomp: 'precompose group children focus',
  custom: 'settings camera light particle',
  info: 'null object controller',
  animators: 'text animator range selector',
};

/** Filter inspector sections by a search query; matches are forced open. */
function filterInspectorItems(items: AccordionItem[], query: string): AccordionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items
    .filter((it) => {
      const title = typeof it.title === 'string' ? it.title.toLowerCase() : '';
      return title.includes(q) || (SECTION_KEYWORDS[it.id] ?? '').includes(q);
    })
    .map((it) => ({ ...it, defaultOpen: true }));
}

/** Shared accordion render for every node-kind branch, applying the search filter. */
function renderInspector(items: AccordionItem[], query: string): JSX.Element {
  const filtered = filterInspectorItems(items, query);
  if (query.trim() && filtered.length === 0) {
    return (
      <div style={{ padding: '16px 14px', color: 'var(--color-text-tertiary)', fontSize: 12 }}>
        No properties match “{query.trim()}”.
      </div>
    );
  }
  // Remount on query change so filtered items re-apply their defaultOpen state.
  // No `key={query}`: keying on the search text REMOUNTED the whole Accordion on
  // every keystroke, and its open/closed state lives in its own useState — so
  // every group you expanded snapped shut as soon as you typed a character.
  return <div style={{ padding: 4 }}><Accordion items={filtered} /></div>;
}

function InspectorContent({ nodeId, query = '' }: { nodeId: string | null; query?: string }): JSX.Element {
  if (!nodeId) {
    return (
      <div style={{ padding: '16px 14px', color: 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
        <div style={{ color: 'var(--color-text-primary)', fontWeight: 600, marginBottom: 8 }}>Nothing selected</div>
        <p style={{ margin: '0 0 12px' }}>
          Select a layer in the canvas or the Scene panel to edit its transform properties
          (position, scale, rotation, parenting…).
        </p>
      </div>
    );
  }

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return <div className={styles.empty}>No node data</div>;

  const kind = readNodeKind(node);
  const items: AccordionItem[] = [];

  // Transform Section (spatial coordinates + 3D)
  if (kind !== 'audio') {
    items.push({
      id: 'transform',
      title: 'Transform',
      icon: 'settings',
      defaultOpen: true,
      content: (
        <>
          <TransformSection nodeId={nodeId} />
          {kind !== 'group' && kind !== 'null' && <ThreeDControl nodeId={nodeId} />}
        </>
      ),
    });
  }

  // Parent & Link Section
  if (kind !== 'light') {
    items.push({
      id: 'parenting',
      title: 'Parent & Link',
      icon: 'layers',
      defaultOpen: true,
      content: <ParentControl nodeId={nodeId} />,
    });
  }

  // Align & Distribute Section
  if (kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video' || kind === 'group') {
    items.push({
      id: 'align',
      title: 'Align & Distribute',
      icon: 'align-center',
      content: <AlignSection />,
    });
  }

  if (items.length === 0) {
    return (
      <div style={{ padding: '16px 14px', color: 'var(--color-text-tertiary)', fontSize: 12 }}>
        No transform controls are available for this layer type.
      </div>
    );
  }

  return renderInspector(items, query);
}

// ── Style (Right inspector) ─────────────────────────────────

export function StylePanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? null;
  const [query, setQuery] = useState('');

  return (
    <Panel
      id="style"
      title="Style"
      icon="brush"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'style' })}
    >
      {primary && (
        <div className={styles.searchRow}>
          <Input
            placeholder="Search style…"
            size="sm"
            fullWidth
            leftIcon="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      )}
      <StylePanelContent nodeId={primary} query={query} />
    </Panel>
  );
}

function StylePanelContent({ nodeId, query = '' }: { nodeId: string | null; query?: string }): JSX.Element {
  if (!nodeId) {
    return (
      <div style={{ padding: '16px 14px', color: 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
        <div style={{ color: 'var(--color-text-primary)', fontWeight: 600, marginBottom: 8 }}>Nothing selected</div>
        <p style={{ margin: '0' }}>Select a layer to edit its visual styling (colors, strokes, typography, animators).</p>
      </div>
    );
  }
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return <div className={styles.empty}>No node data</div>;

  const kind = readNodeKind(node);
  const items: AccordionItem[] = [];

  // Composed looks first — a starting point you then refine in the sections
  // below, rather than assembling every fill/stroke/shadow by hand.
  items.push({
    id: 'style-presets',
    title: 'Styles',
    icon: 'sparkles',
    defaultOpen: true,
    content: <StylePresetsSection nodeId={nodeId} />,
  });

  // Text Typography styles
  if (kind === 'text') {
    items.push({
      id: 'text',
      title: 'Text Styles',
      icon: 'type',
      defaultOpen: true,
      content: <TextSection nodeId={nodeId} />,
    });
    items.push({
      id: 'animators',
      title: 'Text Animators',
      icon: 'sparkles',
      defaultOpen: true,
      content: <TextAnimatorControls nodeId={nodeId} />,
    });
  }

  // Appearance (Fill & Stroke)
  if (kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video') {
    items.push({
      id: 'appearance',
      title: 'Appearance (Fill & Stroke)',
      icon: 'shape',
      defaultOpen: true,
      content: <AppearanceSection nodeId={nodeId} />,
    });
  }

  // Compositing (Blend & Matte)
  if (kind !== 'camera' && kind !== 'light' && kind !== 'audio') {
    items.push({
      id: 'compositing',
      title: 'Compositing (Blend & Matte)',
      icon: 'layers',
      defaultOpen: true,
      content: <CompositingControls nodeId={nodeId} />,
    });
  }

  // Layer Styles (Drop Shadow & Outer Glow)
  if (kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video') {
    items.push({
      id: 'layerStyles',
      title: 'Layer Styles (Shadow & Glow)',
      icon: 'sparkles',
      defaultOpen: false,
      content: <LayerStylesControls nodeId={nodeId} />,
    });
  }

  // Geometry (Shape paths/modifiers)
  if (kind === 'shape') {
    items.push({
      id: 'geometry',
      title: 'Geometry & Path Effects',
      icon: 'line',
      defaultOpen: true,
      content: <ShapeEffects nodeId={nodeId} />,
    });
  }

  if (items.length === 0) {
    return (
      <div style={{ padding: '16px 14px', color: 'var(--color-text-tertiary)', fontSize: 12 }}>
        Style options are not available for this layer type.
      </div>
    );
  }

  return renderInspector(items, query);
}

// ── Rigging (Right inspector) ──────────────────────────────

export function RigPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? null;
  const [query, setQuery] = useState('');

  return (
    <Panel
      id="rig"
      title="Rigging"
      icon="bone"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'rig' })}
    >
      {primary && (
        <div className={styles.searchRow}>
          <Input
            placeholder="Search rigging…"
            size="sm"
            fullWidth
            leftIcon="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      )}
      <RigPanelContent nodeId={primary} query={query} />
    </Panel>
  );
}

function RigPanelContent({ nodeId, query = '' }: { nodeId: string | null; query?: string }): JSX.Element {
  const activeTool = useUIStore((s) => s.activeTool);
  if (!nodeId) {
    return (
      <div style={{ padding: '20px 16px', color: 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
        <div style={{ color: 'var(--color-text-primary)', fontWeight: 600, fontSize: 13, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="bone" size={14} /> Character Rigging
        </div>
        <p style={{ margin: '0 0 14px 0' }}>Select a layer to create or edit 2D Puppet Mesh deformation pins or 2D Skeleton Bone hierarchies.</p>
        <div style={{ display: 'flex', gap: 8, flexDirection: 'column' }}>
          <Button size="sm" variant="secondary" onClick={() => useUIStore.getState().setActiveTool('bone')}>
            <Icon name="bone" size={13} /> Activate Bone Tool (Ctrl+B)
          </Button>
          <Button size="sm" variant="secondary" onClick={() => useUIStore.getState().setActiveTool('puppet-pin')}>
            <Icon name="puppet-pin" size={13} /> Activate Puppet Pin Tool (Ctrl+P)
          </Button>
        </div>
      </div>
    );
  }
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return <div className={styles.empty}>No node data</div>;

  const items: AccordionItem[] = [];
  const hasSkeleton = !!readNodeSkeleton(node);
  const hasPuppet = !!readNodePuppet(node);

  if (hasSkeleton || activeTool === 'bone' || !hasPuppet) {
    items.push({
      id: 'skeleton',
      title: 'Skeleton Bone Rigging',
      icon: 'bone',
      defaultOpen: true,
      content: <BoneControls nodeId={nodeId} />,
    });
  }

  if (hasPuppet || activeTool === 'puppet-pin' || !hasSkeleton) {
    items.push({
      id: 'puppet',
      title: 'Puppet Mesh Pins',
      icon: 'puppet-pin',
      defaultOpen: true,
      content: <PuppetControls nodeId={nodeId} />,
    });
  }

  return renderInspector(items, query);
}

// ── Settings (Right inspector) ─────────────────────────────────

export function MiscPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? null;
  const [query, setQuery] = useState('');

  return (
    <Panel
      id="misc"
      title="Settings"
      icon="sliders-h"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'misc' })}
    >
      {primary && (
        <div className={styles.searchRow}>
          <Input
            placeholder="Search settings…"
            size="sm"
            fullWidth
            leftIcon="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      )}
      <MiscPanelContent nodeId={primary} query={query} />
      {/* Applied-template fields — the "fill in the blanks" surface. Shown only
          when a template is actually applied, so it costs nothing otherwise. */}
      <TemplateFieldsSection />
      {/* Project-level, selection-independent — renders only under LOCAL_FIRST. */}
      <div style={{ padding: '0 14px' }}>
        <VersionHistorySection />
      </div>
    </Panel>
  );
}

function MiscPanelContent({ nodeId, query = '' }: { nodeId: string | null; query?: string }): JSX.Element {
  const enterFocus = useFocusStore((s) => s.enter);

  if (!nodeId) {
    return (
      <div style={{ padding: '16px 14px', color: 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
        <div style={{ color: 'var(--color-text-primary)', fontWeight: 600, marginBottom: 8 }}>Nothing selected</div>
        <p style={{ margin: '0' }}>Select a layer to configure its custom settings (media, precomp, camera, particle).</p>
      </div>
    );
  }
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return <div className={styles.empty}>No node data</div>;

  const kind = readNodeKind(node);
  const items: AccordionItem[] = [];

  if (kind === 'camera') {
    items.push({
      id: 'custom',
      title: 'Camera Settings',
      icon: 'camera',
      defaultOpen: true,
      content: <CameraSection nodeId={nodeId} />,
    });
  } else if (kind === 'light') {
    items.push({
      id: 'custom',
      title: 'Light Settings',
      icon: 'light',
      defaultOpen: true,
      content: <LightSection nodeId={nodeId} />,
    });
  } else if (kind === 'particle') {
    items.push({
      id: 'custom',
      title: 'Particle Settings',
      icon: 'sparkles',
      defaultOpen: true,
      content: <ParticleSection nodeId={nodeId} />,
    });
  } else if (kind === 'svg') {
    items.push({
      id: 'svg',
      title: 'SVG Layer',
      icon: 'shape',
      defaultOpen: true,
      content: <SvgSection nodeId={nodeId} />,
    });
  } else if (kind === 'image' || kind === 'video') {
    items.push({
      id: 'media',
      title: 'Media Settings',
      icon: 'image',
      defaultOpen: true,
      content: <MediaSection nodeId={nodeId} />,
    });
  } else if (kind === 'group') {
    const childrenCount = defaultSceneGraph.getChildren(nodeId).length;
    items.push({
      id: 'precomp',
      title: 'Pre-composition',
      icon: 'folder',
      defaultOpen: true,
      content: (
        <>
          <PrecompControl nodeId={nodeId} />
          {canRevertToSvg(nodeId) && (
            <RevertSvgRow onRevert={() => revertSvgGroupToLayer(nodeId)} />
          )}
          <div style={{ margin: '12px 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
              Children Count: {childrenCount}
            </span>
            <button
              type="button"
              onClick={() => enterFocus(nodeId)}
              style={{
                width: '100%',
                background: 'var(--color-surface-3)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-primary)',
                fontSize: 11,
                padding: '6px',
                borderRadius: 4,
                cursor: 'pointer'
              }}
            >
              Enter Group (Focus Mode)
            </button>
          </div>
        </>
      ),
    });
  } else if (kind === 'null') {
    items.push({
      id: 'info',
      title: 'Null Object Info',
      icon: 'info',
      defaultOpen: true,
      content: (
        <div style={{ margin: '10px 0', fontSize: 10, color: '#ffb703', background: 'rgba(255, 183, 3, 0.08)', padding: '6px 8px', borderRadius: 4, border: '1px solid rgba(255, 183, 3, 0.2)' }}>
          <strong>Null Object:</strong> Invisible controller. Attach layers as children via Parent & Link.
        </div>
      ),
    });
  } else if (kind === 'audio') {
    items.push({
      id: 'custom',
      title: 'Audio Settings',
      icon: 'audio',
      defaultOpen: true,
      content: <AudioControls nodeId={nodeId} />,
    });
  }

  // Switches & quality controls
  if (kind !== 'camera' && kind !== 'light' && kind !== 'audio') {
    items.push({
      id: 'layerSwitches',
      title: 'Switches & Quality',
      icon: 'sliders-h',
      defaultOpen: true,
      content: <LayerSwitchesControls nodeId={nodeId} />,
    });
  }

  // Time & Playback controls
  if (kind !== 'camera' && kind !== 'light' && kind !== 'audio') {
    items.push({
      id: 'time',
      title: 'Time & Playback',
      icon: 'stopwatch',
      defaultOpen: false,
      content: <TimeControls nodeId={nodeId} />,
    });
  }

  if (items.length === 0) {
    return (
      <div style={{ padding: '16px 14px', color: 'var(--color-text-tertiary)', fontSize: 12 }}>
        No custom settings are available for this layer type.
      </div>
    );
  }

  return renderInspector(items, query);
}

const SHAPE_PRESETS = [
  { id: 'rect',     label: 'Rectangle', svg: <rect x="4" y="4" width="24" height="24" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'rect' },
  { id: 'ellipse',  label: 'Ellipse',   svg: <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'ellipse' },
  { id: 'line',     label: 'Line',      svg: <line x1="4" y1="28" x2="28" y2="4" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'line' },
  { id: 'triangle', label: 'Triangle',  svg: <polygon points="16,4 28,26 4,26" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'triangle' },
  { id: 'arrow',    label: 'Arrow',     svg: <polygon points="16,4 28,16 20,16 20,28 12,28 12,16 4,16" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'arrow' },
  { id: 'heart',    label: 'Heart',     svg: <path d="M16,6.5 C16,6.5 12,2 6,2 C1,2 -2,7 2,14 C6,20 16,28 16,28 C16,28 26,20 30,14 C34,7 31,2 26,2 C20,2 16,6.5 16,6.5 Z" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'heart' },
  { id: 'cross',    label: 'Cross',     svg: <polygon points="12,4 20,4 20,12 28,12 28,20 20,20 20,28 12,28 12,20 4,20 4,12 12,12" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'cross' },
  { id: 'diamond',  label: 'Diamond',   svg: <polygon points="16,2 30,16 16,30 2,16" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'diamond' },
  { id: 'crescent', label: 'Crescent',  svg: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="none" stroke="currentColor" strokeWidth="2" transform="scale(1.1) translate(1, 1)" />, primitive: 'crescent' },
  { id: 'star',     label: 'Star',      svg: <polygon points="16,2 20,11 30,12 22,19 24,29 16,24 8,29 10,19 2,12 12,11" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'star' },
  { id: 'polygon',  label: 'Polygon',   svg: <polygon points="16,3 28,10 28,24 16,31 4,24 4,10" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'polygon' },
] as const;

const TEXT_PRESETS = [
  { id: 'title',        label: 'Title',             fontSize: 72,  weight: 700 },
  { id: 'subtitle',     label: 'Subtitle',          fontSize: 48,  weight: 600 },
  { id: 'body',         label: 'Body',              fontSize: 36,  weight: 400 },
  { id: 'caption',      label: 'Caption',           fontSize: 24,  weight: 400 },
  { id: 'neon',         label: 'Neon Glow',         fontSize: 48,  weight: 700,  extra: { fill: '#38bdf8' } },
  { id: 'display',      label: 'Poster Headline',   fontSize: 84,  weight: 900,  extra: { letterSpacing: -2 } },
  { id: 'tag',          label: 'Uppercase Tag',     fontSize: 14,  weight: 700,  extra: { letterSpacing: 4, fill: '#f59e0b' } },
  { id: 'quote',        label: 'Quote',             fontSize: 32,  weight: 300,  extra: { fontStyle: 'italic', fill: '#94a3b8' } },
  { id: 'cyberpunk',    label: 'Cyber Accent',      fontSize: 20,  weight: 800,  extra: { fill: '#f43f5e', letterSpacing: 2 } },
  { id: 'mono',         label: 'Code Monospace',    fontSize: 28,  weight: 500,  extra: { fontFamily: 'monospace', fill: '#10b981' } },
] as const;

export function ComponentsPanel(): JSX.Element {
  const savedComponents = useComponentStore((s) => s.components);
  const saveComponent = useComponentStore((s) => s.saveFromSelection);
  const insertComponent = useComponentStore((s) => s.insert);
  const removeComponent = useComponentStore((s) => s.remove);
  const hasSelection = useSelectionStore((s) => s.ids.length > 0);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [componentName, setComponentName] = useState('My Component');
  // Thumbnails render async on the GPU engine — repaint the grid as each lands.
  const [, setThumbTick] = useState(0);
  useEffect(() => onComponentThumbReady(() => setThumbTick((t) => t + 1)), []);

  const handleSave = () => {
    if (!componentName.trim()) return;
    const id = saveComponent(componentName);
    useUIStore.getState().notify(
      id
        ? { level: 'success', message: `Saved “${componentName}”`, durationMs: 1800 }
        : { level: 'warning', message: 'Select layer(s) to save first', durationMs: 2000 },
    );
    setShowSaveInput(false);
    setComponentName('My Component');
  };

  return (
    <Panel
      id="components"
      title="Components"
      icon="box"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'components' })}
    >
      <div className={styles.libBody}>
        <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!showSaveInput ? (
            <button
              type="button"
              className={styles.libChip}
              style={{ flexDirection: 'row', gap: 8, justifyContent: 'center', opacity: hasSelection ? 1 : 0.5, cursor: hasSelection ? 'pointer' : 'not-allowed' }}
              disabled={!hasSelection}
              title={hasSelection ? 'Save the current selection as a reusable component' : 'Select layer(s) first'}
              onClick={() => setShowSaveInput(true)}
            >
              <Icon name="plus" size={14} /> Save selection as component
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <Input
                value={componentName}
                onChange={(e) => setComponentName(e.currentTarget.value)}
                autoFocus
                size="sm"
                fullWidth
                placeholder="Component name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                  if (e.key === 'Escape') setShowSaveInput(false);
                }}
              />
              <button
                type="button"
                className={styles.libChip}
                style={{ padding: '0 8px', minHeight: 'unset', width: 'auto', flexShrink: 0 }}
                onClick={handleSave}
              >
                Save
              </button>
            </div>
          )}
          {savedComponents.length === 0 ? (
            <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'center', margin: '8px 0' }}>
              No components yet. Select a layer or group and save it — then reuse it anywhere.
            </p>
          ) : (
            <div className={styles.libGrid}>
              {savedComponents.map((c) => (
                <div key={c.id} style={{ position: 'relative' }}>
                  <button
                    type="button"
                    className={styles.libChip}
                    title={`Insert a copy of “${c.name}” — or drag onto the canvas`}
                    draggable
                    onDragStart={(e) => setCanvasDrag(e, { kind: 'component', componentId: c.id })}
                    onClick={() => { insertComponent(c.id); useUIStore.getState().notify({ level: 'success', message: `Inserted ${c.name}`, durationMs: 1500 }); }}
                  >
                    {(() => {
                      const thumb = componentThumb(c);
                      return thumb ? (
                        <img
                          src={thumb}
                          alt=""
                          width={48}
                          height={32}
                          style={{ objectFit: 'contain', borderRadius: 3, background: 'var(--color-surface-0)' }}
                        />
                      ) : (
                        <Icon name="component" size={24} />
                      );
                    })()}
                    <span className={styles.libChipLabel}>{c.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${c.name}`}
                    title="Delete component"
                    onClick={() => removeComponent(c.id)}
                    style={{ position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'var(--color-surface-0)', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 11, lineHeight: 1 }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function ShapesPanel(): JSX.Element {
  const handleShapeInsert = (preset: typeof SHAPE_PRESETS[number]) => {
    insertShape(preset.primitive, preset.label);
  };

  return (
    <Panel
      id="shapes"
      title="Shapes"
      icon="shape"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'shapes' })}
    >
      <div className={styles.libBody}>
        <div className={styles.libGrid}>
          {SHAPE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.libChip}
              title={`Insert ${p.label} — or drag onto the canvas`}
              draggable
              onDragStart={(e) => setCanvasDrag(e, { kind: 'shape', primitive: p.primitive, label: p.label })}
              onClick={() => handleShapeInsert(p)}
            >
              <svg width="32" height="32" viewBox="0 0 32 32" style={{ color: '#bbb' }}>
                {p.svg}
              </svg>
              <span className={styles.libChipLabel}>{p.label}</span>
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

export function TextPanel(): JSX.Element {
  const handleTextInsert = (preset: typeof TEXT_PRESETS[number]) => {
    insertText(preset.label, preset.fontSize, preset.weight, (preset as any).extra ?? {});
  };

  return (
    <Panel
      id="text"
      title="Text"
      icon="type"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'text' })}
    >
      <div className={styles.libBody}>
        <div className={styles.libList}>
          {TEXT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.libTextItem}
              title={`Insert ${p.label} text layer — or drag onto the canvas`}
              draggable
              onDragStart={(e) => setCanvasDrag(e, { kind: 'text', label: p.label, fontSize: p.fontSize, weight: p.weight, extra: (p as any).extra ?? {} })}
              onClick={() => handleTextInsert(p)}
            >
              <span
                style={{
                  fontSize: Math.min(p.fontSize / 3, 20),
                  fontWeight: p.weight,
                  fontStyle: (p as any).extra?.fontStyle,
                  color: (p as any).extra?.fill || 'inherit',
                  fontFamily: (p as any).extra?.fontFamily || 'inherit',
                  letterSpacing: (p as any).extra?.letterSpacing ? `${(p as any).extra.letterSpacing}px` : 'normal',
                  textTransform: (p as any).extra?.transform || 'none',
                }}
              >
                {p.label}
              </span>
              <span className={styles.libTextMeta}>
                {p.fontSize}px · w{p.weight}
                {(p as any).extra?.fill && ' · styled'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}


// ── Motion Graphics Panel ─────────────────────────────────────────
// Real programmatic mograph elements — the card previews PLAY the same
// build + choreography the insert writes (shared gallery ticker).

function MographCard({ item }: { item: MographItem }): JSX.Element {
  const notify = useUIStore((s) => s.notify);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const player = createMographPlayer(canvas, item);
    return () => player.stop();
  }, [item]);
  return (
    <button
      type="button"
      className={styles.libMotionItem}
      title={`${item.name} — Drag onto canvas or click to insert`}
      draggable
      onDragStart={(e) => setCanvasDrag(e, { kind: 'mograph', mographId: item.id, name: item.name })}
      onClick={() => {
        const id = insertMographItem(item.id);
        if (id) notify({ level: 'success', message: `Inserted motion graphic: ${item.name}`, durationMs: 1500 });
        else notify({ level: 'warning', message: `Could not insert ${item.name}`, durationMs: 2000 });
      }}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          width={224}
          height={126}
          style={{ width: '100%', aspectRatio: '16 / 9', borderRadius: 6, background: '#101016', display: 'block' }}
        />
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 3, height: 22, borderRadius: 2, background: item.color, flexShrink: 0 }} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</span>
            <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-family-mono)' }}>
              {item.cat} · {item.loop ? '∞ loop' : `${mographDuration(item).toFixed(1)}s`}
            </span>
          </span>
        </span>
      </span>
    </button>
  );
}

function MotionGFXContent(): JSX.Element {
  const [filter, setFilter] = useState<'all' | MographCategory>('all');
  const items = MOGRAPH_ITEMS.filter((m) => filter === 'all' || m.cat === filter);
  return (
    <>
      <div className={styles.libTabs}>
        {(['all', 'lower-thirds', 'callouts', 'titles', 'data', 'shapes', 'loops'] as const).map((f) => (
          <button key={f} type="button"
            className={`${styles.libTab} ${filter === f ? styles.libTabActive : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'lower-thirds' ? 'Lower 3rds' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.libBody}>
        <div className={styles.libList}>
          {items.map((item) => (
            <MographCard key={item.id} item={item} />
          ))}
        </div>
      </div>
      <div className={styles.footer}>{items.length} preset{items.length !== 1 ? 's' : ''}</div>
    </>
  );
}

// ── Transitions Panel ─────────────────────────────────────────────
// Real keyframe recipes: with a selection the recipe is keyframed onto the
// selected layers at the playhead; otherwise a choreographed solid covers
// the cut. Every write goes through the normal animation engine (undoable).

function TransitionsContent(): JSX.Element {
  const [filter, setFilter] = useState<'all' | TransitionCategory>('all');
  const notify = useUIStore((s) => s.notify);
  const items = TRANSITION_ITEMS.filter((t) => filter === 'all' || t.cat === filter);
  const apply = (id: string, name: string): void => {
    const result = applyTransitionItem(id);
    if (!result) {
      notify({ level: 'warning', message: `Could not apply ${name}`, durationMs: 2000 });
    } else if (result.mode === 'layer') {
      const n = result.nodeIds.length;
      const kinds = new Set(result.phases ?? []);
      const variant = kinds.size === 1 ? ` (${kinds.has('exit') ? 'exit' : 'entrance'})` : kinds.size > 1 ? ' (entrance + exit)' : '';
      notify({ level: 'success', message: `Keyframed ${name}${variant} onto ${n} layer${n > 1 ? 's' : ''}`, durationMs: 1800 });
    } else {
      const n = result.nodeIds.length;
      notify({ level: 'success', message: n > 1 ? `Inserted ${n} ${name} solids at the playhead` : `Inserted ${name} solid at the playhead`, durationMs: 1800 });
    }
  };
  return (
    <>
      <div className={styles.libTabs}>
        {(['all', 'fade', 'slide', 'zoom', 'whip', 'glitch', 'wipe'] as const).map((f) => (
          <button key={f} type="button"
            className={`${styles.libTab} ${filter === f ? styles.libTabActive : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.libBody}>
        <div className={styles.libList}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.libMotionItem}
              title={item.solidOnly
                ? `${item.name} — inserts a choreographed solid at the playhead`
                : `${item.name} — applies to the selected layers (or inserts a solid)`}
              draggable
              onDragStart={(e) => setCanvasDrag(e, { kind: 'transition', transId: item.id, name: item.name })}
              onClick={() => apply(item.id, item.name)}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                <span style={{ display: 'flex', width: 28, height: 20, borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
                  <span style={{ flex: 1, background: item.a, opacity: 0.85 }} />
                  <span style={{ flex: 1, background: item.b, opacity: 0.85 }} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{item.name}</span>
                  <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', fontFamily: 'var(--font-family-mono)' }}>
                    {item.cat} · {item.duration.toFixed(1)}s{item.solidOnly ? ' · solid' : ''}
                  </span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.footer}>{items.length} transition{items.length !== 1 ? 's' : ''}</div>
    </>
  );
}

// ── Sound FX Panel ────────────────────────────────────────────────
// Deterministic synthesized SFX — every item renders a real WAV through the
// normal asset pipeline and lands as a real audio layer at the playhead.

function SoundFXContent(): JSX.Element {
  const [filter, setFilter] = useState<'all' | SfxCategory>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const notify = useUIStore((s) => s.notify);
  const items = SFX_ITEMS.filter((s) => filter === 'all' || s.cat === filter);
  const insert = async (id: string, name: string): Promise<void> => {
    if (busy) return;
    setBusy(id);
    try {
      const nodeId = await insertSfxItem(id);
      if (nodeId) notify({ level: 'success', message: `Added Sound FX: ${name}`, durationMs: 1500 });
      else notify({ level: 'warning', message: `Could not add ${name}`, durationMs: 2000 });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className={styles.libTabs}>
        {(['all', 'click', 'whoosh', 'impact', 'ambient'] as const).map((f) => (
          <button key={f} type="button"
            className={`${styles.libTab} ${filter === f ? styles.libTabActive : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.libBody}>
        <div className={styles.libList}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.libMotionItem}
              disabled={busy !== null}
              style={busy === item.id ? { opacity: 0.6 } : undefined}
              title={`${item.name} — synthesized ${item.duration.toFixed(2)}s WAV, added as an audio layer`}
              draggable
              onDragStart={(e) => setCanvasDrag(e, { kind: 'sfx', sfxId: item.id, name: item.name })}
              onClick={() => { void insert(item.id, item.name); }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 1.5, width: 24, height: 20, flexShrink: 0 }}>
                  {[4, 7, 5, 9, 6, 8, 5].map((h, i) => (
                    <span key={i} style={{ width: 2, height: `${h * 2}px`, borderRadius: 1,
                      background: item.color, opacity: 0.7 + i * 0.04, display: 'block' }} />
                  ))}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{busy === item.id ? 'Rendering…' : item.name}</span>
                  <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-family-mono)' }}>
                    {item.cat} · {item.duration.toFixed(2)}s
                  </span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.footer}>{items.length} sound{items.length !== 1 ? 's' : ''} · synthesized offline</div>
    </>
  );
}

// ── Lottie Micro UI Panel ─────────────────────────────────────────
// Advanced Apple-style UI micro-interactions (Pill Stepper, Dynamic Island, Fluid Switch, Face ID, etc.)

/**
 * A library card that PLAYS ITS OWN DOCUMENT.
 *
 * Each card used to be a hand-drawn SVG impression of its item, with nothing
 * tying it to the Lottie document the card actually inserts — so a card could
 * keep looking right long after the document stopped landing that way. This
 * draws the same plan applyImportPlan realises, which is why inserting an item
 * now reproduces its card.
 *
 * Still by default (one frame is the honest contract for "what you get"), and
 * it plays while hovered so the motion is still visible before you commit.
 */
function LottieCardPreview({ doc, playing }: { doc: LottieJson; playing: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Planning is pure and cheap, but it is per-document work — do it once.
  const scene = useMemo(() => prepareLottiePreview(doc), [doc]);
  const restT = scene.restSec;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 44;
    const h = canvas.clientHeight || 30;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Resizing the canvas above CLEARS it, so paint before yielding: an rAF
    // that never arrives (hidden pane, background window) would otherwise leave
    // the card blank for as long as the throttle lasts.
    drawLottiePreview(ctx, scene, playing ? 0 : restT, w, h);
    if (!playing) return;

    let raf = 0;
    const started = performance.now();
    const tick = (): void => {
      const elapsed = (performance.now() - started) / 1000;
      drawLottiePreview(ctx, scene, scene.durationSec > 0 ? elapsed % scene.durationSec : 0, w, h);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scene, playing, restT]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />;
}

function LottieContent(): JSX.Element {
  const [filter, setFilter] = useState<'all' | LottieCategory>('all');
  const notify = useUIStore((s) => s.notify);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const items = LOTTIE_ITEMS.filter((l) => filter === 'all' || l.cat === filter);

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      reportLottieImport(file.name, await importLottieFile(file));
    } catch (err) {
      reportLottieImportFailure(file.name, err);
    }
  };

  return (
    <>
      <div className={styles.libTabs}>
        {(['all', 'micro-ui', 'widgets', 'controls'] as const).map((f) => (
          <button key={f} type="button"
            className={`${styles.libTab} ${filter === f ? styles.libTabActive : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'micro-ui' ? 'Micro UI' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.libBody}>
        <div style={{ padding: '6px 8px 2px' }}>
          <Button size="sm" variant="secondary" style={{ width: '100%', fontWeight: 600 }}
            onClick={() => fileRef.current?.click()}>
            📥 Import .json / .lottie File…
          </Button>
          <input ref={fileRef} type="file" accept=".json,.lottie,application/json,application/x-lottie" style={{ display: 'none' }}
            onChange={(e) => { void onPickFile(e); }} />
        </div>
        <div className={styles.libGrid}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.libChip}
              title={`${item.name} — ${item.frames}f @ 30fps. Hover to play, drag onto canvas or click to insert`}
              draggable
              onDragStart={(e) => setCanvasDrag(e, { kind: 'lottie', lottieId: item.id, name: item.name })}
              onMouseEnter={() => setHovered(item.id)}
              onMouseLeave={() => setHovered((h) => (h === item.id ? null : h))}
              onClick={() => {
                const ids = insertLottieItem(item.id);
                if (ids.length > 0) notify({ level: 'success', message: `Inserted ${item.name} (${ids.length} layer${ids.length > 1 ? 's' : ''})`, durationMs: 1800 });
                else notify({ level: 'warning', message: `Could not insert ${item.name}`, durationMs: 2000 });
              }}>
              <span className={styles.libChipThumb}
                style={{ background: `radial-gradient(circle at 50% 45%, ${item.color}22 0%, transparent 70%), #09090b`, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <LottieCardPreview doc={item.doc} playing={hovered === item.id} />
                <span style={{ position: 'absolute', bottom: 2, right: 3, fontSize: '0.52rem', fontWeight: 800,
                  color: 'rgba(255,255,255,0.4)', letterSpacing: '0.04em' }}>LOTTIE</span>
              </span>
              <span className={styles.libChipLabel}>{item.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.footer}>{items.length} high-level UI animation{items.length !== 1 ? 's' : ''}</div>
    </>
  );
}

// ── Library Panel — ONE home for asset libraries ──────────────────
// Motion GFX / Transitions / Sound FX / Lottie live as sections inside a single sidebar tab.

type LibrarySection = 'mograph' | 'transitions' | 'sfx' | 'lottie' | 'components' | 'shapes' | 'text';

const LIBRARY_SECTIONS: ReadonlyArray<{ id: LibrarySection; label: string; icon: IconName }> = [
  { id: 'mograph',     label: 'Motion GFX',  icon: 'sparkles' },
  { id: 'transitions', label: 'Transitions', icon: 'scissors' },
  { id: 'sfx',         label: 'Sound FX',    icon: 'voice' },
  { id: 'lottie',      label: 'Lottie UI',   icon: 'video' },
  // Components / Shapes / Text were written, exported, and then left with no way
  // in: their only references were getAllPanelRenderers entries under panel ids
  // that are never registered, and the Library — where they were supposedly
  // folded — never included them. Saved Components in particular is a whole
  // feature (it is what componentThumb renders thumbnails for) that no user
  // could reach. Surfaced here rather than deleted.
  { id: 'components',  label: 'Components',  icon: 'component' },
  { id: 'shapes',      label: 'Shapes',      icon: 'shape' },
  { id: 'text',        label: 'Text',        icon: 'type' },
];

export function LibraryPanel(): JSX.Element {
  const [section, setSection] = useState<LibrarySection>('mograph');
  return (
    <Panel id="library" title="Library" icon="sparkles" hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'library' })}>
      <div className={styles.libTabs} style={{ borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.08))' }}>
        {LIBRARY_SECTIONS.map((s) => (
          <button key={s.id} type="button"
            className={`${styles.libTab} ${section === s.id ? styles.libTabActive : ''}`}
            title={s.label}
            onClick={() => setSection(s.id)}>
            <Icon name={s.icon} size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
            {s.label}
          </button>
        ))}
      </div>
      {section === 'mograph' && <MotionGFXContent />}
      {section === 'transitions' && <TransitionsContent />}
      {section === 'sfx' && <SoundFXContent />}
      {section === 'lottie' && <LottieContent />}
      {section === 'components' && <ComponentsPanel />}
      {section === 'shapes' && <ShapesPanel />}
      {section === 'text' && <TextPanel />}
    </Panel>
  );
}




// ── Render the registered panels in a region ──────────────────────

/** The applied template's fields, or nothing when no template is applied. */
function TemplateFieldsSection(): JSX.Element | null {
  const active = useTemplateStore((s) => s.active);
  if (!active) return null;
  return (
    <div style={{ padding: '0 14px' }}>
      <ActiveTemplateFields />
    </div>
  );
}

export function getAllPanelRenderers(): Record<string, () => ReactNode> {
  return {
    // `components`, `shapes` and `text` used to be listed here as standalone
    // panels too. They were never registered in PANEL_DEFS and nothing opened
    // them, while the SAME three components already render as sections inside
    // LibraryPanel — so the entries were unreachable copies of live UI.
    ai: () => <AiChatPanel />,
    project:   () => <ProjectPanel />,
    scene:     () => <ScenePanel />,
    assets:    () => <AssetsPanel />,
    presets: () => <MotionPresetsPanel />,
    properties: () => <PropertiesPanel />,
    style: () => <StylePanel />,
    rig: () => <RigPanel />,
    motion: () => <MotionEditorPanel />,
    effects: () => <EffectsPanel />,
    misc: () => <MiscPanel />,
    history: () => <HistoryPanel />,
    renderQueue: () => <RenderQueuePanel />,
    plugins: () => <PluginsDockPanel />,
    // ── Asset Library (one tab, sections inside) ─────────────────────────
    library: () => <LibraryPanel />,
  };
}
