/**
 * Pixel Motion's flow half, on synthetic frames — the same test philosophy as
 * the tracker's: known motion in, recovered motion out, plus the contracts
 * that make the feature shippable (determinism, endpoint identity, honest
 * zero-flow on textureless input).
 */

import { computeFlow, lumaOf, sampleFlow, warpBlend, type FlowField } from './pixelMotionFlow';

const W = 96;
const H = 96;

/** RGBA frame of soft blobs at given centres — textured, band-limited, the
 *  kind of content block matching is meant for. */
function blobs(centres: Array<[number, number]>): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 20;
      for (const [cx, cy] of centres) {
        const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        v += 220 * Math.exp(-r2 / 60);
      }
      const o = (y * W + x) * 4;
      const c = Math.min(255, v);
      d[o] = d[o + 1] = d[o + 2] = c;
      d[o + 3] = 255;
    }
  }
  return d;
}

const CENTRES: Array<[number, number]> = [
  [20, 24], [70, 20], [30, 68], [64, 60], [48, 40],
];

const shift = (dx: number, dy: number): Array<[number, number]> =>
  CENTRES.map(([x, y]) => [x + dx, y + dy]);

function flowOf(dx: number, dy: number): FlowField {
  const a = lumaOf(blobs(CENTRES), W, H);
  const b = lumaOf(blobs(shift(dx, dy)), W, H);
  return computeFlow(a, b, W, H);
}

/** Mean flow over the central region (borders clamp and are allowed to sag). */
function meanFlow(f: FlowField): [number, number] {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 24; y < H - 24; y += 4) {
    for (let x = 24; x < W - 24; x += 4) {
      const [dx, dy] = sampleFlow(f, x, y);
      sx += dx;
      sy += dy;
      n++;
    }
  }
  return [sx / n, sy / n];
}

describe('computeFlow', () => {
  it('recovers a known translation to within a pixel', () => {
    const [mx, my] = meanFlow(flowOf(5, 3));
    expect(Math.abs(mx - 5)).toBeLessThan(1);
    expect(Math.abs(my - 3)).toBeLessThan(1);
  });

  it('recovers negative motion too', () => {
    const [mx, my] = meanFlow(flowOf(-4, 2));
    expect(Math.abs(mx + 4)).toBeLessThan(1);
    expect(Math.abs(my - 2)).toBeLessThan(1);
  });

  it('is deterministic — the same frames produce the identical field', () => {
    const f1 = flowOf(3, -2);
    const f2 = flowOf(3, -2);
    expect(Array.from(f1.dx)).toEqual(Array.from(f2.dx));
    expect(Array.from(f1.dy)).toEqual(Array.from(f2.dy));
  });

  it('identical frames report zero flow everywhere', () => {
    const f = flowOf(0, 0);
    for (let i = 0; i < f.dx.length; i++) {
      expect(f.dx[i]).toBe(0);
      expect(f.dy[i]).toBe(0);
    }
  });

  it('textureless frames report zero flow — the honest fallback', () => {
    const flat = new Float32Array(W * H).fill(128);
    const f = computeFlow(flat, flat, W, H);
    for (let i = 0; i < f.dx.length; i++) {
      expect(f.dx[i]).toBe(0);
      expect(f.dy[i]).toBe(0);
    }
  });
});

describe('warpBlend', () => {
  const a = blobs(CENTRES);
  const b = blobs(shift(6, 0));
  const flow = computeFlow(lumaOf(a, W, H), lumaOf(b, W, H), W, H);

  function warped(t: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(W * H * 4);
    warpBlend(a, b, W, H, flow, 1, 1, t, out);
    return out;
  }

  /** Luma-weighted centroid x of a frame — where the content "is". */
  function centroidX(d: Uint8ClampedArray): number {
    let sum = 0;
    let wsum = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = d[(y * W + x) * 4]! - 20; // subtract the background floor
        if (v > 0) {
          sum += v * x;
          wsum += v;
        }
      }
    }
    return sum / wsum;
  }

  it('t=0 reproduces frame A (up to bilinear rounding)', () => {
    const out = warped(0);
    let maxDiff = 0;
    for (let i = 0; i < out.length; i += 4) maxDiff = Math.max(maxDiff, Math.abs(out[i]! - a[i]!));
    expect(maxDiff).toBeLessThanOrEqual(2);
  });

  it('t=1 reproduces frame B', () => {
    const out = warped(1);
    let maxDiff = 0;
    for (let i = 0; i < out.length; i += 4) maxDiff = Math.max(maxDiff, Math.abs(out[i]! - b[i]!));
    expect(maxDiff).toBeLessThanOrEqual(2);
  });

  it('the in-between MOVES the content instead of double-exposing it', () => {
    const xa = centroidX(a);
    const xb = centroidX(b);
    const xm = centroidX(warped(0.5));
    // Halfway in position…
    expect(xm).toBeGreaterThan(xa + 1.5);
    expect(xm).toBeLessThan(xb - 1.5);
    // …and single-imaged: a cross-dissolve's peak is ~half the source's, a
    // motion-compensated frame keeps nearly full contrast.
    let peakMix = 0;
    let peakWarp = 0;
    const mid = warped(0.5);
    for (let i = 0; i < mid.length; i += 4) {
      peakWarp = Math.max(peakWarp, mid[i]!);
      peakMix = Math.max(peakMix, (a[i]! + b[i]!) / 2);
    }
    expect(peakWarp).toBeGreaterThan(peakMix + 20);
  });

  it('zero flow degrades exactly to Frame Mix', () => {
    const still = computeFlow(lumaOf(a, W, H), lumaOf(a, W, H), W, H);
    const out = new Uint8ClampedArray(W * H * 4);
    warpBlend(a, b, W, H, still, 1, 1, 0.5, out);
    for (let i = 0; i < out.length; i += 41 * 4) {
      expect(Math.abs(out[i]! - (a[i]! + b[i]!) / 2)).toBeLessThanOrEqual(1);
    }
  });
});
