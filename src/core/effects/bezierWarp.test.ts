/**
 * Bezier Warp geometry — the Coons patch and its numeric inverse.
 *
 * Every expected coordinate is derived on paper first, from the patch algebra
 * written out below, and NONE of it is read back from the implementation.
 *
 * ── The derivation the whole file rests on ──────────────────────────────
 *
 * Take a `w`×`h` patch at rest and move ONLY the top edge's two handles down
 * by `k`. The top curve's control points in x stay evenly spaced (0, w/3,
 * 2w/3, w), which is the linear parameterisation, so:
 *
 *   Ctop(u) = ( w·u , bez(0, k, k, 0, u) ) = ( w·u , 3k·u(1−u) )
 *
 * The other three edges are at rest, so Cbot(u) = (w·u, h), Cleft(v) = (0, h·v)
 * and Cright(v) = (w, h·v), and the bilinear corner term is exactly (u·w, v·h).
 * Substituting into S = ruled_v + ruled_u − bilinear, the x terms cancel to w·u
 * and the v·h terms cancel once, leaving:
 *
 *   S(u,v) = ( w·u , v·h + 3k·u(1−u)(1−v) )
 *
 * That single closed form is what every top-edge expectation below is read off.
 *
 * ── What the clean values exclude (rule 3a) ─────────────────────────────
 *
 * The main case moves BOTH top handles by the SAME k, which is what makes the
 * displacement collapse to the tidy 3k·u(1−u). Three things become unreachable
 * as a direct consequence, and each gets its own fixture:
 *
 *   • x is never displaced (S.x = w·u identically), so any error in the X
 *     mapping is invisible          → the LEFT-edge fixture, which moves x only
 *   • the displacement is symmetric in u about ½, so swapping the two handles,
 *     or averaging them, changes nothing → the ASYMMETRIC single-handle fixture
 *   • something is always deformed, so an identity patch that quietly resamples
 *     is invisible                  → the REST fixture
 *
 * Asking "is the boundary inert?" would have found only the third. The question
 * that finds all three is what the fixture's values can never produce.
 */

import {
  defaultWarpPoints,
  coonsPoint,
  coonsJacobian,
  solveUV,
  isRestWarp,
  type WarpPoints,
  type WarpPt,
} from './bezierWarp';

const W = 100;
const H = 100;

/** Rest points with a few entries replaced, by index. */
function warp(over: Record<number, WarpPt>): WarpPoints {
  const p = defaultWarpPoints(W, H).map((q) => ({ ...q }));
  for (const [i, v] of Object.entries(over)) p[Number(i)] = v;
  return p as unknown as WarpPoints;
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const at = (p: WarpPoints, u: number, v: number): [number, number] => {
  const q = coonsPoint(p, u, v);
  return [r6(q.x), r6(q.y)];
};
/** Expected points go through the SAME rounding — otherwise a tidy expectation
 *  like 100/3 fails against its own value at the 16th decimal. */
const pt = (x: number, y: number): [number, number] => [r6(x), r6(y)];

describe('the patch at rest is the IDENTITY', () => {
  /**
   * BOUNDARY, and the one every other case excludes by construction.
   *
   * At rest each edge's controls are evenly spaced along a straight line, and a
   * cubic with controls at 0, w/3, 2w/3, w is exactly B(t) = t·w. So the patch
   * must be (u·w, v·h) — not approximately, exactly. An effect whose default
   * quietly resamples its own input loses a fraction of a pixel of sharpness on
   * every layer that carries it, which is invisible until someone stacks two.
   */
  it('maps the unit square onto the layer box exactly', () => {
    const p = defaultWarpPoints(W, H);
    const cases: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0.25, 0.75], [1 / 3, 2 / 3]];
    for (const [u, v] of cases) {
      expect(at(p, u, v)).toEqual(pt(u * W, v * H));
    }
  });

  it('is recognised as rest, so the effect can skip the resample', () => {
    expect(isRestWarp(defaultWarpPoints(W, H), W, H)).toBe(true);
    expect(isRestWarp(warp({ 1: { x: W / 3, y: 1 } }), W, H)).toBe(false);
  });

  it('inverts to the point it came from', () => {
    const p = defaultWarpPoints(W, H);
    expect(solveUV(p, { x: 25, y: 75 }, W, H)).toEqual({ u: 0.25, v: 0.75 });
  });
});

