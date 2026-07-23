/**
 * 4x4 matrix in **column-major** order (Float32Array — GPU upload convention),
 * used by the depth-tested 3D layer path. The 2D pipeline stays on Mat3; this
 * module only exists so 3D renderables can carry true clip-space transforms
 * (real z and w, hardware perspective divide).
 *
 * Layout: index = col * 4 + row; translation lives in m[12..14].
 */

import type { Mat3 } from './Mat3';

export type Mat4 = Float32Array;

export const Mat4 = {
  create(): Mat4 {
    const m = new Float32Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    return m;
  },

  identity(out: Mat4 = Mat4.create()): Mat4 {
    out.fill(0);
    out[0] = 1;
    out[5] = 1;
    out[10] = 1;
    out[15] = 1;
    return out;
  },

  /** From a plain 16-number column-major array (e.g. the scene package's Matrix4). */
  fromArray(a: ArrayLike<number>): Mat4 {
    const m = new Float32Array(16);
    for (let i = 0; i < 16; i++) m[i] = a[i] ?? 0;
    return m;
  },

  /** out = a · b (apply b first, then a — matches Mat3.multiply). */
  multiply(a: Mat4, b: Mat4, out: Mat4 = Mat4.create()): Mat4 {
    const r = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      const b0 = b[col * 4 + 0]!, b1 = b[col * 4 + 1]!, b2 = b[col * 4 + 2]!, b3 = b[col * 4 + 3]!;
      for (let row = 0; row < 4; row++) {
        r[col * 4 + row] =
          a[0 * 4 + row]! * b0 + a[1 * 4 + row]! * b1 + a[2 * 4 + row]! * b2 + a[3 * 4 + row]! * b3;
      }
    }
    out.set(r);
    return out;
  },

  /**
   * Lift a 2D homogeneous Mat3 (acting on (x, y, 1)) to a Mat4 acting on
   * (x, y, z, w): x/y transform as before with the translation scaled by w,
   * z passes through, and w picks up the mat3's projective row. For the
   * renderer's ortho camera matrices (affine), w is preserved — which is what
   * lets the 2D pan/zoom camera compose AFTER a 3D perspective projection
   * without disturbing the hardware divide.
   */
  fromMat3(m: Mat3): Mat4 {
    const out = new Float32Array(16);
    // col 0 (x basis)
    out[0] = m[0]!; out[1] = m[1]!; out[2] = 0; out[3] = m[2]!;
    // col 1 (y basis)
    out[4] = m[3]!; out[5] = m[4]!; out[6] = 0; out[7] = m[5]!;
    // col 2 (z passes through)
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    // col 3 (translation, applied per w)
    out[12] = m[6]!; out[13] = m[7]!; out[14] = 0; out[15] = m[8]!;
    return out;
  },

  /** Transform (x, y, z, w) → homogeneous result (no divide). */
  transform(m: Mat4, x: number, y: number, z: number, w = 1): [number, number, number, number] {
    return [
      m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w,
      m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w,
      m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w,
      m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w,
    ];
  },

  /** Transform a point and apply the perspective divide. */
  project(m: Mat4, x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
    const [hx, hy, hz, hw] = Mat4.transform(m, x, y, z, 1);
    const d = hw === 0 ? 1 : hw;
    return { x: hx / d, y: hy / d, z: hz / d, w: hw };
  },
};
