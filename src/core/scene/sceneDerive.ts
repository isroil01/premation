/**
 * Shared derivations from the scene graph → UI models.
 *
 * Both the Scene tree (LayersPanel) and the Timeline tracks are projections of
 * the same node list, so the read helpers live here to avoid divergence.
 */

import type { SceneNode } from '../types';
import type SceneGraph from './SceneGraph';
import { renderComponentsOf } from './SceneGraph';
import { SCENE_KIND_PROP, type SceneKind } from './seedDefaultScene';

/**
 * Read a node's kind from whichever component carries the meta prop.
 *
 * Goes through `renderComponentsOf` rather than `node.components`: this runs
 * per node per frame on LIVE views during the flatten/expand pass — before
 * `materializeForFrame` has read each field once — and the raw getter rebuilds
 * the node's whole component array on every call. Read-only, so the shared
 * memoized array is safe here.
 */
export function readNodeKind(node: SceneNode): SceneKind {
  for (const c of renderComponentsOf(node)) {
    const k = (c.props as Record<string, unknown>)[SCENE_KIND_PROP];
    if (typeof k === 'string') return k as SceneKind;
  }
  return 'shape';
}

/** Depth-first flatten of the graph (roots → children), i.e. layer stacking order. */
export function flattenScene(graph: SceneGraph): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (n: SceneNode): void => {
    out.push(n);
    for (const child of graph.getChildren(n.id)) walk(child);
  };
  for (const root of graph.getRoots()) walk(root);
  return out;
}

/**
 * A node's children in STACK order — FRONT-most first.
 *
 * The scene graph stores children back-to-front (index 0 paints first, so it is
 * the bottom of the stack); the Scene tree and the timeline both list the
 * front-most layer at the TOP, as After Effects does. That single `reverse` was
 * written out at both call sites, which is one place too many for a convention
 * that every other consumer of z-order has to agree with.
 *
 * The graph's child array stays the authority: this is a projection of it, not
 * a second ordering.
 */
export function stackOrderedChildren(graph: SceneGraph, parentId: string): SceneNode[] {
  return [...graph.getChildren(parentId)].reverse();
}

/**
 * The nodes belonging to ONE composition: `rootId` and its descendants.
 *
 * Compositions are separate root subtrees in a single scene graph, so anything
 * that renders or lists "the comp" must scope to its root — `flattenScene`
 * walks every root, which would draw all compositions on top of each other.
 * Falls back to the whole scene when the root is missing, so a document with a
 * stale/absent comp id still shows something rather than a blank canvas.
 */
export function flattenComposition(graph: SceneGraph, rootId: string | undefined): SceneNode[] {
  if (!rootId) return flattenScene(graph);
  const root = graph.getNode(rootId);
  if (!root) return flattenScene(graph);
  const out: SceneNode[] = [];
  const walk = (n: SceneNode): void => {
    out.push(n);
    for (const child of graph.getChildren(n.id)) walk(child);
  };
  walk(root);
  return out;
}

/**
 * Track color per node kind (the small stripe on the timeline track header).
 * Uses the spec's colorblind-safe layer-category tokens. Purple is NEVER used
 * here — it is reserved exclusively for AI (spec), so groups map to Null slate.
 */
export const KIND_COLOR: Record<SceneKind, string> = {
  group: 'var(--color-category-null)',
  null: 'var(--color-category-null)',
  shape: 'var(--color-category-shape)',
  text: 'var(--color-category-text)',
  image: 'var(--color-category-image)',
  video: 'var(--color-category-video)',
  svg: 'var(--color-category-shape)',
  audio: 'var(--color-category-audio, var(--color-category-video))',
  camera: 'var(--color-category-camera)',
  light: 'var(--color-category-light)',
  adjustment: 'var(--color-category-3d)',
  particle: 'var(--color-category-shape)',
  comp: 'var(--color-category-video)',
};

/**
 * Raw hex of the same category hues, for the Canvas 2D backend — canvas
 * `fillStyle` cannot resolve CSS `var(...)`, so rendering must use literals.
 */
export const KIND_FILL: Record<SceneKind, string> = {
  group: '#64748b',
  null: '#64748b',
  shape: '#3b8276',
  text: '#4f7ea8',
  image: '#b47836',
  video: '#a84e62',
  svg: '#3b8276',
  audio: '#3a8b9e',
  camera: '#4a7bb0',
  light: '#ba8e3a',
  adjustment: '#7965aa',
  particle: '#9e5a82',
  comp: '#a84e62',
};

/**
 * Type glyph per scene kind — shown on the left of a timeline track so each
 * object is identifiable at a glance. Names map to the shared Icon set.
 */
export const KIND_ICON: Record<SceneKind, string> = {
  group: 'folder',
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
