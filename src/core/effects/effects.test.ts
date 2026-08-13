import {
  effectsToFilter,
  reorderEffects,
  resolveEffectParams,
  effectPropPath,
  defaultParams,
  paramsOf,
  migrateEffect,
  effectParam,
  EFFECT_DEFS,
  type Effect,
  moveEffectTo,
} from './effects';
import { isLutEffect } from './colorLut';
import { isCanvas2dOnlyEffect } from './canvas2dEffects';
import { isTemporalEffect } from './effects';

/**
 * Deliberately the LEGACY shape (a single `amount`, no `params`) — every
 * assertion below therefore doubles as a back-compat check that projects saved
 * before the multi-param model still compile to the same filter.
 */
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

describe('resolveEffectParams', () => {
  test('overrides a param when the sampler returns a value, else keeps static', () => {
    const effects = [fx('a', 'blur', 6), fx('b', 'glow', 16)];
    const out = resolveEffectParams(effects, (p) => (p === 'effect.a.amount' ? 20 : undefined));
    expect(effectParam(out[0]!, 'amount')).toBe(20);
    expect(effectParam(out[1]!, 'radius')).toBe(16);
  });

  test('returns the same object reference when an effect is not overridden', () => {
    const effects = [fx('a', 'blur', 6)];
    const out = resolveEffectParams(effects, () => undefined);
    expect(out[0]).toBe(effects[0]); // no needless allocation / mutation
  });

  test('resolves each param of a multi-param effect independently', () => {
    const glow = [fx('g', 'glow', 16)];
    const out = resolveEffectParams(glow, (p) =>
      p === 'effect.g.radius' ? 40 : p === 'effect.g.intensity' ? 25 : undefined,
    );
    expect(effectParam(out[0]!, 'radius')).toBe(40);
    expect(effectParam(out[0]!, 'intensity')).toBe(25);
    expect(effectParam(out[0]!, 'color')).toBe('#78b4ff'); // untouched default
  });

  test('color params animate via decomposed channel tracks (r/g/b 0..255, a 0..1)', () => {
    const glow = [fx('g', 'glow', 16)];
    const sample = (p: string): number | undefined =>
      p === 'effect.g.color_r' ? 255
      : p === 'effect.g.color_g' ? 0
      : p === 'effect.g.color_b' ? 0
      : p === 'effect.g.color_a' ? 1
      : undefined;
    const out = resolveEffectParams(glow, sample);
    expect(effectParam(out[0]!, 'color')).toBe('#ff0000');
  });

  test('a partially-keyframed color keeps the stored channels for the rest', () => {
    const glow = [fx('g', 'glow', 16)]; // stored color default #78b4ff
    const out = resolveEffectParams(glow, (p) => (p === 'effect.g.color_g' ? 0 : undefined));
    expect(effectParam(out[0]!, 'color')).toBe('#7800ff'); // only green replaced
  });

  test('feeds resolved params straight into effectsToFilter (animated blur)', () => {
    const effects = [fx('a', 'blur', 6)];
    const at = (v: number): string =>
      effectsToFilter(resolveEffectParams(effects, (p) => (p === 'effect.a.amount' ? v : undefined)));
    expect(at(0)).toBe('blur(0px)');
    expect(at(30)).toBe('blur(30px)');
  });

  test('a LEGACY `effect.<id>` track still drives the primary param', () => {
    // Projects saved before multi-param keyframed the un-suffixed path.
    const effects = [fx('a', 'blur', 6)];
    const out = resolveEffectParams(effects, (p) => (p === 'effect.a' ? 12 : undefined));
    expect(effectsToFilter(out)).toBe('blur(12px)');
  });

  test('a param-specific track wins over the legacy one', () => {
    const effects = [fx('a', 'blur', 6)];
    const out = resolveEffectParams(effects, (p) =>
      p === 'effect.a.amount' ? 3 : p === 'effect.a' ? 99 : undefined,
    );
    expect(effectsToFilter(out)).toBe('blur(3px)');
  });

  test('effectPropPath namespaces the effect id and the param', () => {
    expect(effectPropPath('fx_3')).toBe('effect.fx_3'); // legacy form
    expect(effectPropPath('fx_3', 'radius')).toBe('effect.fx_3.radius');
    expect(effectPropPath('fx_3', 'radius')).not.toBe(effectPropPath('fx_4', 'radius'));
    expect(effectPropPath('fx_3', 'radius')).not.toBe(effectPropPath('fx_3', 'intensity'));
  });
});

