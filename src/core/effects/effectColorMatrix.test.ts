import {
  effectColorMatrix,
  applyColorMatrix,
  applyColorMatrixImage,
  isColorEffect,
  IDENTITY_COLOR_MATRIX,
} from './effectColorMatrix';
import type { Effect } from './effects';

const fx = (type: Effect['type'], amount: number, enabled?: boolean): Effect =>
  ({ id: type, type, amount, ...(enabled === undefined ? {} : { enabled }) });

/** Apply a stack to a colour and round for stable comparison. */
function grade(effects: Effect[], rgb: [number, number, number], dp = 3): [number, number, number] {
  const [r, g, b] = applyColorMatrix(effectColorMatrix(effects), rgb);
  return [Number(r.toFixed(dp)), Number(g.toFixed(dp)), Number(b.toFixed(dp))];
}

describe('effectColorMatrix', () => {
  test('empty / non-colour stack → identity (colour unchanged)', () => {
    expect(effectColorMatrix([])).toBe(IDENTITY_COLOR_MATRIX);
    expect(grade([fx('blur', 10)], [0.2, 0.4, 0.6])).toEqual([0.2, 0.4, 0.6]);
  });

  test('brightness(200%) doubles rgb (clamped at 1)', () => {
    expect(grade([fx('brightness', 200)], [0.3, 0.4, 0.2])).toEqual([0.6, 0.8, 0.4]);
    expect(grade([fx('brightness', 200)], [0.7, 0, 0])).toEqual([1, 0, 0]); // clamp
  });

  test('invert(100%) flips each channel', () => {
    expect(grade([fx('invert', 100)], [0.2, 0.4, 0.9])).toEqual([0.8, 0.6, 0.1]);
  });

  test('invert(0%) is a no-op', () => {
    expect(grade([fx('invert', 0)], [0.2, 0.4, 0.9])).toEqual([0.2, 0.4, 0.9]);
  });

  test('contrast(100%) is identity; contrast pivots around 0.5', () => {
    expect(grade([fx('contrast', 100)], [0.25, 0.5, 0.75])).toEqual([0.25, 0.5, 0.75]);
    // contrast(200%): (v-0.5)*2 + 0.5
    expect(grade([fx('contrast', 200)], [0.5, 0.75, 0.25])).toEqual([0.5, 1, 0]);
  });

  test('grayscale(100%) collapses to luma (equal channels)', () => {
    const [r, g, b] = grade([fx('grayscale', 100)], [1, 0, 0], 4);
    expect(r).toBeCloseTo(0.2126, 3);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  test('saturate(0%) equals grayscale(100%)', () => {
    const c: [number, number, number] = [0.6, 0.2, 0.9];
    expect(grade([fx('saturate', 0)], c)).toEqual(grade([fx('grayscale', 100)], c));
  });

  test('hue-rotate(360°) ≈ identity', () => {
    const c: [number, number, number] = [0.4, 0.6, 0.2];
    const out = grade([fx('hue-rotate', 360)], c, 3);
    expect(out[0]).toBeCloseTo(0.4, 2);
    expect(out[1]).toBeCloseTo(0.6, 2);
    expect(out[2]).toBeCloseTo(0.2, 2);
  });

  test('sepia(100%) tints toward warm tones (r > g > b for grey)', () => {
    // Mid-grey so channels don't clamp at 1 (white would).
    const [r, g, b] = grade([fx('sepia', 100)], [0.5, 0.5, 0.5], 4);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  test('composes in stack order (brightness then invert ≠ invert then brightness)', () => {
    const c: [number, number, number] = [0.3, 0.3, 0.3];
    const a = grade([fx('brightness', 150), fx('invert', 100)], c);
    const b = grade([fx('invert', 100), fx('brightness', 150)], c);
    expect(a).not.toEqual(b);
  });

  test('skips disabled effects', () => {
    expect(grade([fx('invert', 100, false)], [0.2, 0.4, 0.9])).toEqual([0.2, 0.4, 0.9]);
  });

  test('isColorEffect distinguishes colour grades from spatial effects', () => {
    expect(isColorEffect('brightness')).toBe(true);
    expect(isColorEffect('hue-rotate')).toBe(true);
    expect(isColorEffect('hue-saturation')).toBe(true);
    expect(isColorEffect('blur')).toBe(false);
    expect(isColorEffect('drop-shadow')).toBe(false);
  });

  describe('Hue/Saturation (multi-param colour effect)', () => {
    const hueSat = (params: Record<string, number>): Effect => ({ id: 'hs', type: 'hue-saturation', params });

    test('is identity at defaults (0/0/0)', () => {
      const c: [number, number, number] = [0.6, 0.3, 0.1];
      expect(grade([hueSat({ hue: 0, saturation: 0, lightness: 0 })], c)).toEqual(c);
    });

    test('saturation −100 desaturates to luma-grey', () => {
      const [r, g, b] = grade([hueSat({ hue: 0, saturation: -100, lightness: 0 })], [1, 0, 0]);
      // Fully desaturated: all channels equal the Rec.709 luma of pure red (~0.213).
      expect(r).toBeCloseTo(g, 3);
      expect(g).toBeCloseTo(b, 3);
      expect(r).toBeCloseTo(0.2126, 2);
    });

    test('lightness scales value', () => {
      const [r] = grade([hueSat({ hue: 0, saturation: 0, lightness: 100 })], [0.4, 0.4, 0.4]);
      expect(r).toBeCloseTo(0.8, 3); // brightness ×2
    });

    test('hue rotates channels (red picks up other channels)', () => {
      const [r, g, b] = grade([hueSat({ hue: 120, saturation: 0, lightness: 0 })], [1, 0, 0]);
      // A 120° hue rotation moves pure red toward green.
      expect(g).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(b);
    });

    test('reads its own params, not a legacy amount', () => {
      // A hue-saturation with only saturation set still desaturates.
      const [r, g] = grade([hueSat({ saturation: -100 })], [0.9, 0.1, 0.1]);
      expect(r).toBeCloseTo(g, 3);
    });
  });

  describe('Tint (colour matrix, both backends)', () => {
    const tint = (mapBlack: string, mapWhite: string, amount: number): Effect =>
      ({ id: 'tint', type: 'tint', params: { mapBlack, mapWhite, amount } });

    test('is a colour effect', () => {
      expect(isColorEffect('tint')).toBe(true);
    });

    test('default black→white at 100% maps every pixel to its luma grey', () => {
      // mapBlack #000, mapWhite #fff ⇒ out_c = luma for all channels.
      const [r, g, b] = grade([tint('#000000', '#ffffff', 100)], [1, 0, 0], 4);
      expect(r).toBeCloseTo(0.2126, 3);
      expect(r).toBe(g);
      expect(g).toBe(b);
    });

    test('amount 0 is a no-op (fully original)', () => {
      const c: [number, number, number] = [0.3, 0.6, 0.9];
      expect(grade([tint('#000000', '#ffffff', 0)], c)).toEqual(c);
    });

    test('white maps to mapWhite, black maps to mapBlack', () => {
      const t = tint('#000000', '#ff0000', 100);
      expect(grade([t], [1, 1, 1])).toEqual([1, 0, 0]); // white → red
      expect(grade([t], [0, 0, 0])).toEqual([0, 0, 0]); // black → black
    });

    test('mapBlack lifts the shadows (black → mapBlack)', () => {
      // Map black→blue, white→white; pure black picks up the blue floor.
      const [r, g, b] = grade([tint('#0000ff', '#ffffff', 100)], [0, 0, 0]);
      expect(r).toBe(0);
      expect(g).toBe(0);
      expect(b).toBe(1);
    });
  });

  describe('Channel Mixer (colour matrix, both backends)', () => {
    const mix = (params: Record<string, number | boolean>): Effect =>
      ({ id: 'cm', type: 'channel-mixer', params });

    test('is a colour effect', () => {
      expect(isColorEffect('channel-mixer')).toBe(true);
    });

    test('is identity at defaults', () => {
      const c: [number, number, number] = [0.2, 0.5, 0.8];
      expect(grade([mix({ redRed: 100, greenGreen: 100, blueBlue: 100 })], c)).toEqual(c);
    });

    test('routes green input into the red output', () => {
      const [r] = grade([mix({ redRed: 0, redGreen: 100, greenGreen: 100, blueBlue: 100 })], [0.2, 0.8, 0.4]);
      expect(r).toBeCloseTo(0.8, 3);
    });

    test('a per-channel constant is added as an offset', () => {
      const [, , b] = grade([mix({ redRed: 100, greenGreen: 100, blueBlue: 100, blueConst: 50 })], [0.1, 0.1, 0.1]);
      expect(b).toBeCloseTo(0.6, 3); // 0.1 + 0.5
    });

    test('monochrome collapses every output to the red row', () => {
      const [r, g, b] = grade(
        [mix({ redRed: 30, redGreen: 59, redBlue: 11, monochrome: true })],
        [1, 0, 0],
        4,
      );
      expect(r).toBeCloseTo(0.3, 3);
      expect(r).toBe(g);
      expect(g).toBe(b);
    });
  });

  describe('applyColorMatrixImage (Canvas2D pixel pass)', () => {
    test('identity leaves RGB unchanged and never touches alpha', () => {
      const data = new Uint8ClampedArray([10, 20, 30, 128, 200, 100, 50, 255]);
      applyColorMatrixImage(data, IDENTITY_COLOR_MATRIX);
      expect(Array.from(data)).toEqual([10, 20, 30, 128, 200, 100, 50, 255]);
    });

    test('applies an invert matrix per pixel, alpha preserved', () => {
      const data = new Uint8ClampedArray([0, 128, 255, 77]);
      applyColorMatrixImage(data, effectColorMatrix([fx('invert', 100)]));
      expect(data[0]).toBe(255); // 0 → 255
      expect(data[1]).toBe(127); // 128 → 255-128
      expect(data[2]).toBe(0); // 255 → 0
      expect(data[3]).toBe(77); // alpha untouched
    });

    test('matches applyColorMatrix on the same colour', () => {
      const cm = effectColorMatrix([fx('brightness', 150)]);
      const data = new Uint8ClampedArray([100, 100, 100, 255]);
      applyColorMatrixImage(data, cm);
      const [r] = applyColorMatrix(cm, [100 / 255, 100 / 255, 100 / 255]);
      expect(data[0]).toBe(Math.round(r * 255));
    });
  });
});
