/**
 * On-canvas control points for EFFECTS — the shared mechanism.
 *
 * ## Why this is not part of any one effect
 *
 * Bezier Warp shipped twelve numeric fields and no handles; Corner Pin has had
 * four for as long as it has existed. Both want the same three things — draw a
 * point where a parameter says, drag it, write the parameter back — and so will
 * the distort centres and Mesh Warp if it lands. Solving it inside Bezier Warp
 * would have made the fifth overlay in this codebase to solve hit-test → drag →
 * write independently.
 *
 * ## What an effect has to declare, and what it gets for free
 *
 * A `HandleSpec` is a NAME plus the two params that carry its offset, and a rest
 * position derived from the layer box. That is all. Hit-testing, screen-constant
 * radius, coordinate conversion, autokeying and undo merging are the mechanism's
 * problem, so a new consumer is a table entry rather than an overlay.
 *
 * ## Offsets, not absolute positions
 *
 * Every consumer here stores OFFSETS from a rest position (Corner Pin's
 * `topLeftX`, Bezier Warp's `top1Y`), which is what makes their defaults zero
 * and their identity state expressible. So a handle's absolute position is
 * `rest + offset`, and a drag writes `target − rest`. Doing it the other way —
 * absolute params — would make every default depend on the layer size and break
 * the moment the layer was resized.
 */

import type { EffectType } from './effects';

export interface HandlePoint {
  x: number;
  y: number;
}

/** One draggable point: where it rests, and which two params carry its offset. */
export interface HandleSpec {
  /** Stable id within the effect — also the React key and the aria-label stem. */
  id: string;
  label: string;
  /** Param keys carrying this handle's X and Y offset from `rest`. */
  xKey: string;
  yKey: string;
  /** Rest position in LAYER-LOCAL px, given the layer's box. */
  rest: (w: number, h: number) => HandlePoint;
  /**
   * Handles that are not corners are drawn smaller and rank lower in a tie —
   * a tangent sitting under a vertex should lose, because the vertex is the
   * coarser target and the one you meant.
   */
  kind: 'vertex' | 'tangent' | 'centre';
}

/** A resolved handle: its live layer-space position and where it came from. */
export interface EffectHandle {
  spec: HandleSpec;
  /** `rest + offset`, in layer-local px. */
  pos: HandlePoint;
  rest: HandlePoint;
}

const third = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Bezier Warp's twelve, clockwise from the top-left vertex.
 *
 * The rest positions MUST agree with `defaultWarpPoints` — handles that rest
 * anywhere else would show the user a patch different from the one that renders.
 * They are derived the same way (corners, then the one-third points of each
 * edge) rather than imported, because `bezierWarp.ts` returns a packed tuple
 * with no param names in it; the agreement is asserted in the tests instead.
 */
const BEZIER_WARP_HANDLES: readonly HandleSpec[] = [
  { id: 'topLeft', label: 'Top Left Vertex', xKey: 'topLeftX', yKey: 'topLeftY', kind: 'vertex', rest: () => ({ x: 0, y: 0 }) },
  { id: 'top1', label: 'Top Tangent 1', xKey: 'top1X', yKey: 'top1Y', kind: 'tangent', rest: (w) => ({ x: third(0, w, 1 / 3), y: 0 }) },
  { id: 'top2', label: 'Top Tangent 2', xKey: 'top2X', yKey: 'top2Y', kind: 'tangent', rest: (w) => ({ x: third(0, w, 2 / 3), y: 0 }) },
  { id: 'topRight', label: 'Top Right Vertex', xKey: 'topRightX', yKey: 'topRightY', kind: 'vertex', rest: (w) => ({ x: w, y: 0 }) },
  { id: 'right1', label: 'Right Tangent 1', xKey: 'right1X', yKey: 'right1Y', kind: 'tangent', rest: (w, h) => ({ x: w, y: third(0, h, 1 / 3) }) },
  { id: 'right2', label: 'Right Tangent 2', xKey: 'right2X', yKey: 'right2Y', kind: 'tangent', rest: (w, h) => ({ x: w, y: third(0, h, 2 / 3) }) },
  { id: 'bottomRight', label: 'Bottom Right Vertex', xKey: 'bottomRightX', yKey: 'bottomRightY', kind: 'vertex', rest: (w, h) => ({ x: w, y: h }) },
  { id: 'bottom1', label: 'Bottom Tangent 1', xKey: 'bottom1X', yKey: 'bottom1Y', kind: 'tangent', rest: (w, h) => ({ x: third(0, w, 2 / 3), y: h }) },
  { id: 'bottom2', label: 'Bottom Tangent 2', xKey: 'bottom2X', yKey: 'bottom2Y', kind: 'tangent', rest: (w, h) => ({ x: third(0, w, 1 / 3), y: h }) },
  { id: 'bottomLeft', label: 'Bottom Left Vertex', xKey: 'bottomLeftX', yKey: 'bottomLeftY', kind: 'vertex', rest: (_w, h) => ({ x: 0, y: h }) },
  { id: 'left1', label: 'Left Tangent 1', xKey: 'left1X', yKey: 'left1Y', kind: 'tangent', rest: (_w, h) => ({ x: 0, y: third(0, h, 2 / 3) }) },
  { id: 'left2', label: 'Left Tangent 2', xKey: 'left2X', yKey: 'left2Y', kind: 'tangent', rest: (_w, h) => ({ x: 0, y: third(0, h, 1 / 3) }) },
];

/**
 * Corner Pin's four. The second consumer, and the whole point of the exercise:
 * it is a table entry, not an overlay.
 *
 * Its rest quad is `defaultCorners(w, h)` — the untransformed rectangle — in the
 * same top-left, top-right, bottom-right, bottom-left order the effect reads.
 */
