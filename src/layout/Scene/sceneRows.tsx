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
import type { LayerInfo, LayerSearchFacts } from '@motion/engine-api';
import { KIND_GLYPH_COLOR, KIND_ICON } from '@core/scene/sceneDerive';
import { effectDisplayNames, type Effect } from '@core/inspector/effectCatalog';
import { uiKindOf } from '@core/mirror/layerKinds';
import { mirrorIconName } from '@core/mirror/layerGlyph';
import { mirrorLabelColor } from '@core/mirror/layerLabels';
import { childOrderOf } from '@core/mirror/layerTree';
import { assetRecordNow } from '@stores/assetSession';
import { documentMirror, type DocumentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import type { SceneScope, SearchField } from '@stores/sceneViewStore';
import type { SceneKind } from '@core/scene/seedDefaultScene';
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

/**
 * The editor kind a row keys on: a plugin layer's own kind id (what the legacy
 * `readNodeKind` reported for it — the filter menu lists only the built-in
 * kinds), else the mirror's editor kind.
 */
function rowKind(layer: LayerInfo): SceneKind {
  return (layer.generator || uiKindOf(layer) || 'shape') as SceneKind;
}

/** Asset preview for a media layer, or undefined. */
function thumbnailFor(m: DocumentMirror, layer: LayerInfo): string | undefined {
  const item = layer.source ? m.item(layer.source) : undefined;
  if (!item || item.kind !== 'footage' || item.mediaType === 'audio') return undefined;
  // B4-gap: the preview URL is a page-side object URL the import minted (`thumbSrc`, else `src`), not a document
  // fact — the API's `getThumbnail` answers it once the engine owns decode (D); until then the asset record holds it.
  const asset = assetRecordNow(item.id);
  return asset ? asset.thumbSrc ?? asset.src : undefined;
}

/** A plugin layer kind's icon (the JavaScript plugin system is gone, G2: always the generic one). */
function pluginIconOf(): string | undefined {
  return 'plugin';
}

/** The row of a composition (a tree ROOT): labelled from its settings, its top layers under it. */
function compToTreeNode(m: DocumentMirror, compId: string, opts: RowOptions): TreeNode<SceneNodeData> {
  // A composition root is labelled from the PROJECT record, the source of truth
  // the comp tabs and the timeline read — never from a root node's own name
  // (seeded as "Composition 1", so a fresh project's tree said "Composition 1"
  // under a tab titled "Main Comp").
  const name = m.comp(compId)?.settings.name ?? compId;
  const children = childOrderOf(m, compId).reverse().map((c) => layerToTreeNode(m, c, opts)).filter((n): n is TreeNode<SceneNodeData> => !!n);
  return {
    id: compId,
    label: name,
    name,
    icon: KIND_ICON.group as IconName,
    iconColor: KIND_GLYPH_COLOR.group,
    labelColor: undefined,
    thumbnail: undefined,
    data: { type: 'group' },
    children: children.length ? children : undefined,
  };
}

function layerToTreeNode(m: DocumentMirror, id: string, opts: RowOptions): TreeNode<SceneNodeData> | null {
  const layer = m.layer(id);
  if (!layer) return null;
  const kind = rowKind(layer);
  // Stacking convention (matches the timeline): the TOP entry is the
  // FRONT-most layer. `childOrderOf` is back-to-front, like the scene graph's
  // child list, so the tree and the timeline rows cannot drift. (A legacy
  // nested precomp GROUP is a composition too: its members are that comp's layers.)
  const children = childOrderOf(m, id).reverse().map((c) => layerToTreeNode(m, c, opts)).filter((n): n is TreeNode<SceneNodeData> => !!n);
  const iconName = mirrorIconName(layer, pluginIconOf) as IconName;

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
  const owner = layer.managedBy;
  // A stored plugin-provided layer: its plugin system is gone (G2).
  const inert = layer.generator !== '';
  // The plain text behind whatever `label` becomes below. The rename field is
  // seeded from THIS, never from the node: a label wrapped in a <span> used to
  // seed an empty box, and an empty box commits as a cancel.
  const name = layer.name || id;

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
      <span className={styles.pluginInertRow} title={`"${layer.generator}" came from a JavaScript plugin, which this version no longer runs.`}>
        {label}
        <Icon name="warning" size="sm" />
      </span>
    );
  }

  // A hidden layer reads as hidden in the tree, not only through its eye
  // glyph: the eye is on the far right and fades out until the row is
  // hovered, so a stack with three hidden layers looked identical to one
  // with none. Dimmed, not removed — it is still the user's layer.
  if (!layer.switches.visible) {
    label = <span className={styles.hiddenRow}>{label}</span>;
  }

  return {
    id,
    label,
    name,
    icon: iconName,
    iconColor: KIND_GLYPH_COLOR[kind],
    labelColor: mirrorLabelColor(layer),
    thumbnail: opts.thumbnails ? thumbnailFor(m, layer) : undefined,
    data: { type: kind },
    children: children.length ? children : undefined,
  };
}

