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
import { PluginsDockPanel, pluginPanelRenderers } from '@layout/Plugins/PluginPanel';
import { PluginsMarketplacePanel } from '@layout/Plugins/PluginsMarketplacePanel';
import { TreeView, type TreeNode } from '@components/TreeView';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { EmptyState } from '@components/EmptyState';
import { Input } from '@components/Input';
import { Icon, type IconName } from '@components/Icon';
import { customConfirm } from '@components/Modal';
import { useAssetStore, type AssetFolder, type ImportedAsset } from '@stores/assetStore';
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
import { aiEnabled } from '@core/config/edition';
import { ShapeEffects } from '@layout/Inspector/ShapeEffects';
import { CameraSection } from '@layout/Inspector/CameraSection';
import { LightSection } from '@layout/Inspector/LightSection';
import { CustomLayerSection } from '@layout/Inspector/CustomLayerSection';
import { findLayerKind, findKindFor } from '@core/plugins/layerKindRegistry';
import { splitKind } from '@core/plugins/layerKindSchema';
import { ownerOf, readCustomLayer } from '@core/plugins/customLayers';
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
import { renameLayer } from '@core/scene/renameLayer';
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

  /*
    Two plugin markers, both read from the DOCUMENT rather than from what
    happens to be installed.

    A generated child needs one because it is about to be overwritten by its
    plugin — or, once the user edits it, deliberately not. A user who cannot
    tell a managed layer from their own will edit one and be surprised either
    way, which is the whole reason the ownership mark is stored at all.

    An inert custom layer needs one because it renders and is selectable and
    behaves like a normal layer, and the one thing it will not do is respond to
    its own properties.
  */
  const owner = ownerOf(node);
  const custom = readCustomLayer(node);
  const inert = custom ? !findKindFor(custom.pluginId, custom.kindId) : false;

  let label: React.ReactNode = node.name ?? node.id;
  if (owner) {
    label = (
      <span className={styles.pluginManagedRow} title={`Managed by ${owner}. Editing it takes it over.`}>
        {label}
        <Icon name="plugin" size="sm" />
      </span>
    );
  } else if (inert) {
    label = (
      <span className={styles.pluginInertRow} title={`Needs the plugin "${custom!.pluginId}".`}>
        {label}
        <Icon name="warning" size="sm" />
      </span>
    );
  }

  if (custom) {
    const registered = findLayerKind(custom.kind);
    iconName = (registered?.kind.icon as IconName) ?? 'plugin';
  }

  return {
    id: node.id,
    label,
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
    setRenamingId(null);

    // Not a bare `node.name = name`. Expressions reference layers by NAME and
    // resolve at evaluation time, so a plain rename silently zeroes every
    // reference to this layer — with the symptom appearing nowhere near the
    // rename that caused it. `renameLayer` follows the rename through those
    // references in the SAME undo entry, and reports the two cases it will not
    // guess at.
    const result = renameLayer(id, name);
    if (!result.ok) return;

    if (result.repaired.length > 0) {
      useUIStore.getState().notify({
        level: 'info',
        message:
          result.repaired.length === 1
            ? '1 expression updated to follow the new name.'
            : `${result.repaired.length} expressions updated to follow the new name.`,
        durationMs: 4000,
      });
    }

    // The author's call, not ours — and worth saying out loud precisely because
    // it breaks nothing visibly today.
    if (result.captured.length > 0) {
      const n = result.captured.length;
      useUIStore.getState().notify({
        level: 'warning',
        message: `${n} expression${n === 1 ? '' : 's'} naming “${name.trim()}” now read this layer instead of the one they read before.`,
        // Longer than the others: this one is a silent retarget the user cannot
        // see anywhere else, and it is the only notice they will get.
        durationMs: 10000,
      });
    } else if (result.nameAlreadyInUse) {
      useUIStore.getState().notify({
        level: 'warning',
        message: `Another layer is already called “${name.trim()}”. An expression naming it can only reach one of them.`,
        durationMs: 6000,
      });
    }
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
                  <Icon name={hidden ? 'eye-off' : 'eye'} size="sm" />
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
 * AssetsPanel — an After Effects–style project bin: one unified media list
 * (images, video and audio together, no type tabs) organised into user folders.
 * Supports importing files or a whole folder (which mirrors its structure), and
 * dragging assets between folders.
 */
/**
 * Asset kind → the glyph and the word for it.
 *
 * Explorer's model: the icon says what KIND of thing this is, and the Type
 * column says it in words for anyone who does not read the glyph. Neither is a
 * preview — see the note on the asset row about why thumbnails came out.
 */
const ASSET_TYPE_ICON: Record<string, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
};

