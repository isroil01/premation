/**
 * Linear working-space kill switch and shader transfer helpers.
 *
 * Float intermediates (`rgba16float`) already exist. `LINEAR_WORKING_SPACE`
 * makes grade / blend / blur maths run in linear light. `LINEAR_INTERMEDIATE_STORAGE`
 * keeps those RTs in linear until EffectPass `scene-blit` encodes to sRGB for
 * the canvas. Uploads tagged `rgba8unorm-srgb` decode at the GPU sample;
 * TEXTURED draws use the `*-linear` variant (no redundant shader decode). RT
 * copies use the same variant.
 *
 * Set `LINEAR_WORKING_SPACE` to `false` to restore gamma-space maths without a
 * revert. Storage is meaningful only while working-space is on.
 * Mirrored next to `HDR_INTERMEDIATES` in `RenderGraph.ts` for discoverability.
 *
 * Transfer matches IEC 61966-2-1 (same curves as `packages/design-system`
 * `toLinear` / `toGamma`). Do not import the design-system package here — the
 * renderer must stay free of UI deps.
 */

import type { Color } from '../core/math/Color';
import type { TextureFormat } from '../gpu/types';
import { ACES_TRANSFER_GLSL, ACES_TRANSFER_WGSL, getActiveColorPipeline } from './colorPipeline';

/** Kill switch. `true` = linear grade/blend/blur.
 *  Default on for AE-parity; flip to false to restore gamma-space maths
 *  without a code revert. Goldens must be reblessed when changing this. */
export const LINEAR_WORKING_SPACE = true;

/**
 * When true, float scene-color stays linear until the EffectPass blit encodes.
 * Uploads remain sRGB and are linearized at the TEXTURED sample; RT copies use
 * the `*-linear` shader variant so they are not decoded twice. Authored uniforms/clears go
 * through `toWorkingColor`.
 */
export const LINEAR_INTERMEDIATE_STORAGE = LINEAR_WORKING_SPACE;

/**
 * Use `rgba8unorm-srgb` for display-referred uploads so the GPU decodes at
 * sample and TEXTURED draws skip redundant `srgbToLinearRgb`.
 *
 * Default **off**: premultiplied upload bytes require linearize-after-unpremul in
 * the shader; hardware sRGB decode runs before unpremul and breaks semi-
 * transparent pixels (alpha-control-straight-src on WebGPU). Flip on only after
 * a straight-alpha upload path exists or the invariant changes.
 */
export const HARDWARE_SRGB_UPLOADS = false;

/** GPU format for footage / canvas rasters (not LUT tables or data masks). */
export function displayReferredUploadFormat(): TextureFormat {
  return HARDWARE_SRGB_UPLOADS ? 'rgba8unorm-srgb' : 'rgba8unorm';
}

export function isSrgbTextureFormat(format: TextureFormat): boolean {
  return format === 'rgba8unorm-srgb';
}

/** Scene-color + encode blit. Forced on while RTs stay linear so packColor's
 *  linearized solids are not written into the 8-bit canvas (plugin-control was
 *  147,32,32 against identity's 200,100,100 for `#c86464` when the no-effect
 *  path drew straight to SURFACE). */
export function needsEncodeBlit(hasEffects: boolean): boolean {
  return hasEffects || LINEAR_INTERMEDIATE_STORAGE;
}

/** IEC 61966-2-1 channel decode. Same numbers as the shader helpers. */
export function srgbChanToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearChanToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
}

/** Authored display-referred RGB → values to write into a working-space RT. */
export function toWorkingColor(c: Color): Color {
  if (!LINEAR_WORKING_SPACE || !LINEAR_INTERMEDIATE_STORAGE) return c;
  let r = srgbChanToLinear(c.r);
  let g = srgbChanToLinear(c.g);
  let b = srgbChanToLinear(c.b);
  if (getActiveColorPipeline().workingSpace === 'aces-cg') {
    const nr = 0.613097396 * r + 0.339523469 * g + 0.047379562 * b;
    const ng = 0.070194066 * r + 0.916353879 * g + 0.013452032 * b;
    const nb = 0.020615588 * r + 0.109569769 * g + 0.869814633 * b;
    r = nr; g = ng; b = nb;
  }
  return { r, g, b, a: c.a };
}

