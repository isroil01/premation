/**
 * 2D affine matrix math. Pure functions over the plain {@link Matrix2D} value
 * type — no allocations beyond the returned object, so callers can pool or
 * reuse results in hot paths. Angles are radians unless noted.
 */

import type { Matrix2D, Vec2 } from '../types';

export const IDENTITY: Readonly<Matrix2D> = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function identity(): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

export function clone(m: Matrix2D): Matrix2D {
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
}

/** Multiply `m` by `n` (result applies `n` first, then `m`). */
export function multiply(m: Matrix2D, n: Matrix2D, out: Matrix2D = identity()): Matrix2D {
  const a = m.a * n.a + m.c * n.b;
  const b = m.b * n.a + m.d * n.b;
  const c = m.a * n.c + m.c * n.d;
  const d = m.b * n.c + m.d * n.d;
  const e = m.a * n.e + m.c * n.f + m.e;
  const f = m.b * n.e + m.d * n.f + m.f;
  out.a = a; out.b = b; out.c = c; out.d = d; out.e = e; out.f = f;
  return out;
}

/** Transform a point by a matrix. */
export function transformPoint(m: Matrix2D, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Invert a matrix. Returns identity when the matrix is singular. */
export function invert(m: Matrix2D, out: Matrix2D = identity()): Matrix2D {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0 || !Number.isFinite(det)) {
    out.a = 1; out.b = 0; out.c = 0; out.d = 1; out.e = 0; out.f = 0;
    return out;
  }
  const id = 1 / det;
  const a = m.d * id;
  const b = -m.b * id;
  const c = -m.c * id;
  const d = m.a * id;
  const e = (m.c * m.f - m.d * m.e) * id;
  const f = (m.b * m.e - m.a * m.f) * id;
  out.a = a; out.b = b; out.c = c; out.d = d; out.e = e; out.f = f;
  return out;
}

export interface TransformParts {
  position: Vec2;
  rotation: number; // radians
  scale: Vec2;
  skew: Vec2; // radians (x, y)
  anchor: Vec2;
}

/**
 * Compose a local matrix from transform parts. The anchor is the pivot for
 * rotation/scale/skew; it is subtracted before and NOT re-added (After Effects
 * convention: position places the anchor point).
 *
 * Order: translate(position) · rotate · skew · scale · translate(-anchor)
 */
export function compose(t: TransformParts, out: Matrix2D = identity()): Matrix2D {
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const sx = t.scale.x;
  const sy = t.scale.y;
  const tanX = Math.tan(t.skew.x);
  const tanY = Math.tan(t.skew.y);

  // rotate * skew * scale
  // skew matrix: [1, tanY; tanX, 1]
  const ra = cos, rb = sin, rc = -sin, rd = cos;
  // skew∘scale: [sx, sy*tanX*? ] — build stepwise for clarity.
  // scale: [sx,0,0,sy]; skew: [1,tanY,tanX,1]
  const ka = 1 * sx;                 // skew.a * scale.x
  const kb = tanY * sx;              // skew.b * scale.x
  const kc = tanX * sy;              // skew.c * scale.y
  const kd = 1 * sy;                 // skew.d * scale.y
  // rotate ∘ (skew∘scale)
  const a = ra * ka + rc * kb;
  const b = rb * ka + rd * kb;
  const c = ra * kc + rc * kd;
  const d = rb * kc + rd * kd;

  out.a = a; out.b = b; out.c = c; out.d = d;
  // e,f = position - M*anchor
  out.e = t.position.x - (a * t.anchor.x + c * t.anchor.y);
  out.f = t.position.y - (b * t.anchor.x + d * t.anchor.y);
  return out;
}

/** Approximate decomposition into translate/rotate/scale (skew folded in). */
export function decompose(m: Matrix2D): { position: Vec2; rotation: number; scale: Vec2 } {
  const position = { x: m.e, y: m.f };
  const scaleX = Math.hypot(m.a, m.b);
  const rotation = Math.atan2(m.b, m.a);
  // Remove rotation to recover scaleY.
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const scaleY = m.d * cos - m.c * sin;
  return { position, rotation, scale: { x: scaleX, y: scaleY } };
}

export function equals(m: Matrix2D, n: Matrix2D, epsilon = 1e-9): boolean {
  return (
    Math.abs(m.a - n.a) < epsilon &&
    Math.abs(m.b - n.b) < epsilon &&
    Math.abs(m.c - n.c) < epsilon &&
    Math.abs(m.d - n.d) < epsilon &&
    Math.abs(m.e - n.e) < epsilon &&
    Math.abs(m.f - n.f) < epsilon
  );
}
