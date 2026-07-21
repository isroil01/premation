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
import { TemplateFieldsPanel } from '@layout/Templates/TemplateFieldsPanel';
import { MotionEditorPanel } from '@layout/Motion/MotionEditorPanel';
import { CommentsPanel } from '@layout/Comments/CommentsPanel';
import { EffectsPanel } from '@layout/Effects/EffectsPanel';
import { RenderQueuePanel } from '@layout/RenderQueue/RenderQueuePanel';
import { TreeView, type TreeNode } from '@components/TreeView';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { Input } from '@components/Input';
import { Icon, type IconName } from '@components/Icon';
import { useAssetStore, type AssetFolder } from '@stores/assetStore';
import { ParentControl } from '@layout/Inspector/ParentControl';
import { PrecompControl } from '@layout/Inspector/PrecompControl';
import { TextAnimatorControls } from '@layout/Inspector/TextAnimatorControls';
import { AudioControls } from '@layout/Inspector/AudioControls';
import { TransformSection } from '@layout/Inspector/TransformSection';
import { AppearanceSection } from '@layout/Inspector/AppearanceSection';
import { AlignSection } from '@layout/Inspector/AlignSection';
import { TextSection } from '@layout/Inspector/TextSection';
import { MediaSection } from '@layout/Inspector/MediaSection';
import { ThreeDControl } from '@layout/Inspector/ThreeDControl';
import { AiChatPanel } from '@layout/AiChat/AiChatPanel';
import { ShapeEffects } from '@layout/Inspector/ShapeEffects';
import { CameraSection } from '@layout/Inspector/CameraSection';
import { LightSection } from '@layout/Inspector/LightSection';
import { ParticleSection } from '@layout/Inspector/ParticleSection';
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
            defaultExpandedIds={expandIds}
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
 * AssetsPanel — an After Effects–style project bin: one unified media list
 * (images, video and audio together, no type tabs) organised into user folders.
 * Supports importing files or a whole folder (which mirrors its structure), and
 * dragging assets between folders.
 */