describe('legacy migration', () => {
  test('paramsOf lifts a legacy amount into the primary param', () => {
    expect(paramsOf(fx('a', 'blur', 22)).amount).toBe(22);
    // Glow's primary is `radius`, not `amount`.
    expect(paramsOf(fx('g', 'glow', 22)).radius).toBe(22);
  });

  test('paramsOf fills in declared defaults for params the doc never had', () => {
    const p = paramsOf(fx('g', 'glow', 10));
    expect(p).toMatchObject({ radius: 10, color: '#78b4ff', intensity: 90 });
  });

  test('stored params win over a stale legacy amount', () => {
    const e: Effect = { id: 'a', type: 'blur', amount: 5, params: { amount: 40 } };
    expect(paramsOf(e).amount).toBe(40);
  });

  test('migrateEffect drops the legacy field and keeps the look', () => {
    const m = migrateEffect(fx('a', 'blur', 22));
    expect(m.amount).toBeUndefined();
    expect(effectsToFilter([m])).toBe(effectsToFilter([fx('a', 'blur', 22)]));
  });
});

describe('EFFECT_DEFS', () => {
  test('includes the new invert effect', () => {
    expect(EFFECT_DEFS.some((d) => d.type === 'invert')).toBe(true);
  });

  test('every def declares at least one param', () => {
    for (const d of EFFECT_DEFS) expect(d.params.length).toBeGreaterThan(0);
  });

  test('param keys are unique within a def', () => {
    for (const d of EFFECT_DEFS) {
      expect(new Set(d.params.map((p) => p.key)).size).toBe(d.params.length);
    }
  });

  test('drop-shadow casts at its own angle (not a fixed 45°)', () => {
    const ds = EFFECT_DEFS.find((d) => d.type === 'drop-shadow')!;
    // The old model derived both offsets from one amount (a*0.45, a*0.45), so
    // the shadow could ONLY ever fall down-right at 45°.
    const right = ds.css({ ...defaultParams(ds), distance: 10, angle: 0 });
    const down = ds.css({ ...defaultParams(ds), distance: 10, angle: 90 });
    expect(right).toContain('10.0px 0.0px');
    expect(down).toContain('0.0px 10.0px');
    expect(right).not.toBe(down);
  });

  test('glow takes a colour (it used to be hardcoded blue)', () => {
    const glow = EFFECT_DEFS.find((d) => d.type === 'glow')!;
    const red = glow.css({ ...defaultParams(glow), color: '#ff0000', intensity: 100 });
    expect(red).toBe('drop-shadow(0 0 16px rgba(255,0,0,1))');
  });

  // Effects with no CSS-filter form, rendered instead by the Canvas2D pixel
  // pass as a 3×3 colour matrix + offset (Tint, Channel Mixer). Distinct from
  // LUT effects (per-channel curves) and gpuOnly shader effects.
  const MATRIX_PIXEL_EFFECTS = new Set<string>(['tint', 'channel-mixer']);
  // Generators drawn by the Canvas2D pixel pass (proceduralCanvas2d.ts) — they
  // used to be gpuOnly; now they render on every backend.
  const PROCEDURAL_EFFECTS = new Set<string>(['gradient-ramp', 'fractal-noise']);
  // Canvas2D-only generators / pixel passes with no GPU shader form
  // (canvas2dEffects.ts). Read the REAL predicate rather than a copy of the list.
  //
  // GPU spatial effects with empty CSS (CompositionPass materials) — Fill,
  // Stroke, Sharpen, Noise used to be Canvas2D-only; they now run as shaders.
  //
  // `apply-color-lut` joined them when it gained a strip texture and a shader:
  // it left the forces-a-bake list (so it no longer answers to
  // `isCanvas2dOnlyEffect`) while KEEPING its Canvas2D pass for layers baked
  // for other reasons — exactly the position the four above are in.
  const GPU_SPATIAL_NO_CSS = new Set<string>([
    'fill', 'stroke', 'sharpen', 'noise', 'apply-color-lut',
    // Ported 2026-08-12, the first of the CPU population to move. Same
    // position as the five above: a shader in CompositionPass, no CSS form,
    // and its Canvas2D pass retained as the reference the GPU one is diffed
    // against.
    'beam',
  ]);
  // Temporal effects (Echo, Posterize Time) are resolved in buildSnapshot's
  // time plumbing, not as a per-layer pass. Read the REAL predicate — this was
  // a second private list beside the Canvas2D one, and it went stale for the
  // same reason.

  const isNonCss = (type: string, gpuOnly?: boolean): boolean =>
    gpuOnly === true ||
    isLutEffect(type as never) ||
    MATRIX_PIXEL_EFFECTS.has(type) ||
    PROCEDURAL_EFFECTS.has(type) ||
    isCanvas2dOnlyEffect(type) ||
    GPU_SPATIAL_NO_CSS.has(type) ||
    isTemporalEffect(type);

  test('every CSS-form effect compiles to a non-empty filter at its defaults', () => {
    // Six categories now: CSS-form (non-empty css), GPU-only shader effects,
    // per-pixel LUT effects (Levels/Curves), matrix pixel effects
    // (Tint/Channel Mixer), Canvas2D procedural generators (Gradient Ramp/
    // Fractal Noise), and Canvas2D-only pixel passes (Fill/Stroke/Sharpen/…).
    // Only the first must produce a CSS string.
    for (const d of EFFECT_DEFS) {
      if (isNonCss(d.type, d.gpuOnly)) continue;
      expect(d.css(defaultParams(d)).length).toBeGreaterThan(0);
    }
  });

  test('an effect has no CSS form exactly when it is GPU-only, LUT, matrix pixel, procedural, or Canvas2D-only', () => {
    for (const d of EFFECT_DEFS) {
      const noCss = d.css(defaultParams(d)) === '';
      expect(noCss).toBe(isNonCss(d.type, d.gpuOnly));
    }
  });
});

