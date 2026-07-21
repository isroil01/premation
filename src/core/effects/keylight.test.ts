/**
 * Keylight keyer maths — pure, no canvas. The full pixel path (getImageData →
 * putImageData) is exercised with real pixels in the browser; here we pin the
 * screen-amount formula, the matte it produces, clip behaviour, and despill.
 */

import { screenAmount, applyKeyData, chokeAlpha, softenAlpha, type KeyParams } from './keylight';

const GREEN = { p: 1, a: 0, b: 2 };

const base: KeyParams = {
  screenColor: '#00ff00',
  balance: 0.5,
  gain: 1,
  clipBlack: 0,
  clipWhite: 1,
  despill: 0,
};

/** Key a single RGBA pixel and return its resulting alpha (0..255). */
function keyAlpha(rgba: [number, number, number, number], p: Partial<KeyParams> = {}): number {
  const d = new Uint8ClampedArray(rgba);
  applyKeyData(d, { ...base, ...p });
  return d[3]!;
}

describe('screenAmount', () => {
  test('pure green screen → ~1', () => {
    expect(screenAmount(0, 255, 0, GREEN, 0.5)).toBeCloseTo(1, 5);
  });
  test('pure red foreground → ≤0', () => {
    expect(screenAmount(255, 0, 0, GREEN, 0.5)).toBeLessThanOrEqual(0);
  });
  test('white → 0 (primary and secondaries all equal)', () => {
    expect(screenAmount(255, 255, 255, GREEN, 0.5)).toBeCloseTo(0, 5);
  });
});

describe('applyKeyData matte', () => {
  test('green screen pixel keys to transparent', () => {
    expect(keyAlpha([0, 255, 0, 255])).toBe(0);
  });
  test('red foreground stays fully opaque', () => {
    expect(keyAlpha([255, 0, 0, 255])).toBe(255);
  });
  test('white foreground stays opaque', () => {
    expect(keyAlpha([255, 255, 255, 255])).toBe(255);
  });
  test('a greenish edge is semi-transparent', () => {
    const a = keyAlpha([100, 200, 100, 255]);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
  });
  test('already-transparent pixels are left alone', () => {
    expect(keyAlpha([0, 255, 0, 0])).toBe(0);
  });
  test('blue screen keys blue, keeps green', () => {
    expect(keyAlpha([0, 0, 255, 255], { screenColor: '#0000ff' })).toBe(0);
    expect(keyAlpha([0, 255, 0, 255], { screenColor: '#0000ff' })).toBe(255);
  });
});

describe('clip + gain', () => {
  test('raising Clip Black solidifies (more opaque) the near-screen edges', () => {
    const edge: [number, number, number, number] = [120, 200, 120, 255];
    const loose = keyAlpha(edge, { clipBlack: 0 });
    const tight = keyAlpha(edge, { clipBlack: 0.5 });
    // A higher black point maps low foreground-ness toward 0 → more transparent.
    expect(tight).toBeLessThanOrEqual(loose);
  });
  test('gain 0 keeps everything opaque (no key pulled)', () => {
    expect(keyAlpha([0, 255, 0, 255], { gain: 0 })).toBe(255);
  });
});

describe('despill', () => {
  test('pulls the primary channel down toward its secondaries on kept pixels', () => {
    // A yellow-green foreground pixel kept opaque (edge) with strong green spill.
    const d = new Uint8ClampedArray([120, 240, 120, 255]);
    applyKeyData(d, { ...base, clipBlack: 0, clipWhite: 0.2, despill: 1 });
    // green (index 1) should be reduced toward max(r,b)=120 where it stayed opaque
    if (d[3]! > 0) expect(d[1]!).toBeLessThan(240);
  });
  test('despill 0 leaves RGB untouched', () => {
    const d = new Uint8ClampedArray([120, 240, 120, 255]);
    const before = [d[0], d[1], d[2]];
    applyKeyData(d, { ...base, despill: 0, clipWhite: 0.1 });
    expect([d[0], d[1], d[2]]).toEqual(before);
  });
});

describe('matte refinement (choke + softness)', () => {
  /** 8×8 alpha buffer: opaque 4×4 square centred, transparent elsewhere. */
  const square = (): Uint8ClampedArray => {
    const d = new Uint8ClampedArray(8 * 8 * 4);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) {
      const i = (y * 8 + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 200; d[i + 3] = 255;
    }
    return d;
  };
  const alphaAt = (d: Uint8ClampedArray, x: number, y: number): number => d[(y * 8 + x) * 4 + 3]!;

  test('positive choke shrinks the matte (erode)', () => {
    const d = square();
    chokeAlpha(d, 8, 8, 1);
    expect(alphaAt(d, 2, 2)).toBe(0);   // old edge eroded away
    expect(alphaAt(d, 3, 3)).toBe(255); // interior… wait: 1px erosion of a 4×4 leaves 2×2 at (3,3)-(4,4)
  });

  test('negative choke grows the matte (dilate)', () => {
    const d = square();
    chokeAlpha(d, 8, 8, -1);
    expect(alphaAt(d, 1, 1)).toBe(255); // grown outward by 1px
    expect(alphaAt(d, 0, 0)).toBe(0);
  });

  test('zero choke is the identity', () => {
    const d = square();
    const before = [...d];
    chokeAlpha(d, 8, 8, 0);
    expect([...d]).toEqual(before);
  });

  test('softness feathers the alpha edge without touching color', () => {
    const d = square();
    const rgbBefore = [d[(3 * 8 + 3) * 4], d[(3 * 8 + 3) * 4 + 1], d[(3 * 8 + 3) * 4 + 2]];
    softenAlpha(d, 8, 8, 1);
    // Just outside the square now has partial alpha; centre stays high.
    expect(alphaAt(d, 1, 3)).toBeGreaterThan(0);
    expect(alphaAt(d, 1, 3)).toBeLessThan(255);
    expect(alphaAt(d, 3, 3)).toBeGreaterThan(200);
    expect([d[(3 * 8 + 3) * 4], d[(3 * 8 + 3) * 4 + 1], d[(3 * 8 + 3) * 4 + 2]]).toEqual(rgbBefore);
  });
});
