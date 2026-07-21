/**
 * Minimal 2D affine matrix for skeletal rigging — self-contained, pure, no deps.
 * Stored as [a, b, c, d, e, f] representing
 *     | a c e |
 *     | b d f |
 *     | 0 0 1 |
 * so a point (x, y) maps to (a*x + c*y + e, b*x + d*y + f).
 */

export type Mat2D = readonly [number, number, number, number, number, number];

export const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

/** Translation · Rotation · Scale (applied in that order to a point). */
export function fromTRS(x: number, y: number, rotation: number, scaleX = 1, scaleY = 1): Mat2D {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return [cos * scaleX, sin * scaleX, -sin * scaleY, cos * scaleY, x, y];
}

/** Compose `m1 ∘ m2` — the result applies m2 first, then m1. */
export function multiply(m1: Mat2D, m2: Mat2D): Mat2D {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Transform a point. */
export function apply(m: Mat2D, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = m;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** Inverse of an affine matrix (identity if singular). */
export function invert(m: Mat2D): Mat2D {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const id = 1 / det;
  const na = d * id;
  const nb = -b * id;
  const nc = -c * id;
  const nd = a * id;
  return [na, nb, nc, nd, -(na * e + nc * f), -(nb * e + nd * f)];
}

/** The rotation angle (radians) encoded in a matrix — for reading a bone's world angle. */
export function angleOf(m: Mat2D): number {
  return Math.atan2(m[1], m[0]);
}
