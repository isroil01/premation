/**
 * Demo panels — UI content for the layout's sidebar / inspector regions.
 *
 * In the future these will be replaced by panels registered by the Scene
 * Graph engine, the Asset engine, the Animation engine, etc. For now
 * they exercise every primitive in the design system and prove that the
 * panel/dock architecture is wired correctly.
 */

import { useMemo, useState, useRef, type ReactNode } from 'react';
import { Panel } from '@components/Panel';
import { HistoryPanel } from '@layout/History/HistoryPanel';
import { MotionEditorPanel } from '@layout/Motion/MotionEditorPanel';
import { CommentsPanel } from '@layout/Comments/CommentsPanel';
import { EffectsPanel } from '@layout/Effects/EffectsPanel';
import { RenderQueuePanel } from '@layout/RenderQueue/RenderQueuePanel';
import { MotionToolsPanel } from '@layout/MotionTools';
import { TreeView, type TreeNode } from '@components/TreeView';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { Input } from '@components/Input';
import { Icon, type IconName } from '@components/Icon';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { NodeInspector } from '@components/Inspector/NodeInspector';
import { ParentControl } from '@layout/Inspector/ParentControl';
import { MotionControls } from '@layout/Inspector/MotionControls';
import { PrecompControl } from '@layout/Inspector/PrecompControl';
import { TextAnimatorControls } from '@layout/Inspector/TextAnimatorControls';
import { AudioControls } from '@layout/Inspector/AudioControls';
import { TransformSection } from '@layout/Inspector/TransformSection';
import { AppearanceSection } from '@layout/Inspector/AppearanceSection';
import { AlignSection } from '@layout/Inspector/AlignSection';
import { TextSection } from '@layout/Inspector/TextSection';
import { MediaSection } from '@layout/Inspector/MediaSection';
import { ThreeDControl } from '@layout/Inspector/ThreeDControl';
import { ShapeEffects } from '@layout/Inspector/ShapeEffects';
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
} from '@core/scene/sceneInsert';
import { reparentNode, moveNodeAdjacent, canReparent } from '@core/scene/parenting';
import { LABEL_COLORS, readNodeLabelColor, setNodeLabelColor } from '@core/scene/labelColor';
import { getNodeFill, setNodeFill } from '@core/paint/fill';
import { insertShape, insertText } from '@core/scene/sceneInsert';
import { UI_COMPONENT_PRESETS } from '@core/scene/uiComponents';
import { useComponentStore } from '@stores/componentStore';
import { listPresets, applyPresetByName } from '@core/animation/animationPresets';
import { useUIStore } from '@stores/uiStore';
import { useWorkspaceStore } from '@stores/projectStore';
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
};

