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

/**
 * The inverse of `m`, or null when it is singular.
 *
 * Needed to turn a WORLD-space position back into the PARENT-space values a node
 * actually stores. Direct manipulation computes where the user dropped something
 * in world space; the node holds local values, so a parented object dragged
 * without this inversion is written a world position that is then composed with
 * its parent AGAIN — it snaps away from the cursor on release by exactly the
 * parent transform. That failure is invisible from reading the write path, which
 * is why this lives here rather than being open-coded at a drag site.
 *
 * Affine matrices (bottom row 0,0,0,1 — every transform this app composes) take
 * the closed-form path: invert the 3x3 basis, then apply it to the negated
 * translation. The general cofactor expansion is kept for the projection
 * matrices, whose bottom row is not affine.
 */
export function invert(m: Matrix4, out: Matrix4 = identity()): Matrix4 | null {
  const affine = m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1;
  if (affine) {
    // 3x3 basis (column-major): columns are (m0,m1,m2), (m4,m5,m6), (m8,m9,m10).
    const a = m[0], b = m[1], c = m[2];
    const d = m[4], e = m[5], f = m[6];
    const g = m[8], h = m[9], i = m[10];
    // Cofactors of the basis.
    const A = e * i - f * h;
    const B = f * g - d * i;
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det || !Number.isFinite(det)) return null;
    const inv = 1 / det;
    // Inverse basis = adjugate / det. Written straight into column-major slots.
    const i0 = A * inv;
    const i1 = (c * h - b * i) * inv;
    const i2 = (b * f - c * e) * inv;
    const i4 = B * inv;
    const i5 = (a * i - c * g) * inv;
    const i6 = (c * d - a * f) * inv;
    const i8 = C * inv;
    const i9 = (b * g - a * h) * inv;
    const i10 = (a * e - b * d) * inv;
    const tx = m[12], ty = m[13], tz = m[14];
    out[0] = i0; out[1] = i1; out[2] = i2; out[3] = 0;
    out[4] = i4; out[5] = i5; out[6] = i6; out[7] = 0;
    out[8] = i8; out[9] = i9; out[10] = i10; out[11] = 0;
    // −(B⁻¹ · t): the inverse basis applied to the negated translation.
    // `+ 0` normalises the −0 that negating a zero translation produces: it is
    // mathematically identical but compares unequal to 0 and would otherwise
    // leak into serialised matrices and snapshot comparisons.
    out[12] = -(i0 * tx + i4 * ty + i8 * tz) + 0;
    out[13] = -(i1 * tx + i5 * ty + i9 * tz) + 0;
    out[14] = -(i2 * tx + i6 * ty + i10 * tz) + 0;
    out[15] = 1;
    return out;
  }

  // General 4x4 inverse (cofactor / Laplace expansion), for non-affine matrices.
  const [n0, n1, n2, n3, n4, n5, n6, n7, n8, n9, n10, n11, n12, n13, n14, n15] = m;
  const s0 = n0 * n5 - n1 * n4;
  const s1 = n0 * n6 - n2 * n4;
  const s2 = n0 * n7 - n3 * n4;
  const s3 = n1 * n6 - n2 * n5;
  const s4 = n1 * n7 - n3 * n5;
  const s5 = n2 * n7 - n3 * n6;
  const c5 = n10 * n15 - n11 * n14;
  const c4 = n9 * n15 - n11 * n13;
  const c3 = n9 * n14 - n10 * n13;
  const c2 = n8 * n15 - n11 * n12;
  const c1 = n8 * n14 - n10 * n12;
  const c0 = n8 * n13 - n9 * n12;
  const det = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
  if (!det || !Number.isFinite(det)) return null;
  const v = 1 / det;
  out[0] = (n5 * c5 - n6 * c4 + n7 * c3) * v;
  out[1] = (-n1 * c5 + n2 * c4 - n3 * c3) * v;
  out[2] = (n13 * s5 - n14 * s4 + n15 * s3) * v;
  out[3] = (-n9 * s5 + n10 * s4 - n11 * s3) * v;
  out[4] = (-n4 * c5 + n6 * c2 - n7 * c1) * v;
  out[5] = (n0 * c5 - n2 * c2 + n3 * c1) * v;
  out[6] = (-n12 * s5 + n14 * s2 - n15 * s1) * v;
  out[7] = (n8 * s5 - n10 * s2 + n11 * s1) * v;
  out[8] = (n4 * c4 - n5 * c2 + n7 * c0) * v;
  out[9] = (-n0 * c4 + n1 * c2 - n3 * c0) * v;
  out[10] = (n12 * s4 - n13 * s2 + n15 * s0) * v;
  out[11] = (-n8 * s4 + n9 * s2 - n11 * s0) * v;
  out[12] = (-n4 * c3 + n5 * c1 - n6 * c0) * v;
  out[13] = (n0 * c3 - n1 * c1 + n2 * c0) * v;
  out[14] = (-n12 * s3 + n13 * s1 - n14 * s0) * v;
  out[15] = (n8 * s3 - n9 * s1 + n10 * s0) * v;
  return out;
}

/**
 * A world-space point expressed in the space of `m` — i.e. `m⁻¹ · p`.
 *
 * The one operation direct manipulation needs: given where the user put
 * something in world space and the parent's world matrix, produce the local
 * value to store. Returns the point unchanged when `m` is singular, so a
 * degenerate parent (scale 0) leaves the drag where it was instead of sending
 * it to NaN.
 */
export function toLocalPoint(m: Matrix4, p: Vec3): Vec3 {
  const inv = invert(m);
  return inv ? transformPoint(inv, p) : p;
}

/**
 * Transform a 3D direction vector (ignores matrix translation, returns normalized vector).
 */
export function transformVector(m: Matrix4, v: Vec3): Vec3 {
  const x = m[0] * v.x + m[4] * v.y + m[8] * v.z;
  const y = m[1] * v.x + m[5] * v.y + m[9] * v.z;
  const z = m[2] * v.x + m[6] * v.y + m[10] * v.z;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
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
