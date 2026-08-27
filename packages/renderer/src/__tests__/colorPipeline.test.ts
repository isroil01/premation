/**
 * Colour pipeline contracts — display transform flags, bit-depth RT format,
 * and HDR encode guards.
 */

import {
  packSrcSpaceFlags,
  setActiveColorPipeline,
  getActiveColorPipeline,
  intermediateFloatFormat,
  DEFAULT_COLOR_PIPELINE,
} from '../shaders/colorPipeline';
import { BUILTIN_SHADERS } from '../shaders/builtin';

describe('packSrcSpaceFlags', () => {
  afterEach(() => {
    setActiveColorPipeline(DEFAULT_COLOR_PIPELINE);
  });

  it('encodes display transform into srcSpace.z for the scene-blit ODT', () => {
    setActiveColorPipeline({ ...DEFAULT_COLOR_PIPELINE, displayTransform: 'srgb' });
    expect(packSrcSpaceFlags(true)[2]).toBe(0);

    setActiveColorPipeline({ ...DEFAULT_COLOR_PIPELINE, displayTransform: 'aces' });
    expect(packSrcSpaceFlags(true)[2]).toBe(1);

    setActiveColorPipeline({ ...DEFAULT_COLOR_PIPELINE, displayTransform: 'pq' });
    expect(packSrcSpaceFlags(true)[2]).toBe(2);

    setActiveColorPipeline({ ...DEFAULT_COLOR_PIPELINE, displayTransform: 'hlg' });
    expect(packSrcSpaceFlags(true)[2]).toBe(3);
  });

  it('tags ACEScg working space on srcSpace.y', () => {
    setActiveColorPipeline({ ...DEFAULT_COLOR_PIPELINE, workingSpace: 'aces-cg' });
    expect(packSrcSpaceFlags(false)[1]).toBe(1);
    expect(getActiveColorPipeline().workingSpace).toBe('aces-cg');
  });
});

describe('intermediateFloatFormat (32-bpc)', () => {
  afterEach(() => {
    setActiveColorPipeline(DEFAULT_COLOR_PIPELINE);
  });

  it('picks rgba32float when bitDepth is 32 and the backend filters float32', () => {
    setActiveColorPipeline({ ...DEFAULT_COLOR_PIPELINE, bitDepth: 32 });
    expect(intermediateFloatFormat({ float16Textures: true, float32Textures: true })).toBe('rgba32float');
  });

  it('falls back to rgba16float when float32Textures is missing', () => {
    setActiveColorPipeline({ ...DEFAULT_COLOR_PIPELINE, bitDepth: 32 });
    expect(intermediateFloatFormat({ float16Textures: true, float32Textures: false })).toBe('rgba16float');
  });

  it('stays rgba16float at bitDepth 16 even when float32 is available', () => {
    setActiveColorPipeline({ ...DEFAULT_COLOR_PIPELINE, bitDepth: 16 });
    expect(intermediateFloatFormat({ float16Textures: true, float32Textures: true })).toBe('rgba16float');
  });
});

describe('32-bpc grade/blur shaders preserve HDR', () => {
  it('blur unpremul does not clamp straight colour to 1', () => {
    const blur = BUILTIN_SHADERS.find((s) => s.name === 'blur')!;
    expect(blur.wgsl).toContain('let straight = t.rgb / t.a;');
    expect(blur.wgsl).not.toContain('min(t.rgb / t.a, vec3<f32>(1.0))');
    expect(blur.glsl.fragment).toContain('vec3 straight = t.rgb / t.a;');
  });

  it('bokeh and coc-blur match blur HDR unpremul', () => {
    for (const name of ['bokeh', 'coc-blur'] as const) {
      const s = BUILTIN_SHADERS.find((sh) => sh.name === name)!;
      expect(s.wgsl).not.toContain('min(t.rgb / t.a, vec3<f32>(1.0))');
      expect(s.glsl.fragment).not.toContain('min(t.rgb / t.a, vec3(1.0))');
    }
  });

  it('color-matrix grade (textured) does not clamp graded RGB to [0,1]', () => {
    const textured = BUILTIN_SHADERS.find((s) => s.name === 'textured')!;
    // After unpremultiplyingSample rewrite the matrix still must not SDR-clamp.
    expect(textured.wgsl).toContain('dot(obj.cr0, v)');
    expect(textured.wgsl).not.toMatch(
      /clamp\(vec3<f32>\(dot\(obj\.cr0, v\), dot\(obj\.cr1, v\), dot\(obj\.cr2, v\)\), vec3<f32>\(0\.0\), vec3<f32>\(1\.0\)\)/,
    );
  });
});
