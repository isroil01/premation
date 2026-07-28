/**
 * Oriented boxes — a rectangle that carries its rotation instead of throwing it
 * away.
 *
 * `Rect.transform` maps a rect's four corners and then takes their axis-aligned
 * bounding box. That is the right answer for a broad phase (a superset is
 * exactly what an index wants) and the wrong answer for anything a user sees or
 * clicks: at any angle that is not a multiple of 90° the AABB is visibly larger
 * than the layer, with dead padding at every corner. Selection outlines drawn
 * from it look wrong, and marquee selection made from it picks up layers the
 * rubber band never touched.
 *
 * So both live side by side: `corners` for what is drawn and hit-tested,
 * `Rect.transform` for culling, spatial indexing and fit-to-selection.
 *
 * Corner order is always [top-left, top-right, bottom-right, bottom-left] of
 * the SOURCE rect, carried through the transform — so consecutive corners are
 * adjacent edges and the winding is consistent, which the SAT tests below rely
 * on.
 */

import type { Vec2 } from './Vec2';
import type { Rect } from './Rect';
import type { Mat2D } from './Mat2D';
import { apply } from './Mat2D';
import { corners as rectCorners } from './Rect';

/** Four points in [TL, TR, BR, BL] order of the untransformed rect. */
export type Corners = readonly [Vec2, Vec2, Vec2, Vec2];

/** Transform a rect's corners, keeping the rotation the AABB would discard. */
export function transformCorners(r: Rect, m: Mat2D): Corners {
  const c = rectCorners(r);
  return [apply(m, c[0]), apply(m, c[1]), apply(m, c[2]), apply(m, c[3])];
}

/** Axis-aligned bounds of an oriented box (the broad-phase/culling answer). */
export function cornersBounds(c: Corners): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of c) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Centre of an oriented box. */
export function cornersCenter(c: Corners): Vec2 {
  return {
    x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
    y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
  };
}

/** The two edge axes of an oriented box (unnormalized). */
function axesOf(c: Corners): [Vec2, Vec2] {
  return [
    { x: c[1].x - c[0].x, y: c[1].y - c[0].y },
    { x: c[3].x - c[0].x, y: c[3].y - c[0].y },
  ];
}

/** Project points onto an axis, returning the [min, max] interval. */
function project(points: readonly Vec2[], axis: Vec2): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/**
 * Separating-axis test between an axis-aligned rect and an oriented box.
 *
 * Four candidate axes: the rect's two (world X and Y) and the box's two edge
 * directions. If any one separates them, they do not overlap. A degenerate box
 * (zero-area, e.g. a scaled-to-nothing layer) contributes a zero axis, which is
 * skipped — projecting onto it would say "overlapping" for everything.
 */
export function rectIntersectsCorners(r: Rect, c: Corners): boolean {
  const rectPts: Vec2[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
  const axes: Vec2[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, ...axesOf(c)];
  for (const axis of axes) {
    if (axis.x === 0 && axis.y === 0) continue;
    const [aMin, aMax] = project(rectPts, axis);
    const [bMin, bMax] = project(c, axis);
    if (aMax < bMin || bMax < aMin) return false;
  }
  return true;
}

/** True when every corner of the oriented box lies inside the rect. */
export function rectContainsCorners(r: Rect, c: Corners): boolean {
  const x2 = r.x + r.width;
  const y2 = r.y + r.height;
  for (const p of c) {
    if (p.x < r.x || p.x > x2 || p.y < r.y || p.y > y2) return false;
  }
  return true;
}

/**
 * Point-in-oriented-box, via the cross product against each edge.
 *
 * Sign-consistent across all four edges means inside. Works for either winding,
 * so a mirrored (negative-scale) layer is handled without a special case.
 */
export function cornersContainPoint(c: Corners, p: Vec2, tolerance = 0): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < 4; i++) {
    const a = c[i]!;
    const b = c[(i + 1) % 4]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const cross = ex * (p.y - a.y) - ey * (p.x - a.x);
    const len = Math.hypot(ex, ey);
    // Compare as a DISTANCE so `tolerance` is in world units, not in the
    // cross product's area units (which scale with the edge length).
    const dist = len > 0 ? cross / len : 0;
    if (dist > tolerance) pos = true;
    if (dist < -tolerance) neg = true;
    if (pos && neg) return false;
  }
  return true;
}
