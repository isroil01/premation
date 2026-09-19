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
 * Type glyph per scene kind — shown on the left of a timeline track, a Layers
 * tree row, a Command Palette hit and the Inspector's selection header, so each
 * object is identifiable at a glance. Names map to the shared Icon set.
 *
 * ONE map. There used to be three: this one, a copy in `ScenePanel` and a copy
 * in `CommandPalette`, and they had already drifted — a group drew a `folder`
 * on its timeline track and a `layers` stack on its Layers row, which reads as
 * two different kinds of object rather than one object in two panels. A kind
 * added to the scene now has exactly one place to declare its glyph.
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

/**
 * Kind names as a menu says them. `svg` is not "Svg" and `particle` is plural,
 * which is the whole reason this is a table and not `capitalize(kind)`.
 */
export const KIND_LABEL: Record<SceneKind, string> = {
  group: 'Group',
  null: 'Null',
  shape: 'Shape',
  text: 'Text',
  image: 'Image',
  video: 'Video',
  svg: 'SVG',
  audio: 'Audio',
  camera: 'Camera',
  light: 'Light',
  adjustment: 'Adjustment',
  particle: 'Particles',
  comp: 'Composition',
};

/**
 * Vivid per-kind tint for an 18px GLYPH, as opposed to `KIND_COLOR` above,
 * which tints a 26px bar sitting behind text and is deliberately muted for it.
 * Both are declared in `tokens/domain.css` and both are overridden under
 * `[data-cvd="deuteranopia"]`; they live side by side here so a kind added to
 * the scene cannot pick up one of them and silently miss the other.
 */
export const KIND_GLYPH_COLOR: Record<SceneKind, string> = {
  group: 'var(--color-kind-group)',
  null: 'var(--color-kind-null)',
  shape: 'var(--color-kind-shape)',
  text: 'var(--color-kind-text)',
  image: 'var(--color-kind-image)',
  video: 'var(--color-kind-video)',
  svg: 'var(--color-kind-svg)',
  audio: 'var(--color-kind-audio)',
  camera: 'var(--color-kind-camera)',
  light: 'var(--color-kind-light)',
  adjustment: 'var(--color-kind-adjustment)',
  particle: 'var(--color-kind-particle)',
  comp: 'var(--color-kind-comp)',
};

/**
 * Glyph per SHAPE SUBTYPE — a rectangle and a star are both `kind: 'shape'`,
 * and a tree of eleven identical `shape` glyphs is a tree you have to read
 * rather than scan.
 *
 * Keyed by the `shapeType` prop `insertShape` writes onto the Transform
 * component (see `sceneInsert.ts`'s `ShapeKind`). `path` — a pen-drawn or
 * imported outline — has no primitive glyph and correctly falls through to the
 * generic shape mark.
 */
const SHAPE_TYPE_ICON: Readonly<Record<string, string>> = {
  rect: 'square',
  ellipse: 'circle',
  line: 'line',
  star: 'star',
  polygon: 'polygon',
  // No dedicated triangle glyph in the icon set; the n-gon mark is the closest
  // true statement about the layer, and both are polystars underneath.
  triangle: 'polygon',
  arrow: 'arrow-up',
  heart: 'heart',
  cross: 'cross',
  diamond: 'diamond',
  crescent: 'crescent',
};

/** The `shapeType` a node carries, if it is a shape and has one. */
export function readShapeType(node: SceneNode): string | undefined {
  for (const c of renderComponentsOf(node)) {
    const t = (c.props as Record<string, unknown>)['shapeType'];
    if (typeof t === 'string') return t;
  }
  return undefined;
}

/**
 * Is this node a solid?
 *
 * The `fx` component's `solid` flag, which is what `insertSolid` writes. It
 * used to be `fx.solid === true || node.name.toLowerCase().includes('solid')`
 * in the Layers tree — so a shape the user called "Solid Ground" drew the solid
 * glyph, and a solid they renamed "Backdrop" stopped drawing it. A layer's KIND
 * is not a function of what it is called.
 */
export function isSolidNode(node: SceneNode): boolean {
  for (const c of renderComponentsOf(node)) {
    if (c.type === 'fx' && (c.props as Record<string, unknown>)['solid'] === true) return true;
  }
  return false;
}

/**
 * The glyph for ONE node: its kind's mark, narrowed by shape subtype and by
 * solid-ness, and overridden entirely by a plugin layer kind's own icon.
 *
 * `customIconOf` is injected rather than imported so this module keeps no
 * dependency on the plugin registry — it runs per node per frame on live views.
 */
export function nodeIconName(
  node: SceneNode,
  customIconOf?: (node: SceneNode) => string | undefined,
): string {
  const custom = customIconOf?.(node);
  if (custom) return custom;
  const kind = readNodeKind(node);
  if (kind !== 'shape') return KIND_ICON[kind];
  if (isSolidNode(node)) return 'solid';
  const shapeType = readShapeType(node);
  return (shapeType && SHAPE_TYPE_ICON[shapeType]) ?? KIND_ICON.shape;
}