describe('one edge bent — the top, both handles down by k', () => {
  //   S(u,v) = ( w·u , v·h + 3k·u(1−u)(1−v) ) , with k = 40, w = h = 100.
  const K = 40;
  const p = warp({ 1: { x: W / 3, y: K }, 2: { x: (2 * W) / 3, y: K } });

  it('bows the top edge DOWN by 3k/4 at its midpoint — a signed, absolute fact', () => {
    // v = 0, u = ½ : y = 0 + 3·40·¼·1 = 30. Down is +y here.
    //
    // DIRECTIONAL. A mirrored implementation bows the edge UP and lands on −30,
    // and "the geometry changed" or "it differs from rest" would pass either
    // way — the mistake Spherize shipped with.
    expect(at(p, 0.5, 0)).toEqual([50, 30]);
    // A quarter along: 3·40·0.25·0.75 = 22.5.
    expect(at(p, 0.25, 0)).toEqual([25, 22.5]);
  });

  it('leaves the other three edges exactly where they were', () => {
    expect(at(p, 0.5, 1)).toEqual([50, 100]);   // bottom, untouched
    expect(at(p, 0, 0.5)).toEqual([0, 50]);     // left, untouched
    expect(at(p, 1, 0.5)).toEqual([100, 50]);   // right, untouched
    // And the corners, which belong to two edges each.
    expect(at(p, 0, 0)).toEqual([0, 0]);
    expect(at(p, 1, 0)).toEqual([100, 0]);
  });

  it('decays the displacement linearly toward the far edge', () => {
    // The (1−v) factor. At the halfway line: 3·40·¼·½ = 15, so y = 50 + 15.
    expect(at(p, 0.5, 0.5)).toEqual([50, 65]);
    // Three-quarters down: base 0.75·100 = 75, plus 3·40·¼·¼ = 7.5.
    expect(at(p, 0.5, 0.75)).toEqual([50, 82.5]);
  });

  it('never displaces x — the interior slides along the axis only', () => {
    for (const v of [0, 0.25, 0.5, 1]) expect(at(p, 0.3, v)[0]).toBe(30);
  });

  it('the INVERSE finds the point the forward map sent there', () => {
    const uv = solveUV(p, { x: 50, y: 30 }, W, H)!;
    expect(uv.u).toBeCloseTo(0.5, 6);
    expect(uv.v).toBeCloseTo(0, 6);
    const uv2 = solveUV(p, { x: 50, y: 65 }, W, H)!;
    expect(uv2.u).toBeCloseTo(0.5, 6);
    expect(uv2.v).toBeCloseTo(0.5, 6);
  });

  it('reports NOTHING above the bowed edge, rather than clamping to it', () => {
    // At u = ½ the patch now starts at y = 30, so (50, 0) has no pre-image.
    // Clamping instead would smear the top row downward into a streak.
    expect(solveUV(p, { x: 50, y: 0 }, W, H)).toBeNull();
    // Whereas the corner, which did not move, is still covered.
    expect(solveUV(p, { x: 0, y: 0 }, W, H)).not.toBeNull();
  });

  /**
   * The same coverage question with the bow REVERSED, which is what makes the
   * pair directional.
   *
   * The comment above originally claimed the down-bow's null was itself a
   * directional assertion — that a mirrored implementation would cover (50, 0).
   * Attempting to demonstrate that by mirroring the source did not show it,
   * because mirroring `coonsPoint` alone leaves the Jacobian inconsistent and
   * the null then comes from Newton failing to converge rather than from the
   * geometry. So the claim is made HERE instead, as data rather than prose:
   * handles moved UP by k put the top boundary at y = −30, and (50, 0) is then
   * inside the patch. Down-bow excludes it, up-bow includes it — which no
   * mirrored implementation can satisfy both halves of.
   */
  it('DIRECTION: the same point is covered when the bow is reversed', () => {
    const up = warp({ 1: { x: W / 3, y: -K }, 2: { x: (2 * W) / 3, y: -K } });
    expect(at(up, 0.5, 0)).toEqual([50, -30]);
    expect(solveUV(up, { x: 50, y: 0 }, W, H)).not.toBeNull();
    expect(solveUV(up, { x: 50, y: -20 }, W, H)).not.toBeNull();
    // And below the unmoved bottom edge is still outside, both ways round.
    expect(solveUV(up, { x: 50, y: 140 }, W, H)).toBeNull();
  });
});

