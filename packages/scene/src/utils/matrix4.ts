/**
 * 4x4 matrix math for 3D (and lifted-2D) transforms. Pure functions over the
 * plain {@link Matrix4} tuple — 16 numbers in **column-major** order (WebGL /
 * gl-matrix convention), so the same value type feeds the GPU renderer later:
 *
 *   index = col * 4 + row
 *
 *   | m0  m4  m8  m12 |
 *   | m1  m5  m9  m13 |
 *   | m2  m6  m10 m14 |
 *   | m3  m7  m11 m15 |
 *
 * Translation lives in m12/m13/m14. Angles are radians unless noted. The 2D
 * affine path (`../matrix`) is unchanged and still primary for pure-2D nodes;
 * this module is the additive 3D layer.
 */

import type { Matrix4, Vec2, Vec3, Matrix2D } from '../types';

export function identity(): Matrix4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function clone(m: Matrix4): Matrix4 {
  return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]];
}

/** Multiply `a · b` (result applies `b` first, then `a` — matches the 2D convention). */
export function multiply(a: Matrix4, b: Matrix4, out: Matrix4 = identity()): Matrix4 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15] = a;
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13, b14, b15] = b;

  out[0] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
  out[1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
  out[2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
  out[3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;

  out[4] = a0 * b4 + a4 * b5 + a8 * b6 + a12 * b7;
  out[5] = a1 * b4 + a5 * b5 + a9 * b6 + a13 * b7;
  out[6] = a2 * b4 + a6 * b5 + a10 * b6 + a14 * b7;
  out[7] = a3 * b4 + a7 * b5 + a11 * b6 + a15 * b7;

  out[8] = a0 * b8 + a4 * b9 + a8 * b10 + a12 * b11;
  out[9] = a1 * b8 + a5 * b9 + a9 * b10 + a13 * b11;
  out[10] = a2 * b8 + a6 * b9 + a10 * b10 + a14 * b11;
  out[11] = a3 * b8 + a7 * b9 + a11 * b10 + a15 * b11;

  out[12] = a0 * b12 + a4 * b13 + a8 * b14 + a12 * b15;
  out[13] = a1 * b12 + a5 * b13 + a9 * b14 + a13 * b15;
  out[14] = a2 * b12 + a6 * b13 + a10 * b14 + a14 * b15;
  out[15] = a3 * b12 + a7 * b13 + a11 * b14 + a15 * b15;
  return out;
}

/**
 * Transform a 3D point, applying the perspective divide when the resulting
 * homogeneous `w` is not 1. For an affine matrix (`w` row = 0,0,0,1) this is a
 * plain affine transform.
 */
export function transformPoint(m: Matrix4, p: Vec3): Vec3 {
  const x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
  const y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
  const z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
  if (w !== 0 && w !== 1) return { x: x / w, y: y / w, z: z / w };
  return { x, y, z };
}

export interface TransformParts3D {
  /** World position of the anchor point. */
  position: Vec3;
  /** Euler rotation in radians, applied in order Z · Y · X (X first). */
  rotation: Vec3;
  scale: Vec3;
  /** Pivot for rotation/scale (After Effects: position places the anchor). */
  anchor: Vec3;
}

/**
 * Compose a local 4x4 matrix from 3D transform parts. Mirrors the 2D
 * {@link import('./matrix').compose} contract (anchor is the pivot and is NOT
 * re-added; position places the anchor) and reduces to it exactly when the
 * extra axes are default (z=0, rotX=rotY=0, scaleZ=1, anchorZ=0).
 *
 * Order: translate(position) · Rz · Ry · Rx · scale · translate(-anchor)
 */
export function compose(t: TransformParts3D, out: Matrix4 = identity()): Matrix4 {
  const cx = Math.cos(t.rotation.x), sx = Math.sin(t.rotation.x);
  const cy = Math.cos(t.rotation.y), sy = Math.sin(t.rotation.y);
  const cz = Math.cos(t.rotation.z), sz = Math.sin(t.rotation.z);

  // Rotation R = Rz · Ry · Rx (row-major 3x3).
  const r00 = cz * cy;
  const r01 = cz * sy * sx - sz * cx;
  const r02 = cz * sy * cx + sz * sx;
  const r10 = sz * cy;
  const r11 = sz * sy * sx + cz * cx;
  const r12 = sz * sy * cx - cz * sx;
  const r20 = -sy;
  const r21 = cy * sx;
  const r22 = cy * cx;

  const kx = t.scale.x, ky = t.scale.y, kz = t.scale.z;
  // Linear part L = R · diag(scale): column j scaled by scale_j.
  const l00 = r00 * kx, l01 = r01 * ky, l02 = r02 * kz;
  const l10 = r10 * kx, l11 = r11 * ky, l12 = r12 * kz;
  const l20 = r20 * kx, l21 = r21 * ky, l22 = r22 * kz;

  const ax = t.anchor.x, ay = t.anchor.y, az = t.anchor.z;

  // Column-major store.
  out[0] = l00; out[1] = l10; out[2] = l20; out[3] = 0;
  out[4] = l01; out[5] = l11; out[6] = l21; out[7] = 0;
  out[8] = l02; out[9] = l12; out[10] = l22; out[11] = 0;
  out[12] = t.position.x - (l00 * ax + l01 * ay + l02 * az);
  out[13] = t.position.y - (l10 * ax + l11 * ay + l12 * az);
  out[14] = t.position.z - (l20 * ax + l21 * ay + l22 * az);
  out[15] = 1;
  return out;
}

/** Lift a 2D affine matrix into the 4x4 (z untouched). */
export function fromMatrix2D(m: Matrix2D, out: Matrix4 = identity()): Matrix4 {
  out[0] = m.a; out[1] = m.b; out[2] = 0; out[3] = 0;
  out[4] = m.c; out[5] = m.d; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
  out[12] = m.e; out[13] = m.f; out[14] = 0; out[15] = 1;
  return out;
}

/** Flatten a 4x4 to its 2D affine part (orthographic drop of z). */
export function toMatrix2D(m: Matrix4): Matrix2D {
  return { a: m[0], b: m[1], c: m[4], d: m[5], e: m[12], f: m[13] };
}

/** Drop the z of a 3D point. */
export function toVec2(p: Vec3): Vec2 {
  return { x: p.x, y: p.y };
}

export function equals(a: Matrix4, b: Matrix4, epsilon = 1e-9): boolean {
  for (let i = 0; i < 16; i++) {
    if (Math.abs((a[i] as number) - (b[i] as number)) >= epsilon) return false;
  }
  return true;
}
