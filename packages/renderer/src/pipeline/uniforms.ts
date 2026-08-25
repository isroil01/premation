/**
 * Uniform packing helpers (std140 layout, matching the built-in shaders).
 * A `mat3x3<f32>` in a uniform block occupies 3 columns each padded to 16 bytes
 * (48 bytes / 12 floats). vec4 fields are 16 bytes / 4 floats.
 */

import type { Color } from '../core/math/Color';
import type { Mat3 } from '../core/math/Mat3';
import type { Mat4 } from '../core/math/Mat4';
import type { Rect } from '../core/math/geometry';
import { toWorkingColor } from '../shaders/linearWorkingSpace';
import { packSrcSpaceFlags } from '../shaders/colorPipeline';

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
  const w = toWorkingColor(c);
  out[floatOffset + 0] = w.r;
  out[floatOffset + 1] = w.g;
  out[floatOffset + 2] = w.b;
  out[floatOffset + 3] = w.a * opacity;
  return floatOffset + 4;
}

function writeWorkingRgba(c: Color, out: Float32Array, o: number): void {
  const w = toWorkingColor(c);
  out[o + 0] = w.r; out[o + 1] = w.g; out[o + 2] = w.b; out[o + 3] = w.a;
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

/** vec4 slots per packed light: posType, colorGain, radius/cone/aimXY, and
 *  aimZ/feather/falloff. The shader's `array<vec4<f32>, N>` and `vec4 lights[N]`
 *  declarations are MAX_LIGHTS3D × this — change one and the others must follow
 *  or the tail silently misaligns. */
export const LIGHT3D_VEC4S = 4;

/** Floats occupied by the shade tail appended to every 3d material uniform:
 *  mat4 model (16) + vec4 eye (4) + vec4 shadeParams (4) + lights (8×4 vec4). */
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
  /** Resolved 3D UNIT aim (spot cone aim / parallel direction) — the light's
   *  Point of Interest when it has one, else its type's legacy 2D-angle
   *  fallback. Was cos/sin of the angle, which no POI could ever reach. */
  aimX: number;
  aimY: number;
  aimZ: number;
  /** Spot half-cone in radians. */
  halfConeRad: number;
  /** Spot cone feather in ABSOLUTE radians (0 = hard edge). */
  coneFeatherRad: number;
  /** 0 none (legacy hard cutoff + linear ramp), 1 smooth, 2 inverse-square. */
  falloffMode: number;
  /** Smooth-curve span in px, default already applied by the producer. */
  falloffDistance: number;
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
  /**
   * Metal, 0..1 (AE's Material Options). Blends the specular highlight toward
   * the layer's OWN colour: 0 leaves the highlight the light's colour (plastic),
   * 1 tints it fully by the surface (metal).
   */
  metal?: number;
  /**
   * PBR roughness, 0..1. PRESENT selects the Cook-Torrance/GGX model in the
   * shader; absent keeps Blinn-Phong. Packed into the shininess slot as a
   * NEGATIVE number (−roughness) so the std140 shade tail keeps its layout —
   * the same trick the lit flag uses for one-sided. A shininess can never be
   * negative (the shader floors it at 1), so the sign is unambiguous.
   */
  roughness?: number;
  /**
   * Light this surface from ONE side: `max(dot(N, L), 0)` instead of
   * `abs(dot(N, L))`.
   *
   * Off by default, and that default is correct for the app's primitive — a 2D
   * layer in space has no inside, and a layer seen from behind should still
   * light. It is wrong for a face that BOUNDS A VOLUME: with `abs()` a box lit
   * hard from one side comes out lit identically on both sides.
   *
   * Set only by an extrusion's synthesized WALLS and BACK CAP, whose normals
   * point out of the solid. Not the front face — that is the layer itself, and
   * its outward direction is −Z, the opposite of the convention `planeNormalOf`
   * returns. Not text depth slices either: their normals are all +Z, so
   * one-sided shading would black the whole stack out under a front light.
   */
  oneSided?: boolean;
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
  // Lit flag: 1 = two-sided, 2 = one-sided. A third value in an existing slot
  // rather than a new one, so the std140 layout of the shade tail is unchanged
  // and no other packer or shader moves.
  out[o + 3] = shade.oneSided ? 2 : 1;
  o += 4;
  const lights = shade.lights.filter((l) => l.gain > 0).slice(0, MAX_LIGHTS3D);
  out[o + 0] = lights.length;
  out[o + 1] = shade.specular;
  // −roughness selects GGX in the shader; see `Shade3D.roughness`. Clamped
  // away from 0 so the sign survives: roughness 0 packs as −0.001.
  out[o + 2] = shade.roughness !== undefined ? -Math.max(0.001, Math.min(1, shade.roughness)) : shade.shininess;
  // shadeParams.w — spare padding until now, so Metal costs no layout change.
  out[o + 3] = shade.metal ?? 0;
  o += 4;
  for (const l of lights) {
    out[o + 0] = l.x;
    out[o + 1] = l.y;
    out[o + 2] = l.z;
    out[o + 3] = LIGHT3D_TYPE_ID[l.type];
    // A light has no alpha — `Shade3DLight.color` is rgb by design — but the
    // working-space transfer is defined on `Color`. Opaque is the identity here:
    // only .r/.g/.b are read back out.
    const lc = toWorkingColor({ ...l.color, a: 1 });
    out[o + 4] = lc.r;
    out[o + 5] = lc.g;
    out[o + 6] = lc.b;
    out[o + 7] = l.gain;
    out[o + 8] = l.radius;
    out[o + 9] = l.halfConeRad;
    out[o + 10] = l.aimX;
    out[o + 11] = l.aimY;
    // Fourth vec4 — the parameters that used to stop at the CPU. Feather was
    // hardcoded to 20 % in the shader, the falloff curves degraded to linear,
    // and the aim's z was unrepresentable, so a Point of Interest did nothing
    // on the depth path.
    out[o + 12] = l.aimZ;
    out[o + 13] = l.coneFeatherRad;
    out[o + 14] = l.falloffMode;
    out[o + 15] = l.falloffDistance;
    o += 16;
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

/** Textured material uniform: mat3 mvp + vec4 uvRect + vec4 tint + 3 colour rows
 *  + srcSpace (x=sampleLinear, y=aces working, z=aces ODT). */
export function packTextured(
  mvp: Mat3,
  uvRect: Rect,
  tint: Color,
  opacity: number,
  color: ColorTransform = IDENTITY_COLOR_TRANSFORM,
  sampleLinear = false,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 12 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  o = packColor(tint, out, o, opacity);
  o = packColorRows(color, out, o);
  const [sx, sy, sz, sw] = packSrcSpaceFlags(sampleLinear);
  out[o + 0] = sx;
  out[o + 1] = sy;
  out[o + 2] = sz;
  out[o + 3] = sw;
  return out;
}

/**
 * Scene-blit uniforms with viewer-LUT params in the unused colour-transform
 * first row (cr0): x=±size (neg=1D), y=intensity, z=domainMin, w=domainMax.
 */
export function packSceneBlitLut(
  mvp: Mat3,
  uvRect: Rect,
  tint: Color,
  opacity: number,
  lut: { size: number; is1d: boolean; intensity: number; domainMin: number; domainMax: number },
): Float32Array {
  const color: ColorTransform = {
    m: [
      lut.is1d ? -lut.size : lut.size,
      lut.intensity,
      lut.domainMin,
      0, 1, 0,
      0, 0, 1,
    ],
    offset: [lut.domainMax, 0, 0],
  };
  return packTextured(mvp, uvRect, tint, opacity, color, false);
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
  sampleLinear = false,
): Float32Array {
  const out = new Float32Array(MAT4_STD140_FLOATS + 4 + 4 + 12 + 4 + SHADE3D_FLOATS);
  let o = packMat4(mvp, out, 0);
  o = packRect(uvRect, out, o);
  o = packColor(tint, out, o, opacity);
  o = packColorRows(color, out, o);
  const [sx, sy, sz, sw] = packSrcSpaceFlags(sampleLinear);
  out[o + 0] = sx;
  out[o + 1] = sy;
  out[o + 2] = sz;
  out[o + 3] = sw;
  o += 4;
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
  sampleLinear = false,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 12 + 4);
  let o = packMat3(mvp, out, 0);
  o = packColor(tint, out, o, opacity);
  o = packColorRows(color, out, o);
  const [sx, sy, sz, sw] = packSrcSpaceFlags(sampleLinear);
  out[o + 0] = sx;
  out[o + 1] = sy;
  out[o + 2] = sz;
  out[o + 3] = sw;
  return out;
}
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

/**
 * Polygonal bokeh gather: mat3 + uvRect + params(texelX, texelY, radius, blades)
 * + params2(roundness, highlightGain, 0, 0).
 */
export function packBokeh(
  mvp: Mat3,
  uvRect: Rect,
  texelX: number,
  texelY: number,
  radiusPx: number,
  blades: number,
  roundness: number,
  highlightGain: number,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = texelX;
  out[o + 1] = texelY;
  out[o + 2] = radiusPx;
  out[o + 3] = blades;
  out[o + 4] = roundness;
  out[o + 5] = highlightGain;
  out[o + 6] = 0;
  out[o + 7] = 0;
  return out;
}

/**
 * Planar per-pixel CoC: bilinear corner radii (already in texels) + optional iris.
 * `fxBox` is the layer's extent in the effect buffer (same as gradient ramp).
 */
export function packCocBlur(
  mvp: Mat3,
  uvRect: Rect,
  fxBox: Rect,
  texelX: number,
  texelY: number,
  cornersTexels: readonly [number, number, number, number],
  blades: number,
  roundness: number,
  highlightGain: number,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = texelX;
  out[o + 1] = texelY;
  out[o + 2] = blades;
  out[o + 3] = 0;
  o += 4;
  out[o + 0] = roundness;
  out[o + 1] = highlightGain;
  out[o + 2] = 0;
  out[o + 3] = 0;
  o += 4;
  out[o + 0] = cornersTexels[0];
  out[o + 1] = cornersTexels[1];
  out[o + 2] = cornersTexels[2];
  out[o + 3] = cornersTexels[3];
  o += 4;
  packRect(fxBox, out, o);
  return out;
}

/**
 * Glass composite uniform: mat3 mvp + vec4 uvRect + five vec4 parameter blocks.
 *
 * Packed as opaque vec4s rather than named scalars because std140 pads every
 * scalar to 16 bytes anyway — five vec4s is the same memory as five floats and
 * carries twenty values. The shader unpacks them; the field order is documented
 * on both sides and must be changed in both.
 */
export function packGlass(
  mvp: Mat3,
  uvRect: Rect,
  g: {
    refraction: number;
    edgeWidth: number;
    aberration: number;
    saturation: number;
    tint: Color;
    tintOpacity: number;
    rim: Color;
    rimOpacity: number;
    rimWidth: number;
    rimAngle: number;
    specularAngle: number;
    specularIntensity: number;
    specularFalloff: number;
    grain: number;
  },
  texelX: number,
  texelY: number,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 * 5);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  // p0: refractPx, edgePx, aberrationPx, saturation
  out[o + 0] = g.refraction; out[o + 1] = g.edgeWidth;
  out[o + 2] = g.aberration; out[o + 3] = g.saturation; o += 4;
  // p1: tint rgb, tint opacity
  out[o + 0] = g.tint.r; out[o + 1] = g.tint.g;
  out[o + 2] = g.tint.b; out[o + 3] = g.tint.a * g.tintOpacity; o += 4;
  // p2: rim rgb, rim opacity
  out[o + 0] = g.rim.r; out[o + 1] = g.rim.g;
  out[o + 2] = g.rim.b; out[o + 3] = g.rim.a * g.rimOpacity; o += 4;
  // p3: rimPx, rimAngle, specIntensity, specFalloff
  out[o + 0] = g.rimWidth; out[o + 1] = g.rimAngle;
  out[o + 2] = g.specularIntensity; out[o + 3] = g.specularFalloff; o += 4;
  // p4: specAngle, grain, texel
  out[o + 0] = g.specularAngle; out[o + 1] = g.grain;
  out[o + 2] = texelX; out[o + 3] = texelY;
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

/**
 * Apply Color LUT: x = cube edge N, y = 1 for a 1D LUT, zw = the input domain.
 *
 * The domain travels as a single min/max pair rather than per channel. `.cube`
 * allows a per-channel domain and files that use one are vanishingly rare;
 * carrying three pairs would cost a second uniform vec4 for a case no LUT in
 * the wild exercises. `toStoredLut` keeps the full domain, so widening this
 * later needs no format change.
 */
export function packApplyColorLut(
  mvp: Mat3,
  uvRect: Rect,
  size: number,
  is1d: boolean,
  intensity: number,
  domainMin: number,
  domainMax: number,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  // Size is SIGN-ENCODED (negative = 1D) so intensity gets the second slot.
  // The block is one vec4 and a size is never legitimately negative, so the
  // encoding cannot collide with a real value.
  out[o + 0] = is1d ? -size : size;
  out[o + 1] = intensity;
  out[o + 2] = domainMin; out[o + 3] = domainMax;
  return out;
}

/**
 * Compound Blur: x = max radius in TEXELS, y = 1 inverts the map, zw = one texel.
 *
 * The radius is in texels rather than uv because the shader scales a rosette by
 * it and then multiplies by `texel` to step — passing a uv-space radius would
 * make the blur anisotropic on any non-square target, which is every comp that
 * is not 1:1.
 */
export function packCompoundBlur(
  mvp: Mat3,
  uvRect: Rect,
  radiusTexels: number,
  invert: boolean,
  texelW: number,
  texelH: number,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = radiusTexels; out[o + 1] = invert ? 1 : 0;
  out[o + 2] = texelW; out[o + 3] = texelH;
  return out;
}

/** Set Matte: x = 1 reads the matte's luminance (0 = its alpha), y = 1 inverts. */
export function packSetMatte(mvp: Mat3, uvRect: Rect, useLuminance: boolean, invert: boolean): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = useLuminance ? 1 : 0; out[o + 1] = invert ? 1 : 0; out[o + 2] = 0; out[o + 3] = 0;
  return out;
}

