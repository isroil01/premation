/**
 * Feature selection, tested on the four scenes it exists to tell apart:
 * a corner (trackable), an edge (slides), flat (nothing), and periodic
 * texture (looks trackable, is not).
 *
 * The last one is the whole reason `distinctness` exists, so it gets a test
 * that would still pass if the check were deleted — and one that would not.
 */

import {
  distinctnessAt,
  pickFeature,
  pickFeatures,
  suggestFeatureHalf,
} from './autoFeature';
import type { LumaPlane } from './patchMatch';

function plane(width: number, height: number, f: (x: number, y: number) => number): LumaPlane {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = f(x, y);
  }
  return { data, width, height };
}

/** Uint8 twin of `plane` — the shape the decoder's Y-plane fast path hands
 *  over, on a 0..255 scale the module must normalize away. */
function u8Plane(width: number, height: number, f: (x: number, y: number) => number): LumaPlane {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = Math.round(255 * f(x, y));
  }
  return { data, width, height };
}

const flat = () => 0.5;

/** A single hard corner: bright quadrant meeting dark, at (cx, cy). */
const corner = (cx: number, cy: number) => (x: number, y: number): number =>
  (x >= cx) === (y >= cy) ? 0.85 : 0.15;

/** A vertical edge — strong gradient in x, none in y. */
const edge = (ex: number) => (x: number): number => (x >= ex ? 0.85 : 0.15);

/** Checkerboard: every cell corner is a textbook Shi-Tomasi corner, and every
 *  one of them looks identical to every other. */