const ASSET_TYPE_LABEL: Record<string, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
};

/** Per-kind colour class — see `.assetGlyphImage` and friends for the why. */
const ASSET_TYPE_CLASS: Record<string, string> = {
  image: styles.assetGlyphImage ?? '',
  video: styles.assetGlyphVideo ?? '',
  audio: styles.assetGlyphAudio ?? '',
};

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
    openContextMenu(e.clientX, e.clientY, [
      { id: 'add', label: 'Add to Composition', onSelect: () => insertMedia(asset) },
      { id: 'sep-a', separator: true },
      { id: 'delete', label: 'Delete', danger: true, onSelect: () => { void deleteAsset(asset); } },
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
  const folderAssets = (folderId: string | null): ImportedAsset[] =>
    assets.filter((a) => (a.folderId ?? null) === folderId);

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
    ? assets.filter((a) => a.name.toLowerCase().includes(q))
    : assets;
  const rows: AssetRow[] = [];
  if (searching) {
    for (const a of visibleAssets) rows.push({ kind: 'asset', key: a.id, depth: 0, asset: a });
  } else {
    buildRows(null, 0, rows);
  }

  const isEmpty = rows.length === 0;
  /** Asset ids in the order they are DRAWN — what Shift-range walks over. */
  const orderedAssetIds = rows.filter((r) => r.kind === 'asset').map((r) => r.key);

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
          <Icon name="upload" size="sm" /> Import
        </button>
        <button type="button" className={styles.toolBtn} onClick={() => folderInputRef.current?.click()} title="Import a folder (keeps its structure)">
          <Icon name="folder-open" size="sm" /> Folder
        </button>
        <button type="button" className={styles.toolBtn} onClick={handleNewFolder} title="New folder">
          <Icon name="folder-plus" size="sm" /> New
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

      {/* Column headings, as in Explorer's details view and AE's project panel.
          Rendered once above the list rather than repeated per row, which is
          what lets Type and Size line up into columns you can scan down. */}
      <div className={styles.assetHead}>
        <span className={styles.assetHeadName}>Name</span>
        <span className={styles.assetHeadType}>Type</span>
        <span className={styles.assetHeadSize}>Size</span>
      </div>

      <div className={styles.body} style={{ padding: '2px 0' }}>
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
                    // Selecting a folder is still a selection change: leaving a
                    // file highlighted while browsing elsewhere is what made the
                    // old panel look like everything was selected at once.
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
                  {/* No wrapper around the glyph. The bordered tile that used to
                      sit here made every row look like a card in a list of
                      cards; a file row is a line of text with an icon on it. */}
                  <Icon name={expandedFolders.has(row.folder.id) ? 'folder-open' : 'folder'} size="md" className={styles.assetGlyphFolder} />
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
                  {/* No item count. It was a number that changed as you worked
                      and that nobody acts on — the contents are one click away
                      and now visible in place. */}
                  <span className={styles.assetRowType}>Folder</span>
                  <span className={styles.assetRowSize} />
                </div>
              ) : (
                <div
                  key={row.key}
                  role="treeitem"
                  className={`${styles.assetRow}${selectedAssetIds.has(row.asset.id) ? ` ${styles.assetRowSelected}` : ''}`}
                  style={{ paddingLeft: 8 + row.depth * 16 + (searching ? 0 : 16) }}
                  title={row.asset.name}
                  draggable
                  onClick={(e) => selectAsset(row.asset.id, e, orderedAssetIds)}
                  onDoubleClick={() => insertMedia(row.asset)}
                  onContextMenu={(e) => openAssetMenu(row.asset, e)}
                  onDragStart={(e) => {
                    // Folder-move (this panel) reads text/asset-id; a canvas drop
                    // reads the typed payload.
                    e.dataTransfer.setData('text/asset-id', row.asset.id);
                    setCanvasDrag(e, { kind: 'asset', assetId: row.asset.id });
                  }}
                >
                  {/* A TYPE icon, not a thumbnail. Thumbnails made every row a
                      different height's worth of visual weight, decoded media
                      just to draw a 16px square, and told you least about the
                      files that look alike — which is most of a real library.
                      Explorer and AE both show the kind, and the kind is what
                      you scan for. */}
                  <Icon
                    name={ASSET_TYPE_ICON[row.asset.type] ?? 'file'}
                    size="md"
                    className={`${styles.assetGlyph} ${ASSET_TYPE_CLASS[row.asset.type] ?? styles.assetGlyphFile}`}
                  />
                  <span className={styles.assetRowName}>{row.asset.name}</span>
                  <span className={styles.assetRowType}>{ASSET_TYPE_LABEL[row.asset.type] ?? 'File'}</span>
                  <span className={styles.assetRowSize}>{formatBytes(row.asset.size)}</span>
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ── Inspector (Right inspector) ──────────────────────────────────

/**
 * PropertiesPanel — the single inspector for whatever is selected.
 *
 * This used to be three tabs: Transform (`properties`), Style (`style`) and
 * Settings (`misc`). All three were the same thing — an accordion of property
 * sections for the selected layer — so the split only ever asked the user to
 * guess which tab owned the property they wanted, and each tab carried its own
 * search box that could not see the other two.
 *
 * The split also forced a workaround elsewhere: a selection effect in App.tsx
 * had to auto-switch tabs for cameras and lights, because picking one while
 * the wrong tab was active showed nothing at all. Merging removes the need for
 * that entirely.
 *
 * Rigging, Graph, Effects, Presets, Render and Plugins stay separate tabs on
 * purpose — those are editors and modes, not properties of the selection.
 */
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
      {/* Applied-template fields — the "fill in the blanks" surface. Shown only
          when a template is actually applied, so it costs nothing otherwise. */}
      <TemplateFieldsSection />
      {/* Project-level, selection-independent — renders only under LOCAL_FIRST.
          It sits below the accordion rather than inside it because it is not a
          property of the selected layer, and an accordion row that collapses to
          nothing would be worse than a quiet block that renders nothing. */}
      <div style={{ padding: '0 14px' }}>
        <VersionHistorySection />
      </div>
    </Panel>
  );
}

