import {
  resolutionTier,
  paddingClass,
  rasterCacheKey,
  RESOLUTION_TIERS,
} from '../raster/VectorRasterizer';

describe('resolutionTier', () => {
  it('rounds up to the smallest tier >= scale', () => {
    expect(resolutionTier(1)).toBe(1);
    expect(resolutionTier(1.3)).toBe(2);
    expect(resolutionTier(2)).toBe(2);
    expect(resolutionTier(2.01)).toBe(4);
    expect(resolutionTier(0.4)).toBe(0.5);
    expect(resolutionTier(0.5)).toBe(0.5);
  });

  it('clamps above the top tier (4K export never exceeds max)', () => {
    expect(resolutionTier(6)).toBe(4);
    expect(resolutionTier(100)).toBe(RESOLUTION_TIERS[RESOLUTION_TIERS.length - 1]);
  });

  it('is safe for zero/negative/NaN (falls back to 1×)', () => {
    expect(resolutionTier(0)).toBe(1);
    expect(resolutionTier(-2)).toBe(1);
    expect(resolutionTier(NaN)).toBe(1);
  });

  it('does not thrash: a continuous zoom stays on one tier between steps', () => {
    // Every scale in (1, 2] maps to tier 2 — no re-raster while zooming within it.
    for (const s of [1.01, 1.25, 1.5, 1.75, 2]) expect(resolutionTier(s)).toBe(2);
  });
});

describe('paddingClass', () => {
  it('buckets padding up to coarse classes', () => {
    expect(paddingClass(0)).toBe(0);
    expect(paddingClass(4)).toBe(8);
    expect(paddingClass(8)).toBe(8);
    expect(paddingClass(20)).toBe(24);
    expect(paddingClass(1000)).toBe(64);
    expect(paddingClass(-5)).toBe(0);
  });
});

describe('rasterCacheKey', () => {
  it('same content + same tier ⇒ same key (transform-only reuse)', () => {
    expect(rasterCacheKey('abc', 1.0, 0)).toBe(rasterCacheKey('abc', 1.0, 0));
    // Scales within one tier share a key (no thrash).
    expect(rasterCacheKey('abc', 1.2, 3)).toBe(rasterCacheKey('abc', 1.9, 5));
  });

  it('crossing a tier or changing content ⇒ different key', () => {
    expect(rasterCacheKey('abc', 1.0, 0)).not.toBe(rasterCacheKey('abc', 3.0, 0));
    expect(rasterCacheKey('abc', 1.0, 0)).not.toBe(rasterCacheKey('def', 1.0, 0));
  });
});
