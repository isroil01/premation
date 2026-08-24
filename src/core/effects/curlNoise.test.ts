/**
 * Curl Noise — the property that justifies its existence beside Turbulent
 * Displace: the displacement field has ZERO divergence, so it swirls pixels
 * around one another instead of bunching and tearing them.
 */

import { curlNoiseData, curlNoiseField } from './warp';

const W = 40, H = 40;

function dots(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const on = x % 6 === 0 && y % 6 === 0;
    const i = (y * W + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = on ? 255 : 0;
    d[i + 3] = 255;
  }
  return d;
}

describe('curlNoiseField', () => {
  it('is divergence-free: ∂vx/∂x + ∂vy/∂y is zero to float error, everywhere inside', () => {
    const f = curlNoiseField(W, H, 20, 12, 3, 0);
    const vx = (x: number, y: number) => f[(y * W + x) * 2]!;
    const vy = (x: number, y: number) => f[(y * W + x) * 2 + 1]!;
    let maxDiv = 0, maxMag = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const div = (vx(x + 1, y) - vx(x - 1, y)) / 2 + (vy(x, y + 1) - vy(x, y - 1)) / 2;
      maxDiv = Math.max(maxDiv, Math.abs(div));
      maxMag = Math.max(maxMag, Math.hypot(vx(x, y), vy(x, y)));
    }
    expect(maxMag).toBeGreaterThan(1);       // the field is not trivially zero
    expect(maxDiv).toBeLessThan(1e-3);       // and it is divergence-free
  });

  it('scales swirl amplitude with amount, independent of feature size', () => {
    const mag = (amount: number, size: number) => {
      const f = curlNoiseField(W, H, amount, size, 3, 0);
      let m = 0;
      for (let i = 0; i < f.length; i += 2) m = Math.max(m, Math.hypot(f[i]!, f[i + 1]!));
      return m;
    };
    expect(mag(20, 12)).toBeGreaterThan(mag(10, 12) * 1.8);
    // Doubling the feature size must not halve the motion.
    const r = mag(10, 24) / mag(10, 12);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(2);
  });
});

describe('curlNoiseData', () => {
  it('is the identity at amount 0', () => {
    const src = dots();
    expect(Array.from(curlNoiseData(src, W, H, 0, 100, 3, 0))).toEqual(Array.from(src));
  });

  it('moves pixels, deterministically, and evolution changes the field', () => {
    const src = dots();
    const a = curlNoiseData(src, W, H, 6, 40, 3, 0);
    const b = curlNoiseData(src, W, H, 6, 40, 3, 0);
    const c = curlNoiseData(src, W, H, 6, 40, 3, 500);
    expect(Array.from(a)).not.toEqual(Array.from(src));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });
});
