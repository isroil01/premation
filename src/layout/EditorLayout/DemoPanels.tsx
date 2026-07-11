/**
 * Demo panels — UI content for the layout's sidebar / inspector regions.
 *
 * In the future these will be replaced by panels registered by the Scene
 * Graph engine, the Asset engine, the Animation engine, etc. For now
 * they exercise every primitive in the design system and prove that the
 * panel/dock architecture is wired correctly.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Panel } from '@components/Panel';
import { Inspector } from '@components/Inspector';
import { HistoryPanel } from '@layout/History/HistoryPanel';
import { MotionEditorPanel } from '@layout/Motion/MotionEditorPanel';
import { CommentsPanel } from '@layout/Comments/CommentsPanel';
import { EffectsPanel } from '@layout/Effects/EffectsPanel';
import { TreeView, type TreeNode } from '@components/TreeView';
import { Input } from '@components/Input';
import { Icon, type IconName } from '@components/Icon';
import { NodeInspector } from '@components/Inspector/NodeInspector';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { type SceneKind } from '@core/scene/seedDefaultScene';
import { readNodeKind } from '@core/scene/sceneDerive';
import type { SceneNode } from '@core/types';
import styles from './DemoPanels.module.css';

// ── Scene (Left sidebar) ──────────────────────────────────────────

interface SceneNodeData {
  type: SceneKind;
}

const KIND_ICON: Record<SceneKind, IconName> = {
  group: 'layers',
  shape: 'shape',
  text: 'type',
  image: 'image',
  video: 'video',
};

function toTreeNode(node: SceneNode): TreeNode<SceneNodeData> {
  const kind = readNodeKind(node);
  const children = defaultSceneGraph.getChildren(node.id).map(toTreeNode);
  return {
    id: node.id,
    label: node.name ?? node.id,
    icon: KIND_ICON[kind],
    data: { type: kind },
    children: children.length ? children : undefined,
  };
}

/** Build the Scene tree from the live scene graph (single source of truth). */
function sceneGraphToTree(): TreeNode<SceneNodeData>[] {
  return defaultSceneGraph.getRoots().map(toTreeNode);
}

let nodeSeq = 0;

/** Clone a node (fresh ids, "copy" suffix); children are not duplicated. */
function cloneNode(node: SceneNode): SceneNode {
  const id = `${readNodeKind(node)}_${(nodeSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  return {
    ...node,
    id,
    name: `${node.name ?? 'Node'} copy`,
    parent: node.parent ?? null,
    children: [],
    transform: {
      position: { ...node.transform.position },
      rotation: node.transform.rotation,
      scale: { ...node.transform.scale },
    },
    components: node.components.map((c, i) => ({ id: `${id}_c${i}`, type: c.type, props: { ...c.props } })),
  };
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

  const toggleVisible = (id: string): void => {
    const n = defaultSceneGraph.getNode(id);
    if (!n) return;
    n.visible = n.visible === false;
    bumpScene();
  };

  const deleteNode = (id: string): void => {
    defaultSceneGraph.removeNode(id);
    setSelected(selected.filter((s) => s !== id));
    bumpScene();
  };

  const duplicateNode = (id: string): void => {
    const n = defaultSceneGraph.getNode(id);
    if (!n) return;
    const copy = cloneNode(n);
    if (n.parent) defaultSceneGraph.addChild(n.parent, copy);
    else defaultSceneGraph.addNode(copy);
    setSelected([copy.id]);
    bumpScene();
  };

  const openNodeMenu = (id: string, e: React.MouseEvent): void => {
    const hidden = defaultSceneGraph.getNode(id)?.visible === false;
    openContextMenu(e.clientX, e.clientY, [
      { id: 'duplicate', label: 'Duplicate', onSelect: () => duplicateNode(id) },
      { id: 'toggle', label: hidden ? 'Show' : 'Hide', onSelect: () => toggleVisible(id) },
      { id: 'sep', separator: true },
      { id: 'delete', label: 'Delete', danger: true, onSelect: () => deleteNode(id) },
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
            {q ? 'No layers match your search.' : 'No layers yet. Use the + buttons to add one.'}
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

const SAMPLE_ASSETS: TreeNode<unknown>[] = [
  { id: 'a_root', label: 'Library', icon: 'folder', children: [
    { id: 'a_shapes', label: 'Shapes', icon: 'shape', children: [
      { id: 'a_arrow', label: 'Arrow.svg', icon: 'arrow-right' },
      { id: 'a_star', label: 'Star.svg', icon: 'shape' },
    ]},
    { id: 'a_textures', label: 'Textures', icon: 'image', children: [
      { id: 'a_noise', label: 'Noise.png', icon: 'image' },
      { id: 'a_grain', label: 'Grain.jpg', icon: 'image' },
    ]},
    { id: 'a_audio', label: 'Audio', icon: 'audio', children: [
      { id: 'a_music', label: 'Music.mp3', icon: 'audio' },
    ]},
  ]},
];

export function AssetsPanel(): JSX.Element {
  return (
    <Panel
      id="assets"
      title="Assets"
      icon="folder"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'assets' })}
    >
      <div className={styles.toolbar}>
        <Input placeholder="Search assets…" size="sm" leftIcon="search" className={styles.search} />
      </div>
      <div className={styles.body}>
        <TreeView nodes={SAMPLE_ASSETS} defaultExpandedIds={['a_root']} />
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
  if (!nodeId) {
    return (
      <Inspector
        groups={[]}
        emptyMessage="Select a node to edit its properties."
      />
    );
  }

  // Render the node-specific editors for the selected node.
  return (
    <div style={{ padding: 8 }}>
      <NodeInspector nodeId={nodeId} />
    </div>
  );
}

// ── Render the registered panels in a region ──────────────────────

export function getSidebarRenderers(): Record<string, () => ReactNode> {
  return {
    scene: () => <ScenePanel />,
    assets: () => <AssetsPanel />,
  };
}

export function getInspectorRenderers(): Record<string, () => ReactNode> {
  return {
    properties: () => <PropertiesPanel />,
    motion: () => <MotionEditorPanel />,
    effects: () => <EffectsPanel />,
    comments: () => <CommentsPanel />,
    history: () => <HistoryPanel />,
  };
}
