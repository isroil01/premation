/**
 * Uniform packing helpers (std140 layout, matching the built-in shaders).
 * A `mat3x3<f32>` in a uniform block occupies 3 columns each padded to 16 bytes
 * (48 bytes / 12 floats). vec4 fields are 16 bytes / 4 floats.
 */

import type { Color } from '../core/math/Color';
import type { Mat3 } from '../core/math/Mat3';
import type { Mat4 } from '../core/math/Mat4';
import type { Rect } from '../core/math/geometry';

/** Floats occupied by a std140 mat3x3 (3 padded columns). */
export const MAT3_STD140_FLOATS = 12;

/** Floats occupied by a std140 mat4x4 (no padding needed). */
export const MAT4_STD140_FLOATS = 16;

/** Write a column-major Mat4 into `out` at `floatOffset` (std140: tight). */
export function packMat4(m: Mat4, out: Float32Array, floatOffset: number): number {
  for (let i = 0; i < 16; i++) out[floatOffset + i] = m[i]!;
  return floatOffset + MAT4_STD140_FLOATS;
}

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

// ── Per-fragment 3D lighting (Accepts Lights on the depth-tested path) ───────

/** Hard cap on lights uploaded per draw; extra scene lights are truncated. */
export const MAX_LIGHTS3D = 8;

/** vec4 slots per packed light (posType, colorGain, radius/cone/aim). */
export const LIGHT3D_VEC4S = 3;

/** Floats occupied by the shade tail appended to every 3d material uniform:
 *  mat4 model (16) + vec4 eye (4) + vec4 shadeParams (4) + lights (8×3 vec4). */
export const SHADE3D_FLOATS = MAT4_STD140_FLOATS + 4 + 4 + MAX_LIGHTS3D * LIGHT3D_VEC4S * 4;

/** One scene light in the shader's terms. Structurally compatible with the
 *  FrameScene `SceneLight3D` DTO (kept independent so the pipeline layer does
 *  not import scene types). */
export interface Shade3DLight {
  type: 'ambient' | 'point' | 'spot' | 'parallel';
  color: { r: number; g: number; b: number };
  /** intensity/100 (already normalised). */
  gain: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** cos/sin of the light's 2D aim angle (spot cone aim / parallel direction). */
  aimX: number;
  aimY: number;
  /** Spot half-cone in radians. */
  halfConeRad: number;
}

const LIGHT3D_TYPE_ID: Record<Shade3DLight['type'], number> = { ambient: 0, point: 1, spot: 2, parallel: 3 };

/** Per-draw lighting data for a 3D material. Absent → the shade tail packs as
 *  zeros with the lit flag off, so the shader is a byte-exact no-op. */
export interface Shade3D {
  /** The renderable's world model matrix (unit quad → 3D comp space) — the
   *  vertex stage re-derives per-fragment world position and the plane normal
   *  (its +Z column) from it. */
  model: ArrayLike<number>;
  /** Camera world position (for the Blinn-Phong half vector). */
  eye: readonly [number, number, number];
  /** Specular intensity; 0 (the default) reduces to plain Lambert. */
  specular: number;
  /** Blinn-Phong exponent. */
  shininess: number;
  lights: ReadonlyArray<Shade3DLight>;
}

/** Write the shade tail (model + eye + params + light array). Returns the next
 *  offset. `shade` undefined → zero-filled, lit flag 0 (identity shading). */
export function packShade3D(out: Float32Array, floatOffset: number, shade?: Shade3D): number {
  const end = floatOffset + SHADE3D_FLOATS;
  if (!shade) return end; // Float32Array is zero-initialised — lit flag stays 0.
  let o = floatOffset;
  for (let i = 0; i < 16; i++) out[o + i] = shade.model[i] ?? 0;
  o += MAT4_STD140_FLOATS;
  out[o + 0] = shade.eye[0];
  out[o + 1] = shade.eye[1];
  out[o + 2] = shade.eye[2];
  out[o + 3] = 1; // lit flag
  o += 4;
  const lights = shade.lights.filter((l) => l.gain > 0).slice(0, MAX_LIGHTS3D);
  out[o + 0] = lights.length;
  out[o + 1] = shade.specular;
  out[o + 2] = shade.shininess;
  out[o + 3] = 0;
  o += 4;
  for (const l of lights) {
    out[o + 0] = l.x;
    out[o + 1] = l.y;
    out[o + 2] = l.z;
    out[o + 3] = LIGHT3D_TYPE_ID[l.type];
    out[o + 4] = l.color.r;
    out[o + 5] = l.color.g;
    out[o + 6] = l.color.b;
    out[o + 7] = l.gain;
    out[o + 8] = l.radius;
    out[o + 9] = l.halfConeRad;
    out[o + 10] = l.aimX;
    out[o + 11] = l.aimY;
    o += 12;
  }
  return end;
}

