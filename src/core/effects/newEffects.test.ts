/**
 * The four effects the audit found missing against the brief's baseline:
 * directional blur, linear wipe, transform, posterize time.
 */

import { EFFECT_DEFS, defaultParams } from './effects';
import { isCanvas2dOnlyEffect } from './canvas2dEffects';
import { readPosterizeTimeFps } from './posterizeTime';
import type { Effect } from './effects';

const def = (type: string) => EFFECT_DEFS.find((d) => d.type === type)!;

describe('the four missing effects are registered', () => {
  it.each(['directional-blur', 'linear-wipe', 'transform', 'posterize-time'])('%s exists', (type) => {
    expect(def(type)).toBeTruthy();
    expect(def(type).params.length).toBeGreaterThan(0);
  });

  it('the three PIXEL passes are CPU-baked — none has a GPU shader', () => {
    for (const t of ['directional-blur', 'linear-wipe', 'transform']) {
      expect(isCanvas2dOnlyEffect(t)).toBe(true);
    }
  });

  it('posterize time is NOT a pixel pass — it is resolved in the time plumbing', () => {
    // Listing it as Canvas2D-only would send it through the pixel chain, where
    // it would do nothing at all.
    expect(isCanvas2dOnlyEffect('posterize-time')).toBe(false);
  });

  it('every new effect exposes the parameter that makes it animatable', () => {
    expect(def('directional-blur').params.map((p) => p.key)).toContain('length');
    expect(def('linear-wipe').params.map((p) => p.key)).toContain('completion');
    expect(def('transform').params.map((p) => p.key)).toContain('scale');
    expect(def('posterize-time').params.map((p) => p.key)).toContain('frameRate');
  });
});

describe('posterize time — reading the rate', () => {
  const fx = (over: Record<string, unknown> = {}): Effect => ({
    id: 'p1',
    type: 'posterize-time',
    params: { ...defaultParams(def('posterize-time')), ...over } as never,
  });

  it('returns the configured rate', () => {
    expect(readPosterizeTimeFps([fx({ frameRate: 8 })])).toBe(8);
  });

  it('returns null when the layer has none', () => {
    expect(readPosterizeTimeFps([])).toBeNull();
  });

  it('ignores a disabled instance', () => {
    expect(readPosterizeTimeFps([{ ...fx(), enabled: false }])).toBeNull();
  });

  it('ignores a sub-1fps rate rather than freezing the layer', () => {
    // Freezing is what the layer's Freeze control does, and it says so.
    expect(readPosterizeTimeFps([fx({ frameRate: 0 })])).toBeNull();
    expect(readPosterizeTimeFps([fx({ frameRate: -5 })])).toBeNull();
  });

  it('quantizes a clock to the rate it reports', () => {
    const rate = readPosterizeTimeFps([fx({ frameRate: 10 })])!;
    const q = (t: number) => Math.floor(t * rate) / rate;
    // Everything inside one 1/10s step samples the same instant.
    expect(q(0.00)).toBeCloseTo(0.0, 6);
    expect(q(0.09)).toBeCloseTo(0.0, 6);
    expect(q(0.10)).toBeCloseTo(0.1, 6);
    expect(q(0.19)).toBeCloseTo(0.1, 6);
    // …and it steps, never runs backwards.
    let prev = -Infinity;
    for (let t = 0; t < 2; t += 0.017) {
      const v = q(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
