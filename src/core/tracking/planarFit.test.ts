/**
 * RANSAC planar fit — the property under test is the one that justifies its
 * existence: a minority of wildly wrong correspondences (occlusion) must not
 * bend the recovered plane, where plain least squares provably bends.
 */

import { fitHomography, projectHomography } from '@motion/renderer';
import { fitHomographyRansac, densifyQuad, smoothHomographySequence } from './planarFit';

type P = { x: number; y: number };

/** A mild perspective warp, applied as ground truth. */
const TRUE_H = fitHomography(
  [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
  [{ x: 5, y: 8 }, { x: 108, y: 4 }, { x: 112, y: 106 }, { x: -2, y: 98 }],
)!;

const project = (p: P): P => projectHomography(TRUE_H, p)!;

/** A 4×4 lattice of source features. */
function lattice(): P[] {
  const out: P[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out.push({ x: c * 30 + 5, y: r * 30 + 5 });
  return out;
}

describe('fitHomographyRansac', () => {
  it('recovers the exact homography from clean correspondences', () => {
    const src = lattice();
    const dst = src.map(project);
    const fit = fitHomographyRansac(src, dst, { seed: 3 });
    expect(fit).not.toBeNull();
    expect(fit!.inlierCount).toBe(src.length);
    for (const s of src) {
      const p = projectHomography(fit!.H, s)!;
      const q = project(s);
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(0.1);
    }
  });

  it('outvotes gross outliers that drag a plain LS fit', () => {
    const src = lattice();
    const dst = src.map(project);
    // Occlude 4 of 16 features: they "track" a foreground object 80px away.
    for (const i of [2, 6, 7, 11]) {
      dst[i] = { x: dst[i]!.x + 80, y: dst[i]!.y - 60 };
    }

    const ransac = fitHomographyRansac(src, dst, { inlierPx: 3, seed: 5 })!;
    expect(ransac.inlierCount).toBe(12);
    expect(ransac.inliers[2]).toBe(false);
    expect(ransac.inliers[6]).toBe(false);

    // The RANSAC plane stays on ground truth…
    const corner = { x: 0, y: 0 };
    const truth = project(corner);
    const viaRansac = projectHomography(ransac.H, corner)!;
    expect(Math.hypot(viaRansac.x - truth.x, viaRansac.y - truth.y)).toBeLessThan(0.5);

    // …while the plain LS fit is measurably dragged by the occluders.
    const ls = fitHomography(src, dst)!;
    const viaLs = projectHomography(ls, corner)!;
    expect(Math.hypot(viaLs.x - truth.x, viaLs.y - truth.y)).toBeGreaterThan(2);
  });

  it('excludes zero-weight (coasted) points from the fit and the vote', () => {
    const src = lattice();
    const dst = src.map(project);
    // A coasted sample parked at garbage — weight 0 must make it invisible.
    dst[0] = { x: 9999, y: 9999 };
    const weights = src.map((_, i) => (i === 0 ? 0 : 1));
    const fit = fitHomographyRansac(src, dst, { seed: 2, weights })!;
    expect(fit.inliers[0]).toBe(false);
    expect(fit.inlierCount).toBe(src.length - 1);
  });

  it('degenerates to the direct fit with exactly four usable points', () => {
    const src: P[] = [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 90 }, { x: 0, y: 90 }];
    const dst = src.map(project);
    const fit = fitHomographyRansac(src, dst, { seed: 1 })!;
    expect(fit.inlierCount).toBe(4);
  });

  it('is deterministic for a given seed', () => {
    const src = lattice();
    const dst = src.map(project);
    dst[3] = { x: dst[3]!.x + 50, y: dst[3]!.y };
    const a = fitHomographyRansac(src, dst, { seed: 11 })!;
    const b = fitHomographyRansac(src, dst, { seed: 11 })!;
    expect(a.H).toEqual(b.H);
    expect(a.inliers).toEqual(b.inliers);
  });

  it('returns null below four usable correspondences', () => {
    const src: P[] = [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 90 }];
    const dst = src.map(project);
    expect(fitHomographyRansac(src, dst)).toBeNull();
  });
});

describe('densifyQuad', () => {
  it('keeps the handles and adds an interior lattice', () => {
    const quad = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
      { x: 50, y: 50 },
    ];
    const out = densifyQuad(quad, 5);
    expect(out.slice(0, 5)).toEqual(quad);
    expect(out.length).toBe(5 + 25);
    // Interior points stay strictly inside the quad.
    for (const p of out.slice(5)) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(100);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(100);
    }
  });
});

describe('smoothHomographySequence', () => {
  it('averages neighbouring Hs and preserves null gaps', () => {
    const H0 = TRUE_H;
    const H1 = fitHomography(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      [{ x: 6, y: 9 }, { x: 109, y: 5 }, { x: 113, y: 107 }, { x: -1, y: 99 }],
    )!;
    const smoothed = smoothHomographySequence([H0, H1, null], 1);
    expect(smoothed[0]).not.toBeNull();
    expect(smoothed[1]).not.toBeNull();
    expect(smoothed[2]).toBeNull();
    expect(smoothed[0]![8]).toBeCloseTo(1, 5);
  });
});