/**
 * The Perspective family's shared block: two generic vec4s then the light
 * colour. One packer for all of them because the LAYOUT is what has to agree
 * with the shaders, and three packers that must stay identical is three places
 * for them to stop being identical.
 *
 * What p0/p1 mean is each shader's business and documented there.
 */
export function packPerspective(
  mvp: Mat3, uvRect: Rect,
  p0: readonly [number, number, number, number],
  p1: readonly [number, number, number, number],
  /** The LAYER's box within the chain buffer — NOT `uvRect`. See the shaders. */
  fxBox: Rect,
  color: Color,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = p0[0]; out[o + 1] = p0[1]; out[o + 2] = p0[2]; out[o + 3] = p0[3]; o += 4;
  out[o + 0] = p1[0]; out[o + 1] = p1[1]; out[o + 2] = p1[2]; out[o + 3] = p1[3]; o += 4;
  o = packRect(fxBox, out, o);
  writeWorkingRgba(color, out, o);
  return out;
}

/** Arithmetic: the operator and its per-channel constants, then the clip flag. */
export function packArithmetic(
  mvp: Mat3, uvRect: Rect,
  operator: number, r: number, g: number, b: number, clip: boolean,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = operator; out[o + 1] = r; out[o + 2] = g; out[o + 3] = b; o += 4;
  out[o + 0] = clip ? 1 : 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
  return out;
}

