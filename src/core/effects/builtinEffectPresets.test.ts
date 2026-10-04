import { BUILTIN_EFFECT_PRESETS } from './builtinEffectPresets';
import { EFFECT_DEFS } from './effects';

describe('builtin effect presets', () => {
  it('ships forty production starter looks', () => {
    expect(BUILTIN_EFFECT_PRESETS).toHaveLength(60);
    expect(new Set(BUILTIN_EFFECT_PRESETS.map((p) => p.name)).size).toBe(60);
  });

  it('uses effect types that exist in EFFECT_DEFS', () => {
    const types = new Set(EFFECT_DEFS.map((d) => d.type));
    for (const preset of BUILTIN_EFFECT_PRESETS) {
      for (const item of preset.items) {
        expect(types.has(item.effect.type)).toBe(true);
      }
    }
  });
});
