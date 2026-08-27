/**
 * The composition-settings sanitizer. The one behaviour worth pinning hard:
 * fps is clamped but NEVER rounded. 23.976 and 29.97 are real broadcast rates
 * (presets.ts offers both and documents that rounding them is a sync bug) —
 * an integer-rounding sanitize silently turned the NTSC presets into 24/30,
 * so the comp record and the timeline disagreed and footage drifted against
 * its audio.
 */

import { sanitize } from './compositionStore';

describe('composition sanitize', () => {
  it('keeps NTSC fractional frame rates exactly', () => {
    expect(sanitize({ fps: 23.976 }).fps).toBeCloseTo(23.976, 6);
    expect(sanitize({ fps: 29.97 }).fps).toBeCloseTo(29.97, 6);
    expect(sanitize({ fps: 59.94 }).fps).toBeCloseTo(59.94, 6);
  });

  it('still clamps fps into [1, 240] and falls back on non-finite', () => {
    expect(sanitize({ fps: 0 }).fps).toBe(1);
    expect(sanitize({ fps: 1000 }).fps).toBe(240);
    expect(sanitize({ fps: Number.NaN }).fps).toBe(30);
  });

  it('keeps rounding the integer-valued fields', () => {
    expect(sanitize({ width: 1920.6 }).width).toBe(1921);
    expect(sanitize({ height: 0 }).height).toBe(1);
  });
});
