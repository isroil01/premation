/**
 * The Layers tree's ROWS — scene graph → `TreeNode`, and the facts the filter
 * asks about each one.
 *
 * Split out of `ScenePanel` because the panel had grown three jobs into one
 * file and this is the one with no React in it worth speaking of: it is a
 * projection of the document, testable without standing a panel up, and the
 * layer-ordering tests already reached into it for exactly that reason.
 *
 * The glyphs come from `sceneDerive` — the same table the timeline, the
 * Inspector header and the Command Palette read, so one layer draws as one kind
 * of object wherever it appears.
 */

import { Icon, type IconName } from '@components/Icon';
import type { TreeNode } from '@components/TreeView';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type SceneGraph from '@core/scene/SceneGraph';
import {
  KIND_GLYPH_COLOR,
  nodeIconName,
  readNodeKind,
  stackOrderedChildren,
} from '@core/scene/sceneDerive';
import { activeCompRootId } from '@core/scene/activeComp';
import { readNodeLabelColor } from '@core/scene/labelColor';
import { findKindFor, findLayerKind } from '@core/plugins/layerKindRegistry';
import { ownerOf, readCustomLayer } from '@core/plugins/customLayers';
import { getNodeEffects, effectDisplayNames } from '@core/effects/effects';
import { assetIdOf } from '@core/source/sourceInfo';
import { defaultAnimation } from '@motion/animation';
import { useAssetStore } from '@stores/assetStore';
import { useProjectStore } from '@stores/projectStore';
import type { SceneScope, SearchField } from '@stores/sceneViewStore';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import type { SceneNodeFacts } from './sceneFilters';
import styles from '@layout/EditorLayout/panels.module.css';

/** What the TreeView carries per row beyond its label — used for the glyph. */
export interface SceneNodeData {
  type: SceneKind;
}

export interface RowOptions {
  /** Draw a source preview instead of the kind glyph on media layers. */
  thumbnails?: boolean;
}

/** Asset preview for a media layer, or undefined. */
function thumbnailFor(node: SceneNode): string | undefined {
  const assetId = assetIdOf(node);
  if (!assetId) return undefined;
  const asset = useAssetStore.getState().assets.find((a) => a.id === assetId);
  if (!asset || asset.type === 'audio') return undefined;
  return asset.thumbSrc ?? asset.src;
}

function toTreeNode(node: SceneNode, opts: RowOptions): TreeNode<SceneNodeData> {
  const kind = readNodeKind(node);
  // Stacking convention (matches the timeline): the TOP entry is the
  // FRONT-most layer. `stackOrderedChildren` is that one convention, shared
  // with `deriveTimelineTracks` so the tree and the timeline rows cannot drift.
  const children = stackOrderedChildren(defaultSceneGraph, node.id).map((c) => toTreeNode(c, opts));

  const custom = readCustomLayer(node);
  const iconName = nodeIconName(node, () => {
    if (!custom) return undefined;
    const registered = findLayerKind(custom.kind);
    return (registered?.kind.icon as string | undefined) ?? 'plugin';
  }) as IconName;

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
  const inert = custom ? !findKindFor(custom.pluginId, custom.kindId) : false;

  // A composition root is labelled from the PROJECT record, the source of truth
  // the comp tabs and the timeline read. The root node carries a name of its
  // own, seeded as "Composition 1" and only kept in step by `renameComposition`
  // — so a fresh project's tree said "Composition 1" under a tab titled
  // "Main Comp".
  const compName = node.parent ? undefined : useProjectStore.getState().comps[node.id]?.name;
  // The plain text behind whatever `label` becomes below. The rename field is
  // seeded from THIS, never from the node: a label wrapped in a <span> used to
  // seed an empty box, and an empty box commits as a cancel.
  const name = compName ?? node.name ?? node.id;

  let label: React.ReactNode = name;
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

  // A hidden layer reads as hidden in the tree, not only through its eye
  // glyph: the eye is on the far right and fades out until the row is
  // hovered, so a stack with three hidden layers looked identical to one
  // with none. Dimmed, not removed — it is still the user's layer.
  if (node.visible === false) {
    label = <span className={styles.hiddenRow}>{label}</span>;
  }

  return {
    id: node.id,
    label,
    name,
    icon: iconName,
    iconColor: KIND_GLYPH_COLOR[kind],
    labelColor: readNodeLabelColor(node),
    thumbnail: opts.thumbnails ? thumbnailFor(node) : undefined,
    data: { type: kind },
    children: children.length ? children : undefined,
  };
}

