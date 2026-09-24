/**
 * Document addressing for the local engine: how API ids (LayerId, ItemId) map
 * onto today's scene graph, composition store and asset store.
 *
 *   • A composition item is a top-level scene node with a settings record in
 *     `projectStore.comps` (its id IS the ItemId). A precomp LAYER is a comp
 *     instance node (`__compRef`) whose `source` is the referenced comp.
 *   • A layer is any node below a composition root. Parenting IS nesting in
 *     this graph, so a comp's stack is the depth-first, front-first walk of its
 *     tree, not descending through precomp barriers (`enclosingCompRootOf`).
 *   • A footage item is an asset-store record; a folder is an asset folder.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { enclosingCompRootOf } from '@core/scene/parenting';
import { isPrecomp } from '@core/scene/precomp';
import { readCompRef, COMP_REF_PROP } from '@core/scene/compInstance';
import { readNodeKind, readShapeType, isSolidNode } from '@core/scene/sceneDerive';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useProjectStore } from '@stores/projectStore';
import { useAssetStore } from '@stores/assetStore';
import type { SceneNode } from '@core/types';
import type { LayerKind, ItemKind } from '@motion/engine-api';
import { fail } from './errors';

export const graph = defaultSceneGraph;

// ── Compositions ─────────────────────────────────────────────────────

/** Composition item ids, in the store's order. */
export function compItemIds(): string[] {
  const comps = useProjectStore.getState().comps;
  return Object.keys(comps).filter((id) => isCompItem(id));
}

export function isCompItem(id: string): boolean {
  if (!useProjectStore.getState().comps[id]) return false;
  const node = graph.getNode(id);
  if (!node) return false;
  // Roots, and legacy nested precomp GROUPS that carry their own layers.
  return !node.parent || (isPrecomp(node) && node.children.length > 0 && readCompRef(node) === null);
}

export function requireComp(id: string): void {
  if (!isCompItem(id)) fail('notFound', `no composition '${id}'`, { item: id });
}

/** The composition a layer belongs to, or null when `id` is not a layer. */
export function compOfLayer(id: string): string | null {
  const node = graph.getNode(id);
  if (!node || !node.parent) return null;
  return enclosingCompRootOf(id);
}

export function isLayer(id: string): boolean {
  return compOfLayer(id) !== null;
}

export function requireLayer(id: string): SceneNode {
  const node = graph.getNode(id);
  if (!node || !node.parent) fail('notFound', `no layer '${id}'`, { layer: id });
  return node;
}

/** Whether a node's children are layers of ANOTHER composition (a precomp barrier). */
function isBarrier(node: SceneNode): boolean {
  return isPrecomp(node);
}

/**
 * A composition's layers, top of the stack first: depth-first over the tree,
 * front-most sibling first (childIds are back-to-front), a parent before its
 * children, never through a precomp barrier.
 */
export function layerIdsOfComp(compId: string): string[] {
  const out: string[] = [];
  const walk = (parentId: string): void => {
    const kids = graph.getChildOrder(parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const id = kids[i]!;
      const node = graph.getNode(id);
      if (!node) continue;
      out.push(id);
      if (!isBarrier(node)) walk(id);
    }
  };
  walk(compId);
  return out;
}

/**
 * A layer and every layer nested under it (parent first), as ONE composition's
 * layers — what a subtree delete sends as a single `deleteLayers` (the doomed
 * set: nothing is re-parented). Null when `id` is not a layer or the subtree
 * crosses a precomp barrier (its nested layers belong to another composition,
 * which one `deleteLayers` cannot address).
 */
export function layerSubtree(id: string): string[] | null {
  const root = graph.getNode(id);
  if (!root || !isLayer(id)) return null;
  const comp = compOfLayer(id);
  const out: string[] = [];
  const walk = (nodeId: string): boolean => {
    out.push(nodeId);
    const node = graph.getNode(nodeId);
    if (!node) return false;
    if (node.children.length > 0 && isBarrier(node)) return false;
    for (const child of graph.getChildOrder(nodeId)) {
      if (compOfLayer(child) !== comp || !walk(child)) return false;
    }
    return true;
  };
  return walk(id) ? out : null;
}