const CORNER_PIN_HANDLES: readonly HandleSpec[] = [
  { id: 'topLeft', label: 'Top Left', xKey: 'topLeftX', yKey: 'topLeftY', kind: 'vertex', rest: () => ({ x: 0, y: 0 }) },
  { id: 'topRight', label: 'Top Right', xKey: 'topRightX', yKey: 'topRightY', kind: 'vertex', rest: (w) => ({ x: w, y: 0 }) },
  { id: 'bottomRight', label: 'Bottom Right', xKey: 'bottomRightX', yKey: 'bottomRightY', kind: 'vertex', rest: (w, h) => ({ x: w, y: h }) },
  { id: 'bottomLeft', label: 'Bottom Left', xKey: 'bottomLeftX', yKey: 'bottomLeftY', kind: 'vertex', rest: (_w, h) => ({ x: 0, y: h }) },
];

/**
 * The registry.
 *
 * A `Partial<Record<EffectType, …>>` rather than a Map or an if-chain: most
 * effects have no handles and should not be forced to declare an empty list,
 * but the KEY side is still typed, so a renamed `EffectType` breaks the build
 * here instead of silently orphaning an overlay.
 */
export const EFFECT_HANDLES: Partial<Record<EffectType, readonly HandleSpec[]>> = {
  'bezier-warp': BEZIER_WARP_HANDLES,
  'corner-pin': CORNER_PIN_HANDLES,
};

export function hasEffectHandles(type: string): boolean {
  return (EFFECT_HANDLES as Record<string, unknown>)[type] !== undefined;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Resolve an effect's handles to live layer-space positions.
 *
 * `params` is the RESOLVED param bag — animated values already folded in by the
 * caller — so a handle sits where the frame actually shows it rather than where
 * the static prop says. A handle drawn at the un-animated position on an
 * animated effect is worse than no handle: it invites a drag that jumps.
 */
export function collectEffectHandles(
  type: string,
  params: Readonly<Record<string, unknown>>,
  w: number,
  h: number,
): EffectHandle[] {
  const specs = (EFFECT_HANDLES as Record<string, readonly HandleSpec[] | undefined>)[type];
  if (!specs) return [];
  return specs.map((spec) => {
    const rest = spec.rest(w, h);
    return {
      spec,
      rest,
      pos: { x: rest.x + num(params[spec.xKey]), y: rest.y + num(params[spec.yKey]) },
    };
  });
}

/**
 * Effect param space → LAYER-LOCAL space.
 *
 * Effects address the layer box as `0..w, 0..h` with the origin at its top-left
 * — `defaultCorners` and `defaultWarpPoints` both do — while everything that
 * composes a layer transform works in coordinates CENTRED on the layer origin,
 * because that is where `worldMatrixOf` rotates and `shapeOutline` emits
 * ±w/2. The two differ by exactly half the box.
 *
 * It is a two-line conversion and it is here, named and tested, rather than
 * inline in the overlay: getting it wrong offsets every handle by half the
 * layer and still looks like a plausible overlay, just misaligned — and
 * "misaligned overlay" is the kind of thing that gets nudged by eye instead of
 * fixed.
 */
export function effectToLayer(p: HandlePoint, w: number, h: number): HandlePoint {
  return { x: p.x - w / 2, y: p.y - h / 2 };
}

/** LAYER-LOCAL space → effect param space. The exact inverse. */
export function layerToEffect(p: HandlePoint, w: number, h: number): HandlePoint {
  return { x: p.x + w / 2, y: p.y + h / 2 };
}

/** Screen-space pick radius, in CSS px. Matches the interaction engine's. */
export const HANDLE_PICK_RADIUS = 9;

/**
 * The handle under a screen point, or null.
 *
 * Hit-testing happens in SCREEN space with a constant radius, which is what
 * makes the grab feel identical at every zoom — the same choice
 * `SelectTool.pickHandle` makes, and the reason the 3D gizmo is screen-constant.
 * Testing in layer space against a fixed layer-space radius would make handles
 * unhittable when zoomed out and grab from centimetres away when zoomed in.
 *
 * `toScreen` is injected rather than imported so this stays pure and the tests
 * can supply a transform they derived by hand.
 *
 * Ties go to the VERTEX. A tangent resting under a corner is the configuration
 * every consumer starts in — Bezier Warp's rest state has none of them
 * coincident, but a user can easily drag one on top of another — and the vertex
 * is the coarser intent.
 */
export function hitTestEffectHandle(
  screen: HandlePoint,
  handles: readonly EffectHandle[],
  toScreen: (p: HandlePoint) => HandlePoint,
  radius: number = HANDLE_PICK_RADIUS,
): EffectHandle | null {
  let best: EffectHandle | null = null;
  let bestD = Infinity;
  for (const handle of handles) {
    const s = toScreen(handle.pos);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const d = Math.hypot(s.x - screen.x, s.y - screen.y);
    if (d > radius) continue;
    const better = d < bestD || (d === bestD && handle.spec.kind === 'vertex' && best?.spec.kind !== 'vertex');
    if (better) { best = handle; bestD = d; }
  }
  return best;
}

/**
 * The param values a drag to `layerTarget` implies.
 *
 * Pure, and returns the values rather than writing them: the write path has to
 * be the same one the numeric field uses (see `writeEffectParams`), and mixing
 * "what to write" with "how to write it" is how the two drift apart.
 */
export function handleDragValues(
  handle: EffectHandle,
  layerTarget: HandlePoint,
): Record<string, number> {
  return {
    [handle.spec.xKey]: layerTarget.x - handle.rest.x,
    [handle.spec.yKey]: layerTarget.y - handle.rest.y,
  };
}
