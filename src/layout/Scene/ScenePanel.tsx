/**
 * ScenePanel — the layer tree for the open composition, plus the project's
 * composition list above it.
 *
 * Three jobs, all of them the document's structure rather than its values:
 *   • the composition list (open, duplicate, settings, delete);
 *   • the layer tree — selection, rename, visibility, drag-to-reparent, and
 *     the per-layer kebab that hosts arrange / lock / solo / label colour,
 *     grouping and pre-compose, the SVG actions, and the boolean path
 *     operators (Merge Paths, live and baked);
 *   • the search box that filters the tree, keeping ancestors of any match.
 *
 * It reads the live scene graph directly (`defaultSceneGraph`) and re-derives
 * the tree from a scene revision bump, so there is one source of truth for
 * what the document contains and this panel never holds a second copy of it.
 *
 * Panel chrome (rows, the footer, the search row) comes from the shared
 * `EditorLayout/panels.module.css`, which the Scene, Assets and Inspector
 * panels all draw from — they are three views of one dock, not three designs.
 */

import { useMemo, useState, useEffect } from 'react';
import { Panel } from '@components/Panel';
import { TreeView, type TreeNode } from '@components/TreeView';
import { SearchField } from '@components/SearchField';
import { Icon, type IconName } from '@components/Icon';
import { customConfirm } from '@components/Modal';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { renameLayer } from '@core/scene/renameLayer';
import { type SceneKind } from '@core/scene/seedDefaultScene';
import { flattenComposition, readNodeKind, stackOrderedChildren } from '@core/scene/sceneDerive';
import {
  toggleSelectedLocked,
  toggleSelectedSolo,
  groupSelectedLayers,
  ungroupSelected,
  precomposeSelected,
  duplicateSelectedLayers,
  deleteSelectedLayers,
} from '@core/scene/sceneInsert';
import { mergeSelectedPaths, liveMergeSelectedPaths } from '@core/scene/mergePaths';
import { rigLogoForAnimation } from '@core/scene/rigLogo';
import { reparentNode, moveNodeAdjacent, canReparent, arrangeNodes } from '@core/scene/parenting';
import { LABEL_COLORS, readNodeLabelColor, setNodeLabelColor, nodesWithLabelColor } from '@core/scene/labelColor';
import { deleteComposition, duplicateComposition } from '@core/composition/compositionOps';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import { svgContextMenuItems } from '@layout/Inspector/svgLayerActions';
import { findLayerKind, findKindFor } from '@core/plugins/layerKindRegistry';
import { ownerOf, readCustomLayer } from '@core/plugins/customLayers';
import type { SceneNode } from '@core/types';
import styles from '@layout/EditorLayout/panels.module.css';

/** What the TreeView carries per row beyond its label — used for the glyph. */
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

const KIND_COLOR: Record<SceneKind, string> = {
  group: '#a78bfa',
  null: '#94a3b8',
  shape: '#2dd4bf',
  text: '#60a5fa',
  image: '#f59e0b',
  video: '#f43f5e',
  svg: '#34d399',
  audio: '#10b981',
  camera: '#fb923c',
  light: '#facc15',
  adjustment: '#c084fc',
  particle: '#ec4899',
  comp: '#818cf8',
};

function toTreeNode(node: SceneNode): TreeNode<SceneNodeData> {
  const kind = readNodeKind(node);
  // Stacking convention (matches the timeline): the TOP entry is the
  // FRONT-most layer. `stackOrderedChildren` is that one convention, shared
  // with `deriveTimelineTracks` so the tree and the timeline rows cannot drift.
  const children = stackOrderedChildren(defaultSceneGraph, node.id).map(toTreeNode);
  
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
    iconColor: KIND_COLOR[kind],
    labelColor: readNodeLabelColor(node),
    data: { type: kind },
    children: children.length ? children : undefined,
  };
}

/** Build the Scene tree from the live scene graph (single source of truth).
 *  Exported for the layer-ordering tests, which assert what this panel LISTS
 *  after an arrange without standing the whole React tree up. */
