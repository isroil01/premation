/**
 * The colour kernels, asserted numerically.
 *
 * Vibrance and Colorama here; Exposure is asserted in `colorLut.test.ts` with
 * the other transfer functions, which is where it belongs — it is a LUT effect,
 * and the split is load-bearing rather than cosmetic (see LUT_EFFECTS).
 */

import { vibranceData, coloramaData, samplePalette, luma, COLORAMA_PALETTES } from './colorEffects';

const rgba = (...px: Array<[number, number, number, number]>): Uint8ClampedArray =>
  new Uint8ClampedArray(px.flat());

/** Saturation as the kernel measures it: extreme-channel spread, 0..1. */
const satOf = (d: Uint8ClampedArray, i = 0): number => {
  const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / 255;
};

describe('vibranceData', () => {
  it('is a no-op at zero', () => {
    const d = rgba([200, 100, 50, 255]);
    expect(Array.from(vibranceData(d, 0, 0))).toEqual([200, 100, 50, 255]);
  });

  it('boosts a muted pixel more than an already-saturated one', () => {
    // THE property of the effect, and the only reason it exists beside
    // Saturation. If this inverts, it is Saturation with extra steps.
    const muted = rgba([130, 120, 110, 255]);
    const vivid = rgba([250, 20, 10, 255]);
    const mBefore = satOf(muted), vBefore = satOf(vivid);

    const mAfter = satOf(vibranceData(muted, 60, 0));
    const vAfter = satOf(vibranceData(vivid, 60, 0));

    expect(mAfter - mBefore).toBeGreaterThan(vAfter - vBefore);
  });

  it('leaves a pure grey grey', () => {
    // A grey pixel has nothing to saturate — scaling around its own luma must
    // be a fixed point, not a drift toward a colour cast.
    const d = vibranceData(rgba([128, 128, 128, 255]), 100, 100);
    expect(d[0]).toBe(d[1]);
    expect(d[1]).toBe(d[2]);
  });

  it('desaturates toward grey, not toward black, at -100 saturation', () => {
    const d = vibranceData(rgba([200, 60, 30, 255]), 0, -100);
    const l = Math.round(luma(200, 60, 30));
    expect(Math.abs(d[0]! - l)).toBeLessThanOrEqual(1);
    expect(Math.abs(d[1]! - l)).toBeLessThanOrEqual(1);
    expect(Math.abs(d[2]! - l)).toBeLessThanOrEqual(1);
  });

  it('leaves fully transparent pixels byte-identical', () => {
    const d = rgba([200, 100, 50, 0]);
    expect(Array.from(vibranceData(d, 80, 80))).toEqual([200, 100, 50, 0]);
  });

  it('preserves alpha', () => {
    const d = vibranceData(rgba([200, 100, 50, 128]), 50, 20);
    expect(d[3]).toBe(128);
  });
});

describe('samplePalette', () => {
  const ramp = [
    { at: 0, rgb: [0, 0, 0] as const },
    { at: 1, rgb: [255, 255, 255] as const },
  ];

  it('hits the endpoints exactly', () => {
    expect(samplePalette(ramp, 0)).toEqual([0, 0, 0]);
    expect(samplePalette(ramp, 1)).toEqual([255, 255, 255]);
  });

  it('interpolates linearly between stops', () => {
    expect(samplePalette(ramp, 0.5)).toEqual([127.5, 127.5, 127.5]);
  });

  it('clamps outside 0..1 rather than extrapolating', () => {
    expect(samplePalette(ramp, -3)).toEqual([0, 0, 0]);
    expect(samplePalette(ramp, 9)).toEqual([255, 255, 255]);
  });

  it('survives an empty palette', () => {
    expect(samplePalette([], 0.5)).toEqual([0, 0, 0]);
  });
});