const checker = (cell: number) => (x: number, y: number): number =>
  (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0.85 : 0.15;

describe('pickFeature', () => {
  it('finds a corner and lands on it', () => {
    const p = plane(160, 160, corner(80, 80));
    const f = pickFeature(p, { hint: { x: 80, y: 80 }, radius: 40 });
    expect(f).not.toBeNull();
    expect(Math.hypot(f!.x - 80, f!.y - 80)).toBeLessThanOrEqual(6);
  });

  it('returns null on a flat region rather than the least-flat point', () => {
    expect(pickFeature(plane(160, 160, flat), { hint: { x: 80, y: 80 }, radius: 40 })).toBeNull();
  });

  it('prefers a corner over an edge of the same contrast', () => {
    // Corner on the left half, plain vertical edge on the right half. The
    // edge has the larger gradient SUM; only the min-eigenvalue separates them.
    const p = plane(320, 160, (x, y) => (x < 160 ? corner(80, 80)(x, y) : edge(240)(x)));
    const cornerPick = pickFeature(p, { hint: { x: 80, y: 80 }, radius: 50 })!;
    const edgePick = pickFeature(p, { hint: { x: 240, y: 80 }, radius: 50 });
    expect(cornerPick).not.toBeNull();
    // An edge is not a feature: either rejected outright, or scored well below.
    if (edgePick) expect(edgePick.strength).toBeLessThan(cornerPick.strength * 0.5);
  });

  it('snaps to the feature NEAR the hint, not the strongest in the frame', () => {
    // Weak corner near the hint, high-contrast corner far away.
    const p = plane(320, 160, (x, y) => {
      const near = (x >= 60) === (y >= 80) ? 0.55 : 0.45; // low contrast
      const far = (x >= 260) === (y >= 80) ? 1 : 0; // maximum contrast
      return x < 160 ? near : far;
    });
    const f = pickFeature(p, { hint: { x: 60, y: 80 }, radius: 50 })!;
    expect(f).not.toBeNull();
    expect(f.x).toBeLessThan(160);
  });

  it('reads Uint8 planes on the same scale as Float32 ones', () => {
    const f32 = pickFeature(plane(160, 160, corner(80, 80)), { hint: { x: 80, y: 80 }, radius: 40 })!;
    const u8 = pickFeature(u8Plane(160, 160, corner(80, 80)), { hint: { x: 80, y: 80 }, radius: 40 })!;
    expect(u8).not.toBeNull();
    // Same feature, and a strength within rounding distance — NOT 255² out.
    expect(Math.hypot(u8.x - f32.x, u8.y - f32.y)).toBeLessThanOrEqual(4);
    expect(u8.strength).toBeGreaterThan(f32.strength * 0.5);
    expect(u8.strength).toBeLessThan(f32.strength * 2);
  });
});

describe('distinctnessAt', () => {
  it('rates an isolated corner distinct', () => {
    const p = plane(200, 200, corner(100, 100));
    expect(distinctnessAt(p, 100, 100, 8, 60)).toBeGreaterThan(0.5);
  });

  it('rates a repeating checkerboard corner ambiguous', () => {
    // Cell 20 → identical corners every 40 px. Strength is high at all of
    // them; only self-correlation reveals that they are interchangeable.
    const p = plane(200, 200, checker(20));
    expect(distinctnessAt(p, 100, 100, 8, 60)).toBeLessThan(0.2);
  });

  it('cannot report ambiguity when the probe radius overlaps the patch', () => {
    const p = plane(200, 200, checker(20));
    expect(distinctnessAt(p, 100, 100, 8, 10)).toBe(1);
  });
});

describe('suggestFeatureHalf', () => {
  it('picks a small window for a sharp feature', () => {
    const p = plane(200, 200, corner(100, 100));
    expect(suggestFeatureHalf(p, 100, 100)).toBeLessThanOrEqual(10);
  });

  it('picks a larger window for a soft, low-frequency feature', () => {
    // A wide gaussian blob: its gradient is spread over ~30 px, so a 13×13
    // window sees almost no structure and a big one sees the whole slope.
    const p = plane(200, 200, (x, y) =>
      0.2 + 0.7 * Math.exp(-((x - 100) ** 2 + (y - 100) ** 2) / (2 * 18 ** 2)));
    const soft = suggestFeatureHalf(p, 100 - 18, 100 - 18);
    const sharp = suggestFeatureHalf(plane(200, 200, corner(100, 100)), 100, 100);
    expect(soft).toBeGreaterThan(sharp);
  });

  it('falls back to the scan window when there is nothing to measure', () => {
    expect(suggestFeatureHalf(plane(200, 200, flat), 100, 100)).toBe(8);
  });
});

describe('pickFeatures', () => {
  it('spreads picks across the frame instead of clustering on one object', () => {
    // Four corners of contrast, one per quadrant, plus a cluster of six extra
    // corners in the top-left. A strength-only ranking returns the cluster.
    const spots = [
      { x: 120, y: 120 }, { x: 400, y: 120 }, { x: 120, y: 400 }, { x: 400, y: 400 },
      { x: 100, y: 100 }, { x: 140, y: 100 }, { x: 100, y: 140 },
      { x: 140, y: 140 }, { x: 160, y: 120 }, { x: 120, y: 160 },
    ];
    const p = plane(520, 520, (x, y) => {
      for (const s of spots) {
        if (Math.abs(x - s.x) < 24 && Math.abs(y - s.y) < 24) return corner(s.x, s.y)(x, y);
      }
      return 0.5;
    });
    const picks = pickFeatures(p, 4, { tile: 200 });
    expect(picks.length).toBeGreaterThanOrEqual(3);
    // No two picks in the same tile → they cannot all be the one cluster.
    const tiles = new Set(picks.map((f) => `${Math.floor(f.x / 200)},${Math.floor(f.y / 200)}`));
    expect(tiles.size).toBe(picks.length);
  });

  it('returns nothing on a featureless frame', () => {
    expect(pickFeatures(plane(400, 400, flat), 4)).toEqual([]);
  });

  it('asks for none, gets none, and does no work', () => {
    expect(pickFeatures(plane(400, 400, corner(200, 200)), 0)).toEqual([]);
  });
});
