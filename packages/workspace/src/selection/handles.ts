/**
 * Selection handles — the eight resize grips derived from a selection's bounds.
 * Computed in whatever space the bounds are given (world or screen); the
 * overlay/tool decides. Handle ids follow compass conventions so a resize tool
 * can map a grabbed handle to an axis.
 *
 * ── There is deliberately no rotation HANDLE ─────────────────────────
 * A rotate grip floating off one corner buys one gesture and costs three
 * things: a dead zone between the corner and the grip where clicks do nothing,
 * accidental rotation whenever a user reaches slightly wide for a corner, and a
 * gizmo whose affordances no longer read as "this box has eight symmetric
 * grips". So this list stays eight resize grips.
 *
 * Rotation is available two other ways, and neither is a handle. `RotateTool`
 * (W) is the tool mode. `SelectTool` also rotates from a ZONE just outside each
 * corner (`ROTATE_RING_PX`) — which is not a grip: it is drawn nowhere, it sits
 * entirely outside the box so there is no gap to fall into, and `pickHandle`
 * runs first so the corner grip keeps every pixel it had. All three pivot on the
 * ANCHOR — the same point keyframed rotation revolves around — so none of them
 * can disagree with a keyframe.
 *
 * ── Degrading at small sizes ─────────────────────────────────────────
 * Eight 8px handles on a 30px box is not a gizmo, it is a blob. Below a
 * threshold the mid-edge handles drop out, and below a smaller one every handle
 * does and only the outline remains. See `visibleHandleIds`.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import type { Corners } from '../math/OrientedBox';

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface Handle {
  id: HandleId;
  position: Vec2;
  kind: 'resize';
}

/** The four corners, in TL/TR/BR/BL order. */
export const CORNER_HANDLES: readonly HandleId[] = ['nw', 'ne', 'se', 'sw'];
/** The four edge midpoints. */
export const EDGE_HANDLES: readonly HandleId[] = ['n', 'e', 's', 'w'];

/**
 * On-screen box size (px, smaller dimension) below which the mid-edge handles
 * are hidden, and below which every handle is. Chosen so handles never overlap:
 * with an 8px handle, edges and corners collide under ~40px.
 */
export const EDGE_HANDLE_MIN_PX = 40;
export const ANY_HANDLE_MIN_PX = 20;

/** Compute handles for a bounds rect. Order: corners, then edge midpoints. */
export function computeHandles(bounds: Rect): Handle[] {
  const { x, y, width, height } = bounds;
  const cx = x + width / 2;
  const cy = y + height / 2;
  return [
    { id: 'nw', position: { x, y }, kind: 'resize' },
    { id: 'n', position: { x: cx, y }, kind: 'resize' },
    { id: 'ne', position: { x: x + width, y }, kind: 'resize' },
    { id: 'e', position: { x: x + width, y: cy }, kind: 'resize' },
    { id: 'se', position: { x: x + width, y: y + height }, kind: 'resize' },
    { id: 's', position: { x: cx, y: y + height }, kind: 'resize' },
    { id: 'sw', position: { x, y: y + height }, kind: 'resize' },
    { id: 'w', position: { x, y: cy }, kind: 'resize' },
  ];
}

/**
 * Which handles should be shown for a box of `screenWidth` × `screenHeight`
 * on-screen pixels. Returns null for "none" so a caller can skip the work.
 */
export function visibleHandleIds(screenWidth: number, screenHeight: number): readonly HandleId[] {
  const smaller = Math.min(Math.abs(screenWidth), Math.abs(screenHeight));
  if (smaller < ANY_HANDLE_MIN_PX) return [];
  if (smaller < EDGE_HANDLE_MIN_PX) return CORNER_HANDLES;
  return [...CORNER_HANDLES, ...EDGE_HANDLES];
}

/** Outward direction of each handle, in radians (0 = +x, π/2 = +y/down). */
const HANDLE_ANGLE: Record<HandleId, number> = {
  e: 0,
  se: Math.PI / 4,
  s: Math.PI / 2,
  sw: (3 * Math.PI) / 4,
  w: Math.PI,
  nw: (5 * Math.PI) / 4,
  n: (3 * Math.PI) / 2,
  ne: (7 * Math.PI) / 4,
};

/** The eight cursors, indexed by direction octant starting at +x (east). */
const CURSOR_BY_OCTANT = [
  'resize-e',
  'resize-se',
  'resize-s',
  'resize-sw',
  'resize-w',
  'resize-nw',
  'resize-n',
  'resize-ne',
] as const;

/**
 * The resize cursor for a handle on a layer rotated by `rotationRad`.
 *
 * A corner handle on a 45°-rotated layer must show the diagonal that actually
 * applies, not the one the unrotated box would have had — otherwise the cursor
 * promises an axis the drag will not follow. Rounded to the nearest octant,
 * which is all the eight standard resize cursors can express.
 */
export function handleCursor(id: HandleId, rotationRad = 0): string {
  const angle = HANDLE_ANGLE[id] + rotationRad;
  const TWO_PI = Math.PI * 2;
  const norm = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
  const octant = Math.round(norm / (Math.PI / 4)) % 8;
  return CURSOR_BY_OCTANT[octant]!;
}

/** Hit-test handles at a point (same space as the handles), radius in units. */
export function pickHandle(handles: readonly Handle[], point: Vec2, radius: number): Handle | null {
  let best: Handle | null = null;
  let bestDist = radius;
  for (const h of handles) {
    const d = Math.hypot(h.position.x - point.x, h.position.y - point.y);
    if (d <= bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return best;
}

/**
 * The eight grips on an ORIENTED box, from its four corners.
 *
 * `computeHandles` derives them from an axis-aligned rect, which is right for a
 * multi-selection (no single orientation to honour) and wrong for one rotated
 * layer: it leaves the grips in an upright rectangle around turned artwork.
 *
 * Corner order is `[TL, TR, BR, BL]` (see `OrientedBox.transformCorners`), and
 * the edge grips are the midpoints between neighbours — which stays correct
 * under rotation, shear and negative scale, where "the top edge" is no longer
 * the one with the smallest y.
 *
 * The ids keep their compass names and now mean the LAYER's own axes, not the
 * world's. That is the whole point: `nw` is the layer's top-left wherever it
 * has been turned to, and the resize acts along the layer's axes to match.
 */
export function orientedHandles(c: Corners): Handle[] {
  const [tl, tr, br, bl] = c;
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return [
    { id: 'nw', position: tl, kind: 'resize' },
    { id: 'n', position: mid(tl, tr), kind: 'resize' },
    { id: 'ne', position: tr, kind: 'resize' },
    { id: 'e', position: mid(tr, br), kind: 'resize' },
    { id: 'se', position: br, kind: 'resize' },
    { id: 's', position: mid(br, bl), kind: 'resize' },
    { id: 'sw', position: bl, kind: 'resize' },
    { id: 'w', position: mid(bl, tl), kind: 'resize' },
  ];
}
