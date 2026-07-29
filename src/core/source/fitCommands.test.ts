/**
 * Fit arithmetic — the rule that decides whether a 4K clip dropped into a 1080
 * comp is visible or four times outside the frame.
 *
 * Pure `computeFit` is tested directly rather than through the scene graph: the
 * scene write is trivial, the arithmetic is what silently ruins an import.
 */

import { computeFit } from './fitCommands';

const UHD = { width: 3840, height: 2160 };
const HD = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };
const SQUARE = { width: 1000, height: 1000 };

describe('computeFit — 4K source into a 1080 comp', () => {
  it('contains: the whole frame fits, nothing overflows', () => {
    const r = computeFit(UHD, HD, 'contain');
    expect(r).toEqual({ width: 1920, height: 1080 });
    expect(r.width).toBeLessThanOrEqual(HD.width);
    expect(r.height).toBeLessThanOrEqual(HD.height);
  });

  it('native leaves it at source size — deliberately overflowing', () => {
    expect(computeFit(UHD, HD, 'native')).toEqual({ width: 3840, height: 2160 });
  });
});

describe('computeFit — mismatched aspect ratios', () => {
  it('contain letterboxes a square source in a wide frame', () => {
    // 1000x1000 into 1920x1080 → scale 1.08, height-bound.
    expect(computeFit(SQUARE, HD, 'contain')).toEqual({ width: 1080, height: 1080 });
  });

  it('cover fills a wide frame with a square source, overflowing vertically', () => {
    // scale 1.92, width-bound; height overflows, which is the point.
    const r = computeFit(SQUARE, HD, 'cover');
    expect(r).toEqual({ width: 1920, height: 1920 });
    expect(r.height).toBeGreaterThan(HD.height);
  });

  it('contain fits a vertical source into a wide frame without cropping', () => {
    const r = computeFit(VERTICAL, HD, 'contain');
    expect(r).toEqual({ width: 608, height: 1080 });
    expect(r.width).toBeLessThanOrEqual(HD.width);
  });

  it('contain fits a wide source into a vertical frame without cropping', () => {
    const r = computeFit(HD, VERTICAL, 'contain');
    expect(r).toEqual({ width: 1080, height: 608 });
    expect(r.height).toBeLessThanOrEqual(VERTICAL.height);
  });
});

describe('computeFit — single-axis and stretch', () => {
  it('width matches the frame width and keeps aspect', () => {
    expect(computeFit(UHD, HD, 'width')).toEqual({ width: 1920, height: 1080 });
    expect(computeFit(SQUARE, HD, 'width')).toEqual({ width: 1920, height: 1920 });
  });

  it('height matches the frame height and keeps aspect', () => {
    expect(computeFit(SQUARE, HD, 'height')).toEqual({ width: 1080, height: 1080 });
  });

  it('stretch fills exactly, breaking aspect', () => {
    expect(computeFit(SQUARE, HD, 'stretch')).toEqual({ width: 1920, height: 1080 });
  });
});

describe('computeFit — degenerate input', () => {
  it('falls back to the frame when the source has no size yet', () => {
    // Metadata not resolved: fill the frame rather than collapse to nothing.
    expect(computeFit({ width: 0, height: 0 }, HD, 'contain')).toEqual(HD);
  });
});

describe('computeFit — a composition source fits by the same rule', () => {
  it('treats a 1080x1920 comp exactly like 1080x1920 footage', () => {
    expect(computeFit(VERTICAL, HD, 'contain')).toEqual(computeFit({ width: 1080, height: 1920 }, HD, 'contain'));
  });
});
