import { SCENERY_PRESETS } from './sceneryPresets';
import { listPresets, presetFolder, remapEffectTracks, type PresetTrack } from './animationPresets';
import { EFFECT_DEFS } from '@core/effects/effects';

const track = (prop: string): PresetTrack => ({ prop, keyframes: [{ t: 0, value: 0 }] });

describe('transition and background presets', () => {
  it('every declared effect type is real', () => {
    // A typo'd effect type installs an entry the renderer skips: the preset
    // applies "successfully" and produces nothing.
    const known = new Set(EFFECT_DEFS.map((e) => e.type));
    for (const p of SCENERY_PRESETS) {
      for (const e of p.effects!) {
        expect({ preset: p.name, type: e.type, known: known.has(e.type) }).toEqual({
          preset: p.name,
          type: e.type,
          known: true,
        });
      }
    }
  });

  it('every declared effect param key exists on that effect', () => {
    // The other silent failure: a param the effect has never heard of is
    // stored, ignored, and the preset renders with the default instead.
    const byType = new Map(EFFECT_DEFS.map((e) => [e.type, new Set(e.params.map((p) => p.key))]));
    for (const p of SCENERY_PRESETS) {
      for (const e of p.effects!) {
        for (const key of Object.keys(e.params ?? {})) {
          expect({ preset: p.name, type: e.type, key, valid: byType.get(e.type)!.has(key) }).toEqual({
            preset: p.name, type: e.type, key, valid: true,
          });
        }
      }
    }
  });

  it('every effect track points at an effect the preset installs, and a real param', () => {
    // The track path carries the effect id AND the param name; either can rot
    // independently of the effect declaration above.
    const byType = new Map(EFFECT_DEFS.map((e) => [e.type, new Set(e.params.map((p) => p.key))]));
    for (const p of SCENERY_PRESETS) {
      const declared = new Map(p.effects!.map((e) => [e.id, e.type]));
      for (const t of p.tracks) {
        const m = /^effect\.([^.]+)\.(.*)$/.exec(t.prop);
        if (!m) continue; // a plain property track (opacity) is fine
        const type = declared.get(m[1]!);
        expect({ preset: p.name, prop: t.prop, effectDeclared: !!type }).toEqual({
          preset: p.name, prop: t.prop, effectDeclared: true,
        });
        expect({ preset: p.name, prop: t.prop, paramReal: byType.get(type!)!.has(m[2]!) }).toEqual({
          preset: p.name, prop: t.prop, paramReal: true,
        });
      }
    }
  });

  it('spatial effect params are declared in relative units', () => {
    // Same rule as everywhere else: a 40px feather is a broad gradient at 720p
    // and a hairline at 4K.
    for (const p of SCENERY_PRESETS) {
      for (const t of p.tracks) {
        const leaf = t.prop.split('.').pop()!;
        if (!['feather', 'amount'].includes(leaf)) continue;
        if (!t.prop.startsWith('effect.')) continue;
        // `noise.amount` is a percentage, not a distance — exempt.
        if (p.effects!.some((e) => e.type === 'noise')) continue;
        expect({ preset: p.name, prop: t.prop, unit: t.unit }).toEqual({
          preset: p.name,
          prop: t.prop,
          unit: expect.stringMatching(/^(compW|compH|compMin)$/),
        });
      }
    }
  });

  it('lands in the library under Transitions or Backgrounds', () => {
    const names = listPresets().map((p) => p.name);
    for (const p of SCENERY_PRESETS) {
      expect(names).toContain(p.name);
      expect(['Transitions', 'Backgrounds']).toContain(presetFolder(p));
    }
  });

  it('carries a description', () => {
    for (const p of SCENERY_PRESETS) {
      expect({ preset: p.name, described: !!p.description }).toEqual({ preset: p.name, described: true });
    }
  });
});

describe('remapEffectTracks', () => {
  it('re-points preset-namespaced effect ids onto the installed ones', () => {
    // Without this, applying a transition to a layer that already carries an
    // effect with a colliding id keyframes the wrong one — silently.
    const out = remapEffectTracks(
      [track('effect.fx0.completion'), track('effect.fx1.amount'), track('opacity')],
      new Map([['fx0', 'pfx_abc_0'], ['fx1', 'pfx_abc_1']]),
    );
    expect(out.map((t) => t.prop)).toEqual([
      'effect.pfx_abc_0.completion',
      'effect.pfx_abc_1.amount',
      'opacity',
    ]);
  });

  it('leaves tracks alone when nothing is mapped', () => {
    const tracks = [track('effect.fx0.completion')];
    expect(remapEffectTracks(tracks, new Map()).map((t) => t.prop)).toEqual(['effect.fx0.completion']);
  });

  it('leaves an unmapped effect id untouched rather than corrupting it', () => {
    const out = remapEffectTracks([track('effect.other.amount')], new Map([['fx0', 'pfx_1']]));
    expect(out[0]!.prop).toBe('effect.other.amount');
  });
});
