/**
 * Independent gradient OPACITY stops (#22).
 *
 * Photoshop and AE keep colour and opacity as two separate lists. Copying that
 * is the point: fading a gradient out at one end should be one opacity stop,
 * not a duplicate of every colour stop with alpha baked into each.
 */

import {
  sampleGradientOpacity,
  sortedOpacityStops,
  applyAlpha,
  defaultOpacityStops,
  makeOpacityStop,
  type OpacityStop,
} from './fill';

const stops = (...pairs: Array<[number, number]>): OpacityStop[] =>
  pairs.map(([offset, opacity], i) => ({ id: `o${i}`, offset, opacity }));

describe('sampleGradientOpacity', () => {
  it('is fully opaque when the gradient has no opacity ramp', () => {
    // Absent must mean opaque, or every existing gradient would go invisible.
    expect(sampleGradientOpacity([], 0.5)).toBe(1);
  });

  it('interpolates linearly between stops', () => {
    const s = stops([0, 1], [1, 0]);
    expect(sampleGradientOpacity(s, 0)).toBe(1);
    expect(sampleGradientOpacity(s, 0.5)).toBeCloseTo(0.5, 6);
    expect(sampleGradientOpacity(s, 1)).toBe(0);
  });

  it('clamps outside the stop range rather than extrapolating', () => {
    const s = stops([0.25, 0.4], [0.75, 0.8]);
    expect(sampleGradientOpacity(s, 0)).toBe(0.4);
    expect(sampleGradientOpacity(s, 1)).toBe(0.8);
  });

  it('handles unsorted input', () => {
    expect(sampleGradientOpacity(stops([1, 0], [0, 1]), 0.25)).toBeCloseTo(0.75, 6);
  });

  it('handles a single stop as a constant', () => {
    expect(sampleGradientOpacity(stops([0.5, 0.3]), 0)).toBe(0.3);
    expect(sampleGradientOpacity(stops([0.5, 0.3]), 1)).toBe(0.3);
  });

  it('does not divide by zero on coincident stops', () => {
    const v = sampleGradientOpacity(stops([0.5, 1], [0.5, 0]), 0.5);
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe('opacity stops are INDEPENDENT of colour stops', () => {
  it('one opacity stop can fade a gradient with any number of colours', () => {
    // The whole reason for a second list: 5 colours, 2 opacity stops.
    const fade = stops([0, 1], [1, 0]);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(sampleGradientOpacity(fade, t)).toBeCloseTo(1 - t, 6);
    }
  });

  it('opacity stops can sit at offsets no colour stop uses', () => {
    // Ramp 1 → 0 across 0.33..0.66; at 0.5 that is 0.17/0.33 of the way down.
    const s = stops([0.33, 1], [0.66, 0]);
    expect(sampleGradientOpacity(s, 0.5)).toBeCloseTo(1 - (0.5 - 0.33) / (0.66 - 0.33), 6);
    // The exact midpoint of the ramp is 0.495, and that IS a half.
    expect(sampleGradientOpacity(s, 0.495)).toBeCloseTo(0.5, 6);
  });
});

describe('applyAlpha', () => {
  it('multiplies a colour by an opacity, producing 8-digit hex', () => {
    expect(applyAlpha('#ffffff', 1).toLowerCase()).toBe('#ffffffff');
    expect(applyAlpha('#ffffff', 0).toLowerCase()).toBe('#ffffff00');
    expect(applyAlpha('#ffffff', 0.5).toLowerCase()).toMatch(/^#ffffff(7f|80)$/);
  });

  it('COMPOUNDS with alpha already in the colour', () => {
    // A half-transparent colour at half opacity is a quarter, not a half.
    const out = applyAlpha('#ff000080', 0.5).toLowerCase();
    const a = parseInt(out.slice(7, 9), 16);
    expect(a).toBeGreaterThan(0x38);
    expect(a).toBeLessThan(0x44);
  });

  it('clamps out-of-range opacity', () => {
    expect(applyAlpha('#ffffff', 5).toLowerCase()).toBe('#ffffffff');
    expect(applyAlpha('#ffffff', -1).toLowerCase()).toBe('#ffffff00');
  });
});

describe('helpers', () => {
  it('a default ramp is opaque at both ends, so adding one changes nothing', () => {
    const d = defaultOpacityStops();
    expect(d).toHaveLength(2);
    expect(sampleGradientOpacity(d, 0.5)).toBe(1);
  });

  it('makeOpacityStop clamps both fields into 0..1', () => {
    expect(makeOpacityStop(5, 5).offset).toBe(1);
    expect(makeOpacityStop(-1, -1).opacity).toBe(0);
  });

  it('sortedOpacityStops tolerates undefined', () => {
    expect(sortedOpacityStops(undefined)).toEqual([]);
  });
});