/**
 * Keywords per section id so the Inspector search matches on intent, not just
 * the visible title (e.g. searching "color" surfaces Appearance).
 *
 * This map now covers EVERY section, because the inspector has one search box
 * instead of one per tab. Motion and effects are still deliberately absent —
 * those live in the Graph / Effects tabs, which are editors, not property
 * sections.
 */
const SECTION_KEYWORDS: Record<string, string> = {
  // Spatial
  transform: 'position scale rotation opacity anchor size 3d',
  parenting: 'parent link pick whip',
  align: 'align distribute center',
  // Layer-kind settings
  custom: 'settings camera light particle audio volume',
  svg: 'svg vector path import',
  media: 'source trim speed fit crop volume',
  precomp: 'precompose group children focus',
  info: 'null object controller',
  // Style
  'style-presets': 'style preset look saved',
  text: 'font typography size weight letter spacing line height align',
  animators: 'text animator range selector',
  appearance: 'fill stroke color gradient background border',
  geometry: 'path trim repeater round corners wiggle stroke',
  compositing: 'blend mode matte track alpha luma',
  layerStyles: 'shadow glow drop outer bevel layer style',
  // Layer behaviour
  layerSwitches: 'switches quality solo shy motion blur collapse',
  time: 'time playback remap stretch speed in out',
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
      <EmptyState
        compact
        icon="search"
        message={`No properties match “${query.trim()}”.`}
      />
    );
  }
  // Remount on query change so filtered items re-apply their defaultOpen state.
  // No `key={query}`: keying on the search text REMOUNTED the whole Accordion on
  // every keystroke, and its open/closed state lives in its own useState — so
  // every group you expanded snapped shut as soon as you typed a character.
  //
  // No wrapper padding: a 4px inset stopped the section hairlines short of the
  // panel edge and pushed each section's gutter to 16px, while the search box
  // above sat at 8px — three different left edges down one narrow column.
  return <Accordion items={filtered} />;
}