describe('moveEffectTo — drag reorder', () => {
  const stack = () =>
    ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'blur' as const, params: {} }));
  const ids = (l: ReadonlyArray<{ id: string }>) => l.map((e) => e.id);

  it('moves an effect down to a later gap', () => {
    // 'a' dropped into the gap before 'd' (index 3) → a sits after c.
    expect(ids(moveEffectTo(stack(), 'a', 3))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an effect up to an earlier gap', () => {
    expect(ids(moveEffectTo(stack(), 'd', 1))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('drops at the very end', () => {
    expect(ids(moveEffectTo(stack(), 'a', 4))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('drops at the very start', () => {
    expect(ids(moveEffectTo(stack(), 'd', 0))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('treats both no-op gaps around an item as no-ops', () => {
    // Dropping 'b' immediately before or immediately after itself must not
    // shuffle anything — the off-by-one that makes a drag feel jittery.
    expect(ids(moveEffectTo(stack(), 'b', 1))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(moveEffectTo(stack(), 'b', 2))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clamps out-of-range targets instead of dropping the effect', () => {
    expect(ids(moveEffectTo(stack(), 'a', 99))).toEqual(['b', 'c', 'd', 'a']);
    expect(ids(moveEffectTo(stack(), 'a', -5))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves an unknown id alone', () => {
    expect(ids(moveEffectTo(stack(), 'zzz', 0))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never loses or duplicates an effect', () => {
    for (const id of ['a', 'b', 'c', 'd']) {
      for (let to = 0; to <= 4; to++) {
        const out = ids(moveEffectTo(stack(), id, to));
        expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
      }
    }
  });
});
