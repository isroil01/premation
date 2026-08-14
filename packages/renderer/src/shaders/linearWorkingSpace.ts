/**
 * Linear working-space kill switch and shader transfer helpers.
 *
 * Float intermediates (`rgba16float`) already exist; compositing still ran in
 * gamma-encoded sRGB. Flipping `LINEAR_WORKING_SPACE` makes grade / blend / blur
 * maths run in linear light, then encode back to sRGB before writing so render
 * targets stay display-referred and safe to re-sample through the same path
 * (uploads and intermediate RTs share `TEXTURED`).
 *
 * Set to `false` to restore the previous gamma-space behaviour without a revert.
 * Mirrored next to `HDR_INTERMEDIATES` in `RenderGraph.ts` for discoverability.
 *
 * Transfer matches IEC 61966-2-1 (same curves as `packages/design-system`
 * `toLinear` / `toGamma`). Do not import the design-system package here — the
 * renderer must stay free of UI deps.
 */

/** Kill switch. `true` = linear grade/blend/blur with sRGB storage.
 *  Default on for AE-parity; flip to false to restore gamma-space maths
 *  without a code revert. Goldens must be reblessed when changing this. */
export const LINEAR_WORKING_SPACE = true;

/**
 * When true, float scene-color stays linear until the EffectPass blit encodes.
 * First slice keeps this false: per-op encode before write, so blit is a copy.
 * Flip together with removing encode-before-write once uploads are tagged.
 */
export const LINEAR_INTERMEDIATE_STORAGE = false;

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
`;

/** Identity stubs so call sites compile when the kill switch is off. */
const SRGB_TRANSFER_WGSL_IDENTITY = /* wgsl */ `
fn srgbToLinearRgb(c : vec3<f32>) -> vec3<f32> { return c; }
fn linearToSrgbRgb(c : vec3<f32>) -> vec3<f32> { return c; }
`;

const SRGB_TRANSFER_GLSL_IDENTITY = /* glsl */ `
vec3 srgbToLinearRgb(vec3 c) { return c; }
vec3 linearToSrgbRgb(vec3 c) { return c; }
`;

export const SRGB_TRANSFER_WGSL = LINEAR_WORKING_SPACE
  ? SRGB_TRANSFER_WGSL_REAL
  : SRGB_TRANSFER_WGSL_IDENTITY;

export const SRGB_TRANSFER_GLSL = LINEAR_WORKING_SPACE
  ? SRGB_TRANSFER_GLSL_REAL
  : SRGB_TRANSFER_GLSL_IDENTITY;