/**
 * Every property section for the selected layer, in one ordered list.
 *
 * The order is the order you actually work in: where the layer IS, then what
 * KIND of thing it is, then how it LOOKS, then how it BEHAVES. Previously
 * these three groups were three separate tabs, so the sequence only existed in
 * the user's head.
 *
 * defaultOpen is deliberately stingier than it was when these lived in three
 * tabs. Sections that were the only content of their own tab could afford to
 * start open; in a single column, ten open sections is a scroll, not an
 * inspector. Spatial and kind-specific sections start open because they are
 * why you selected the layer; the secondary style and behaviour sections start
 * closed. A search match still force-opens anything it matches.
 */
function InspectorContent({ nodeId, query = '' }: { nodeId: string | null; query?: string }): JSX.Element {
  // Hook before any early return — the group section's "Enter group" needs it.
  const enterFocus = useFocusStore((s) => s.enter);

  if (!nodeId) {
    return (
      <EmptyState
        icon="mouse-pointer"
        title="No selection"
        message="Select a layer on the canvas or in the Scene panel to edit its properties."
      />
    );
  }

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return <div className={styles.empty}>No node data</div>;

  const kind = readNodeKind(node);
  const items: AccordionItem[] = [];

  // Kinds that have no spatial/visual presence of their own.
  const isAbstract = kind === 'camera' || kind === 'light' || kind === 'audio';
  const isDrawable = kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video';

  // ── Where it is ────────────────────────────────────────────────
  if (kind !== 'audio') {
    items.push({
      id: 'transform',
      title: 'Transform',
      icon: 'move',
      defaultOpen: true,
      content: (
        <>
          <TransformSection nodeId={nodeId} />
          {kind !== 'group' && kind !== 'null' && <ThreeDControl nodeId={nodeId} />}
        </>
      ),
    });
  }

  if (kind !== 'light') {
    items.push({
      id: 'parenting',
      title: 'Parent & Link',
      icon: 'layers',
      defaultOpen: true,
      content: <ParentControl nodeId={nodeId} />,
    });
  }

  if (isDrawable || kind === 'group') {
    items.push({
      id: 'align',
      title: 'Align & Distribute',
      icon: 'align-center',
      content: <AlignSection />,
    });
  }

  /*
    A plugin's own layer kind.

    Recognised by the dot: a native kind is a bare word, a custom one is always
    `<pluginId>.<kindId>`. The section is rendered from the plugin's SCHEMA by
    host components — and rendered even when the plugin is missing, where it
    falls back to what the document stored and goes read-only. An empty panel
    would read as a layer that had lost its settings.
  */
  const customKind = splitKind(kind);
  if (customKind) {
    const registered = findLayerKind(kind);
    items.push({
      id: 'custom',
      // The plugin's own label when it is here; the kind id when it is not,
      // which is still more use than "Custom Layer".
      title: registered?.kind.label ?? customKind.kindId,
      icon: (registered?.kind.icon as never) ?? 'plugin',
      defaultOpen: true,
      content: <CustomLayerSection nodeId={nodeId} />,
    });
  }

  // ── What kind of thing it is ───────────────────────────────────
  if (kind === 'camera') {
    items.push({
      id: 'custom', title: 'Camera Settings', icon: 'camera', defaultOpen: true,
      content: <CameraSection nodeId={nodeId} />,
    });
  } else if (kind === 'light') {
    items.push({
      id: 'custom', title: 'Light Settings', icon: 'light', defaultOpen: true,
      content: <LightSection nodeId={nodeId} />,
    });
  } else if (kind === 'particle') {
    items.push({
      id: 'custom', title: 'Particle Settings', icon: 'sparkles', defaultOpen: true,
      content: <ParticleSection nodeId={nodeId} />,
    });
  } else if (kind === 'audio') {
    items.push({
      id: 'custom', title: 'Audio Settings', icon: 'audio', defaultOpen: true,
      content: <AudioControls nodeId={nodeId} />,
    });
  } else if (kind === 'svg') {
    items.push({
      id: 'svg', title: 'SVG Layer', icon: 'shape', defaultOpen: true,
      content: <SvgSection nodeId={nodeId} />,
    });
  } else if (kind === 'image' || kind === 'video') {
    items.push({
      id: 'media', title: 'Media Settings', icon: 'image', defaultOpen: true,
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
          <div className={styles.groupMeta}>
            <span className={styles.groupCount}>Children: {childrenCount}</span>
            <Button size="sm" variant="secondary" fullWidth onClick={() => enterFocus(nodeId)}>
              Enter group
            </Button>
          </div>
        </>
      ),
    });
  } else if (kind === 'null') {
    items.push({
      id: 'info',
      title: 'Null Object',
      icon: 'info',
      defaultOpen: true,
      content: (
        <p className={styles.sectionNote}>
          An invisible controller. Attach layers to it as children via Parent &amp; Link.
        </p>
      ),
    });
  }

  // ── How it looks ───────────────────────────────────────────────
  if (kind === 'text') {
    items.push({
      id: 'text', title: 'Text Styles', icon: 'type', defaultOpen: true,
      content: <TextSection nodeId={nodeId} />,
    });
    items.push({
      id: 'animators', title: 'Text Animators', icon: 'sparkles',
      content: <TextAnimatorControls nodeId={nodeId} />,
    });
  }

  if (isDrawable) {
    items.push({
      id: 'appearance', title: 'Fill & Stroke', icon: 'shape', defaultOpen: true,
      content: <AppearanceSection nodeId={nodeId} />,
    });
  }

  if (kind === 'shape') {
    items.push({
      id: 'geometry', title: 'Geometry & Path Effects', icon: 'line',
      content: <ShapeEffects nodeId={nodeId} />,
    });
  }

  // Composed looks — a starting point you then refine in the sections above.
  // Gated on drawables: the old Style tab pushed this unconditionally, so a
  // camera or a light offered you "Neon" and "Gradient Card" presets that
  // cannot apply to anything they own. Splitting it across tabs hid that;
  // putting every section in one column made it obvious.
  if (isDrawable) {
    items.push({
      id: 'style-presets', title: 'Saved Styles', icon: 'sparkles',
      content: <StylePresetsSection nodeId={nodeId} />,
    });
    items.push({
      // "Layer Styles" is the After Effects term users will look for; the
      // keyword map also matches shadow/glow/bevel so either search finds it.
      id: 'layerStyles', title: 'Layer Styles', icon: 'sparkles',
      content: <LayerStylesControls nodeId={nodeId} />,
    });
  }

  // ── How it behaves ─────────────────────────────────────────────
  if (!isAbstract) {
    items.push({
      id: 'compositing', title: 'Blend & Matte', icon: 'layers',
      content: <CompositingControls nodeId={nodeId} />,
    });
    items.push({
      id: 'layerSwitches', title: 'Switches & Quality', icon: 'sliders-h',
      content: <LayerSwitchesControls nodeId={nodeId} />,
    });
    items.push({
      id: 'time', title: 'Time & Playback', icon: 'stopwatch',
      content: <TimeControls nodeId={nodeId} />,
    });
  }

  if (items.length === 0) {
    return <EmptyState icon="info" message="This layer type has no editable properties." />;
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
      <EmptyState
        icon="bone"
        title="Character Rigging"
        message="Select a layer to add puppet pins or a skeleton, or pick a tool to start."
        action={
          <>
            <Button size="sm" variant="secondary" fullWidth onClick={() => useUIStore.getState().setActiveTool('bone')}>
              <Icon name="bone" size="sm" /> Bone tool
            </Button>
            <Button size="sm" variant="secondary" fullWidth onClick={() => useUIStore.getState().setActiveTool('puppet-pin')}>
              <Icon name="puppet-pin" size="sm" /> Puppet pin tool
            </Button>
          </>
        }
      />
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
              <Icon name="plus" size="md" /> Save selection as component
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
            <EmptyState
              compact
              icon="component"
              message="No components yet. Select a layer or group and save it to reuse anywhere."
            />
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
                          style={{ objectFit: 'contain', borderRadius: 4, background: 'var(--color-surface-0)' }}
                        />
                      ) : (
                        <Icon name="component" size="lg" />
                      );
                    })()}
                    <span className={styles.libChipLabel}>{c.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${c.name}`}
                    title="Delete component"
                    onClick={() => removeComponent(c.id)}
                    style={{ position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'var(--color-surface-0)', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 'var(--font-size-xs)', lineHeight: 1 }}
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
                <span style={{ display: 'flex', width: 28, height: 20, borderRadius: 4, overflow: 'hidden', flexShrink: 0 }}>
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
      {/* The bottom rule lives in `.libTabs`. The inline copy that was here
          drew a SECOND hairline under the stylesheet's, and carried a
          `var(--color-border, rgba(255,255,255,0.08))` fallback for a token
          that has always been defined — a white-ish line hardcoded for dark. */}
      <div className={styles.libTabs} role="tablist">
        {LIBRARY_SECTIONS.map((s) => (
          <button key={s.id} type="button"
            role="tab"
            aria-selected={section === s.id}
            // Was `libTab` PLUS `libTabActive`, but `libTabActive` already
            // `composes: libTab` — so the base class landed twice.
            className={section === s.id ? styles.libTabActive : styles.libTab}
            title={s.label}
            onClick={() => setSection(s.id)}>
            <Icon name={s.icon} size="sm" />
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
    //
    // `style` and `misc` are gone for the same reason (2026-08-03): they were
    // two more accordions of properties for the selected layer, which is what
    // `properties` already is. Their sections now render inside it. DockPanel
    // drops panelOrder ids that no longer register, so persisted layouts and
    // saved workspaces holding the old ids simply lose the dead tabs.
    //
    // The assistant is spread conditionally rather than listed: the local
    // edition does not ship it. Not registering the panel (panelDefs.ts) already
    // stops the dock rendering it, but PopoutRoute resolves renderers by id
    // straight from this map — so a pop-out window deep-linked at /popout/ai
    // would have re-mounted the whole panel around the gate.
    ...(aiEnabled() ? { ai: () => <AiChatPanel /> } : {}),
    project:   () => <ProjectPanel />,
    scene:     () => <ScenePanel />,
    assets:    () => <AssetsPanel />,
    presets: () => <MotionPresetsPanel />,
    properties: () => <PropertiesPanel />,
    rig: () => <RigPanel />,
    motion: () => <MotionEditorPanel />,
    effects: () => <EffectsPanel />,
    history: () => <HistoryPanel />,
    renderQueue: () => <RenderQueuePanel />,
    plugins: () => <PluginsDockPanel />,
    marketplace: () => <PluginsMarketplacePanel />,
    // Plugin panels that earned a rail tab of their own. Spread rather than
    // listed, because which ones exist depends on what the user installed —
    // the only entries in this map not known at build time. Both sidebars and
    // `PopoutRoute` read this map, so a plugin panel detached into its own
    // window resolves here exactly like Scene does.
    ...pluginPanelRenderers(),
    // ── Asset Library (one tab, sections inside) ─────────────────────────
    library: () => <LibraryPanel />,
  };
}