describe('BOUNDARY — the left edge, which the top-edge case cannot reach', () => {
  /**
   * The mirror derivation. Moving the two LEFT handles right by `j` gives
   *
   *   S(u,v) = ( w·u + 3j·v(1−v)(1−u) , v·h )
   *
   * so the displacement is in X, where the top-edge case's was in Y and its X
   * was identically w·u. An implementation that read only the top and bottom
   * curves, or that applied both edges' contributions to one axis, passes every
   * assertion in the block above and fails here.
   */
  const J = 40;
  const p = warp({ 10: { x: J, y: (2 * H) / 3 }, 11: { x: J, y: H / 3 } });

  it('bows the left edge RIGHT by 3j/4 at its midpoint', () => {
    expect(at(p, 0, 0.5)).toEqual([30, 50]);
    expect(at(p, 0, 0.25)).toEqual([22.5, 25]);
  });

  it('displaces X and leaves Y alone — the opposite axis to the top case', () => {
    expect(at(p, 0.5, 0.5)).toEqual([50 + 15, 50]);
    for (const u of [0, 0.25, 0.5, 1]) expect(at(p, u, 0.3)[1]).toBe(30);
  });

  it('leaves the right edge untouched', () => {
    expect(at(p, 1, 0.5)).toEqual([100, 50]);
  });
});

describe('BOUNDARY — one handle only, which the symmetric case cannot reach', () => {
  /**
   * Moving BOTH top handles by k makes the displacement 3k·u(1−u), which is
   * symmetric about u = ½. Swap the two handles, average them, or apply the
   * first one twice, and every number in the main block is unchanged.
   *
   * With only the FIRST handle moved the curve is bez(0, k, 0, 0, u) =
   * 3k·u(1−u)², which is not symmetric:
   *
   *   u = ⅓ : 3k·(⅓)(⅔)² = 3k·(4/27) = 4k/9  = 40   (k = 90)
   *   u = ⅔ : 3k·(⅔)(⅓)² = 3k·(2/27) = 2k/9  = 20
   *
   * against 3k·u(1−u) = 60 at BOTH points in the symmetric case. So the two
   * fixtures cannot be confused for one another.
   */
  const K = 90;
  const p = warp({ 1: { x: W / 3, y: K } });

  it('leans the bow toward the moved handle', () => {
    expect(at(p, 1 / 3, 0)).toEqual(pt(100 / 3, 40));
    expect(at(p, 2 / 3, 0)).toEqual(pt(200 / 3, 20));
  });

  it('is NOT symmetric about the middle — the thing the main case cannot see', () => {
    const a = coonsPoint(p, 1 / 3, 0).y;
    const b = coonsPoint(p, 2 / 3, 0).y;
    expect(a).toBeGreaterThan(b);
    expect(a / b).toBeCloseTo(2, 6);
  });

  it('moving the OTHER handle mirrors it', () => {
    const q = warp({ 2: { x: (2 * W) / 3, y: K } });
    expect(at(q, 1 / 3, 0)).toEqual(pt(100 / 3, 20));
    expect(at(q, 2 / 3, 0)).toEqual(pt(200 / 3, 40));
  });
});

describe('the Jacobian matches the surface it claims to differentiate', () => {
  /**
   * Newton is only as good as its derivative, and a wrong Jacobian does not
   * announce itself — it converges more slowly, or to a nearby wrong point, and
   * the picture merely looks slightly off.
   *
   * Checked against a central difference, which is an INDEPENDENT derivation:
   * it uses `coonsPoint` alone and knows nothing of the analytic form.
   */
  it('agrees with a central difference on a warped patch', () => {
    const p = warp({
      1: { x: W / 3, y: 40 }, 2: { x: (2 * W) / 3, y: -15 },
      10: { x: 25, y: (2 * H) / 3 }, 6: { x: W + 30, y: H + 10 },
    });
    const e = 1e-5;
    const js: Array<[number, number]> = [[0.25, 0.25], [0.5, 0.5], [0.75, 0.4], [0.1, 0.9]];
    for (const [u, v] of js) {
      const j = coonsJacobian(p, u, v);
      const du = {
        x: (coonsPoint(p, u + e, v).x - coonsPoint(p, u - e, v).x) / (2 * e),
        y: (coonsPoint(p, u + e, v).y - coonsPoint(p, u - e, v).y) / (2 * e),
      };
      const dv = {
        x: (coonsPoint(p, u, v + e).x - coonsPoint(p, u, v - e).x) / (2 * e),
        y: (coonsPoint(p, u, v + e).y - coonsPoint(p, u, v - e).y) / (2 * e),
      };
      expect(j.du.x).toBeCloseTo(du.x, 3);
      expect(j.du.y).toBeCloseTo(du.y, 3);
      expect(j.dv.x).toBeCloseTo(dv.x, 3);
      expect(j.dv.y).toBeCloseTo(dv.y, 3);
    }
  });
});