/**
 * Spotlight's block. One vec4 wider than the rest of the Perspective family
 * because From/To take four floats between them and the cone still needs its
 * angle, softness, intensity, ambient, aspect and render mode.
 *
 * A wider UNIFORM does not change the binding layout, so this still uses the
 * shared `SPOTLIGHT_MATERIAL` — only the packer and the shader's struct differ.
 */
export function packSpotlight(
  mvp: Mat3, uvRect: Rect,
  fromX: number, fromY: number, toX: number, toY: number,
  coneHalfRad: number, softness: number, intensity: number, ambient: number,
  aspect: number, lightOnly: boolean, reach: number,
  /** The LAYER's box within the chain buffer — NOT `uvRect`. See the shader. */
  fxBox: Rect,
  color: Color,
): Float32Array {
  // uvRect + p0 + p1 + p2 + lightColor — FIVE vec4s after the matrix, not four.
  // Allocating one short does not throw: JS drops the out-of-range writes, so
  // the colour silently never arrives AND the buffer is 16 bytes smaller than
  // the struct the shader declares. WebGPU rejects the bind group, the draw
  // never happens, and the layer disappears. Guarded by uniformPackerSize.test.
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = fromX; out[o + 1] = fromY; out[o + 2] = toX; out[o + 3] = toY; o += 4;
  out[o + 0] = coneHalfRad; out[o + 1] = softness; out[o + 2] = intensity; out[o + 3] = ambient; o += 4;
  out[o + 0] = aspect; out[o + 1] = lightOnly ? 1 : 0; out[o + 2] = reach; out[o + 3] = 0; o += 4;
  o = packRect(fxBox, out, o);
  writeWorkingRgba(color, out, o);
  return out;
}

