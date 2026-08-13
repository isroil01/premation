/**
 * Correlation — the parameter that makes Roughen actually be AE's Wiggle Paths.
 *
 * ## Why this was almost built as a second operator
 *
 * "No Wiggle Paths" was recorded as an AE gap on the strength of a grep for
 * `wigglePath` returning zero hits. It returns zero because the operator is
 * STORED as `roughen` and only LABELLED "Wiggle Paths" (`PathOpControls`, and
 * the module header of `pathOps.ts` says so too). A whole second operator was
 * written before the label was noticed — two entries in one menu, both named
 * Wiggle Paths, which is the duplication rather than the fix.
 *
 * What was genuinely missing was one parameter. AE's Roughen displaces along
 * the normal with every point independent; AE's Wiggle Paths adds Correlation —
 * how alike neighbours move — and that is the whole character of the operator.
 * Without it, the thing carrying the name was the other effect.
 *
 * ## The assertion that matters
 *
 * `correlation` defaults to 0 and 0 is byte-identical to the pre-existing
 * output. A new parameter that re-shapes work already in a project is worse
 * than no parameter, so the no-op default is pinned first and separately.
 */

import { readSource } from '@/__testHelpers__/readSource';
import { roughen } from './pathOps';
import type { Pt } from './trimPath';

/** A closed square, subdivided enough for a wiggle to have somewhere to go. */
const SQUARE: Pt[] = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
];

/**
 * The subdivided-but-undisplaced outline.
 *
 * NOT `roughen(pts, closed, 0, detail)`: an amount of exactly 0 short-circuits
 * to `[...pts]` and never subdivides, so that baseline has 4 points against the
 * wiggled 16 and every index comparison reads the wrong point. A negligible
 * amount takes the real path and displaces by ~1e-12 px.
 */
const dense = (detail: number): Pt[] => roughen(SQUARE, true, 1e-12, detail, 0, 0, 0);

const spread = (pts: Pt[], base: Pt[]): number => {
  // Mean absolute deviation of each point from where it started — a proxy for
  // "how much the OUTLINE deformed", as opposed to how far it moved.
  const n = Math.min(pts.length, base.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.hypot(pts[i]!.x - base[i]!.x, pts[i]!.y - base[i]!.y);
  return sum / n;
};

describe('the no-op default', () => {
  it('omitting correlation reproduces the old output exactly', () => {
    const without = roughen(SQUARE, true, 8, 4, 0, 7);
    const explicitZero = roughen(SQUARE, true, 8, 4, 0, 7, 0);
    expect(explicitZero).toEqual(without);
  });

  it('holds while the wiggle is animating too', () => {
    for (const phase of [0, 0.25, 1, 3.7]) {
      expect(roughen(SQUARE, true, 8, 4, phase, 2, 0))
        .toEqual(roughen(SQUARE, true, 8, 4, phase, 2));
    }
  });
});

describe('correlation changes how neighbours move', () => {
  it('actually changes the result — it is not an ignored argument', () => {
    const loose = roughen(SQUARE, true, 10, 4, 0, 1, 0);
    const tight = roughen(SQUARE, true, 10, 4, 0, 1, 100);
    expect(tight).not.toEqual(loose);
  });

  it('at 100 every point takes the SAME displacement magnitude', () => {
    // Fully correlated ⇒ one shared value drives every point, so each moves by
    // |amount × shared| along its own normal. Distances are therefore equal.
    const base = dense(4);
    const out = roughen(SQUARE, true, 10, 4, 0, 3, 100);
    const dists = out.map((p, i) => Math.hypot(p.x - base[i]!.x, p.y - base[i]!.y));
    for (const d of dists) expect(d).toBeCloseTo(dists[0]!, 9);
    expect(dists[0]!).toBeGreaterThan(0); // and it did move
  });

  it('at 0 the displacements differ point to point', () => {
    const base = dense(4);
    const out = roughen(SQUARE, true, 10, 4, 0, 3, 0);
    const dists = out.map((p, i) => Math.hypot(p.x - base[i]!.x, p.y - base[i]!.y));
    const allSame = dists.every((d) => Math.abs(d - dists[0]!) < 1e-9);
    expect(allSame).toBe(false);
  });

  it('is monotone: more correlation means less point-to-point variation', () => {
    const base = dense(6);
    const variation = (c: number): number => {
      const out = roughen(SQUARE, true, 10, 6, 0, 5, c);
      const d = out.map((p, i) => Math.hypot(p.x - base[i]!.x, p.y - base[i]!.y));
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      return Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
    };
    expect(variation(100)).toBeLessThan(variation(50));
    expect(variation(50)).toBeLessThan(variation(0));
  });
});

describe('determinism survives the new parameter', () => {
  it('is a pure function of (points, amount, detail, phase, seed, correlation)', () => {
    const a = roughen(SQUARE, true, 9, 5, 1.5, 11, 40);
    const b = roughen(SQUARE, true, 9, 5, 1.5, 11, 40);
    expect(a).toEqual(b);
  });

  it('different seeds still decorrelate two layers at the same correlation', () => {
    expect(roughen(SQUARE, true, 9, 5, 0, 1, 60))
      .not.toEqual(roughen(SQUARE, true, 9, 5, 0, 2, 60));
  });

  it('a correlated wiggle still animates rather than snapping', () => {
    const base = dense(4);
    const at = (phase: number): number => spread(roughen(SQUARE, true, 10, 4, phase, 4, 80), base);
    // Neighbouring phases produce neighbouring shapes — the time cross-fade
    // applies to the shared field too, not only to the per-point one.
    expect(Math.abs(at(1.0) - at(1.02))).toBeLessThan(2);
  });

  it('clamps out-of-range correlation instead of extrapolating', () => {
    expect(roughen(SQUARE, true, 9, 5, 0, 1, 500)).toEqual(roughen(SQUARE, true, 9, 5, 0, 1, 100));
    expect(roughen(SQUARE, true, 9, 5, 0, 1, -20)).toEqual(roughen(SQUARE, true, 9, 5, 0, 1, 0));
  });
});

describe('it is reachable, and there is still only ONE Wiggle Paths', () => {

  it('the inspector exposes Correlation on the operator', () => {
    const ui = readSource('layout/Inspector/PathOpControls.tsx');
    expect(ui).toMatch(/param="correlation"/);
    expect(ui).toMatch(/label="Correlation"/);
  });

  it('is keyframeable, unlike seed', () => {
    const src = readSource('core/scene/pathOps.ts');
    const params = /export const PATHOP_PARAMS = \[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
    expect(params).toContain("'correlation'");
    expect(params).not.toContain("'seed'");
  });

  it('no second operator wears the same name', () => {
    const src = readSource('core/scene/pathOps.ts');
    const union = /export type PathOpType =([\s\S]*?);/.exec(src)?.[1] ?? '';
    expect(union).not.toContain('wigglePaths');
    const ui = readSource('layout/Inspector/PathOpControls.tsx');
    expect([...ui.matchAll(/label: 'Wiggle Paths'/g)]).toHaveLength(1);
  });
});
