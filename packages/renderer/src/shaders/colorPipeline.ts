/**
 * Runtime colour pipeline — working space, display transform, intermediate depth.
 *
 * Set via `setActiveColorPipeline` before each frame (MotionRendererBackend reads
 * the project store). Uniform packers encode `srcSpace` from the active config.
 */

import type { TextureFormat } from '../gpu/types';

export type WorkingSpace = 'srgb-linear' | 'aces-cg';
export type DisplayTransform = 'srgb' | 'aces';
export type IntermediateBitDepth = 16 | 32;

export interface ColorPipelineConfig {
  workingSpace: WorkingSpace;
  displayTransform: DisplayTransform;
  bitDepth: IntermediateBitDepth;
}

export const DEFAULT_COLOR_PIPELINE: ColorPipelineConfig = {
  workingSpace: 'srgb-linear',
  displayTransform: 'srgb',
  bitDepth: 16,
};

let active: ColorPipelineConfig = { ...DEFAULT_COLOR_PIPELINE };

export function setActiveColorPipeline(config: ColorPipelineConfig): void {
  active = { ...config };
}

export function getActiveColorPipeline(): Readonly<ColorPipelineConfig> {
  return active;
}

/** Float RT format for scene-color and effect intermediates. */
export function intermediateFloatFormat(caps: {
  float16Textures: boolean;
  float32Textures?: boolean;
}): TextureFormat {
  if (active.bitDepth === 32 && caps.float32Textures) return 'rgba32float';
  if (caps.float16Textures) return 'rgba16float';
  return 'rgba8unorm';
}

/** srcSpace: x=sampleLinear, y=aces working space, z=aces display ODT. */
export function packSrcSpaceFlags(sampleLinear: boolean): [number, number, number, number] {
  return [
    sampleLinear ? 1 : 0,
    active.workingSpace === 'aces-cg' ? 1 : 0,
    active.displayTransform === 'aces' ? 1 : 0,
    0,
  ];
}

/** ACES 1.3 — IEC 61966-2-1 linear Rec.709 → ACEScg (AP1). */
export const ACES_TRANSFER_WGSL = /* wgsl */ `
fn linearSrgbToAcesCg(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(c, vec3<f32>(0.613097396, 0.339523469, 0.047379562)),
    dot(c, vec3<f32>(0.070194066, 0.916353879, 0.013452032)),
    dot(c, vec3<f32>(0.020615588, 0.109569769, 0.869814633)),
  );
}

fn acesOdtSrgb(c : vec3<f32>) -> vec3<f32> {
  var v = max(c, vec3<f32>(0.0));
  let a = v * (v + vec3<f32>(0.0245786)) - vec3<f32>(0.0000905377);
  let b = v * (0.983729 * v + vec3<f32>(0.4329510)) + vec3<f32>(0.238081);
  return clamp(a / b, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn workingToDisplay(rgb : vec3<f32>, srcSpace : vec4<f32>) -> vec3<f32> {
  if (srcSpace.z > 0.5) {
    var v = rgb;
    if (srcSpace.y < 0.5) { v = linearSrgbToAcesCg(v); }
    return acesOdtSrgb(v);
  }
  return linearToSrgbRgb(rgb);
}
`;

export const ACES_TRANSFER_GLSL = /* glsl */ `
vec3 linearSrgbToAcesCg(vec3 c) {
  return vec3(
    dot(c, vec3(0.613097396, 0.339523469, 0.047379562)),
    dot(c, vec3(0.070194066, 0.916353879, 0.013452032)),
    dot(c, vec3(0.020615588, 0.109569769, 0.869814633))
  );
}

vec3 acesOdtSrgb(vec3 c) {
  vec3 v = max(c, vec3(0.0));
  vec3 a = v * (v + vec3(0.0245786)) - vec3(0.0000905377);
  vec3 b = v * (0.983729 * v + vec3(0.4329510)) + vec3(0.238081);
  return clamp(a / b, 0.0, 1.0);
}

vec3 workingToDisplay(vec3 rgb, vec4 srcSpace) {
  if (srcSpace.z > 0.5) {
    vec3 v = rgb;
    if (srcSpace.y < 0.5) v = linearSrgbToAcesCg(v);
    return acesOdtSrgb(v);
  }
  return linearToSrgbRgb(rgb);
}
`;
