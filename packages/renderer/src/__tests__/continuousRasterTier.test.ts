/**
 * The Continuous Rasterization tier ladder, and the bounds that keep it from
 * being a footgun.
 *
 * Measured invariants on a quantifiable property (the tier a scale resolves to,
 * and the pixels that implies), decomposed one variable at a time: scale alone,
 * then box size alone, then each bound alone.
 */

import {
  resolutionTier,
  RESOLUTION_TIERS,
  continuousResolutionTier,
  maxContinuousTier,
  CONTINUOUS_RESOLUTION_TIERS,
  DEFAULT_MAX_RASTER_DIMENSION,
  DEFAULT_MAX_RASTER_PIXELS,
} from '../raster/VectorRasterizer';

/** A box small enough that no bound binds, so scale is the only variable. */
const TINY = 16;

describe('the old ladder is untouched — CR OFF must be byte-identical', () => {
  it('still stops at 4', () => {
    expect(RESOLUTION_TIERS).toEqual([0.5, 1, 2, 4]);
    expect(resolutionTier(8)).toBe(4);
    expect(resolutionTier(64)).toBe(4);
  });

  it('still rounds up within range', () => {
    expect(resolutionTier(1.3)).toBe(2);
    expect(resolutionTier(0.4)).toBe(0.5);
    expect(resolutionTier(1)).toBe(1);
  });
});

describe('continuousResolutionTier — scale is the only variable', () => {
  it('rounds UP so content is never softer than asked for', () => {
    expect(continuousResolutionTier(1.1, TINY, TINY)).toBe(2);
    expect(continuousResolutionTier(4.1, TINY, TINY)).toBe(8);
    expect(continuousResolutionTier(8.1, TINY, TINY)).toBe(16);
  });

  it('goes PAST 4, which is the entire point of the feature', () => {
    expect(continuousResolutionTier(8, TINY, TINY)).toBe(8);
    expect(continuousResolutionTier(16, TINY, TINY)).toBe(16);
    expect(continuousResolutionTier(32, TINY, TINY)).toBe(32);
  });

  it('agrees with the old ladder at and below 4, so nothing shifts on opt-in alone', () => {
    for (const s of [0.4, 0.5, 1, 1.3, 2, 3, 4]) {
      expect(continuousResolutionTier(s, TINY, TINY)).toBe(resolutionTier(s));
    }
  });

  it('is monotonic in scale — zooming in never picks a smaller tier', () => {
    let prev = 0;
    for (let s = 0.1; s <= 40; s += 0.1) {
      const t = continuousResolutionTier(s, TINY, TINY);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('handles degenerate scale without throwing or returning 0', () => {
    for (const s of [0, -1, NaN, Infinity]) {
      const t = continuousResolutionTier(s, TINY, TINY);
      expect(t).toBeGreaterThan(0);
      expect(Number.isFinite(t)).toBe(true);
    }
  });
});

describe('maxContinuousTier — the DIMENSION bound is a hardware fact', () => {
  it('never lets a box exceed the max texture dimension', () => {
    // 1000px box against an 8192 limit: 8x = 8000 (ok), 16x = 16000 (no).
    expect(maxContinuousTier(1000, 1000, 8192, Number.MAX_SAFE_INTEGER)).toBe(8);
    expect(maxContinuousTier(1000, 1000, 8192, Number.MAX_SAFE_INTEGER) * 1000).toBeLessThanOrEqual(8192);
  });

  it('respects a low WebGL2 limit — 4096 is a real report, not a hypothetical', () => {
    expect(maxContinuousTier(1000, 1000, 4096, Number.MAX_SAFE_INTEGER)).toBe(4);
  });

  it('measures the LONGER axis, so a wide box is not allowed to overflow', () => {
    const t = maxContinuousTier(4000, 100, 8192, Number.MAX_SAFE_INTEGER);
    expect(4000 * t).toBeLessThanOrEqual(8192);
    expect(t).toBe(2);
  });

  it('never returns below the smallest tier, even for an impossible box', () => {
    expect(maxContinuousTier(100000, 100000, 8192, DEFAULT_MAX_RASTER_PIXELS)).toBe(CONTINUOUS_RESOLUTION_TIERS[0]);
  });
});

describe('maxContinuousTier — the PIXEL bound is the policy that stops a footgun', () => {
  it('binds before the dimension limit for a mid-size box', () => {
    // 1024 box: 8x = 8192 (inside the dimension limit) but 67M px, 4x the budget.
    const t = maxContinuousTier(1024, 1024, 8192, DEFAULT_MAX_RASTER_PIXELS);
    expect(1024 * t * 1024 * t).toBeLessThanOrEqual(DEFAULT_MAX_RASTER_PIXELS);
    expect(t).toBe(4);
  });

  it('lets a small box go high — that is where CR is cheap and worth it', () => {
    expect(maxContinuousTier(128, 128, 8192, DEFAULT_MAX_RASTER_PIXELS)).toBeGreaterThanOrEqual(16);
  });

  it('keeps every allowed tier inside BOTH bounds, swept across box sizes', () => {
    for (let box = 8; box <= 4096; box *= 2) {
      const t = maxContinuousTier(box, box, DEFAULT_MAX_RASTER_DIMENSION, DEFAULT_MAX_RASTER_PIXELS);
      expect(box * t).toBeLessThanOrEqual(DEFAULT_MAX_RASTER_DIMENSION);
      expect(box * t * box * t).toBeLessThanOrEqual(DEFAULT_MAX_RASTER_PIXELS);
    }
  });
});

describe('the per-frame ceiling — draft awareness', () => {
  it('caps the tier however high the scale is', () => {
    expect(continuousResolutionTier(32, TINY, TINY, 4)).toBe(4);
    expect(continuousResolutionTier(32, TINY, TINY, 8)).toBe(8);
  });

  it('a ceiling of 4 reproduces the old ladder exactly — the draft path', () => {
    for (const s of [0.4, 1, 2, 3, 4, 8, 16, 64]) {
      expect(continuousResolutionTier(s, TINY, TINY, 4)).toBe(resolutionTier(s));
    }
  });

  it('the tighter of ceiling and box bound wins', () => {
    // Ceiling 32 but a 1024 box is pixel-bound to 4.
    expect(continuousResolutionTier(32, 1024, 1024, 32)).toBe(4);
    // Ceiling 2 but a tiny box could go to 32 — ceiling wins.
    expect(continuousResolutionTier(32, TINY, TINY, 2)).toBe(2);
  });
});
