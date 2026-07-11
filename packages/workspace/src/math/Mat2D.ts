/**
 * 2D affine matrix in the canonical 6-value form — the same convention as
 * SVG/Canvas `matrix(a,b,c,d,e,f)` and `@motion/scene`'s `Matrix2D`, so a node's
 * world matrix can be fed straight in for coordinate conversion.
 *
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 */

import type { Vec2 } from './Vec2';

export interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Readonly<Mat2D> = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function identity(): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

export function clone(m: Mat2D): Mat2D {
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
}

export function translation(tx: number, ty: number): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scaling(sx: number, sy: number): Mat2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function rotation(rad: number): Mat2D {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

/** Multiply `m` by `n` (result applies `n` first, then `m`). */
export function multiply(m: Mat2D, n: Mat2D): Mat2D {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** Transform a point (position — translation applies). */
export function apply(m: Mat2D, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Transform a direction/vector (translation ignored). */
export function applyVector(m: Mat2D, v: Vec2): Vec2 {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

export function determinant(m: Mat2D): number {
  return m.a * m.d - m.b * m.c;
}

/** Invert a matrix. Returns identity when the matrix is singular. */
export function invert(m: Mat2D): Mat2D {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0 || !Number.isFinite(det)) return identity();
  const id = 1 / det;
  return {
    a: m.d * id,
    b: -m.b * id,
    c: -m.c * id,
    d: m.a * id,
    e: (m.c * m.f - m.d * m.e) * id,
    f: (m.b * m.e - m.a * m.f) * id,
  };
}

export function equals(m: Mat2D, n: Mat2D, epsilon = 1e-9): boolean {
  return (
    Math.abs(m.a - n.a) < epsilon &&
    Math.abs(m.b - n.b) < epsilon &&
    Math.abs(m.c - n.c) < epsilon &&
    Math.abs(m.d - n.d) < epsilon &&
    Math.abs(m.e - n.e) < epsilon &&
    Math.abs(m.f - n.f) < epsilon
  );
}

/** Uniform-ish scale factor (average of the two axis magnitudes). */
export function scaleFactor(m: Mat2D): number {
  return (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2;
}
