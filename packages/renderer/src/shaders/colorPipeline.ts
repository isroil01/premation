/**
 * Runtime colour pipeline — working space, display transform, intermediate depth.
 *
 * Set via `setActiveColorPipeline` before each frame (MotionRendererBackend reads
 * the project store). Uniform packers encode `srcSpace` from the active config.
 */

import type { TextureFormat } from '../gpu/types';

export type WorkingSpace = 'srgb-linear' | 'aces-cg';
/** Display / delivery transform. `pq` is a foothold ST.2084 curve still
 *  written into an 8-bit canvas (preview approximation — not HDR10 encode). */
export type DisplayTransform = 'srgb' | 'aces' | 'pq' | 'hlg';
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

/**
 * Optional viewer/monitor LUT applied AFTER `workingToDisplay` on the final
 * scene blit. Session-only — the app sets this for viewport frames and clears
 * it for auxiliary (export) frames.
 */
export interface ViewerLutMeta {
  /** Edge length (3D) or entry count (1D). */
  size: number;
  is1d: boolean;
  /** 0..1 blend of graded vs display-referred source. */
  intensity: number;
  domainMin: number;
  domainMax: number;
}

let viewerLut: ViewerLutMeta | null = null;

export function setActiveViewerLut(meta: ViewerLutMeta | null): void {
  viewerLut = meta;
}

export function getActiveViewerLut(): ViewerLutMeta | null {
  return viewerLut;
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

/** srcSpace: x=sampleLinear, y=aces working space, z=display mode (0=srgb, 1=aces, 2=pq, 3=hlg). */
export function packSrcSpaceFlags(sampleLinear: boolean): [number, number, number, number] {
  const display =
    active.displayTransform === 'aces' ? 1
      : active.displayTransform === 'pq' ? 2
        : active.displayTransform === 'hlg' ? 3
          : 0;
  return [
    sampleLinear ? 1 : 0,
    active.workingSpace === 'aces-cg' ? 1 : 0,
    display,
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

fn hlgOetfChannel(E : f32) -> f32 {
  // ARIB STD-B67 — same curve as hdrTransfer.ts (HDR export). Preview ODT
  // must match delivery or Comp Settings “HLG” and Export ▸ HLG diverge.
  let a = 0.17883277;
  let b = 0.28466892;
  let c = 0.55991073;
  let e = max(E, 0.0);
  if (e <= 1.0 / 12.0) { return sqrt(3.0 * e); }
  return a * log(12.0 * e - b) + c;
}

fn workingToDisplay(rgb : vec3<f32>, srcSpace : vec4<f32>) -> vec3<f32> {
  // z≈3 → HLG (ARIB STD-B67) preview ODT on SDR canvas.
  if (srcSpace.z > 2.5) {
    var v = max(rgb, vec3<f32>(0.0));
    if (srcSpace.y > 0.5) {
      v = vec3<f32>(
        dot(v, vec3<f32>(1.6410233797, -0.3248032942, -0.2364246952)),
        dot(v, vec3<f32>(-0.6636628587, 1.6153315917, 0.0167563477)),
        dot(v, vec3<f32>(0.0117218943, -0.0082844420, 0.9883948585)),
      );
      v = max(v, vec3<f32>(0.0));
    }
    return clamp(vec3<f32>(hlgOetfChannel(v.x), hlgOetfChannel(v.y), hlgOetfChannel(v.z)), vec3<f32>(0.0), vec3<f32>(1.0));
  }
  // z≈2 → PQ (ST.2084) foothold: map linear scene → PQ then re-expand for
  // SDR canvas preview. Not a real HDR10 encode — just a selectable ODT.
  if (srcSpace.z > 1.5) {
    var v = max(rgb, vec3<f32>(0.0));
    if (srcSpace.y > 0.5) {
      // ACEScg → approx linear Rec.709 for the PQ curve.
      v = vec3<f32>(
        dot(v, vec3<f32>(1.6410233797, -0.3248032942, -0.2364246952)),
        dot(v, vec3<f32>(-0.6636628587, 1.6153315917, 0.0167563477)),
        dot(v, vec3<f32>(0.0117218943, -0.0082844420, 0.9883948585)),
      );
      v = max(v, vec3<f32>(0.0));
    }
    let m1 = 0.1593017578125;
    let m2 = 78.84375;
    let c1 = 0.8359375;
    let c2 = 18.8515625;
    let c3 = 18.6875;
    let Y = max(v, vec3<f32>(0.0)) / 100.0; // assume ~100 nit scene white
    let Ym = pow(Y, vec3<f32>(m1));
    let pq = pow((c1 + c2 * Ym) / (1.0 + c3 * Ym), vec3<f32>(m2));
    return clamp(pq, vec3<f32>(0.0), vec3<f32>(1.0));
  }
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
  if (srcSpace.z > 2.5) {
    vec3 v = max(rgb, vec3(0.0));
    if (srcSpace.y > 0.5) {
      v = vec3(
        dot(v, vec3(1.6410233797, -0.3248032942, -0.2364246952)),
        dot(v, vec3(-0.6636628587, 1.6153315917, 0.0167563477)),
        dot(v, vec3(0.0117218943, -0.0082844420, 0.9883948585))
      );
      v = max(v, vec3(0.0));
    }
    float a = 0.17883277;
    float b = 0.28466892;
    float c = 0.55991073;
    vec3 outc;
    for (int i = 0; i < 3; i++) {
      float E = max(v[i], 0.0);
      outc[i] = E <= 1.0 / 12.0 ? sqrt(3.0 * E) : a * log(12.0 * E - b) + c;
    }
    return clamp(outc, 0.0, 1.0);
  }
  if (srcSpace.z > 1.5) {
    vec3 v = max(rgb, vec3(0.0));
    if (srcSpace.y > 0.5) {
      v = vec3(
        dot(v, vec3(1.6410233797, -0.3248032942, -0.2364246952)),
        dot(v, vec3(-0.6636628587, 1.6153315917, 0.0167563477)),
        dot(v, vec3(0.0117218943, -0.0082844420, 0.9883948585))
      );
      v = max(v, vec3(0.0));
    }
    float m1 = 0.1593017578125;
    float m2 = 78.84375;
    float c1 = 0.8359375;
    float c2 = 18.8515625;
    float c3 = 18.6875;
    vec3 Y = max(v, vec3(0.0)) / 100.0;
    vec3 Ym = pow(Y, vec3(m1));
    vec3 pq = pow((c1 + c2 * Ym) / (1.0 + c3 * Ym), vec3(m2));
    return clamp(pq, 0.0, 1.0);
  }
  if (srcSpace.z > 0.5) {
    vec3 v = rgb;
    if (srcSpace.y < 0.5) v = linearSrgbToAcesCg(v);
    return acesOdtSrgb(v);
  }
  return linearToSrgbRgb(rgb);
}
`;
