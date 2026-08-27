/**
 * Linear working-space wiring — contract tests.
 *
 * Guards that the kill switch and transfer helpers actually reach the shaders
 * that grade, blend, blur, and blit. A silent miss would leave compositing in
 * gamma forever while docs claim otherwise.
 */

import { BUILTIN_SHADERS, LINEAR_WORKING_SPACE } from '../shaders/builtin';
import {
  LINEAR_INTERMEDIATE_STORAGE,
  HARDWARE_SRGB_UPLOADS,
  displayReferredUploadFormat,
  isSrgbTextureFormat,
  SRGB_TRANSFER_GLSL,
  SRGB_TRANSFER_WGSL,
  srgbChanToLinear,
  toWorkingColor,
  needsEncodeBlit,
} from '../shaders/linearWorkingSpace';

const byName = (n: string) => BUILTIN_SHADERS.find((s) => s.name === n);

describe('linear working space', () => {
  it('exposes the kill switches (working space + linear RT storage)', () => {
    expect(LINEAR_WORKING_SPACE).toBe(true);
    expect(LINEAR_INTERMEDIATE_STORAGE).toBe(true);
  });

  it('ships real transfer helpers when the switch is on', () => {
    expect(SRGB_TRANSFER_WGSL).toContain('srgbToLinearChan');
    expect(SRGB_TRANSFER_GLSL).toContain('srgbToLinearChan');
    expect(SRGB_TRANSFER_WGSL).toContain('linearToSrgbChan');
    expect(SRGB_TRANSFER_WGSL).toContain('workingFromSample');
    expect(SRGB_TRANSFER_WGSL).toContain('workingToStorage');
    expect(SRGB_TRANSFER_WGSL).toContain('storageToWorking');
  });

  it.each(['textured', 'textured-linear', 'masked-textured', 'deformed-mesh', 'blend-combine', 'blur', 'scene-blit', 'scene-blit-lut'])(
    '%s carries srgb↔linear helpers in both dialects',
    (name) => {
      const s = byName(name)!;
      expect(s).toBeDefined();
      expect(s.wgsl).toContain('srgbToLinearRgb');
      expect(s.wgsl).toContain('linearToSrgbRgb');
      expect(s.glsl.fragment).toContain('srgbToLinearRgb');
      expect(s.glsl.fragment).toContain('linearToSrgbRgb');
    },
  );

  it('textured linearizes uploads at the sample and does not encode before write', () => {
    const s = byName('textured')!;
    expect(s.wgsl).toContain('workingFromSample(c.rgb, 0.0)');
    expect(s.wgsl).toContain('obj.srcSpace.y > 0.5');
    expect(s.wgsl).not.toContain('linearToSrgbRgb(graded)');
    expect(s.wgsl).toContain('graded * c.a');
  });

  it('textured-linear skips the upload decode so RT copies stay in working space', () => {
    const s = byName('textured-linear')!;
    expect(s).toBeDefined();
    expect(s.wgsl).toContain('let v = vec4<f32>(c.rgb, 1.0);');
    expect(s.wgsl).not.toContain('workingFromSample(c.rgb, 0.0)');
  });

  it('scene-blit encodes linear working-space to sRGB for the canvas', () => {
    expect(byName('scene-blit')).toBeDefined();
    expect(byName('scene-blit')!.wgsl).toContain('workingToDisplay');
    expect(byName('scene-blit-lut')).toBeDefined();
    expect(byName('scene-blit-lut')!.wgsl).toContain('workingToDisplay');
    expect(byName('scene-blit-lut')!.wgsl).toContain('viewerSlice');
  });

  it('toWorkingColor linearizes mid-grey and leaves 0/1 alone', () => {
    expect(toWorkingColor({ r: 0, g: 0, b: 0, a: 1 })).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(toWorkingColor({ r: 1, g: 1, b: 1, a: 0.5 })).toEqual({ r: 1, g: 1, b: 1, a: 0.5 });
    expect(toWorkingColor({ r: 0.5, g: 0.5, b: 0.5, a: 1 }).r).toBeCloseTo(srgbChanToLinear(0.5));
  });

  it('forces the encode blit for every frame while RT storage is linear', () => {
    expect(needsEncodeBlit(false)).toBe(LINEAR_INTERMEDIATE_STORAGE);
    expect(needsEncodeBlit(true)).toBe(true);
  });

  it('tags display-referred uploads for hardware sRGB when linear light is on', () => {
    expect(HARDWARE_SRGB_UPLOADS).toBe(false);
    expect(displayReferredUploadFormat()).toBe('rgba8unorm');
    expect(isSrgbTextureFormat('rgba8unorm-srgb')).toBe(true);
    expect(isSrgbTextureFormat('rgba8unorm')).toBe(false);
  });
});
