import type { Vec2 } from './Vec2';

/**
 * 3x3 matrix in **column-major** order (GPU upload convention), used for 2D
 * affine transforms and orthographic projection.
 *
 * Layout (column-major): m = [ m00 m01 m02 | m10 m11 m12 | m20 m21 m22 ]
 * maps to the math matrix
 *   | m00 m10 m20 |
 *   | m01 m11 m21 |
 *   | m02 m12 m22 |
 * so a 2D affine transform stores translation in (m20, m21).
 */
export type Mat3 = Float32Array;

export const Mat3 = {
  create(): Mat3 {
    const m = new Float32Array(9);
    m[0] = 1;
    m[4] = 1;
    m[8] = 1;
    return m;
  },

  identity(out: Mat3 = Mat3.create()): Mat3 {
    out.fill(0);
    out[0] = 1;
    out[4] = 1;
    out[8] = 1;
    return out;
  },

  clone(m: Mat3): Mat3 {
    return new Float32Array(m) as Mat3;
  },

  /** out = a * b (apply b first, then a — standard matrix composition). */
  multiply(a: Mat3, b: Mat3, out: Mat3 = Mat3.create()): Mat3 {
    const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!;
    const a10 = a[3]!, a11 = a[4]!, a12 = a[5]!;
    const a20 = a[6]!, a21 = a[7]!, a22 = a[8]!;
    const b00 = b[0]!, b01 = b[1]!, b02 = b[2]!;
    const b10 = b[3]!, b11 = b[4]!, b12 = b[5]!;
    const b20 = b[6]!, b21 = b[7]!, b22 = b[8]!;
    out[0] = b00 * a00 + b01 * a10 + b02 * a20;
    out[1] = b00 * a01 + b01 * a11 + b02 * a21;
    out[2] = b00 * a02 + b01 * a12 + b02 * a22;
    out[3] = b10 * a00 + b11 * a10 + b12 * a20;
    out[4] = b10 * a01 + b11 * a11 + b12 * a21;
    out[5] = b10 * a02 + b11 * a12 + b12 * a22;
    out[6] = b20 * a00 + b21 * a10 + b22 * a20;
    out[7] = b20 * a01 + b21 * a11 + b22 * a21;
    out[8] = b20 * a02 + b21 * a12 + b22 * a22;
    return out;
  },

  translation(tx: number, ty: number, out: Mat3 = Mat3.create()): Mat3 {
    Mat3.identity(out);
    out[6] = tx;
    out[7] = ty;
    return out;
  },

  scaling(sx: number, sy: number, out: Mat3 = Mat3.create()): Mat3 {
    Mat3.identity(out);
    out[0] = sx;
    out[4] = sy;
    return out;
  },

  rotation(radians: number, out: Mat3 = Mat3.create()): Mat3 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    Mat3.identity(out);
    out[0] = c;
    out[1] = s;
    out[3] = -s;
    out[4] = c;
    return out;
  },

  /**
   * Compose a 2D affine transform: translate(tx,ty) · rotate(rad) · scale(sx,sy).
   * Applied to a point p as T·R·S·p (scale first, then rotate, then translate).
   */
  compose(
    tx: number,
    ty: number,
    radians: number,
    sx: number,
    sy: number,
    out: Mat3 = Mat3.create(),
  ): Mat3 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    out[0] = c * sx;
    out[1] = s * sx;
    out[2] = 0;
    out[3] = -s * sy;
    out[4] = c * sy;
    out[5] = 0;
    out[6] = tx;
    out[7] = ty;
    out[8] = 1;
    return out;
  },

  /**
   * Orthographic projection mapping the rectangle [left,right]×[bottom,top]
   * to clip space [-1,1]×[-1,1]. Pass top<bottom to flip Y (screen-space).
   */
  ortho(left: number, right: number, bottom: number, top: number, out: Mat3 = Mat3.create()): Mat3 {
    const w = right - left || 1;
    const h = top - bottom || 1;
    Mat3.identity(out);
    out[0] = 2 / w;
    out[4] = 2 / h;
    out[6] = -(right + left) / w;
    out[7] = -(top + bottom) / h;
    return out;
  },

  transformPoint(m: Mat3, p: Vec2): Vec2 {
    return {
      x: m[0]! * p.x + m[3]! * p.y + m[6]!,
      y: m[1]! * p.x + m[4]! * p.y + m[7]!,
    };
  },

  /** Inverse of an affine 3x3 (last row assumed 0,0,1). Returns null if singular. */
  invert(m: Mat3): Mat3 | null {
    const a = m[0]!, b = m[1]!;
    const c = m[3]!, d = m[4]!;
    const e = m[6]!, f = m[7]!;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) return null;
    const id = 1 / det;
    const out = Mat3.create();
    out[0] = d * id;
    out[1] = -b * id;
    out[3] = -c * id;
    out[4] = a * id;
    out[6] = (c * f - d * e) * id;
    out[7] = (b * e - a * f) * id;
    out[8] = 1;
    return out;
  },

  equals(a: Mat3, b: Mat3, eps = 1e-5): boolean {
    for (let i = 0; i < 9; i++) if (Math.abs(a[i]! - b[i]!) > eps) return false;
    return true;
  },
};