/**
 * Bend's two blocks: the arc itself, then the span it acts over.
 *
 * `angleRad` is pre-converted and the axis arrives as its cos/sin rather than
 * as an angle — the shader needs the direction VECTOR, and computing it once
 * per draw beats recomputing it per fragment.
 */
export function packBend(
  mvp: Mat3, uvRect: Rect,
  angleRad: number, style: number, aspect: number, outside: number,
  topX: number, topY: number, baseX: number, baseY: number,
  /** The LAYER's box within the chain buffer — not `uvRect`. See the shader. */
  fxBox: Rect,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = angleRad; out[o + 1] = style; out[o + 2] = aspect; out[o + 3] = outside; o += 4;
  out[o + 0] = topX; out[o + 1] = topY; out[o + 2] = baseX; out[o + 3] = baseY; o += 4;
  packRect(fxBox, out, o);
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
  writeWorkingRgba(color, out, o);
  return out;
}

export function packStroke(
  mvp: Mat3, uvRect: Rect, color: Color,
  width: number, texelWidth: number, texelHeight: number,
  /** 0 Outside, 1 Inside, 2 Center, 3 Alpha-dilate. */
  position = 0,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  writeWorkingRgba(color, out, o); o += 4;
  out[o + 0] = width; out[o + 1] = texelWidth; out[o + 2] = texelHeight; out[o + 3] = position;
  return out;
}