describe('COLORAMA_PALETTES', () => {
  it('has every palette sorted, spanning 0..1, and non-empty', () => {
    // The kernel's index arithmetic assumes sorted stops; an out-of-order
    // palette would sample the wrong segment and be almost impossible to spot.
    for (const p of COLORAMA_PALETTES) {
      expect(p.stops.length).toBeGreaterThan(1);
      expect(p.stops[0]!.at).toBe(0);
      expect(p.stops[p.stops.length - 1]!.at).toBe(1);
      for (let i = 1; i < p.stops.length; i++) {
        expect(p.stops[i]!.at).toBeGreaterThan(p.stops[i - 1]!.at);
      }
    }
  });

  it('keeps Spectrum cyclic so a phase animation loops', () => {
    // Its first and last stop must match, or a looping phase keyframe jumps.
    const spectrum = COLORAMA_PALETTES.find((p) => p.name === 'Spectrum')!;
    expect(spectrum.stops[0]!.rgb).toEqual(spectrum.stops[spectrum.stops.length - 1]!.rgb);
  });
});

describe('coloramaData', () => {
  const fire = COLORAMA_PALETTES[0]!.stops;
  const grey = (v: number) => rgba([v, v, v, 255]);

  it('maps luminance through the palette', () => {
    const black = coloramaData(grey(0), fire, 0, 1, 0);
    const bright = coloramaData(grey(250), fire, 0, 1, 0);
    expect(Array.from(black).slice(0, 3)).toEqual([0, 0, 0]);
    expect(bright[0]).toBeGreaterThan(200);
  });

  it('treats the cycle as a WHEEL — pure white wraps to the palette start', () => {
    // Deliberate, not an off-by-one. The output cycle is cyclic, which is what
    // lets a phase keyframe loop seamlessly; the price is that the single point
    // t = 1.0 lands back on t = 0.0. AE behaves the same way. Pinned here
    // because it looks like a bug at a glance and would otherwise get "fixed"
    // by clamping, which would break every looping phase animation.
    const white = coloramaData(grey(255), fire, 0, 1, 0);
    const black = coloramaData(grey(0), fire, 0, 1, 0);
    expect(Array.from(white)).toEqual(Array.from(black));
  });

  it('phase shifts the mapping', () => {
    const a = coloramaData(grey(128), fire, 0, 1, 0);
    const b = coloramaData(grey(128), fire, 90, 1, 0);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('wraps at 360° so a phase animation loops seamlessly', () => {
    // Clamping instead of wrapping makes a looping keyframe slam into the end
    // of the ramp and hold, which is the classic way this effect is broken.
    const at0 = coloramaData(grey(128), fire, 0, 1, 0);
    const at360 = coloramaData(grey(128), fire, 360, 1, 0);
    expect(Array.from(at360)).toEqual(Array.from(at0));
  });

  it('wraps NEGATIVE phase too', () => {
    // A keyframe scrubbing backwards produces this for real. `% 1` alone leaves
    // negatives negative, which walks off the front of the palette.
    const minus90 = coloramaData(grey(128), fire, -90, 1, 0);
    const plus270 = coloramaData(grey(128), fire, 270, 1, 0);
    expect(Array.from(minus90)).toEqual(Array.from(plus270));
  });

  it('blendWithOriginal 1 returns the source untouched', () => {
    const d = coloramaData(rgba([200, 100, 50, 255]), fire, 120, 3, 1);
    expect(Array.from(d)).toEqual([200, 100, 50, 255]);
  });

  it('blendWithOriginal 0 is the palette alone', () => {
    const full = coloramaData(grey(255), fire, 0, 1, 0);
    const half = coloramaData(grey(255), fire, 0, 1, 0.5);
    expect(Array.from(full)).not.toEqual(Array.from(half));
  });

  it('leaves fully transparent pixels alone and preserves alpha', () => {
    expect(Array.from(coloramaData(rgba([9, 9, 9, 0]), fire, 30, 1, 0))).toEqual([9, 9, 9, 0]);
    expect(coloramaData(rgba([120, 120, 120, 77]), fire, 30, 1, 0)[3]).toBe(77);
  });
});