describe('the inverse is a real inverse, on a patch with every edge bent', () => {
  const p = warp({
    1: { x: W / 3 + 10, y: 22 }, 2: { x: (2 * W) / 3, y: -18 },
    4: { x: W + 25, y: H / 3 }, 5: { x: W - 12, y: (2 * H) / 3 },
    7: { x: (2 * W) / 3, y: H + 20 }, 8: { x: W / 3, y: H - 14 },
    10: { x: -20, y: (2 * H) / 3 }, 11: { x: 16, y: H / 3 },
  });

  it('round-trips forward → inverse across the interior', () => {
    const rt: Array<[number, number]> = [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2], [0.3, 0.8], [1, 1], [0, 0]];
    for (const [u, v] of rt) {
      const f = coonsPoint(p, u, v);
      const back = solveUV(p, f, W, H)!;
      expect(back).not.toBeNull();
      expect(back.u).toBeCloseTo(u, 4);
      expect(back.v).toBeCloseTo(v, 4);
    }
  });

  it('rejects a point far outside the patch instead of inventing a pre-image', () => {
    // Verified rather than merely out of range: an unchecked Newton exit would
    // return whatever (u,v) it stalled on, and the caller would sample a
    // plausible wrong pixel — which reads as texture, not as an error.
    expect(solveUV(p, { x: -600, y: -600 }, W, H)).toBeNull();
    expect(solveUV(p, { x: 900, y: 900 }, W, H)).toBeNull();
  });

  /**
   * THE CONTRACT, swept rather than sampled: if `solveUV` returns a point, that
   * point must actually map to the target.
   *
   * This exists because deleting the residual verification inside `solveUV`
   * broke NO other test in this file — the range check on (u,v) happened to
   * catch every case the other fixtures probe. On a FOLDED patch it does not:
   * Newton can exhaust its iterations at a (u,v) that is comfortably inside the
   * unit square and nowhere near the target, and an unverified answer there
   * makes the effect sample a plausible wrong pixel, which reads as texture
   * rather than as an error.
   *
   * Asserting the invariant over a grid is the right shape for it — there is no
   * single interesting point to hand-derive, and the claim being made is
   * universal.
   */
  it('never returns a point that does not map back, even on a FOLDED patch', () => {
    // BR dragged up past TL, so the surface crosses itself and parts of the
    // plane have two pre-images while others have none.
    const folded = warp({ 6: { x: -60, y: -60 } });
    let checked = 0;
    for (let x = -150; x <= 250; x += 10) {
      for (let y = -150; y <= 250; y += 10) {
        const uv = solveUV(folded, { x, y }, W, H);
        if (!uv) continue;
        checked++;
        const f = coonsPoint(folded, uv.u, uv.v);
        expect(Math.hypot(f.x - x, f.y - y)).toBeLessThan(0.5);
      }
    }
    // The sweep must actually find solutions, or it asserts nothing at all —
    // the same deadness trap as a golden that renders an empty frame.
    expect(checked).toBeGreaterThan(20);
  });

  it('terminates on a degenerate patch rather than iterating forever', () => {
    // Every control point collapsed to one spot, so the Jacobian is singular
    // everywhere and the whole patch images to the single point (50, 50).
    //
    // This first asserted null for that point too, which was wrong: the guess
    // (½, ½) already satisfies S(u,v) = (50,50) exactly, so it is a genuine
    // pre-image and reporting it is correct. The claim worth making is that
    // every OTHER destination gets null — the effect draws one dot, not a
    // smear — and that neither answer costs an unbounded loop.
    const flat = defaultWarpPoints(W, H).map(() => ({ x: 50, y: 50 })) as unknown as WarpPoints;
    for (const q of [{ x: 0, y: 0 }, { x: 99, y: 12 }, { x: 50, y: 51 }]) {
      expect(solveUV(flat, q, W, H)).toBeNull();
    }
    const hit = solveUV(flat, { x: 50, y: 50 }, W, H);
    if (hit) expect(coonsPoint(flat, hit.u, hit.v)).toEqual({ x: 50, y: 50 });
  });
});
