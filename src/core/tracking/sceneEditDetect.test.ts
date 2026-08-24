/**
 * Scene Edit Detection — the pure half.
 *
 * Synthetic planes with known cuts; the detector must find exactly those and
 * nothing else. The failure modes it is built against each get a case: a
 * fast pan (large motion, no cut), a flash frame (two spikes a frame apart),
 * and a dark scene (where absolute thresholds under-fire).
 */

import { lumaHistogram, histogramDistance, cutsFromDistances, walkSceneEdits } from './sceneEditDetect';
import type { LumaPlane } from './patchMatch';

const W = 64, H = 36;

/** A flat plane at one luma, with mild per-pixel noise so histograms are not degenerate. */
function flat(luma: number, seed = 1): LumaPlane {
  const data = new Uint8Array(W * H);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = Math.max(0, Math.min(255, luma + ((s % 9) - 4)));
  }
  return { data, width: W, height: H };
}

/** A horizontal gradient, shifted by `offset` px — what a pan looks like. */
function gradient(offset: number): LumaPlane {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    data[y * W + x] = ((x + offset) * 4) & 255;
  }
  return { data, width: W, height: H };
}

describe('histogram', () => {
  it('is normalised and identical planes have zero distance', () => {
    const h = lumaHistogram(flat(120));
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(histogramDistance(h, lumaHistogram(flat(120)))).toBe(0);
  });

  it('puts a hard cut far above ordinary motion', () => {
    const cut = histogramDistance(lumaHistogram(flat(40)), lumaHistogram(flat(200)));
    const pan = histogramDistance(lumaHistogram(gradient(0)), lumaHistogram(gradient(3)));
    expect(cut).toBeGreaterThan(1.5);
    expect(pan).toBeLessThan(0.2);
  });
});

describe('cutsFromDistances', () => {
  it('finds a lone spike and reports the first frame of the new shot', () => {
    const d = Array(40).fill(0.05);
    d[19] = 1.4; // between frame 19 and 20 → frame 20 starts the new shot
    expect(cutsFromDistances(d)).toEqual([20]);
  });

  it('ignores a spike below the absolute floor, whatever the median', () => {
    const d = Array(40).fill(0.0);
    d[10] = 0.2;
    expect(cutsFromDistances(d)).toEqual([]);
  });

  it('adapts to a noisy clip: a handheld floor of 0.3 does not fire on every frame', () => {
    const d = Array(60).fill(0).map((_, i) => 0.28 + (i % 3) * 0.02);
    d[30] = 1.6;
    expect(cutsFromDistances(d)).toEqual([31]);
  });

  it('collapses a flash frame (two spikes a frame apart) into one cut', () => {
    const d = Array(40).fill(0.05);
    d[19] = 1.2; d[20] = 1.5;
    expect(cutsFromDistances(d)).toHaveLength(1);
  });

  it('finds several well-separated cuts', () => {
    const d = Array(120).fill(0.08);
    d[29] = 1.1; d[59] = 1.3; d[89] = 0.9;
    expect(cutsFromDistances(d)).toEqual([30, 60, 90]);
  });
});

describe('walkSceneEdits', () => {
  it('walks a synthetic clip with two cuts and a pan, and finds only the cuts', async () => {
    const frames: LumaPlane[] = [];
    for (let i = 0; i < 30; i++) frames.push(flat(60, i));          // shot A, dark
    for (let i = 0; i < 30; i++) frames.push(gradient(i * 2));       // shot B, panning
    for (let i = 0; i < 30; i++) frames.push(flat(210, i));         // shot C, bright
    const pulled: number[] = [];
    const r = await walkSceneEdits({
      frameAt: async (i) => { pulled.push(i); return frames[i]!; },
      fromFrame: 0,
      toFrame: 89,
    });
    expect(r.status).toBe('completed');
    expect(r.cuts).toEqual([30, 60]);
    // Strictly sequential, each frame once — the decoder's GOP cache depends on it.
    expect(pulled).toEqual(Array.from({ length: 90 }, (_, i) => i));
  });

  it('offsets cuts by fromFrame and honours cancel', async () => {
    const frames: LumaPlane[] = [];
    for (let i = 0; i < 20; i++) frames.push(flat(60, i));
    for (let i = 0; i < 20; i++) frames.push(flat(200, i));
    const r = await walkSceneEdits({
      frameAt: async (i) => frames[i - 100]!,
      fromFrame: 100,
      toFrame: 139,
      onProgress: (f) => f < 0.9,
    });
    expect(r.status).toBe('cancelled');
    expect(r.cuts).toEqual([120]);
  });
});

describe('dissolves', () => {
  it('finds a cross-fade at its midpoint, and not a pan that wanders back', async () => {
    // Shot A (dark) → 20-frame cross-fade → shot B (bright). A real dissolve
    // is a MIX of the two pictures, so its histogram is a blend of theirs:
    // each pixel comes from A or B with probability following the fade.
    const A = flat(50, 1), B = flat(200, 2);
    const mix = (alpha: number, seed: number): LumaPlane => {
      const data = new Uint8Array(W * H);
      let s = seed * 7919 + 13;
      for (let i = 0; i < data.length; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (s % 1000) / 1000 < alpha ? B.data[i]! : A.data[i]!;
      }
      return { data, width: W, height: H };
    };
    const frames: LumaPlane[] = [];
    for (let i = 0; i < 20; i++) frames.push(flat(50, i));
    for (let k = 1; k <= 20; k++) frames.push(mix(k / 21, k));
    for (let i = 0; i < 20; i++) frames.push(flat(200, i));
    const r = await walkSceneEdits({ frameAt: async (i) => frames[i]!, fromFrame: 0, toFrame: 59 });
    expect(r.dissolveCuts).toHaveLength(1);
    expect(r.dissolveCuts[0]).toBeGreaterThan(24);
    expect(r.dissolveCuts[0]).toBeLessThan(36);
    expect(r.cuts).toEqual(r.dissolveCuts); // no hard cut was invented

    // A pan that drifts out and back: plenty of accumulated change, no dissolve.
    const pan: LumaPlane[] = [];
    for (let i = 0; i < 60; i++) pan.push(gradient(Math.round(12 * Math.sin(i / 8))));
    const p = await walkSceneEdits({ frameAt: async (i) => pan[i]!, fromFrame: 0, toFrame: 59 });
    expect(p.dissolveCuts).toEqual([]);
  });

  it('does not double-report a hard cut as a dissolve', async () => {
    const frames: LumaPlane[] = [];
    for (let i = 0; i < 30; i++) frames.push(flat(50, i));
    for (let i = 0; i < 30; i++) frames.push(flat(200, i));
    const r = await walkSceneEdits({ frameAt: async (i) => frames[i]!, fromFrame: 0, toFrame: 59 });
    expect(r.cuts).toEqual([30]);
    expect(r.dissolveCuts).toEqual([]);
  });
});
