import {
  effectsToFilter,
  reorderEffects,
  resolveEffectAmounts,
  effectPropPath,
  EFFECT_DEFS,
  type Effect,
} from './effects';

const fx = (id: string, type: Effect['type'], amount: number, enabled?: boolean): Effect =>
  ({ id, type, amount, ...(enabled === undefined ? {} : { enabled }) });

describe('effectsToFilter', () => {
  test('empty stack → empty string', () => {
    expect(effectsToFilter([])).toBe('');
  });

  test('compiles each effect in stack order', () => {
    const f = effectsToFilter([fx('a', 'blur', 5), fx('b', 'brightness', 200)]);
    expect(f).toBe('blur(5px) brightness(2)');
  });

  test('order matters (reversing changes the filter string)', () => {
    const a = effectsToFilter([fx('a', 'blur', 5), fx('b', 'invert', 100)]);
    const b = effectsToFilter([fx('b', 'invert', 100), fx('a', 'blur', 5)]);
    expect(a).not.toBe(b);
  });

  test('skips disabled effects but keeps the rest', () => {
    const f = effectsToFilter([fx('a', 'blur', 5, false), fx('b', 'grayscale', 100, true)]);
    expect(f).toBe('grayscale(1)');
  });

  test('invert compiles to invert(fraction)', () => {
    expect(effectsToFilter([fx('a', 'invert', 100)])).toBe('invert(1)');
    expect(effectsToFilter([fx('a', 'invert', 50)])).toBe('invert(0.5)');
  });
});

describe('reorderEffects', () => {
  const stack = [fx('a', 'blur', 1), fx('b', 'glow', 2), fx('c', 'sepia', 3)];

  test('moves an effect up', () => {
    expect(reorderEffects(stack, 'b', -1).map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });
  test('moves an effect down', () => {
    expect(reorderEffects(stack, 'b', 1).map((e) => e.id)).toEqual(['a', 'c', 'b']);
  });
  test('clamps at the top (no-op)', () => {
    expect(reorderEffects(stack, 'a', -1).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
  test('clamps at the bottom (no-op)', () => {
    expect(reorderEffects(stack, 'c', 1).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
  test('unknown id → unchanged', () => {
    expect(reorderEffects(stack, 'zz', 1).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('resolveEffectAmounts', () => {
  test('overrides amount when the sampler returns a value, else keeps static', () => {
    const effects = [fx('a', 'blur', 6), fx('b', 'glow', 16)];
    const out = resolveEffectAmounts(effects, (id) => (id === 'a' ? 20 : undefined));
    expect(out[0]!.amount).toBe(20);
    expect(out[1]!.amount).toBe(16);
  });

  test('returns the same object reference when an effect is not overridden', () => {
    const effects = [fx('a', 'blur', 6)];
    const out = resolveEffectAmounts(effects, () => undefined);
    expect(out[0]).toBe(effects[0]); // no needless allocation / mutation
  });

  test('feeds resolved amounts straight into effectsToFilter (animated blur)', () => {
    const effects = [fx('a', 'blur', 6)];
    const at = (v: number): string => effectsToFilter(resolveEffectAmounts(effects, () => v));
    expect(at(0)).toBe('blur(0px)');
    expect(at(30)).toBe('blur(30px)');
  });

  test('effectPropPath namespaces the effect id', () => {
    expect(effectPropPath('fx_3')).toBe('effect.fx_3');
    expect(effectPropPath('fx_3')).not.toBe(effectPropPath('fx_4'));
  });
});

describe('EFFECT_DEFS', () => {
  test('includes the new invert effect', () => {
    expect(EFFECT_DEFS.some((d) => d.type === 'invert')).toBe(true);
  });

  test('drop-shadow is defined and offsets with the amount (distinct from glow)', () => {
    const ds = EFFECT_DEFS.find((d) => d.type === 'drop-shadow');
    expect(ds).toBeDefined();
    // Non-zero offset (unlike glow's 0 0 halo), and blur scales with amount.
    expect(ds!.css(20)).toBe('drop-shadow(9.0px 9.0px 20px rgba(0,0,0,0.55))');
    const glow = EFFECT_DEFS.find((d) => d.type === 'glow')!;
    expect(glow.css(20)).not.toBe(ds!.css(20));
  });

  test('every def compiles to a non-empty css filter at its default', () => {
    const gpuOnly = ['gradient-ramp', 'fractal-noise', 'displacement-map', 'motion-tile'];
    for (const d of EFFECT_DEFS) {
      if (gpuOnly.includes(d.type)) continue;
      expect(d.css(d.default).length).toBeGreaterThan(0);
    }
  });
});