/** The API parent of a layer: its tree parent unless that is the comp root. */
export function apiParentOf(id: string): string | null {
  const node = graph.getNode(id);
  if (!node?.parent) return null;
  const comp = compOfLayer(id);
  return node.parent === comp ? null : node.parent;
}

// ── Kinds ────────────────────────────────────────────────────────────

function fxProps(node: SceneNode): Record<string, unknown> {
  return (node.components.find((c) => c.type === 'fx')?.props ?? {}) as Record<string, unknown>;
}

export function layerKindOf(node: SceneNode): LayerKind {
  if (readCompRef(node) !== null) return 'precomp';
  const kind = readNodeKind(node);
  switch (kind) {
    case 'comp': return 'precomp';
    case 'group': return isPrecomp(node) ? 'precomp' : 'group';
    case 'null': return 'null';
    case 'text': return 'text';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'svg': return 'svg';
    case 'camera': return 'camera';
    case 'light': return 'light';
    case 'adjustment': return 'adjustment';
    case 'particle': return 'particle';
    case 'image': return fxProps(node).sequence ? 'sequence' : 'image';
    default: break;
  }
  if (isSolidNode(node)) return 'solid';
  if (node.components.some((c) => c.type === 'Primitive' || c.type === 'Model')) return 'model3d';
  if (node.components.some((c) => c.type === 'plugin' || c.type === 'PluginLayer')) return 'generator';
  switch (readShapeType(node)) {
    case 'rect': return 'rectangle';
    case 'ellipse': return 'ellipse';
    case 'polygon':
    case 'star':
    case 'triangle': return 'polygon';
    default: break;
  }
  if (node.components.some((c) => c.type === 'Geometry')) return 'path';
  return 'shape';
}

/** The item a layer shows: footage asset id, or the comp a precomp references. */
export function layerSourceOf(node: SceneNode): string | undefined {
  const ref = readCompRef(node);
  if (ref) return ref;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.assetId === 'string' && p.assetId) return p.assetId;
    if (typeof p.__assetId === 'string' && p.__assetId) return p.__assetId;
  }
  return undefined;
}

// ── Items ────────────────────────────────────────────────────────────

export type ItemRef =
  | { kind: 'composition'; id: string }
  | { kind: 'footage'; id: string }
  | { kind: 'folder'; id: string };

export function resolveItem(id: string): ItemRef | null {
  if (isCompItem(id)) return { kind: 'composition', id };
  const assets = useAssetStore.getState();
  if (assets.assets.some((a) => a.id === id)) return { kind: 'footage', id };
  if (assets.folders.some((f) => f.id === id)) return { kind: 'folder', id };
  return null;
}

export function requireItem(id: string): ItemRef {
  const r = resolveItem(id);
  if (!r) fail('notFound', `no item '${id}'`, { item: id });
  return r;
}

export function itemKindOf(ref: ItemRef): ItemKind {
  return ref.kind === 'composition' ? 'composition' : ref.kind === 'folder' ? 'folder' : 'footage';
}

/** Every id the document uses in the shared item/layer id spaces. */
export function idTaken(id: string): boolean {
  if (graph.getNode(id)) return true;
  if (useProjectStore.getState().comps[id]) return true;
  const a = useAssetStore.getState();
  return a.assets.some((x) => x.id === id) || a.folders.some((f) => f.id === id);
}

/** Layers anywhere in the document that show `itemId`. */
export function layersUsingItem(itemId: string): string[] {
  const out: string[] = [];
  graph.traverse((n) => {
    if (n.parent && layerSourceOf(n) === itemId) out.push(n.id);
  });
  return out;
}

export { COMP_REF_PROP, SCENE_KIND_PROP };
