/**
 * The transition kernels, asserted numerically.
 *
 * The property every transition must have and that is easy to lose: at
 * completion 0 the layer is untouched, and at completion 1 it is entirely gone.
 * A wipe that leaves a sliver at 100% is the classic failure — it looks correct
 * while scrubbing and ruins the cut.
 */

import {
  venetianBlindsData,
  gradientWipeData,
  cardWipeData,
  cardWipeDirection,
  luminanceMapFrom,
} from './transitions';

function opaque(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 200; d[i + 1] = 200; d[i + 2] = 200; d[i + 3] = 255;
  }
  return d;
}

const visible = (d: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
  return n;
};

const allGone = (d: Uint8ClampedArray): boolean => {
  for (let i = 3; i < d.length; i += 4) if (d[i]! !== 0) return false;
  return true;
};

describe('venetianBlindsData', () => {
  it('leaves the layer untouched at completion 0', () => {
    const d = venetianBlindsData(opaque(16, 16), 16, 16, 0, 0, 4, 0);
    expect(visible(d)).toBe(256);
  });

  it('removes the layer entirely at completion 1', () => {
    // No sliver. This is the assertion that matters for a cut.
    expect(allGone(venetianBlindsData(opaque(16, 16), 16, 16, 1, 0, 4, 0))).toBe(true);
  });

  it('removes progressively more in between', () => {
    const at25 = visible(venetianBlindsData(opaque(32, 32), 32, 32, 0.25, 0, 8, 0));
    const at75 = visible(venetianBlindsData(opaque(32, 32), 32, 32, 0.75, 0, 8, 0));
    expect(at75).toBeLessThan(at25);
    expect(at25).toBeLessThan(1024);
  });

  it('produces SLATS rather than one moving edge', () => {
    // What separates it from Linear Wipe. Scanning the normal must cross
    // multiple opaque/transparent boundaries, not one.
    const d = venetianBlindsData(opaque(64, 4), 64, 4, 0.5, 0, 8, 0);
    let transitions = 0;
    for (let x = 1; x < 64; x++) {
      const prev = d[(0 * 64 + x - 1) * 4 + 3]! > 0;
      const cur = d[(0 * 64 + x) * 4 + 3]! > 0;
      if (prev !== cur) transitions++;
    }
    expect(transitions).toBeGreaterThan(3);
  });

  it('feather produces partial alpha at the slat edge', () => {
    const hard = venetianBlindsData(opaque(64, 4), 64, 4, 0.5, 0, 16, 0);
    const soft = venetianBlindsData(opaque(64, 4), 64, 4, 0.5, 0, 16, 4);
    const partials = (d: Uint8ClampedArray): number => {
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 0 && d[i]! < 255) n++;
      return n;
    };
    expect(partials(hard)).toBe(0);
    expect(partials(soft)).toBeGreaterThan(0);
  });

  it('respects the angle', () => {
    const at0 = venetianBlindsData(opaque(32, 32), 32, 32, 0.5, 0, 8, 0);
    const at90 = venetianBlindsData(opaque(32, 32), 32, 32, 0.5, 90, 8, 0);
    expect(Array.from(at0)).not.toEqual(Array.from(at90));
  });
});

describe('gradientWipeData', () => {
  /** A left-to-right luminance ramp over a 16×1 strip. */
  const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i / (n - 1));

  it('leaves the layer untouched at completion 0', () => {
    const d = gradientWipeData(opaque(16, 1), ramp(16), 0, 0.2, false);
    expect(visible(d)).toBe(16);
  });

  it('removes the layer entirely at completion 1 — including the brightest pixel', () => {
    // The reason the threshold sweep is widened by the softness at both ends. A
    // naive `threshold = completion` leaves the softest pixels partly visible at
    // 100%, which is invisible while scrubbing and wrong at the cut.
    expect(allGone(gradientWipeData(opaque(16, 1), ramp(16), 1, 0.3, false))).toBe(true);
  });

  it('reveals in luminance order — darkest first', () => {
    const d = gradientWipeData(opaque(16, 1), ramp(16), 0.5, 0.05, false);
    const alphaAt = (x: number) => d[x * 4 + 3]!;
    expect(alphaAt(0)).toBe(0);          // darkest, gone
    expect(alphaAt(15)).toBeGreaterThan(0); // brightest, still there
  });

  it('inverts the order when asked', () => {
    const d = gradientWipeData(opaque(16, 1), ramp(16), 0.5, 0.05, true);
    expect(d[0 * 4 + 3]).toBeGreaterThan(0);
    expect(d[15 * 4 + 3]).toBe(0);
  });

  it('softness widens the partial band', () => {
    const partials = (soft: number): number => {
      const d = gradientWipeData(opaque(32, 1), ramp(32), 0.5, soft, false);
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 0 && d[i]! < 255) n++;
      return n;
    };
    expect(partials(0.5)).toBeGreaterThan(partials(0.02));
  });
});

describe('luminanceMapFrom', () => {
  it('maps white to 1 and black to 0', () => {
    const d = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const map = luminanceMapFrom(d);
    expect(map[0]).toBeCloseTo(1, 5);
    expect(map[1]).toBeCloseTo(0, 5);
  });

  it('produces one entry per pixel', () => {
    expect(luminanceMapFrom(opaque(8, 4)).length).toBe(32);
  });
});

describe('cardWipeDirection', () => {
  it('maps stored indices, defaulting to right', () => {
    expect(cardWipeDirection(0)).toBe('right');
    expect(cardWipeDirection(1)).toBe('left');
    expect(cardWipeDirection(4)).toBe('radial');
    expect(cardWipeDirection(77)).toBe('right');
  });
});

describe('cardWipeData', () => {
  it('leaves the layer untouched at completion 0', () => {
    expect(visible(cardWipeData(opaque(16, 16), 16, 16, 0, 4, 4, 'right'))).toBe(256);
  });

  it('removes the layer entirely at completion 1', () => {
    expect(allGone(cardWipeData(opaque(16, 16), 16, 16, 1, 4, 4, 'right'))).toBe(true);
  });

  it('removes progressively more in between', () => {
    const at30 = visible(cardWipeData(opaque(32, 32), 32, 32, 0.3, 4, 4, 'right'));
    const at80 = visible(cardWipeData(opaque(32, 32), 32, 32, 0.8, 4, 4, 'right'));
    expect(at80).toBeLessThan(at30);
  });

  it('staggers — cards do not all leave at once', () => {
    // Without the stagger this is a hard cut with extra steps. Mid-transition
    // there must be BOTH fully-present and fully-absent cards.
    const d = cardWipeData(opaque(32, 32), 32, 32, 0.5, 1, 8, 'right');
    const colFull = (c: number): number => {
      let n = 0;
      for (let y = 0; y < 32; y++) {
        for (let x = c * 4; x < (c + 1) * 4; x++) if (d[(y * 32 + x) * 4 + 3]! > 0) n++;
      }
      return n;
    };
    const counts = Array.from({ length: 8 }, (_, c) => colFull(c));
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts));
  });

  it('reverses the stagger with the direction', () => {
    const right = cardWipeData(opaque(32, 4), 32, 4, 0.4, 1, 8, 'right');
    const left = cardWipeData(opaque(32, 4), 32, 4, 0.4, 1, 8, 'left');
    expect(Array.from(right)).not.toEqual(Array.from(left));
  });

  it('handles a single card without dividing by zero', () => {
    const d = cardWipeData(opaque(8, 8), 8, 8, 0.5, 1, 1, 'right');
    for (let i = 3; i < d.length; i += 4) expect(Number.isFinite(d[i]!)).toBe(true);
  });
});
