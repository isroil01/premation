/**
 * Warp effects — pure-data tests (no canvas): wave warp displaces along the
 * chosen axis by a sine, turbulent displace by a smooth deterministic noise
 * field; both preserve buffers at zero strength and never invent alpha.
 */

import { waveWarpData, turbulentDisplaceData } from './warp';

/** A w×h RGBA buffer with a single opaque white column at x = `col`. */
function columnBuffer(w: number, h: number, col: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const i = (y * w + col) * 4;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = 255;
  }
  return d;
}

function alphaAt(d: Uint8ClampedArray, w: number, x: number, y: number): number {
  return d[(y * w + x) * 4 + 3]!;
}

describe('waveWarpData', () => {
  test('zero height is the identity', () => {
    const src = columnBuffer(16, 16, 8);
    expect([...waveWarpData(src, 16, 16, 0, 50, 90, 0)]).toEqual([...src]);
  });

  test('a horizontal wave bends a straight column', () => {
    const w = 32;
    const h = 32;
    const src = columnBuffer(w, h, 16);
    // Displace along x (direction 0°? no: direction is the displacement axis —
    // use 0° = horizontal displacement, wave running down the column).
    const out = waveWarpData(src, w, h, 6, 16, 0, 0);
    // The column must still exist somewhere on every row…
    for (let y = 0; y < h; y++) {
      let rowMax = 0;
      for (let x = 0; x < w; x++) rowMax = Math.max(rowMax, alphaAt(out, w, x, y));
      expect(rowMax).toBeGreaterThan(100);
    }
    // …but not at the same x on every row (it bends).
    const xOfMax = (y: number): number => {
      let best = 0;
      let bx = 0;
      for (let x = 0; x < w; x++) {
        const a = alphaAt(out, w, x, y);
        if (a > best) { best = a; bx = x; }
      }
      return bx;
    };
    const positions = new Set<number>();
    for (let y = 0; y < h; y++) positions.add(xOfMax(y));
    expect(positions.size).toBeGreaterThan(1);
  });

  test('phase shifts the wave (animation axis)', () => {
    const src = columnBuffer(32, 32, 16);
    const a = waveWarpData(src, 32, 32, 6, 16, 0, 0);
    const b = waveWarpData(src, 32, 32, 6, 16, 0, 90);
    expect([...a]).not.toEqual([...b]);
  });
});

describe('turbulentDisplaceData', () => {
  test('zero amount is the identity', () => {
    const src = columnBuffer(16, 16, 8);
    expect([...turbulentDisplaceData(src, 16, 16, 0, 100, 2, 0)]).toEqual([...src]);
  });

  test('deterministic: same inputs, same output', () => {
    const src = columnBuffer(24, 24, 12);
    const a = turbulentDisplaceData(src, 24, 24, 8, 40, 2, 5);
    const b = turbulentDisplaceData(src, 24, 24, 8, 40, 2, 5);
    expect([...a]).toEqual([...b]);
  });

  test('evolution churns the field', () => {
    const src = columnBuffer(24, 24, 12);
    const a = turbulentDisplaceData(src, 24, 24, 8, 40, 2, 0);
    const b = turbulentDisplaceData(src, 24, 24, 8, 40, 2, 500);
    expect([...a]).not.toEqual([...b]);
  });

  test('displacement moves pixels', () => {
    const src = columnBuffer(24, 24, 12);
    const out = turbulentDisplaceData(src, 24, 24, 10, 20, 2, 0);
    expect([...out]).not.toEqual([...src]);
  });
});