function toTreeNode(node: SceneNode): TreeNode<SceneNodeData> {
  const kind = readNodeKind(node);
  const children = defaultSceneGraph.getChildren(node.id).map(toTreeNode);
  return {
    id: node.id,
    label: node.name ?? node.id,
    icon: KIND_ICON[kind],
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

  // Drag-to-reorder / reparent from the layer tree.
  const handleReorder = (
    dragId: string,
    targetId: string,
    pos: 'before' | 'after' | 'inside',
  ): void => {
    if (pos === 'inside') {
      if (canReparent(dragId, targetId)) reparentNode(dragId, targetId);
      else moveNodeAdjacent(dragId, targetId, 'after');
    } else {
      moveNodeAdjacent(dragId, targetId, pos);
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

const TYPE_ICON: Record<ImportedAsset['type'], IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
};

export function AssetsPanel(): JSX.Element {
  const assets = useAssetStore((s) => s.assets);
  const addAsset = useAssetStore((s) => s.addAsset);
  const removeAsset = useAssetStore((s) => s.removeAsset);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    for (let i = 0; i < e.target.files.length; i++) {
      const file = e.target.files[i];
      if (file) {
        // Import into the library AND drop it straight onto the canvas, so the
        // user sees their media immediately (no separate "Add to composition"
        // step). It stays in the Assets panel for re-use.
        const asset = await addAsset(file);
        insertMedia(asset);
      }
    }
    // Reset input
    e.target.value = '';
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const addAssetToScene = (asset: ImportedAsset) => {
    insertMedia(asset);
  };

  const filteredAssets = assets.filter((a) =>
    a.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <Panel
      id="assets"
      title="Assets"
      icon="folder"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'assets' })}
    >
      <div className={styles.toolbar}>
        <Input
          placeholder="Search assets…"
          size="sm"
          leftIcon="search"
          className={styles.search}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button type="button" className={styles.importBtn} onClick={handleImportClick} title="Import media files">
          <Icon name="plus" size={13} /> Import
        </button>
        <input
          type="file"
          ref={fileInputRef}
          className={styles.fileInput}
          multiple
          accept="image/*,video/*,audio/*"
          onChange={handleFileChange}
        />
      </div>
      <div className={styles.body}>
        {filteredAssets.length === 0 ? (
          <div className={styles.empty}>
            <p style={{ margin: 0, color: 'var(--color-text-tertiary)', fontSize: '11px' }}>
              {searchQuery ? 'No matching assets found.' : 'No media assets imported yet. Click Import to add files.'}
            </p>
          </div>
        ) : (
          <div className={styles.assetList}>
            {filteredAssets.map((asset) => (
              <div key={asset.id} className={styles.assetItem} title={asset.name}>
                <div className={styles.assetIcon}>
                  <Icon name={TYPE_ICON[asset.type]} size={14} />
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
                    onClick={() => addAssetToScene(asset)}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                  <button
                    type="button"
                    className={styles.actionButtonRemove}
                    title="Delete asset"
                    onClick={() => removeAsset(asset.id)}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={styles.footer}>
        <span>{filteredAssets.length} items</span>
      </div>
    </Panel>
  );
}

// ── Properties (Right inspector) ─────────────────────────────────

export function PropertiesPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? null;

  return (
    <Panel
      id="properties"
      title="Properties"
      icon="settings"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'properties' })}
    >
      <InspectorContent nodeId={primary} />
    </Panel>
  );
}

function InspectorContent({ nodeId }: { nodeId: string | null }): JSX.Element {
  // Hooks must run unconditionally on every render — keep this above the early
  // returns below (nothing-selected / missing-node), or React throws
  // "Expected static flag was missing" when the selection toggles.
  const enterFocus = useFocusStore((s) => s.enter);

  if (!nodeId) {
    return (
      <div style={{ padding: '16px 14px', color: 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
        <div style={{ color: 'var(--color-text-primary)', fontWeight: 600, marginBottom: 8 }}>Nothing selected</div>
        <p style={{ margin: '0 0 12px' }}>
          Select a layer in the canvas or the Scene panel to edit its properties
          (fill, font, transform, effects…).
        </p>
        <div style={{ color: 'var(--color-text-primary)', fontWeight: 600, margin: '4px 0 6px' }}>Give it motion</div>
        <ol style={{ margin: 0, paddingLeft: 16 }}>
          <li>Select a layer.</li>
          <li>Click <strong style={{ color: 'var(--color-text-primary)' }}>Animate</strong> next to a property (Position, Scale, Opacity…) to set a first keyframe.</li>
          <li>Move the playhead in the timeline, then change the value — a second keyframe is created.</li>
          <li>Press <strong style={{ color: 'var(--color-text-primary)' }}>Play</strong> to preview.</li>
        </ol>
        <p style={{ margin: '12px 0 0', opacity: 0.8, color: 'var(--color-text-tertiary)' }}>
          Tip: with a layer selected, use the <strong style={{ color: 'var(--color-text-primary)' }}>Animate</strong> menu (top bar) or the
          assistant (“Ask anything…”) for one-click motion presets.
        </p>
      </div>
    );
  }

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return <div className={styles.empty}>No node data</div>;

  const kind = readNodeKind(node);

  switch (kind) {
    case 'shape': {
      const items: AccordionItem[] = [
        { id: 'transform', title: 'Transform', icon: 'settings', defaultOpen: true, content: (
          <>
            <TransformSection nodeId={nodeId} />
            <ThreeDControl nodeId={nodeId} />
          </>
        )},
        { id: 'parenting', title: 'Parent & Link', icon: 'layers', content: <ParentControl nodeId={nodeId} /> },
        { id: 'motion', title: 'Motion & Keyframes', icon: 'keyframe', content: <MotionControls nodeId={nodeId} /> },
        { id: 'appearance', title: 'Appearance (Fill & Stroke)', icon: 'shape', defaultOpen: true, content: <AppearanceSection nodeId={nodeId} /> },
        { id: 'geometry', title: 'Geometry & Path Effects', icon: 'line', content: <ShapeEffects nodeId={nodeId} /> },
        { id: 'align', title: 'Align & Distribute', icon: 'align-center', content: <AlignSection /> },      ];
      return <div style={{ padding: 4 }}><Accordion items={items} /></div>;
    }
    case 'text': {
      const items: AccordionItem[] = [
        { id: 'transform', title: 'Transform', icon: 'settings', defaultOpen: true, content: (
          <>
            <TransformSection nodeId={nodeId} />
            <ThreeDControl nodeId={nodeId} />
          </>
        )},
        { id: 'parenting', title: 'Parent & Link', icon: 'layers', content: <ParentControl nodeId={nodeId} /> },
        { id: 'motion', title: 'Motion & Keyframes', icon: 'keyframe', content: <MotionControls nodeId={nodeId} /> },
        { id: 'text', title: 'Text Styles', icon: 'type', defaultOpen: true, content: <TextSection nodeId={nodeId} /> },
        { id: 'appearance', title: 'Appearance (Fill & Stroke)', icon: 'shape', content: <AppearanceSection nodeId={nodeId} /> },
        { id: 'animators', title: 'Text Animators', icon: 'sparkles', content: <TextAnimatorControls nodeId={nodeId} /> },
        { id: 'align', title: 'Align & Distribute', icon: 'align-center', content: <AlignSection /> },      ];
      return <div style={{ padding: 4 }}><Accordion items={items} /></div>;
    }
    case 'image':
    case 'video': {
      const items: AccordionItem[] = [
        { id: 'transform', title: 'Transform', icon: 'settings', defaultOpen: true, content: (
          <>
            <TransformSection nodeId={nodeId} />
            <ThreeDControl nodeId={nodeId} />
          </>
        )},
        { id: 'parenting', title: 'Parent & Link', icon: 'layers', content: <ParentControl nodeId={nodeId} /> },
        { id: 'motion', title: 'Motion & Keyframes', icon: 'keyframe', content: <MotionControls nodeId={nodeId} /> },
        { id: 'media', title: 'Media Settings', icon: 'image', defaultOpen: true, content: <MediaSection nodeId={nodeId} /> },
        { id: 'align', title: 'Align & Distribute', icon: 'align-center', content: <AlignSection /> },      ];
      return <div style={{ padding: 4 }}><Accordion items={items} /></div>;
    }
    case 'group': {
      const childrenCount = defaultSceneGraph.getChildren(nodeId).length;
      const items: AccordionItem[] = [
        { id: 'transform', title: 'Transform', icon: 'settings', defaultOpen: true, content: <TransformSection nodeId={nodeId} /> },
        { id: 'parenting', title: 'Parent & Link', icon: 'layers', content: <ParentControl nodeId={nodeId} /> },
        { id: 'precomp', title: 'Pre-composition', icon: 'folder', defaultOpen: true, content: (
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
        )},
        { id: 'motion', title: 'Motion & Keyframes', icon: 'keyframe', content: <MotionControls nodeId={nodeId} /> },      ];
      return <div style={{ padding: 4 }}><Accordion items={items} /></div>;
    }
    case 'camera': {
      const items: AccordionItem[] = [
        { id: 'transform', title: 'Transform', icon: 'settings', defaultOpen: true, content: <TransformSection nodeId={nodeId} /> },
        { id: 'parenting', title: 'Parent & Link', icon: 'layers', content: <ParentControl nodeId={nodeId} /> },
        { id: 'custom', title: 'Camera Settings', icon: 'camera', defaultOpen: true, content: (
          <>
            <NodeInspector nodeId={nodeId} />
            <div style={{ margin: '10px 0', fontSize: 10, color: 'var(--color-primary)', background: 'rgba(56, 189, 248, 0.08)', padding: '6px 8px', borderRadius: 4, border: '1px solid rgba(56, 189, 248, 0.2)' }}>
              <strong>Camera:</strong> 3D viewport view controller. Adjust Position X/Y/Z and Focal Length to navigate.
            </div>
          </>
        )},
      ];
      return <div style={{ padding: 4 }}><Accordion items={items} /></div>;
    }
    case 'light': {
      const items: AccordionItem[] = [
        { id: 'transform', title: 'Transform', icon: 'settings', defaultOpen: true, content: <TransformSection nodeId={nodeId} /> },
        { id: 'custom', title: 'Light Settings', icon: 'light', defaultOpen: true, content: (
          <>
            <NodeInspector nodeId={nodeId} />
            <div style={{ margin: '10px 0', fontSize: 10, color: '#f59e0b', background: 'rgba(245, 158, 11, 0.08)', padding: '6px 8px', borderRadius: 4, border: '1px solid rgba(245, 158, 11, 0.2)' }}>
              <strong>Light:</strong> Casts radial illumination onto layers beneath. Adjust radius and intensity in transform.
            </div>
          </>
        )},
      ];
      return <div style={{ padding: 4 }}><Accordion items={items} /></div>;
    }
    case 'null': {
      const items: AccordionItem[] = [
        { id: 'transform', title: 'Transform', icon: 'settings', defaultOpen: true, content: (
          <TransformSection nodeId={nodeId} />
        )},
        { id: 'parenting', title: 'Parent & Link', icon: 'layers', content: <ParentControl nodeId={nodeId} /> },
        { id: 'motion', title: 'Motion & Keyframes', icon: 'keyframe', content: <MotionControls nodeId={nodeId} /> },
        { id: 'info', title: 'Null Object Info', icon: 'info', defaultOpen: true, content: (
          <div style={{ margin: '10px 0', fontSize: 10, color: '#ffb703', background: 'rgba(255, 183, 3, 0.08)', padding: '6px 8px', borderRadius: 4, border: '1px solid rgba(255, 183, 3, 0.2)' }}>
            <strong>Null Object:</strong> Invisible controller. Attach layers as children via Parent & Link.
          </div>
        )},
      ];
      return <div style={{ padding: 4 }}><Accordion items={items} /></div>;
    }
    case 'audio': {
      return (
        <div style={{ padding: 8 }}>
          <ParentControl nodeId={nodeId} />
          <AudioControls nodeId={nodeId} />
        </div>
      );
    }
    default:
      return (
        <div style={{ padding: 8 }}>
          <ParentControl nodeId={nodeId} />
          <TransformSection nodeId={nodeId} />
          <NodeInspector nodeId={nodeId} />
        </div>
      );
  }
}

const SHAPE_PRESETS = [
  { id: 'rect',    label: 'Rectangle', svg: <rect x="4" y="4" width="24" height="24" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'rect' },
  { id: 'ellipse', label: 'Ellipse',   svg: <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'ellipse' },
  { id: 'line',    label: 'Line',      svg: <line x1="4" y1="28" x2="28" y2="4" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'line' },
  { id: 'star',    label: 'Star',      svg: <polygon points="16,2 20,11 30,12 22,19 24,29 16,24 8,29 10,19 2,12 12,11" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'star' },
  { id: 'polygon', label: 'Polygon',   svg: <polygon points="16,3 28,10 28,24 16,31 4,24 4,10" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'polygon' },
] as const;

const TEXT_PRESETS = [
  { id: 'title',    label: 'Title',    fontSize: 72,  weight: 700 },
  { id: 'subtitle', label: 'Subtitle', fontSize: 48,  weight: 600 },
  { id: 'body',     label: 'Body',     fontSize: 36,  weight: 400 },
  { id: 'caption',  label: 'Caption',  fontSize: 24,  weight: 400 },
  { id: 'label',    label: 'Label',    fontSize: 20,  weight: 500 },
  { id: 'overline', label: 'Overline', fontSize: 14,  weight: 500 },
  { id: 'quote',    label: 'Quote',    fontSize: 32,  weight: 300 },
  { id: 'mono',     label: 'Monospace',fontSize: 36,  weight: 500 },
  { id: 'button',   label: 'Button',   fontSize: 16,  weight: 600 },
  { id: 'link',     label: 'Link',     fontSize: 18,  weight: 400 },
] as const;

const SWATCHES = [
  '#ff2b7e', '#2b7eff', '#28c7d7', '#ffb703',
  '#9b5de5', '#00f5d4', '#ff9f1c', '#e63946',
  '#457b9d', '#1d3557', '#a8dadc', '#ffffff'
];

export function LibrariesPanel(): JSX.Element {
  const [activeTab, setActiveTab] = useState<'ui' | 'components' | 'shapes' | 'text' | 'colors' | 'motion'>('ui');
  const savedComponents = useComponentStore((s) => s.components);
  const saveComponent = useComponentStore((s) => s.saveFromSelection);
  const insertComponent = useComponentStore((s) => s.insert);
  const removeComponent = useComponentStore((s) => s.remove);
  const hasSelection = useSelectionStore((s) => s.ids.length > 0);

  const handleShapeInsert = (preset: typeof SHAPE_PRESETS[number]) => {
    insertShape(preset.primitive, preset.label);
  };

  const handleTextInsert = (preset: typeof TEXT_PRESETS[number]) => {
    insertText(preset.label, preset.fontSize, preset.weight);
  };

  const handleColorClick = (color: string) => {
    const sel = useSelectionStore.getState().ids;
    if (sel.length === 0) {
      useUIStore.getState().notify({ level: 'warning', message: 'Select a layer to apply color', durationMs: 2000 });
      return;
    }
    for (const nodeId of sel) {
      const current = getNodeFill(nodeId);
      if (current && current.type === 'solid') {
        setNodeFill(nodeId, { ...current, color });
      } else {
        setNodeFill(nodeId, { type: 'solid', color });
      }
    }
    useUIStore.getState().notify({ level: 'success', message: 'Color swatch applied', durationMs: 1500 });
  };

  return (
    <Panel
      id="libraries"
      title="Libraries"
      icon="folder"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'libraries' })}
    >
      <div className={styles.libTabs}>
        {(['ui', 'components', 'shapes', 'text', 'colors', 'motion'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={activeTab === t ? styles.libTabActive : styles.libTab}
            onClick={() => setActiveTab(t)}
          >
            {t === 'ui' ? 'UI' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className={styles.libBody}>
        {activeTab === 'ui' && (
          <div className={styles.libGrid}>
            {UI_COMPONENT_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={styles.libChip}
                title={`Insert ${p.label} mock-up (editable layers)`}
                onClick={() => { p.insert(); useUIStore.getState().notify({ level: 'success', message: `Inserted ${p.label}`, durationMs: 1500 }); }}
              >
                <Icon name="layout" size={26} />
                <span className={styles.libChipLabel}>{p.label}</span>
              </button>
            ))}
          </div>
        )}
        {activeTab === 'components' && (
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              type="button"
              className={styles.libChip}
              style={{ flexDirection: 'row', gap: 8, justifyContent: 'center', opacity: hasSelection ? 1 : 0.5, cursor: hasSelection ? 'pointer' : 'not-allowed' }}
              disabled={!hasSelection}
              title={hasSelection ? 'Save the current selection as a reusable component' : 'Select layer(s) first'}
              onClick={() => {
                const name = window.prompt('Component name', 'My Component');
                if (name == null) return;
                const id = saveComponent(name);
                useUIStore.getState().notify(
                  id
                    ? { level: 'success', message: `Saved “${name}”`, durationMs: 1800 }
                    : { level: 'warning', message: 'Select layer(s) to save first', durationMs: 2000 },
                );
              }}
            >
              <Icon name="plus" size={14} /> Save selection as component
            </button>
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
                      title={`Insert a copy of “${c.name}”`}
                      onClick={() => { insertComponent(c.id); useUIStore.getState().notify({ level: 'success', message: `Inserted ${c.name}`, durationMs: 1500 }); }}
                    >
                      <Icon name="shape" size={24} />
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
        )}
        {activeTab === 'shapes' && (
          <div className={styles.libGrid}>
            {SHAPE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={styles.libChip}
                title={`Insert ${p.label}`}
                onClick={() => handleShapeInsert(p)}
              >
                <svg width="32" height="32" viewBox="0 0 32 32" style={{ color: '#bbb' }}>
                  {p.svg}
                </svg>
                <span className={styles.libChipLabel}>{p.label}</span>
              </button>
            ))}
          </div>
        )}
        {activeTab === 'text' && (
          <div className={styles.libList}>
            {TEXT_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={styles.libTextItem}
                title={`Insert ${p.label} text layer`}
                onClick={() => handleTextInsert(p)}
              >
                <span style={{ fontSize: Math.min(p.fontSize / 3, 20), fontWeight: p.weight }}>
                  {p.label}
                </span>
                <span className={styles.libTextMeta}>{p.fontSize}px · w{p.weight}</span>
              </button>
            ))}
          </div>
        )}
        {activeTab === 'colors' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: 12 }}>
            {SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => handleColorClick(color)}
                style={{
                  width: '100%',
                  aspectRatio: '1',
                  background: color,
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 4,
                  cursor: 'pointer'
                }}
                title={color}
              />
            ))}
          </div>
        )}
        {activeTab === 'motion' && (
          <div className={styles.libList}>
            {listPresets().map((preset) => (
              <button
                key={preset.name}
                type="button"
                className={styles.libMotionItem}
                title={`Apply: ${preset.name}`}
                onClick={() => {
                  const sel = useSelectionStore.getState().ids;
                  if (sel[0]) {
                    const ws = useWorkspaceStore.getState();
                    const playhead = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;
                    applyPresetByName(sel[0], preset.name, playhead);
                    useUIStore.getState().notify({ level: 'success', message: `Applied "${preset.name}"`, durationMs: 2000 });
                  } else {
                    useUIStore.getState().notify({ level: 'warning', message: 'Select a layer first', durationMs: 2000 });
                  }
                }}
              >
                <Icon name="play" size={13} />
                <span>{preset.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ── Render the registered panels in a region ──────────────────────

export function getAllPanelRenderers(): Record<string, () => ReactNode> {
  return {
    scene:     () => <ScenePanel />,
    assets:    () => <AssetsPanel />,
    libraries: () => <LibrariesPanel />,
    properties: () => <PropertiesPanel />,
    motion: () => <MotionEditorPanel />,
    effects: () => <EffectsPanel />,
    motionTools: () => <MotionToolsPanel />,
    comments: () => <CommentsPanel />,
    history: () => <HistoryPanel />,
    renderQueue: () => <RenderQueuePanel />,
  };
}
