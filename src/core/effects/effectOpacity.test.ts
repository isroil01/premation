/**
 * AE Compositing Options → Effect Opacity.
 *
 * THE POINT OF THE FEATURE: an effect has no in/out point, in After Effects or
 * here. Limiting one to a time range therefore means keyframing it to nothing
 * outside that range, and most effects expose no parameter that means "off" —
 * Find Edges, Mosaic and a colour LUT have nothing to ramp to zero. This dial
 * blends an effect's OUTPUT against its INPUT, so it gives every effect in the
 * registry the same time range for free.
 *
 * THE INVARIANTS these pin:
 *   1. absent ≠ 100. Absent means untouched and keeps the effect on its GPU
 *      path; present — at ANY value, 100 included — forces the CPU bake, which
 *      is the only chain that can blend against an input.
 *   2. the reserved key cannot collide with the nineteen effects that already
 *      declare a param plainly named `opacity`.
 *   3. an animated opacity stamps the field on EVERY frame, so a 0→100→0 ramp
 *      never flips render paths mid-animation.
 *
 * Pixel algebra (out = before·(1−α) + after·α, byte-identical at both ends) is
 * carried end-to-end by the golden-frame suite in packages/render-tests: Skia
 * doubles globalAlpha on `destination-in`, which is one of the two ops the flat
 * blend is built from, so this environment cannot assert it. See
 * `__testHelpers__/canvasFidelity` for the measurement.
 */

import {
  EFFECT_DEFS,
  EFFECT_OPACITY_KEY,
  effectOpacityKeyIsReserved,
  effectOpacityPath,
  effectOpacityOf,
  effectHasOpacity,
  effectPropPath,
  resolveEffectParams,
  type Effect,
} from './effects';
import { pluginEffectDefs } from './pluginEffectDefs';
import { effectsNeedCpuBake, layerIsBaked } from './effectBake';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';

const blur: Effect = { id: 'e1', type: 'blur', params: { radius: 8 } } as Effect;

describe('the reserved key', () => {
  it('collides with no built-in or plugin param key', () => {
    // Nineteen effects declare a param keyed `opacity` — Drop Shadow's, Glow's,
    // Vegas'. Those mean "how opaque is the thing this effect draws"; this one
    // means "how much of this effect's result survives". Sharing a key would
    // put two different quantities on one keyframe track.
    expect(effectOpacityKeyIsReserved(EFFECT_DEFS)).toBe(true);
    expect(effectOpacityKeyIsReserved(pluginEffectDefs())).toBe(true);
    // The dot is what makes the collision impossible rather than merely absent:
    // every declared key in the registry is a plain identifier.
    expect(EFFECT_OPACITY_KEY).toContain('.');
    for (const d of EFFECT_DEFS) {
      for (const p of d.params) expect(p.key).not.toContain('.');
    }
  });

  it('still parses as an effect path, id and key intact', () => {
    // `resolveEffectParam`'s regex takes the id from the first segment and the
    // whole remainder as the key, so the extra dot rides through.
    expect(effectOpacityPath('fx_3')).toBe('effect.fx_3.fx.opacity');
    const meta = resolvePropertyMeta(effectOpacityPath('fx_3'));
    expect(meta.unit).toBe('%');
    expect(meta.min).toBe(0);
    expect(meta.max).toBe(100);
    expect(meta.defaultValue).toBe(100);
    expect(meta.label).toContain('Effect Opacity');
  });

  it('does not steal the label of an effect own `opacity` param', () => {
    // The regression this guards: falling through to the key-matching scan
    // would describe it with whichever effect declares `opacity` first.
    const own = resolvePropertyMeta(effectPropPath('fx_3', 'opacity'));
    expect(own.label).not.toContain('Effect Opacity');
  });
});