export function AssetsPanel(): JSX.Element {
  const assets = useAssetStore((s) => s.assets);
  const folders = useAssetStore((s) => s.folders);
  const addAsset = useAssetStore((s) => s.addAsset);
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

  // Import loose files into the current folder and drop them on the canvas.
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file) {
        const asset = await addAsset(file, currentFolderId);
        insertMedia(asset);
      }
    }
    e.target.value = '';
  };

  // Import a whole directory: recreate its folder structure under the current
  // folder (via webkitRelativePath) and file each asset into the matching leaf.
  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
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
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const parts = rel.split('/');
      // Recreate the full picked structure: "MyPack/logos/a.png" → folders
      // "MyPack" then "MyPack/logos", with a.png filed in the leaf.
      const folderSegments = parts.slice(0, -1);
      const targetFolder = ensureFolder(folderSegments);
      await addAsset(file, targetFolder);
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

  return (
    <Panel
      id="assets"
      title="Assets"
      icon="media"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'assets' })}
    >
      <div className={styles.toolbar} style={{ paddingBottom: 4 }}>
        <Input
          placeholder="Search all assets…"
          size="sm"
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
            onClick={() => setCurrentFolderId(null)}
          >
            Assets
          </button>
          {breadcrumb.map((f, i) => (
            <span key={f.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <span className={styles.crumbSep}>/</span>
              <button
                type="button"
                className={i === breadcrumb.length - 1 ? styles.crumbCurrent : styles.crumb}
                onClick={() => setCurrentFolderId(f.id)}
              >
                {f.name}
              </button>
            </span>
          ))}
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
                  onClick={() => { if (renamingId !== folder.id) setCurrentFolderId(folder.id); }}
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
                      title="Delete folder (keeps its assets)"
                      onClick={(e) => { e.stopPropagation(); removeFolder(folder.id); }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Then assets (unified — images, video, audio together) */}
            {visibleAssets.map((asset) => (
              <div
                key={asset.id}
                className={styles.assetItem}
                title={asset.name}
                draggable
                onDragStart={(e) => {
                  // Folder-move (Assets panel) reads text/asset-id; canvas drop reads the typed payload.
                  e.dataTransfer.setData('text/asset-id', asset.id);
                  setCanvasDrag(e, { kind: 'asset', assetId: asset.id });
                }}
              >
                <div className={styles.assetIcon}>
                  {asset.type === 'image' ? (
                    <img src={asset.src} alt="" className={styles.assetThumbImg} />
                  ) : asset.type === 'video' ? (
                    <video src={asset.src} className={styles.assetThumbVideo} muted playsInline />
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
                    onClick={() => insertMedia(asset)}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                  <button
                    type="button"
                    className={styles.actionButtonRemove}
                    title="Delete asset"
                    onClick={() => removeAsset(asset.id)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>
            ))}
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
  return <div style={{ padding: 4 }}><Accordion key={query} items={filtered} /></div>;
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


// ── Cursor Library Panel ──────────────────────────────────────────

const CURSOR_LIB = [
  { id: 'c1', name: 'Default Arrow',     cat: 'click',     tag: 'FREE', color: '#2988ff', animated: false },
  { id: 'c2', name: 'Click Ripple',      cat: 'click',     tag: 'FREE', color: '#8b5cf6', animated: true  },
  { id: 'c3', name: 'Double Burst',      cat: 'click',     tag: 'FREE', color: '#f59e0b', animated: true  },
  { id: 'c4', name: 'Glow Trail',        cat: 'trail',     tag: 'PRO',  color: '#10b981', animated: true  },
  { id: 'c5', name: 'Neon Trail',        cat: 'trail',     tag: 'PRO',  color: '#ec4899', animated: true  },
  { id: 'c6', name: 'Particle Trail',    cat: 'trail',     tag: 'PRO',  color: '#6366f1', animated: true  },
  { id: 'c7', name: 'Spotlight Circle',  cat: 'spotlight', tag: 'FREE', color: '#f97316', animated: false },
  { id: 'c8', name: 'Soft Spotlight',    cat: 'spotlight', tag: 'FREE', color: '#84cc16', animated: false },
  { id: 'c9', name: 'Hand Pointer',      cat: 'hand',      tag: 'FREE', color: '#14b8a6', animated: false },
  { id: 'c10', name: 'Hand Click',       cat: 'hand',      tag: 'FREE', color: '#a78bfa', animated: true  },
  { id: 'c11', name: 'Crosshair',        cat: 'click',     tag: 'PRO',  color: '#fb7185', animated: false },
  { id: 'c12', name: 'Magnetic Pull',    cat: 'trail',     tag: 'PRO',  color: '#38bdf8', animated: true  },
] as const;

export function CursorLibraryPanel(): JSX.Element {
  const [filter, setFilter] = useState<'all'|'click'|'trail'|'spotlight'|'hand'>('all');
  const notify = useUIStore((s) => s.notify);
  const items = CURSOR_LIB.filter((c) => filter === 'all' || c.cat === filter);
  return (
    <Panel id="lib-cursors" title="Cursors" icon="mouse-pointer" hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'lib-cursors' })}>
      <div className={styles.libTabs}>
        {(['all','click','trail','spotlight','hand'] as const).map((f) => (
          <button key={f} type="button"
            className={`${styles.libTab} ${filter === f ? styles.libTabActive : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase()+f.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.libBody}>
        <div className={styles.libGrid}>
          {items.map((item) => (
            <button key={item.id} type="button" className={styles.libChip}
              title={`${item.name} — ${item.tag}`}
              onClick={() => notify({ level: 'info', message: `"${item.name}" added to timeline`, durationMs: 1800 })}>
              <span className={styles.libChipThumb}
                style={{ background: `radial-gradient(circle at 40% 40%, ${item.color}44 0%, transparent 70%), #1a1a2e` }}>
                <span style={{ display:'block', width:8, height:8, borderRadius:'50%',
                  background: item.color, boxShadow: `0 0 8px ${item.color}`, margin:'auto', marginTop:10 }} />
              </span>
              <span className={styles.libChipLabel}>{item.name}</span>
              {item.tag === 'PRO' && <span className={styles.libChipPro}>PRO</span>}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.footer}>{items.length} cursor{items.length !== 1 ? 's' : ''}</div>
    </Panel>
  );
}

// ── Motion Graphics Panel ─────────────────────────────────────────

const MG_LIB = [
  { id: 'mg1',  name: 'Clean Lower Third',   cat: 'lower-thirds', tag: 'FREE', color: '#2988ff', dur: '3s' },
  { id: 'mg2',  name: 'Bold Name Plate',      cat: 'lower-thirds', tag: 'FREE', color: '#8b5cf6', dur: '4s' },
  { id: 'mg3',  name: 'News Ticker',          cat: 'lower-thirds', tag: 'PRO',  color: '#f59e0b', dur: 'Loop' },
  { id: 'mg4',  name: 'Speech Bubble',        cat: 'callouts',     tag: 'FREE', color: '#10b981', dur: '2s' },
  { id: 'mg5',  name: 'Arrow Callout',        cat: 'callouts',     tag: 'FREE', color: '#ec4899', dur: '1.5s' },
  { id: 'mg6',  name: 'Highlight Box',        cat: 'callouts',     tag: 'FREE', color: '#6366f1', dur: '2s' },
  { id: 'mg7',  name: 'Geometric Circle',     cat: 'shapes',       tag: 'FREE', color: '#f97316', dur: 'Loop' },
  { id: 'mg8',  name: 'Particle Burst',       cat: 'shapes',       tag: 'PRO',  color: '#84cc16', dur: '2s' },
  { id: 'mg9',  name: 'Grid Reveal',          cat: 'shapes',       tag: 'PRO',  color: '#14b8a6', dur: '1.5s' },
  { id: 'mg10', name: 'Kinetic Title',        cat: 'titles',       tag: 'FREE', color: '#a78bfa', dur: '3s' },
  { id: 'mg11', name: 'Glitch Title',         cat: 'titles',       tag: 'PRO',  color: '#fb7185', dur: '2s' },
  { id: 'mg12', name: 'Neon Glow Title',      cat: 'titles',       tag: 'PRO',  color: '#38bdf8', dur: '4s' },
] as const;

export function MotionGFXPanel(): JSX.Element {
  const [filter, setFilter] = useState<'all'|'lower-thirds'|'callouts'|'shapes'|'titles'>('all');
  const notify = useUIStore((s) => s.notify);
  const items = MG_LIB.filter((m) => filter === 'all' || m.cat === filter);
  return (
    <Panel id="lib-mograph" title="Motion GFX" icon="component" hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'lib-mograph' })}>
      <div className={styles.libTabs}>
        {(['all','lower-thirds','callouts','shapes','titles'] as const).map((f) => (
          <button key={f} type="button"
            className={`${styles.libTab} ${filter === f ? styles.libTabActive : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'lower-thirds' ? 'Lower 3rds' : f.charAt(0).toUpperCase()+f.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.libBody}>
        <div className={styles.libList}>
          {items.map((item) => (
            <button key={item.id} type="button" className={styles.libMotionItem}
              onClick={() => notify({ level: 'info', message: `"${item.name}" added to timeline`, durationMs: 1800 })}>
              <span style={{ display:'flex', alignItems:'center', gap:8, flex:1 }}>
                <span style={{ width:3, height:28, borderRadius:2, background:item.color, flexShrink:0 }} />
                <span style={{ display:'flex', flexDirection:'column', gap:2 }}>
                  <span style={{ fontSize:'0.78rem', fontWeight:600 }}>{item.name}</span>
                  <span style={{ fontSize:'0.68rem', color:'var(--color-text-muted)', fontFamily:'var(--font-family-mono)' }}>
                    {item.cat} · {item.dur}
                  </span>
                </span>
              </span>
              {item.tag === 'PRO' && <span className={styles.libChipPro}>PRO</span>}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.footer}>{items.length} preset{items.length !== 1 ? 's' : ''}</div>
    </Panel>
  );
}

// ── Transitions Panel ─────────────────────────────────────────────

const TRANS_LIB = [
  { id: 't1',  name: 'Clean Cut',       cat: 'wipe',   tag: 'FREE', a: '#2988ff', b: '#8b5cf6' },
  { id: 't2',  name: 'Horizontal Wipe', cat: 'wipe',   tag: 'FREE', a: '#1a1a2e', b: '#2988ff' },
  { id: 't3',  name: 'Diagonal Wipe',   cat: 'wipe',   tag: 'FREE', a: '#10b981', b: '#1a1a2e' },
  { id: 't4',  name: 'Zoom In',         cat: 'zoom',   tag: 'FREE', a: '#f59e0b', b: '#1a1a2e' },
  { id: 't5',  name: 'Zoom Out',        cat: 'zoom',   tag: 'FREE', a: '#ec4899', b: '#1a1a2e' },
  { id: 't6',  name: 'Whip Pan Zoom',   cat: 'zoom',   tag: 'PRO',  a: '#6366f1', b: '#f97316' },
  { id: 't7',  name: 'Push Left',       cat: 'push',   tag: 'FREE', a: '#84cc16', b: '#1a1a2e' },
  { id: 't8',  name: 'Push Right',      cat: 'push',   tag: 'FREE', a: '#14b8a6', b: '#1a1a2e' },
  { id: 't9',  name: 'Push Down',       cat: 'push',   tag: 'PRO',  a: '#a78bfa', b: '#1a1a2e' },
  { id: 't10', name: 'Glitch Slice',    cat: 'glitch', tag: 'PRO',  a: '#fb7185', b: '#38bdf8' },
  { id: 't11', name: 'RGB Split',       cat: 'glitch', tag: 'PRO',  a: '#f43f5e', b: '#06b6d4' },
  { id: 't12', name: 'VHS Glitch',      cat: 'glitch', tag: 'PRO',  a: '#ef4444', b: '#22c55e' },
] as const;

export function TransitionsPanel(): JSX.Element {
  const [filter, setFilter] = useState<'all'|'wipe'|'zoom'|'push'|'glitch'>('all');
  const notify = useUIStore((s) => s.notify);
  const items = TRANS_LIB.filter((t) => filter === 'all' || t.cat === filter);
  return (
    <Panel id="lib-trans" title="Transitions" icon="scissors" hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'lib-trans' })}>
      <div className={styles.libTabs}>
        {(['all','wipe','zoom','push','glitch'] as const).map((f) => (
          <button key={f} type="button"
            className={`${styles.libTab} ${filter === f ? styles.libTabActive : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase()+f.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.libBody}>
        <div className={styles.libList}>
          {items.map((item) => (
            <button key={item.id} type="button" className={styles.libMotionItem}
              title="Drop between two clips on the timeline"
              onClick={() => notify({ level: 'info', message: `"${item.name}" transition added`, durationMs: 1800 })}>
              <span style={{ display:'flex', alignItems:'center', gap:8, flex:1 }}>
                <span style={{ display:'flex', width:28, height:20, borderRadius:3, overflow:'hidden', flexShrink:0 }}>
                  <span style={{ flex:1, background: item.a, opacity:0.8 }} />
                  <span style={{ flex:1, background: item.b, opacity:0.8 }} />
                </span>
                <span style={{ display:'flex', flexDirection:'column', gap:2 }}>
                  <span style={{ fontSize:'0.78rem', fontWeight:600 }}>{item.name}</span>
                  <span style={{ fontSize:'0.68rem', color:'var(--color-text-muted)', textTransform:'uppercase', fontFamily:'var(--font-family-mono)' }}>
                    {item.cat}
                  </span>
                </span>
              </span>
              {item.tag === 'PRO' && <span className={styles.libChipPro}>PRO</span>}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.footer}>{items.length} transition{items.length !== 1 ? 's' : ''}</div>
    </Panel>
  );
}

// ── Sound FX Panel ────────────────────────────────────────────────

const SFX_LIB = [
  { id: 's1',  name: 'UI Click',        cat: 'click',   tag: 'FREE', dur: '0.1s', color: '#2988ff' },
  { id: 's2',  name: 'Button Pop',      cat: 'click',   tag: 'FREE', dur: '0.2s', color: '#8b5cf6' },
  { id: 's3',  name: 'Toggle Switch',   cat: 'click',   tag: 'FREE', dur: '0.15s', color: '#10b981' },
  { id: 's4',  name: 'Fast Whoosh',     cat: 'whoosh',  tag: 'FREE', dur: '0.4s', color: '#f59e0b' },
  { id: 's5',  name: 'Heavy Whoosh',    cat: 'whoosh',  tag: 'FREE', dur: '0.6s', color: '#ec4899' },
  { id: 's6',  name: 'Wind Sweep',      cat: 'whoosh',  tag: 'PRO',  dur: '0.8s', color: '#6366f1' },
  { id: 's7',  name: 'Hit Impact',      cat: 'impact',  tag: 'FREE', dur: '0.3s', color: '#f97316' },
  { id: 's8',  name: 'Thud',            cat: 'impact',  tag: 'FREE', dur: '0.5s', color: '#ef4444' },
  { id: 's9',  name: 'Cinematic Boom',  cat: 'impact',  tag: 'PRO',  dur: '1.2s', color: '#7c3aed' },
  { id: 's10', name: 'Room Tone',       cat: 'ambient', tag: 'FREE', dur: 'Loop', color: '#14b8a6' },
  { id: 's11', name: 'City Noise',      cat: 'ambient', tag: 'FREE', dur: 'Loop', color: '#84cc16' },
  { id: 's12', name: 'Studio Hum',      cat: 'ambient', tag: 'PRO',  dur: 'Loop', color: '#38bdf8' },
] as const;

export function SoundFXPanel(): JSX.Element {
  const [filter, setFilter] = useState<'all'|'click'|'whoosh'|'impact'|'ambient'>('all');
  const notify = useUIStore((s) => s.notify);
  const items = SFX_LIB.filter((s) => filter === 'all' || s.cat === filter);
  return (
    <Panel id="lib-sfx" title="Sound FX" icon="zap" hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'lib-sfx' })}>
      <div className={styles.libTabs}>
        {(['all','click','whoosh','impact','ambient'] as const).map((f) => (
          <button key={f} type="button"
            className={`${styles.libTab} ${filter === f ? styles.libTabActive : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase()+f.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.libBody}>
        <div className={styles.libList}>
          {items.map((item) => (
            <button key={item.id} type="button" className={styles.libMotionItem}
              title="Sync to keyframe or drop on audio track"
              onClick={() => notify({ level: 'info', message: `"${item.name}" added to audio track`, durationMs: 1800 })}>
              <span style={{ display:'flex', alignItems:'center', gap:8, flex:1 }}>
                {/* Mini waveform bars */}
                <span style={{ display:'flex', alignItems:'center', gap:1.5, width:24, height:20, flexShrink:0 }}>
                  {[4,7,5,9,6,8,5].map((h,i) => (
                    <span key={i} style={{ width:2, height:`${h*2}px`, borderRadius:1,
                      background: item.color, opacity:0.7+i*0.04, display:'block' }} />
                  ))}
                </span>
                <span style={{ display:'flex', flexDirection:'column', gap:2 }}>
                  <span style={{ fontSize:'0.78rem', fontWeight:600 }}>{item.name}</span>
                  <span style={{ fontSize:'0.68rem', color:'var(--color-text-muted)', fontFamily:'var(--font-family-mono)' }}>
                    {item.cat} · {item.dur}
                  </span>
                </span>
              </span>
              {item.tag === 'PRO' && <span className={styles.libChipPro}>PRO</span>}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.footer}>{items.length} sound{items.length !== 1 ? 's' : ''}</div>
    </Panel>
  );
}

// ── Lottie & JSON Panel ───────────────────────────────────────────

const LOTTIE_LIB = [
  { id: 'l1',  name: 'Success Check',   cat: 'icons',          tag: 'FREE', color: '#10b981', frames: 60,  size: '4.2 KB' },
  { id: 'l2',  name: 'Loading Spinner', cat: 'loaders',        tag: 'FREE', color: '#2988ff', frames: 120, size: '2.8 KB' },
  { id: 'l3',  name: 'Warning Alert',   cat: 'icons',          tag: 'FREE', color: '#f59e0b', frames: 90,  size: '3.5 KB' },
  { id: 'l4',  name: 'Heart Like',      cat: 'icons',          tag: 'FREE', color: '#ec4899', frames: 45,  size: '5.1 KB' },
  { id: 'l5',  name: 'Dots Loader',     cat: 'loaders',        tag: 'FREE', color: '#8b5cf6', frames: 60,  size: '1.9 KB' },
  { id: 'l6',  name: 'Progress Ring',   cat: 'loaders',        tag: 'PRO',  color: '#6366f1', frames: 90,  size: '3.2 KB' },
  { id: 'l7',  name: 'Globe Spin',      cat: 'illustrations',  tag: 'PRO',  color: '#14b8a6', frames: 180, size: '22 KB' },
  { id: 'l8',  name: 'Rocket Launch',   cat: 'illustrations',  tag: 'PRO',  color: '#f97316', frames: 120, size: '18 KB' },
  { id: 'l9',  name: 'Thumbs Up',       cat: 'stickers',       tag: 'FREE', color: '#84cc16', frames: 60,  size: '8.4 KB' },
  { id: 'l10', name: 'Fire Flame',      cat: 'stickers',       tag: 'FREE', color: '#ef4444', frames: 120, size: '6.7 KB' },
  { id: 'l11', name: 'Star Burst',      cat: 'stickers',       tag: 'PRO',  color: '#fbbf24', frames: 45,  size: '5.2 KB' },
  { id: 'l12', name: 'Confetti Pop',    cat: 'illustrations',  tag: 'PRO',  color: '#a78bfa', frames: 150, size: '14 KB' },
] as const;

export function LottiePanel(): JSX.Element {
  const [filter, setFilter] = useState<'all'|'icons'|'loaders'|'illustrations'|'stickers'>('all');
  const notify = useUIStore((s) => s.notify);
  const items = LOTTIE_LIB.filter((l) => filter === 'all' || l.cat === filter);
  return (
    <Panel id="lib-lottie" title="Lottie" icon="ease" hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'lib-lottie' })}>
      <div className={styles.libTabs}>
        {(['all','icons','loaders','illustrations','stickers'] as const).map((f) => (
          <button key={f} type="button"
            className={`${styles.libTab} ${filter === f ? styles.libTabActive : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase()+f.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.libBody}>
        <div className={styles.libGrid}>
          {items.map((item) => (
            <button key={item.id} type="button" className={styles.libChip}
              title={`${item.name} · ${item.frames}f · ${item.size}`}
              onClick={() => notify({ level: 'info', message: `"${item.name}" Lottie imported`, durationMs: 1800 })}>
              <span className={styles.libChipThumb}
                style={{ background: `radial-gradient(circle at 50% 45%, ${item.color}33 0%, transparent 70%), #0f0f1a`, position:'relative' }}>
                <span style={{ display:'block', width:16, height:16, borderRadius:'50%', margin:'auto', marginTop:6,
                  background: `conic-gradient(from 0deg, ${item.color}, ${item.color}44, ${item.color})`,
                  boxShadow: `0 0 10px ${item.color}55`,
                  animation: 'spin 3s linear infinite' }} />
                <span style={{ position:'absolute', bottom:2, right:3, fontSize:'0.55rem', fontWeight:800,
                  color: 'rgba(255,255,255,0.4)', letterSpacing:'0.04em' }}>JSON</span>
              </span>
              <span className={styles.libChipLabel}>{item.name}</span>
              {item.tag === 'PRO' && <span className={styles.libChipPro}>PRO</span>}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.footer}>{items.length} animation{items.length !== 1 ? 's' : ''}</div>
    </Panel>
  );
}



// ── Render the registered panels in a region ──────────────────────

export function getAllPanelRenderers(): Record<string, () => ReactNode> {
  return {
    ai: () => <AiChatPanel />,
    templates: () => <TemplateFieldsPanel />,
    project:   () => <ProjectPanel />,
    scene:     () => <ScenePanel />,
    assets:    () => <AssetsPanel />,
    components: () => <ComponentsPanel />,
    shapes:     () => <ShapesPanel />,
    text:       () => <TextPanel />,
    presets: () => <MotionPresetsPanel />,
    properties: () => <PropertiesPanel />,
    style: () => <StylePanel />,
    rig: () => <RigPanel />,
    motion: () => <MotionEditorPanel />,
    effects: () => <EffectsPanel />,
    misc: () => <MiscPanel />,
    comments: () => <CommentsPanel />,
    history: () => <HistoryPanel />,
    renderQueue: () => <RenderQueuePanel />,
    // ── Asset Libraries ──────────────────────────────────────────────────
    'lib-cursors': () => <CursorLibraryPanel />,
    'lib-mograph': () => <MotionGFXPanel />,
    'lib-trans':   () => <TransitionsPanel />,
    'lib-sfx':     () => <SoundFXPanel />,
    'lib-lottie':  () => <LottiePanel />,
  };
}