/**
 * Build the Layers tree from the document mirror (B4).
 *
 * `scope` picks how much of the document is listed: the open composition, as
 * the timeline shows it, or every composition at once. It used to be the
 * second unconditionally, so a ten-comp project put ten roots in one tree
 * while the footer beside it counted only the open one.
 *
 * Exported for the layer-ordering tests, which assert what this panel LISTS
 * after an arrange without standing the whole React tree up (they let the
 * engine's events land in the mirror first).
 */
export function sceneGraphToTree(
  scope: SceneScope = 'project',
  opts: RowOptions = {},
  m: DocumentMirror = documentMirror(),
): TreeNode<SceneNodeData>[] {
  if (scope === 'comp') {
    const id = activeCompIdNow();
    // A composition, or a group opened in its own tab. No open comp falls back
    // to the whole project rather than to an empty panel: something on screen
    // beats a blank with no stated cause.
    if (id && m.comp(id) && !m.layer(id)) return [compToTreeNode(m, id, opts)];
    const row = id ? layerToTreeNode(m, id, opts) : null;
    if (row) return [row];
  }
  // The tree's roots: the compositions that are not also a layer (a nested precomp group is listed where it sits).
  return m.compIds.filter((c) => !m.layer(c)).map((c) => compToTreeNode(m, c, opts));
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
export function makeFactsReader(
  fields: ReadonlyArray<SearchField>,
  querying: boolean,
  m: DocumentMirror = documentMirror(),
  search: ReadonlyMap<string, LayerSearchFacts> | null = null,
): (id: string) => SceneNodeFacts | null {
  const wants = (f: SearchField): boolean => querying && fields.includes(f);

  // B4: the document-wide expression / effect facts are the engine's
  // `getSearchFacts` answer (`useSearchFacts`) — the mirror loads property
  // trees on demand, never wholesale. Until it lands those fields match nothing.
  let exprByNode: Map<string, string> | null = null;
  if (wants('expressions')) {
    exprByNode = new Map();
    for (const [id, f] of search ?? []) if (f.expressions.length > 0) exprByNode.set(id, f.expressions.join('\n'));
  }
  const effectNamesOf = (id: string): string => {
    const pseudo = (search?.get(id)?.effects ?? []).map((type, i) => ({ id: String(i), type }) as Effect);
    return [...effectDisplayNames(pseudo).values()].join('\n').toLowerCase();
  };

  const wantEffectNames = wants('effects');
  const wantSource = wants('source');

  return (id: string): SceneNodeFacts | null => {
    const layer = m.layer(id);
    if (!layer) {
      // A composition root row: its name is its settings' name.
      const comp = m.comp(id);
      return comp
        ? { kind: 'group', label: undefined, animated: false, hasEffects: false, name: comp.settings.name, shy: false, effectNames: wantEffectNames ? '' : undefined, expressions: exprByNode?.get(id)?.toLowerCase(), source: undefined }
        : null;
    }

    let source: string | undefined;
    if (wantSource) {
      // A footage layer's source is its file; a comp layer's "source" is the
      // composition it plays, which is the thing a user looking for "every
      // layer using the Logo comp" means (a composition item carries its name).
      const named = layer.source ? m.item(layer.source)?.name ?? m.comp(layer.source)?.settings.name : undefined;
      source = (named ?? (layer.kind === 'precomp' ? m.comp(id)?.settings.name : undefined))?.toLowerCase();
    }

    return {
      kind: rowKind(layer),
      label: mirrorLabelColor(layer),
      animated: m.layerKeyframes(id).size > 0,
      hasEffects: layer.effectCount > 0,
      name: layer.name || id,
      shy: layer.switches.shy,
      effectNames: wantEffectNames ? effectNamesOf(id) : undefined,
      expressions: exprByNode?.get(id)?.toLowerCase(),
      source,
    };
  };
}
