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
  SRGB_TRANSFER_GLSL,
  SRGB_TRANSFER_WGSL,
} from '../shaders/linearWorkingSpace';

const byName = (n: string) => BUILTIN_SHADERS.find((s) => s.name === n);

describe('linear working space', () => {
  it('exposes the kill switch (default on for AE-parity linear light)', () => {
    expect(LINEAR_WORKING_SPACE).toBe(true);
    // First slice keeps display-referred RT storage; blit encode is prepared.
    expect(LINEAR_INTERMEDIATE_STORAGE).toBe(false);
  });

  it('ships real transfer helpers when the switch is on', () => {
    expect(SRGB_TRANSFER_WGSL).toContain('srgbToLinearChan');
    expect(SRGB_TRANSFER_GLSL).toContain('srgbToLinearChan');
    expect(SRGB_TRANSFER_WGSL).toContain('linearToSrgbChan');
  });

  it.each(['textured', 'masked-textured', 'deformed-mesh', 'blend-combine', 'blur', 'scene-blit'])(
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

  it('textured linearizes before the colour matrix', () => {
    const s = byName('textured')!;
    expect(s.wgsl).toContain('srgbToLinearRgb(c.rgb)');
    expect(s.wgsl).toContain('linearToSrgbRgb(graded)');
  });

  it('registers scene-blit for the EffectPass encode path', () => {
    expect(byName('scene-blit')).toBeDefined();
  });
});
