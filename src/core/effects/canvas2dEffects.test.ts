/**
 * Pure-math tests for the Canvas2D-only effect family. The canvas-drawing paths
 * (Fill/4-Color/Stroke/Beam) need real pixels and are verified in a browser;
 * here we pin the two pixel transforms that ARE pure (Sharpen, Noise) plus the
 * hex parser and the capability classification.
 */

import { readSource } from '@/__testHelpers__/readSource';
import { parseHex, sharpenData, addNoiseData, isCanvas2dOnlyEffect } from './canvas2dEffects';
import { EFFECT_DEFS } from './effects';

describe('parseHex', () => {
  test('6-digit', () => expect(parseHex('#ff8040')).toEqual([255, 128, 64]));
  test('3-digit', () => expect(parseHex('#f84')).toEqual([255, 136, 68]));
  test('non-hex → mid-grey', () => expect(parseHex('rebeccapurple')).toEqual([128, 128, 128]));
});

describe('sharpenData', () => {
  // A 3×3 with a bright centre on a dark field. Sharpen accentuates the centre
  // (center weight 1+4k) and darkens the ring (−k each), so the centre rises.
  function field(center: number, edge: number): Uint8ClampedArray {
    const d = new Uint8ClampedArray(3 * 3 * 4);
    for (let i = 0; i < 9; i++) {
      const v = i === 4 ? center : edge;
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    return d;
  }

  test('amount 0 is identity', () => {
    const d = field(200, 50);
    const out = sharpenData(d, 3, 3, 0);
    expect(Array.from(out)).toEqual(Array.from(d));
  });

  test('centre brightens over a darker ring', () => {
    const out = sharpenData(field(200, 50), 3, 3, 0.5);
    // centre = (1+4·0.5)·200 − 0.5·(4·50) = 600 − 100 = 500 → clamp 255
    expect(out[4 * 4]).toBe(255);
    // corner neighbours are only edge pixels; a corner reads clamped edges so it
    // stays put-ish, never exceeds 255 and never goes negative
    for (let i = 0; i < 9; i++) {
      expect(out[i * 4]).toBeGreaterThanOrEqual(0);
      expect(out[i * 4]).toBeLessThanOrEqual(255);
    }
  });

  test('alpha channel is never touched', () => {
    const d = field(200, 50);
    d[4 * 4 + 3] = 123;
    const out = sharpenData(d, 3, 3, 0.8);
    expect(out[4 * 4 + 3]).toBe(123);
  });

  test('fully transparent pixels are left alone', () => {
    const d = new Uint8ClampedArray(4);
    d[0] = 100; // rgb present but alpha 0
    const out = sharpenData(d, 1, 1, 1);
    expect(out[0]).toBe(100); // untouched — we don't invent colour in empty pixels
  });
});

describe('addNoiseData', () => {
  test('amount 0 is a no-op', () => {
    const d = new Uint8ClampedArray([120, 120, 120, 255]);
    const before = Array.from(d);
    addNoiseData(d, 1, 0, 0, true);
    // amount 0 → strength 0 → delta 0
    expect(Array.from(d)).toEqual(before);
  });

  test('deterministic for a given evolution', () => {
    const a = new Uint8ClampedArray([120, 120, 120, 255, 120, 120, 120, 255]);
    const b = new Uint8ClampedArray([120, 120, 120, 255, 120, 120, 120, 255]);
    addNoiseData(a, 2, 0.5, 7, true);
    addNoiseData(b, 2, 0.5, 7, true);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test('different evolution → different grain', () => {
    const a = new Uint8ClampedArray([120, 120, 120, 255]);
    const b = new Uint8ClampedArray([120, 120, 120, 255]);
    addNoiseData(a, 1, 0.8, 1, true);
    addNoiseData(b, 1, 0.8, 2, true);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  test('monochrome adds the SAME delta to r,g,b', () => {
    const d = new Uint8ClampedArray([120, 120, 120, 255]);
    addNoiseData(d, 1, 0.5, 3, true);
    expect(d[0]).toBe(d[1]);
    expect(d[1]).toBe(d[2]);
  });

  test('colour mode varies channels independently', () => {
    const d = new Uint8ClampedArray([120, 120, 120, 255]);
    addNoiseData(d, 1, 0.9, 3, false);
    // extremely unlikely all three hashes coincide
    expect(d[0] === d[1] && d[1] === d[2]).toBe(false);
  });

  test('alpha preserved; transparent pixels skipped', () => {
    const d = new Uint8ClampedArray([120, 120, 120, 0]);
    addNoiseData(d, 1, 1, 0, true); // full-strength noise, but alpha 0 → skipped
    expect(Array.from(d)).toEqual([120, 120, 120, 0]);
  });
});

describe('classification', () => {
  test('pixel-pass generators without GPU shaders are Canvas2D-only', () => {
    for (const t of ['four-color-gradient', 'keylight', 'bevel', 'inner-shadow']) {
      expect(isCanvas2dOnlyEffect(t)).toBe(true);
    }
  });

  test('effects with CompositionPass GPU materials are not Canvas2D-only', () => {
    for (const t of ['blur', 'glow', 'levels', 'tint', 'gradient-ramp', 'displacement-map', 'fill', 'stroke', 'sharpen', 'noise', 'beam']) {
      expect(isCanvas2dOnlyEffect(t)).toBe(false);
    }
  });

  test('every Canvas2D-only effect is registered with an empty css form', () => {
    for (const d of EFFECT_DEFS) {
      if (!isCanvas2dOnlyEffect(d.type)) continue;
      expect(d.css({})).toBe('');
      expect(d.params.length).toBeGreaterThan(0);
    }
  });

  /**
   * Every effect that FORCES a bake must have something to draw once it happens.
   *
   * WHY THIS EXISTS. `applyCanvas2dEffect` is a switch with no `default`, so an
   * effect listed in `CANVAS2D_ONLY` but missing its `case` falls straight
   * through and returns — silently. The layer still pays for the entire CPU
   * round-trip (that list is precisely what forces the bake), the effect appears
   * in the stack, its parameters animate and keyframe, and nothing is drawn.
   *
   * Worse than an unimplemented effect, because every signal the user has says
   * it works. It is also the same shape as the two bugs the wiring audit found:
   * a registration and its consumer drifting apart, with nothing checking they
   * still meet. Read from SOURCE rather than by invoking the function — invoking
   * it needs a canvas and would only prove the types the test remembered to pass.
   *
   * IF THIS FAILS, either add the `case` or take the type off `CANVAS2D_ONLY`.
   */
  test('every Canvas2D-only effect has a dispatch case in applyCanvas2dEffect', () => {
    const src = readSource('core/effects/canvas2dEffects.ts');
    const body = src.slice(src.indexOf('export function applyCanvas2dEffect'));
    const dispatched = new Set(
      [...body.matchAll(/case\s+'([a-z0-9-]+)'\s*:/g)].map((m) => m[1]!),
    );

    // Guards the guard: an empty set satisfies the subset check vacuously.
    expect(dispatched.size).toBeGreaterThan(10);

    const missing = EFFECT_DEFS
      .filter((d) => isCanvas2dOnlyEffect(d.type) && !dispatched.has(d.type))
      .map((d) => d.type);
    expect(missing).toEqual([]);
  });
});
