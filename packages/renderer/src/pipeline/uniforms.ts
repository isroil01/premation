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

/** SDF shape params packed into the solid uniform's `shape` vec4:
 *  (kind, radiusPx, worldW, worldH). kind 0 = plain rect (no mask). */
export interface SolidShape {
  kind: 0 | 1 | 2;
  radiusPx: number;
  width: number;
  height: number;
}

const RECT_SHAPE: SolidShape = { kind: 0, radiusPx: 0, width: 0, height: 0 };

/** Solid material uniform: mat3 mvp + vec4 color + vec4 shape. `shape` defaults
 *  to a plain rect (kind 0), so masks and untyped solids are unchanged. */
export function packSolid(mvp: Mat3, color: Color, opacity: number, shape: SolidShape = RECT_SHAPE): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packColor(color, out, o, opacity);
  out[o + 0] = shape.kind;
  out[o + 1] = shape.radiusPx;
  out[o + 2] = shape.width;
  out[o + 3] = shape.height;
  return out;
}

/** A per-pixel colour transform: row-major 3×3 `m` + `offset` (out = M·rgb+off). */
export interface ColorTransform {
  m: readonly number[];
  offset: readonly number[];
}

/** Identity colour transform (no grade). */
export const IDENTITY_COLOR_TRANSFORM: ColorTransform = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] };

/**
 * Pack a colour transform as THREE vec4 rows: (mRow, offsetComponent). The shader
 * computes `dot(rowᵢ, vec4(rgb, 1))` per channel — so it's independent of any
 * row/column-major matrix convention (no transpose ambiguity).
 */
export function packColorRows(ct: ColorTransform, out: Float32Array, floatOffset: number): number {
  const m = ct.m;
  const off = ct.offset;
  for (let row = 0; row < 3; row++) {
    out[floatOffset + row * 4 + 0] = m[row * 3 + 0]!;
    out[floatOffset + row * 4 + 1] = m[row * 3 + 1]!;
    out[floatOffset + row * 4 + 2] = m[row * 3 + 2]!;
    out[floatOffset + row * 4 + 3] = off[row]!;
  }
  return floatOffset + 12;
}

/** Textured material uniform: mat3 mvp + vec4 uvRect + vec4 tint + 3 colour rows. */
export function packTextured(
  mvp: Mat3,
  uvRect: Rect,
  tint: Color,
  opacity: number,
  color: ColorTransform = IDENTITY_COLOR_TRANSFORM,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 12);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  o = packColor(tint, out, o, opacity);
  packColorRows(color, out, o);
  return out;
}

/** Blur material uniform: mat3 mvp + vec4 uvRect + vec4 blurParams (dirX, dirY, radiusPx, 0). */
export function packBlur(
  mvp: Mat3,
  uvRect: Rect,
  dirX: number,
  dirY: number,
  radiusPx: number,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = dirX;
  out[o + 1] = dirY;
  out[o + 2] = radiusPx;
  out[o + 3] = 0;
  return out;
}