/** solid3d uniform: mat4 mvp + vec4 color + vec4 shape (see packSolid) + the
 *  shade tail (per-fragment Accepts-Lights data; zeros when unlit). */
export function packSolid3D(mvp: Mat4, color: Color, opacity: number, shape: SolidShape = RECT_SHAPE, shade?: Shade3D): Float32Array {
  const out = new Float32Array(MAT4_STD140_FLOATS + 4 + 4 + SHADE3D_FLOATS);
  let o = packMat4(mvp, out, 0);
  o = packColor(color, out, o, opacity);
  out[o + 0] = shape.kind;
  out[o + 1] = shape.radiusPx;
  out[o + 2] = shape.width;
  out[o + 3] = shape.height;
  packShade3D(out, o + 4, shade);
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

/** textured3d / masked-textured3d / lut-textured3d uniform: mat4 mvp + same
 *  tail as packTextured + the shade tail (zeros when unlit). */
export function packTextured3D(
  mvp: Mat4,
  uvRect: Rect,
  tint: Color,
  opacity: number,
  color: ColorTransform = IDENTITY_COLOR_TRANSFORM,
  shade?: Shade3D,
): Float32Array {
  const out = new Float32Array(MAT4_STD140_FLOATS + 4 + 4 + 12 + SHADE3D_FLOATS);
  let o = packMat4(mvp, out, 0);
  o = packRect(uvRect, out, o);
  o = packColor(tint, out, o, opacity);
  o = packColorRows(color, out, o);
  packShade3D(out, o, shade);
  return out;
}

/**
 * Deformed-mesh material uniform: mat3 mvp + vec4 tint + 3 colour rows.
 * NOTE: This is intentionally DIFFERENT from packTextured — the DEFORMED_MESH
 * shader does not have a uvRect field because UVs come per-vertex from the
 * mesh buffer, not from a uniform quad rect. Using packTextured here would
 * shift tint into the wrong slot (reading uvRect as tint instead).
 */
export function packDeformedMesh(
  mvp: Mat3,
  tint: Color,
  opacity: number,
  color: ColorTransform = IDENTITY_COLOR_TRANSFORM,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 12);
  let o = packMat3(mvp, out, 0);
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

export function packGradientRamp(mvp: Mat3, uvRect: Rect, colors: [Color, Color], points: [number, number, number, number], blend: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 16 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  // colors: mat4x4
  out[o + 0] = colors[0].r; out[o + 1] = colors[0].g; out[o + 2] = colors[0].b; out[o + 3] = colors[0].a; o += 4;
  out[o + 0] = colors[1].r; out[o + 1] = colors[1].g; out[o + 2] = colors[1].b; out[o + 3] = colors[1].a; o += 4;
  o += 8; // mat4 padding
  // points
  out[o + 0] = points[0]; out[o + 1] = points[1]; out[o + 2] = points[2]; out[o + 3] = points[3]; o += 4;
  // blend
  out[o + 0] = blend; o += 4;
  return out;
}

export function packFractalNoise(mvp: Mat3, uvRect: Rect, scale: number, offsetX: number, offsetY: number, octaves: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = scale; out[o + 1] = offsetX; out[o + 2] = offsetY; out[o + 3] = octaves;
  return out;
}

export function packDisplacementMap(mvp: Mat3, uvRect: Rect, amountX: number, amountY: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = amountX; out[o + 1] = amountY; out[o + 2] = 0; out[o + 3] = 0;
  return out;
}

export function packMotionTile(mvp: Mat3, uvRect: Rect, scaleX: number, scaleY: number, offsetX: number, offsetY: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = scaleX; out[o + 1] = scaleY; out[o + 2] = offsetX; out[o + 3] = offsetY;
  return out;
}

export function packFill(mvp: Mat3, uvRect: Rect, color: Color): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = color.r; out[o + 1] = color.g; out[o + 2] = color.b; out[o + 3] = color.a;
  return out;
}

export function packStroke(mvp: Mat3, uvRect: Rect, color: Color, width: number, texelWidth: number, texelHeight: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = color.r; out[o + 1] = color.g; out[o + 2] = color.b; out[o + 3] = color.a; o += 4;
  out[o + 0] = width; out[o + 1] = texelWidth; out[o + 2] = texelHeight; out[o + 3] = 0;
  return out;
}

export function packSharpen(mvp: Mat3, uvRect: Rect, texelWidth: number, texelHeight: number, amount: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = texelWidth; out[o + 1] = texelHeight; out[o + 2] = amount; out[o + 3] = 0;
  return out;
}

export function packNoise(mvp: Mat3, uvRect: Rect, amount: number, evolution: number, monochrome: boolean): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = amount; out[o + 1] = evolution; out[o + 2] = monochrome ? 1 : 0; out[o + 3] = 0;
  return out;
}