describe('absent is not 100', () => {
  it('an untouched effect blends at 1 and forces no bake', () => {
    expect(effectHasOpacity(blur)).toBe(false);
    expect(effectOpacityOf(blur)).toBe(1);
    expect(effectsNeedCpuBake([blur])).toBe(false);
  });

  it('a PRESENT opacity forces the bake even at exactly 100', () => {
    // This is what stops a 0→100→0 ramp from flipping to the GPU path at its
    // peak and popping where the two backends round differently.
    expect(effectsNeedCpuBake([{ ...blur, opacity: 100 }])).toBe(true);
    expect(effectsNeedCpuBake([{ ...blur, opacity: 50 }])).toBe(true);
    expect(effectsNeedCpuBake([{ ...blur, opacity: 0 }])).toBe(true);
  });

  it('reaches layerIsBaked, so every call site agrees', () => {
    // M5b's single source of truth must see it too, or the rasterizer and the
    // frame-scene builder disagree about who owns the chain and it runs twice.
    for (const kind of ['shape', 'text', 'image', 'video']) {
      expect(layerIsBaked({ kind, effects: [{ ...blur, opacity: 40 }] })).toBe(true);
    }
  });

  it('a DISABLED effect with an opacity forces no bake', () => {
    expect(effectsNeedCpuBake([{ ...blur, opacity: 40, enabled: false }])).toBe(false);
  });

  it('rejects a non-finite stored value rather than blending by NaN', () => {
    expect(effectOpacityOf({ ...blur, opacity: NaN })).toBe(1);
    expect(effectHasOpacity({ ...blur, opacity: NaN })).toBe(false);
  });

  it('clamps a stored value outside 0..100', () => {
    expect(effectOpacityOf({ ...blur, opacity: 250 })).toBe(1);
    expect(effectOpacityOf({ ...blur, opacity: -40 })).toBe(0);
    expect(effectOpacityOf({ ...blur, opacity: 50 })).toBe(0.5);
  });
});

describe('resolveEffectParams samples it per frame', () => {
  const sampleAt = (v: number | undefined) => (p: string) =>
    p === effectOpacityPath('e1') ? v : undefined;

  it('stamps the sampled value onto the effect', () => {
    const out = resolveEffectParams([blur], sampleAt(35))[0]!;
    expect(out.opacity).toBe(35);
    expect(effectOpacityOf(out)).toBeCloseTo(0.35);
  });

  it('stamps it on frames that sample exactly 100, keeping the path stable', () => {
    // Invariant 3. The whole animation must stay on one render path.
    const peak = resolveEffectParams([blur], sampleAt(100))[0]!;
    expect(peak.opacity).toBe(100);
    expect(effectsNeedCpuBake([peak])).toBe(true);
  });

  it('leaves an unanimated effect untouched', () => {
    const out = resolveEffectParams([blur], sampleAt(undefined))[0]!;
    expect(out.opacity).toBeUndefined();
    expect(effectsNeedCpuBake([out])).toBe(false);
  });

  it('the static value survives when there is no track', () => {
    const out = resolveEffectParams([{ ...blur, opacity: 60 }], sampleAt(undefined))[0]!;
    expect(out.opacity).toBe(60);
  });

  it('an animated value beats the stored one', () => {
    const out = resolveEffectParams([{ ...blur, opacity: 60 }], sampleAt(10))[0]!;
    expect(out.opacity).toBe(10);
  });

  it('does not disturb the effect OWN `opacity` param', () => {
    // Drop Shadow declares one. Both must resolve, independently.
    const shadow = { id: 'e1', type: 'drop-shadow', params: { opacity: 55 } } as Effect;
    const out = resolveEffectParams([shadow], (p) =>
      p === effectOpacityPath('e1') ? 20
        : p === effectPropPath('e1', 'opacity') ? 80
        : undefined)[0]!;
    expect(out.params?.opacity).toBe(80); // the shadow's own darkness
    expect(out.opacity).toBe(20);         // how much of the shadow effect survives
  });

  it('reaches a plugin effect, whose def is not in the built-in table', () => {
    // It is an instance field rather than a declared param, which is exactly
    // what lets it work on an effect whose definition knows nothing about it.
    const unknown = { id: 'e1', type: 'not-a-registered-type' } as unknown as Effect;
    const out = resolveEffectParams([unknown], sampleAt(25))[0]!;
    expect(out.opacity).toBe(25);
  });
});