export function sceneGraphToTree(): TreeNode<SceneNodeData>[] {
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
    { id: 'label-select-sep', separator: true },
    {
      id: 'label-select-same',
      // The other half of what a label is FOR. Assigning colours only pays off
      // if you can then act on the group; without this the palette is
      // decoration. Matches the UNLABELLED set too, which is how you find the
      // layers you forgot to tag.
      label: 'Select All with This Label',
      onSelect: () => {
        const matches = nodesWithLabelColor(targetId);
        if (matches.length) useSelectionStore.getState().set(matches);
      },
    },
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

  const comps = useProjectStore((s) => s.comps);
  const projectTabs = useProjectStore((s) => s.tabs);
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const openTab = useProjectStore((s) => s.actions.openTab);
  const setActiveTab = useProjectStore((s) => s.actions.setActiveTab);
  const listedComps = useMemo(
    () => Object.values(comps).filter((c) => !c.pristine),
    [comps],
  );
  const activeCompId = activeTabId ? projectTabs[activeTabId]?.compositionId : undefined;

  const openComposition = (compId: string): void => {
    const existing = Object.values(projectTabs).find((t) => t.compositionId === compId);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    const name = comps[compId]?.name ?? compId;
    openTab(compId, [compId], name);
  };

  const confirmDeleteComp = async (compId: string): Promise<void> => {
    const comp = comps[compId];
    if (!comp || comp.pristine) return;
    const layers = Math.max(0, flattenComposition(defaultSceneGraph, compId).length - 1);
    const warn = layers > 0
      ? `Delete “${comp.name}” and its ${layers} layer${layers === 1 ? '' : 's'}?`
      : `Delete “${comp.name}”?`;
    if (await customConfirm('Delete Composition', warn, { isDanger: true, confirmLabel: 'Delete' })) {
      deleteComposition(compId);
    }
  };

  const openCompMenu = (compId: string, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const name = comps[compId]?.name ?? compId;
    openContextMenu(e.clientX, e.clientY, [
      { id: 'open', label: 'Open Composition', onSelect: () => openComposition(compId) },
      {
        id: 'settings',
        label: 'Composition Settings…',
        onSelect: () => {
          openComposition(compId);
          openCompositionSettings();
        },
      },
      { id: 'duplicate', label: 'Duplicate', onSelect: () => duplicateComposition(compId) },
      { id: 'sep', separator: true },
      {
        id: 'delete',
        label: `Delete “${name}”`,
        danger: true,
        onSelect: () => { void confirmDeleteComp(compId); },
      },
    ]);
  };

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

  /*
   * Keep a reparented layer on screen.
   *
   * `parent` IS the tree here, so parenting MOVES the layer into the parent's
   * branch — and only composition roots are expanded by default. Parent a
   * rectangle to a Null and it lands inside a branch that has never been
   * expanded (a Null has no children until that moment), so it vanishes from
   * this panel entirely while still rendering on canvas. Reported as
   * "missing layer after parent to null".
   *
   * The whole ancestor chain, not just the parent: the destination can itself
   * sit inside a shut group, and opening only the innermost branch would leave
   * the layer just as hidden one level up.
   */
  const [revealIds, setRevealIds] = useState<ReadonlyArray<string>>([]);
  useEffect(() => {
    const sub = getEventBus().on('LayerReparented', ({ parentId }) => {
      const chain: string[] = [];
      const seen = new Set<string>();
      let cur: string | null = parentId;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        chain.push(cur);
        cur = defaultSceneGraph.getNode(cur)?.parent ?? null;
      }
      setRevealIds(chain);
    });
    return () => sub.dispose();
  }, []);

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
      // `arrangeNodes` over the WHOLE selection, never a loop over it — the
      // loop moved a multi-selection one layer at a time and the members
      // leapfrogged each other (see `reorderSiblings`). Same call the Layer ▸
      // Arrange commands and the viewport's context menu make.
      { id: 'arrange', label: 'Arrange', children: [
        { id: 'arr-front', label: 'Bring to Front', onSelect: () => { arrangeNodes(useSelectionStore.getState().ids, 'front'); } },
        { id: 'arr-forward', label: 'Bring Forward', onSelect: () => { arrangeNodes(useSelectionStore.getState().ids, 'forward'); } },
        { id: 'arr-backward', label: 'Send Backward', onSelect: () => { arrangeNodes(useSelectionStore.getState().ids, 'backward'); } },
        { id: 'arr-back', label: 'Send to Back', onSelect: () => { arrangeNodes(useSelectionStore.getState().ids, 'back'); } },
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
      noScroll
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'scene' })}
    >
      <div className={styles.sceneShell} data-tour="scene-panel">
      {/* Compositions live here — not in Assets. Assets = media library. */}
      <div className={styles.compSection}>
        <div className={styles.compSectionHead}>
          <span className={styles.compSectionLabel}>Compositions</span>
          <button
            type="button"
            className={styles.compAddBtn}
            title="New Composition…"
            aria-label="New Composition"
            onClick={() => openNewCompositionDialog()}
          >
            <Icon name="plus" size="sm" />
          </button>
        </div>
        {listedComps.length === 0 ? (
          <div className={styles.compEmpty}>None yet — create one to start</div>
        ) : (
          <div className={styles.compList} role="list">
            {listedComps.map((c) => {
              const active = c.id === activeCompId;
              return (
                <div
                  key={c.id}
                  role="listitem"
                  className={`${styles.compRow}${active ? ` ${styles.compRowActive}` : ''}`}
                  title={`${c.name} · ${c.width}×${c.height} · ${c.fps} fps`}
                  onClick={() => openComposition(c.id)}
                  onContextMenu={(e) => openCompMenu(c.id, e)}
                >
                  <Icon name="component" size="sm" className={styles.compGlyph} />
                  <span className={styles.compName}>{c.name}</span>
                  <span className={styles.compMeta}>{c.width}×{c.height}</span>
                  <button
                    type="button"
                    className={styles.compDeleteBtn}
                    title={`Delete “${c.name}”`}
                    aria-label={`Delete ${c.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void confirmDeleteComp(c.id);
                    }}
                  >
                    <Icon name="trash" size="sm" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.layerSectionHead}>
        <span className={styles.compSectionLabel}>Layers</span>
      </div>
      <div className={styles.searchRow}>
        <SearchField
          placeholder="Search layers…"
          ariaLabel="Search layers"
          value={query}
          onChange={setQuery}
        />
      </div>
      {/*
        A pick-whip drop surface. Rows already carry `data-id` from the shared
        TreeView and that id IS the scene node id here, so scoping the container
        is the entire integration — see `@core/whip/whipTarget` for why the
        alternative (teaching TreeView to emit whip attributes) would be worse
        for a component six panels use with four kinds of id.
      */}
      <div className={styles.body} data-whip-scope="layer">
        {filtered.length ? (
          <TreeView
            nodes={filtered}
            selectedIds={selected}
            onSelect={setSelected}
            defaultExpandedIds={defaultExpandIds}
            expandedIds={q ? expandIds : undefined}
            revealIds={revealIds}
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
      </div>
    </Panel>
  );
}
