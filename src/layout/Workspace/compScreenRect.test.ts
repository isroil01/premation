/**
 * The comp rect's rounding rule.
 *
 * This exists because the transparency checkerboard is a DOM element and the
 * comp is drawn by the GPU. They are two different rasterisers looking at one
 * rectangle, so any disagreement shows as a hairline of checker past the comp
 * edge, or a gap at the seam — and the interesting cases are all at fractional
 * zoom, which is exactly where a screenshot is least useful as evidence.
 */

import { compScreenRect, type WorldToScreen } from './compScreenRect';

/** A plain zoom+pan camera, the shape the real one presents. */
const camera = (zoom: number, panX = 0, panY = 0): WorldToScreen =>
  (p) => ({ x: p.x * zoom + panX, y: p.y * zoom + panY });

describe('compScreenRect', () => {
  it('is exact at 100% with no pan', () => {
    expect(compScreenRect(camera(1), 1920, 1080)).toEqual({
      left: 0, top: 0, width: 1920, height: 1080,
    });
  });

  it.each([0.33, 0.67, 1.5, 2.25])('stays integral at %s zoom', (zoom) => {
    const r = compScreenRect(camera(zoom), 1920, 1080);
    for (const v of [r.left, r.top, r.width, r.height]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('derives width from two rounded edges, not from a rounded width', () => {
    // The distinction the whole file exists for. At 33% with a half-pixel pan
    // the right edge lands at 634.1 and the left at 0.5: rounding the SIZE
    // would give 634 at left 1 — a right edge at 635, one past where the GPU
    // put it. Rounding both edges keeps the two rasterisers on the same seam.
    const r = compScreenRect(camera(0.33, 0.5), 1920, 1080);
    expect(r.left).toBe(1);
    expect(r.left + r.width).toBe(Math.round(1920 * 0.33 + 0.5));
  });

  it('a pan of one whole pixel moves the rect and does not resize it', () => {
    // The shimmer case: if width were computed independently of position, a
    // scroll would make the rect breathe by a pixel as it moved.
    const a = compScreenRect(camera(0.67), 1920, 1080);
    const b = compScreenRect(camera(0.67, 1, 1), 1920, 1080);
    expect(b.left - a.left).toBe(1);
    expect(b.top - a.top).toBe(1);
    expect(b.width).toBe(a.width);
    expect(b.height).toBe(a.height);
  });

  it('handles a non-integer comp size', () => {
    const r = compScreenRect(camera(1), 1920.5, 1080.5);
    expect(r.width).toBe(1921);
    expect(r.height).toBe(1081);
  });

  it('stays well-formed when an axis is flipped', () => {
    // Some views invert an axis. Deriving size from the zoom factor would
    // produce a negative width and a rect the browser silently drops.
    const flipped: WorldToScreen = (p) => ({ x: -p.x, y: -p.y });
    const r = compScreenRect(flipped, 1920, 1080);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(1080);
    expect(r.left).toBe(-1920);
  });
});