export function packSharpen(mvp: Mat3, uvRect: Rect, texelWidth: number, texelHeight: number, amount: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = texelWidth; out[o + 1] = texelHeight; out[o + 2] = amount; out[o + 3] = 0;
  return out;
}

/**
 * Beam's block: endpoints and radii already in TARGET UV, and the colour.
 *
 * The conversion happens in the pass rather than here because only the pass
 * knows the layer's box within the chain's buffer and the comp-px-to-texel
 * scale — the two facts that differ between the 2D and 3D routes. This packs
 * what it is given.
 */
export function packBeam(
  mvp: Mat3, uvRect: Rect,
  ax: number, ay: number, bx: number, by: number,
  coreRadius: number, softRadius: number, aa: number,
  color: Color,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = ax; out[o + 1] = ay; out[o + 2] = bx; out[o + 3] = by; o += 4;
  out[o + 0] = coreRadius; out[o + 1] = softRadius; out[o + 2] = aa; out[o + 3] = 0; o += 4;
  writeWorkingRgba(color, out, o);
  return out;
}

/** Light Sweep — same layout as Beam: ends of the gradient band, then
 *  params (softness, intensity, composite, unused), then colour. */
export function packLightSweep(
  mvp: Mat3, uvRect: Rect,
  ax: number, ay: number, bx: number, by: number,
  softness: number, intensity: number, composite: number,
  color: Color,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = ax; out[o + 1] = ay; out[o + 2] = bx; out[o + 3] = by; o += 4;
  out[o + 0] = softness; out[o + 1] = intensity; out[o + 2] = composite; out[o + 3] = 0; o += 4;
  writeWorkingRgba(color, out, o);
  return out;
}

/** Lens Flare — ends = (center, mid); params = (brightness, coreR, haloR, streakH). */
export function packLensFlare(
  mvp: Mat3, uvRect: Rect,
  cx: number, cy: number, midX: number, midY: number,
  brightness: number, coreR: number, haloR: number, streakH: number,
  color: Color,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = cx; out[o + 1] = cy; out[o + 2] = midX; out[o + 3] = midY; o += 4;
  out[o + 0] = brightness; out[o + 1] = coreR; out[o + 2] = haloR; out[o + 3] = streakH; o += 4;
  writeWorkingRgba(color, out, o);
  return out;
}