/**
 * Build the Layers tree from the live scene graph (single source of truth).
 *
 * `scope` picks how much of the document is listed: the open composition, as
 * the timeline shows it, or every composition at once. It used to be the
 * second unconditionally — `getRoots()` — so a ten-comp project put ten roots
 * in one tree while the footer beside it counted only the open one.
 *
 * Exported for the layer-ordering tests, which assert what this panel LISTS
 * after an arrange without standing the whole React tree up.
 */
export function sceneGraphToTree(
  scope: SceneScope = 'project',
  opts: RowOptions = {},
  graph: SceneGraph = defaultSceneGraph,
): TreeNode<SceneNodeData>[] {
  if (scope === 'comp') {
    const rootId = activeCompRootId();
    const root = rootId ? graph.getNode(rootId) : undefined;
    // No open comp (or a stale id) falls back to the whole project rather than
    // to an empty panel: something on screen beats a blank with no stated cause.
    if (root) return [toTreeNode(root, opts)];
  }
  return graph.getRoots().map((n) => toTreeNode(n, opts));
}

/** Every kind actually present, in `order`'s order — the menu lists what this
 *  tree HAS, not the thirteen kinds that exist. */
export function presentKinds(
  nodes: ReadonlyArray<TreeNode<SceneNodeData>>,
  order: ReadonlyArray<SceneKind>,
): SceneKind[] {
  const seen = new Set<SceneKind>();
  const walk = (list: ReadonlyArray<TreeNode<SceneNodeData>>): void => {
    for (const n of list) {
      if (n.data) seen.add(n.data.type);
      if (n.children) walk(n.children as TreeNode<SceneNodeData>[]);
    }
  };
  walk(nodes);
  return order.filter((k) => seen.has(k));
}

export function collectIds(nodes: ReadonlyArray<TreeNode<SceneNodeData>>): string[] {
  return nodes.flatMap((n) => [
    n.id,
    ...(n.children ? collectIds(n.children as TreeNode<SceneNodeData>[]) : []),
  ]);
}

/**
 * A reader of node facts for the filter, with the per-pass work done ONCE.
 *
 * Two of the four search fields are expensive to answer per node in the way the
 * panel used to: `allExpressions()` walks every expression in the document, and
 * the asset list is a linear scan. Asking them per node per keystroke made the
 * cost of a search quadratic in the size of the project. So the caller builds
 * one of these per filter pass and the tree walk reads it — and the fields that
 * are not being searched are never computed at all.
 *
 * Returns a plain function so `filterSceneTree` and `countSceneMatches` share
 * the same index instead of each doing their own walk.
 */
export function makeFactsReader(fields: ReadonlyArray<SearchField>, querying: boolean): (id: string) => SceneNodeFacts | null {
  const wants = (f: SearchField): boolean => querying && fields.includes(f);

  let exprByNode: Map<string, string> | null = null;
  if (wants('expressions')) {
    exprByNode = new Map();
    for (const expr of defaultAnimation.allExpressions()) {
      const prev = exprByNode.get(expr.nodeId);
      exprByNode.set(expr.nodeId, prev ? `${prev}\n${expr.src}` : expr.src);
    }
  }

  let assetNameById: Map<string, string> | null = null;
  if (wants('source')) {
    assetNameById = new Map(useAssetStore.getState().assets.map((a) => [a.id, a.name]));
  }
  const comps = wants('source') ? useProjectStore.getState().comps : null;

  const wantEffectNames = wants('effects');

  return (id: string): SceneNodeFacts | null => {
    const node = defaultSceneGraph.getNode(id);
    if (!node) return null;
    const effects = getNodeEffects(id);

    let source: string | undefined;
    if (assetNameById) {
      const assetId = assetIdOf(node);
      const named = assetId ? assetNameById.get(assetId) : undefined;
      // A comp layer's "source" is the composition it plays, which is the
      // thing a user looking for "every layer using the Logo comp" means.
      source = (named ?? comps?.[id]?.name)?.toLowerCase();
    }

    return {
      kind: readNodeKind(node),
      label: readNodeLabelColor(node),
      animated: defaultAnimation.hasAnimation(id),
      hasEffects: effects.length > 0,
      name: node.name ?? id,
      shy: (node as { shy?: boolean }).shy === true,
      effectNames: wantEffectNames
        ? [...effectDisplayNames(effects).values()].join('\n').toLowerCase()
        : undefined,
      expressions: exprByNode?.get(id)?.toLowerCase(),
      source,
    };
  };
}
