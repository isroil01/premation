/**
 * Colour LUTs — Levels and Curves.
 *
 * These are the non-affine per-channel remaps (black/white points + gamma;
 * spline) that CSS `filter` and the 3×3 colour matrix can't express, so they
 * render through a per-pixel pass. The table math is where an off-by-one washes
 * out or clips an image, so it's tested directly.
 */

import { buildChannelLut, applyChannelLut, isLutEffect } from './colorLut';
import type { Effect } from './effects';

function levels(params: Record<string, number>): Effect {
  return { id: 'lv', type: 'levels', params };
}

/** Apply a stack to one RGB triple and read it back. */
function grade(effects: Effect[], rgb: [number, number, number]): [number, number, number] {
  const lut = buildChannelLut(effects);
  const data = new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]);
  if (lut) applyChannelLut(data, lut);
  return [data[0]!, data[1]!, data[2]!];
}

describe('isLutEffect', () => {
  it('classifies levels, curves and posterize, not css/matrix effects', () => {
    expect(isLutEffect('levels')).toBe(true);
    expect(isLutEffect('curves')).toBe(true);
    expect(isLutEffect('posterize')).toBe(true);
    expect(isLutEffect('brightness')).toBe(false);
    expect(isLutEffect('blur')).toBe(false);
  });
});

describe('buildChannelLut', () => {
  it('returns null when the stack has no LUT effect', () => {
    expect(buildChannelLut([{ id: 'b', type: 'blur', params: { amount: 5 } }])).toBeNull();
  });

  it('is a no-op at default Levels (0/255/1/0/255)', () => {
    const def = levels({ inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 });
    expect(grade([def], [0, 128, 255])).toEqual([0, 128, 255]);
  });

  it('raises the black point (crushes shadows)', () => {
    // Input black 64 → anything ≤64 becomes 0; the range 64..255 stretches to 0..255.
    const l = levels({ inputBlack: 64, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 });
    const [r] = grade([l], [64, 0, 0]);
    expect(r).toBe(0);
    // Midpoint of the new range maps near mid-grey.
    const [r2] = grade([l], [160, 0, 0]); // (160-64)/(255-64) ≈ 0.502
    expect(r2).toBeGreaterThan(120);
    expect(r2).toBeLessThan(135);
  });

  it('lifts the output black (fades blacks toward grey)', () => {
    const l = levels({ inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 50, outputWhite: 255 });
    expect(grade([l], [0, 0, 0])).toEqual([50, 50, 50]);
    expect(grade([l], [255, 255, 255])).toEqual([255, 255, 255]);
  });

  it('gamma > 1 brightens midtones without moving the endpoints', () => {
    const l = levels({ inputBlack: 0, inputWhite: 255, gamma: 2, outputBlack: 0, outputWhite: 255 });
    expect(grade([l], [0, 0, 0])).toEqual([0, 0, 0]);
    expect(grade([l], [255, 255, 255])).toEqual([255, 255, 255]);
    const [mid] = grade([l], [128, 0, 0]);
    expect(mid).toBeGreaterThan(128); // midtone lifted
  });

  it('composes two Levels effects in stack order', () => {
    // First halves the output range, second inverts nothing — combined effect is
    // the composition, not either alone.
    const a = levels({ inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 128 });
    const b = levels({ inputBlack: 0, inputWhite: 128, gamma: 1, outputBlack: 0, outputWhite: 255 });
    // a maps 255→128; b then maps 128→255. Net: white stays white.
    expect(grade([a, b], [255, 0, 0])[0]).toBeGreaterThan(250);
    // a alone would leave white at 128.
    expect(grade([a], [255, 0, 0])[0]).toBeLessThan(135);
  });

  it('leaves alpha untouched', () => {
    const l = levels({ inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 100, outputWhite: 200 });
    const data = new Uint8ClampedArray([0, 0, 0, 42]);
    applyChannelLut(data, buildChannelLut([l])!);
    expect(data[3]).toBe(42);
  });
});

describe('curves', () => {
  it('is identity for a straight 0→0, 255→255 ramp', () => {
    const c: Effect = { id: 'c', type: 'curves', params: { points: [[0, 0], [255, 255]] } };
    expect(grade([c], [0, 100, 255])).toEqual([0, 100, 255]);
  });

  it('applies a lift through a mid control point', () => {
    // Pull the midpoint up: 128 → 200.
    const c: Effect = { id: 'c', type: 'curves', params: { points: [[0, 0], [128, 200], [255, 255]] } };
    const [mid] = grade([c], [128, 0, 0]);
    expect(mid).toBeGreaterThanOrEqual(199);
    expect(mid).toBeLessThanOrEqual(201);
    // Endpoints unchanged.
    expect(grade([c], [0, 0, 0])[0]).toBe(0);
    expect(grade([c], [255, 0, 0])[0]).toBe(255);
  });
});

describe('posterize', () => {
  const posterize = (levels: number): Effect => ({ id: 'p', type: 'posterize', params: { levels } });

  it('keeps the endpoints and snaps midtones to bands', () => {
    // 2 levels → hard two-tone: everything ≤ 127.5 → 0, else → 255.
    const p = posterize(2);
    expect(grade([p], [0, 127, 255])).toEqual([0, 0, 255]);
    expect(grade([p], [128, 200, 10])).toEqual([255, 255, 0]);
  });

  it('quantises to N evenly-spaced levels', () => {
    // 3 levels → bands at 0, 128, 255.
    const p = posterize(3);
    expect(grade([p], [0, 0, 0])).toEqual([0, 0, 0]);
    expect(grade([p], [128, 128, 128])).toEqual([128, 128, 128]);
    expect(grade([p], [255, 255, 255])).toEqual([255, 255, 255]);
    // A value near an edge snaps to the nearest band.
    expect(grade([p], [30, 0, 0])[0]).toBe(0);
    expect(grade([p], [100, 0, 0])[0]).toBe(128);
  });

  it('is a per-channel LUT that leaves alpha untouched', () => {
    const data = new Uint8ClampedArray([200, 50, 90, 33]);
    applyChannelLut(data, buildChannelLut([posterize(4)])!);
    expect(data[3]).toBe(33);
  });
});