/** Light Rays — ends = (cx, cy, lengthUV, count); params = (opac, falloff, rot, arc);
 *  seedComp = (seed, composite, 0, 0). */
export function packLightRays(
  mvp: Mat3, uvRect: Rect,
  cx: number, cy: number, lengthUV: number, rayCount: number,
  opacity: number, falloff: number, rotation: number, spreadArc: number,
  seed: number, composite: number,
  color: Color,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = cx; out[o + 1] = cy; out[o + 2] = lengthUV; out[o + 3] = rayCount; o += 4;
  out[o + 0] = opacity; out[o + 1] = falloff; out[o + 2] = rotation; out[o + 3] = spreadArc; o += 4;
  out[o + 0] = seed; out[o + 1] = composite; out[o + 2] = 0; out[o + 3] = 0; o += 4;
  writeWorkingRgba(color, out, o);
  return out;
}

// ── Round-six per-pixel colour ports ─────────────────────────────────
//
// Colours in these blocks are RAW sRGB fractions, not working-space: the CPU
// kernels (the parity reference) do their maths on sRGB bytes, so the shader
// must see the same numbers — `writeWorkingRgba` here would grade in a
// different space than the reference bakes in.

/** Vignette — p0 = (amount, inner, feather, roundness); p1 = (cx, cy, aspect, 0); fxBox. */
export function packVignetteFx(
  mvp: Mat3, uvRect: Rect,
  amount: number, inner: number, feather: number, roundness: number,
  cx: number, cy: number, aspect: number,
  fxBox: Rect,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = amount; out[o + 1] = inner; out[o + 2] = feather; out[o + 3] = roundness; o += 4;
  out[o + 0] = cx; out[o + 1] = cy; out[o + 2] = aspect; out[o + 3] = 0; o += 4;
  packRect(fxBox, out, o);
  return out;
}

/** Black & White — p0 = (reds, yellows, greens, cyans); p1 = (blues, magentas, tintOn, tintH); p2 = (tintS, 0, 0, 0). */
export function packBlackAndWhite(
  mvp: Mat3, uvRect: Rect,
  reds: number, yellows: number, greens: number, cyans: number,
  blues: number, magentas: number, tintOn: number, tintH: number, tintS: number,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = reds; out[o + 1] = yellows; out[o + 2] = greens; out[o + 3] = cyans; o += 4;
  out[o + 0] = blues; out[o + 1] = magentas; out[o + 2] = tintOn; out[o + 3] = tintH; o += 4;
  out[o + 0] = tintS; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
  return out;
}

/** Tritone — p0 = (shadows.rgb, blend); p1 = (midtones.rgb, 0); p2 = (highlights.rgb, 0). */
export function packTritone(
  mvp: Mat3, uvRect: Rect,
  sr: number, sg: number, sb: number, blend: number,
  mr: number, mg: number, mb: number,
  hr: number, hg: number, hb: number,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = sr; out[o + 1] = sg; out[o + 2] = sb; out[o + 3] = blend; o += 4;
  out[o + 0] = mr; out[o + 1] = mg; out[o + 2] = mb; out[o + 3] = 0; o += 4;
  out[o + 0] = hr; out[o + 1] = hg; out[o + 2] = hb; out[o + 3] = 0;
  return out;
}

/** Photo Filter — p0 = (gel.rgb, density); p1 = (preserveLuminosity, 0, 0, 0). */
export function packPhotoFilter(
  mvp: Mat3, uvRect: Rect,
  r: number, g: number, b: number, density: number, preserveLuminosity: boolean,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = density; o += 4;
  out[o + 0] = preserveLuminosity ? 1 : 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
  return out;
}

/** Threshold — p0 = (level, 0, 0, 0). */
export function packThreshold(mvp: Mat3, uvRect: Rect, level: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = level; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
  return out;
}

/** Vibrance — p0 = (vibrance, saturation, 0, 0). */
export function packVibrance(mvp: Mat3, uvRect: Rect, vibrance: number, saturation: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = vibrance; out[o + 1] = saturation; out[o + 2] = 0; out[o + 3] = 0;
  return out;
}