const STORAGE_WGSL = LINEAR_INTERMEDIATE_STORAGE
  ? /* wgsl */ `
fn workingFromSample(rgb : vec3<f32>, srcLinear : f32) -> vec3<f32> {
  return select(srgbToLinearRgb(rgb), rgb, srcLinear > 0.5);
}
fn workingToStorage(rgb : vec3<f32>) -> vec3<f32> { return rgb; }
fn storageToWorking(rgb : vec3<f32>) -> vec3<f32> { return rgb; }
`
  : /* wgsl */ `
fn workingFromSample(rgb : vec3<f32>, srcLinear : f32) -> vec3<f32> {
  return srgbToLinearRgb(rgb);
}
fn workingToStorage(rgb : vec3<f32>) -> vec3<f32> { return linearToSrgbRgb(rgb); }
fn storageToWorking(rgb : vec3<f32>) -> vec3<f32> { return srgbToLinearRgb(rgb); }
`;

const STORAGE_GLSL = LINEAR_INTERMEDIATE_STORAGE
  ? /* glsl */ `
vec3 workingFromSample(vec3 rgb, float srcLinear) {
  return srcLinear > 0.5 ? rgb : srgbToLinearRgb(rgb);
}
vec3 workingToStorage(vec3 rgb) { return rgb; }
vec3 storageToWorking(vec3 rgb) { return rgb; }
`
  : /* glsl */ `
vec3 workingFromSample(vec3 rgb, float srcLinear) {
  return srgbToLinearRgb(rgb);
}
vec3 workingToStorage(vec3 rgb) { return linearToSrgbRgb(rgb); }
vec3 storageToWorking(vec3 rgb) { return srgbToLinearRgb(rgb); }
`;

const SRGB_TRANSFER_WGSL_REAL = /* wgsl */ `
fn srgbToLinearChan(c : f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn linearToSrgbChan(c : f32) -> f32 {
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055;
}
fn srgbToLinearRgb(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(srgbToLinearChan(c.r), srgbToLinearChan(c.g), srgbToLinearChan(c.b));
}
fn linearToSrgbRgb(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(linearToSrgbChan(c.r), linearToSrgbChan(c.g), linearToSrgbChan(c.b));
}
${ACES_TRANSFER_WGSL}
${STORAGE_WGSL}
`;

const SRGB_TRANSFER_GLSL_REAL = /* glsl */ `
float srgbToLinearChan(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
float linearToSrgbChan(float c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055;
}
vec3 srgbToLinearRgb(vec3 c) {
  return vec3(srgbToLinearChan(c.r), srgbToLinearChan(c.g), srgbToLinearChan(c.b));
}
vec3 linearToSrgbRgb(vec3 c) {
  return vec3(linearToSrgbChan(c.r), linearToSrgbChan(c.g), linearToSrgbChan(c.b));
}
${ACES_TRANSFER_GLSL}
${STORAGE_GLSL}
`;

/** Identity stubs so call sites compile when the kill switch is off. */
const SRGB_TRANSFER_WGSL_IDENTITY = /* wgsl */ `
fn srgbToLinearRgb(c : vec3<f32>) -> vec3<f32> { return c; }
fn linearToSrgbRgb(c : vec3<f32>) -> vec3<f32> { return c; }
fn workingFromSample(rgb : vec3<f32>, srcLinear : f32) -> vec3<f32> { return rgb; }
fn workingToStorage(rgb : vec3<f32>) -> vec3<f32> { return rgb; }
fn storageToWorking(rgb : vec3<f32>) -> vec3<f32> { return rgb; }
`;

const SRGB_TRANSFER_GLSL_IDENTITY = /* glsl */ `
vec3 srgbToLinearRgb(vec3 c) { return c; }
vec3 linearToSrgbRgb(vec3 c) { return c; }
vec3 workingFromSample(vec3 rgb, float srcLinear) { return rgb; }
vec3 workingToStorage(vec3 rgb) { return rgb; }
vec3 storageToWorking(vec3 rgb) { return rgb; }
`;

export const SRGB_TRANSFER_WGSL = LINEAR_WORKING_SPACE
  ? SRGB_TRANSFER_WGSL_REAL
  : SRGB_TRANSFER_WGSL_IDENTITY;

export const SRGB_TRANSFER_GLSL = LINEAR_WORKING_SPACE
  ? SRGB_TRANSFER_GLSL_REAL
  : SRGB_TRANSFER_GLSL_IDENTITY;
