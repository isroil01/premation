/**
 * Pure-math tests for the Canvas2D-only effect family. The canvas-drawing paths
 * (Fill/4-Color/Stroke/Beam) need real pixels and are verified in a browser;
 * here we pin the two pixel transforms that ARE pure (Sharpen, Noise) plus the
 * hex parser and the capability classification.
 */

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
  test('the new effects are Canvas2D-only', () => {
    for (const t of ['fill', 'four-color-gradient', 'stroke', 'beam', 'sharpen', 'noise', 'keylight']) {
      expect(isCanvas2dOnlyEffect(t)).toBe(true);
    }
  });

  test('existing effects are not misclassified as Canvas2D-only', () => {
    for (const t of ['blur', 'glow', 'levels', 'tint', 'gradient-ramp', 'displacement-map']) {
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
});