/**
 * Round-six waves 2–3 share one shape: mvp + uvRect + N param vec4s + fxBox.
 * `rows` is the param vec4s in struct order; each shader's struct declares the
 * matching count (pinned per shader by uniformPackerSize.test).
 */
export function packFxBlock(
  mvp: Mat3, uvRect: Rect,
  rows: ReadonlyArray<readonly [number, number, number, number]>,
  fxBox: Rect,
): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + rows.length * 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  for (const r of rows) {
    out[o + 0] = r[0]; out[o + 1] = r[1]; out[o + 2] = r[2]; out[o + 3] = r[3];
    o += 4;
  }
  packRect(fxBox, out, o);
  return out;
}

export function packNoise(mvp: Mat3, uvRect: Rect, amount: number, evolution: number, monochrome: boolean): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = amount; out[o + 1] = evolution; out[o + 2] = monochrome ? 1 : 0; out[o + 3] = 0;
  return out;
}

/**
 * A plugin effect's uniform block: the renderer's header, then the plugin's own
 * parameters exactly as the app packed them.
 *
 * ── Why the two halves are packed in different places ────────────────────────
 *
 * Only the APP knows a plugin's parameter layout — it generated the WGSL struct
 * from the manifest, so it owns the offsets. Only the PASS knows `mvp` and
 * `uvRect`, which are per-frame and per-layer. Neither can produce the whole
 * block alone, and duplicating either half so that one of them could is how the
 * CPU-side packing and the GPU-side struct drift apart.
 *
 * So the app hands over its half, already at its own offsets, and this writes
 * the header underneath it. `params` is copied rather than mutated: the app may
 * reuse that buffer across frames, and writing a per-frame transform into it
 * would make the plugin's parameters depend on where the layer happened to be.
 *
 * ── The host pass block, at floats 16..23 (bytes 64..95) ─────────────────────
 *
 * Between the renderer's header and the plugin's parameters sits a block this
 * function owns entirely:
 *
 *   16,17  texelSize : vec2<f32>   one over the target's dimensions
 *   18     passScale : f32
 *   19     passIndex : f32
 *   20..23 _reserved : vec4<f32>   zeroed
 *
 * `texelSize` is the reason a separable blur can be written at all — `uv +
 * vec2(texelSize.x, 0)` is one pixel to the right at whatever resolution the
 * host allocated. It is written HERE and not by the app because the app does
 * not know the size of the target being drawn into; that is a per-pass,
 * per-frame fact of the render graph.
 *
 * Written unconditionally, for single-pass effects too. The struct declares
 * these members for every plugin effect, so leaving them as whatever `params`
 * held would hand a shader a `texelSize` of zero and a blur that samples the
 * same texel 65 times.
 */
const PASS_BLOCK_FLOAT = MAT3_STD140_FLOATS + 4;

export function packPluginEffect(
  mvp: Mat3,
  uvRect: Rect,
  params: Float32Array,
  /** Target width in texels. `texelSize.x` is one over this. */
  targetWidth: number,
  targetHeight: number,
  passScale: number,
  passIndex: number,
): Float32Array {
  const out = new Float32Array(Math.max(params.length, PASS_BLOCK_FLOAT + 8));
  out.set(params);
  const o = packMat3(mvp, out, 0);
  packRect(uvRect, out, o);

  // Guarded: a zero-sized target is a real state during teardown, and dividing
  // by it puts Infinity in a uniform — which does not throw and renders a layer
  // as one flat colour.
  out[PASS_BLOCK_FLOAT + 0] = targetWidth > 0 ? 1 / targetWidth : 0;
  out[PASS_BLOCK_FLOAT + 1] = targetHeight > 0 ? 1 / targetHeight : 0;
  out[PASS_BLOCK_FLOAT + 2] = passScale;
  out[PASS_BLOCK_FLOAT + 3] = passIndex;
  // `_reserved`, zeroed explicitly. It is the part a later version will start
  // using, and a plugin reading stale bytes from it today would break on the
  // day it becomes meaningful.
  out[PASS_BLOCK_FLOAT + 4] = 0;
  out[PASS_BLOCK_FLOAT + 5] = 0;
  out[PASS_BLOCK_FLOAT + 6] = 0;
  out[PASS_BLOCK_FLOAT + 7] = 0;
  return out;
}
