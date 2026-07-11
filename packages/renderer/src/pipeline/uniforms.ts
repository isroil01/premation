/**
 * Uniform packing helpers (std140 layout, matching the built-in shaders).
 * A `mat3x3<f32>` in a uniform block occupies 3 columns each padded to 16 bytes
 * (48 bytes / 12 floats). vec4 fields are 16 bytes / 4 floats.
 */

import type { Color } from '../core/math/Color';
import type { Mat3 } from '../core/math/Mat3';
import type { Rect } from '../core/math/geometry';

/** Floats occupied by a std140 mat3x3 (3 padded columns). */
export const MAT3_STD140_FLOATS = 12;

/** Write a column-major Mat3 into `out` at `floatOffset` with std140 padding. */
export function packMat3(m: Mat3, out: Float32Array, floatOffset: number): number {
  // column 0
  out[floatOffset + 0] = m[0]!;
  out[floatOffset + 1] = m[1]!;
  out[floatOffset + 2] = m[2]!;
  out[floatOffset + 3] = 0;
  // column 1
  out[floatOffset + 4] = m[3]!;
  out[floatOffset + 5] = m[4]!;
  out[floatOffset + 6] = m[5]!;
  out[floatOffset + 7] = 0;
  // column 2
  out[floatOffset + 8] = m[6]!;
  out[floatOffset + 9] = m[7]!;
  out[floatOffset + 10] = m[8]!;
  out[floatOffset + 11] = 0;
  return floatOffset + MAT3_STD140_FLOATS;
}

export function packColor(c: Color, out: Float32Array, floatOffset: number, opacity = 1): number {
  out[floatOffset + 0] = c.r;
  out[floatOffset + 1] = c.g;
  out[floatOffset + 2] = c.b;
  out[floatOffset + 3] = c.a * opacity;
  return floatOffset + 4;
}

export function packRect(r: Rect, out: Float32Array, floatOffset: number): number {
  out[floatOffset + 0] = r.x;
  out[floatOffset + 1] = r.y;
  out[floatOffset + 2] = r.width;
  out[floatOffset + 3] = r.height;
  return floatOffset + 4;
}

/** Solid material uniform: mat3 mvp + vec4 color. */
export function packSolid(mvp: Mat3, color: Color, opacity: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4);
  let o = packMat3(mvp, out, 0);
  packColor(color, out, o, opacity);
  return out;
}

/** Textured material uniform: mat3 mvp + vec4 uvRect + vec4 tint. */
export function packTextured(mvp: Mat3, uvRect: Rect, tint: Color, opacity: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  packColor(tint, out, o, opacity);
  return out;
}
