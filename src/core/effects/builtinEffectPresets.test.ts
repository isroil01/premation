import { BUILTIN_EFFECT_PRESETS, listBuiltinEffectPresets } from './builtinEffectPresets';
import { applyEffectPreset, listEffectPresets } from './effectClipboard';
import { EFFECT_DEFS } from './effects';

describe('builtin effect presets', () => {
  it('ships twenty production starter looks', () => {
    expect(BUILTIN_EFFECT_PRESETS).toHaveLength(20);
    expect(new Set(BUILTIN_EFFECT_PRESETS.map((p) => p.name)).size).toBe(20);
  });

  it('uses effect types that exist in EFFECT_DEFS', () => {
    const types = new Set(EFFECT_DEFS.map((d) => d.type));
    for (const preset of BUILTIN_EFFECT_PRESETS) {
      for (const item of preset.items) {
        expect(types.has(item.effect.type)).toBe(true);
      }
    }
  });

  it('surfaces builtins through listEffectPresets and applyEffectPreset', () => {
    const names = listEffectPresets().map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(listBuiltinEffectPresets().map((p) => p.name)));
    // apply looks up builtins, not only localStorage user presets
    expect(applyEffectPreset('Soft Glow', [])).toBe(true);
  });
});
