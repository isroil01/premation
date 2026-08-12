/**
 * Wiggle Paths displaces in 2D, not along the normal only.
 *
 * ## What was wrong, and why it read as fine
 *
 * Every point moved along its own normal by one scalar. That produces a
 * perfectly plausible-looking wiggle — a still frame of it is indistinguishable
 * from the real thing — which is why it survived: nothing that looked at the
 * output could tell, and the only test that could was one that measured the
 * DIRECTION of the displacement rather than its presence or its size.
 *
 * It is not what AE does, and the difference shows in motion. A normal-only
 * wiggle can only push an outline out and pull it in, so its vertices keep
 * their arc positions and the shape breathes like a membrane. AE's vertices
 * also slide ALONG the path, which is what makes a wiggled outline read as
 * hand-drawn.
 *
 * ## The shape of these tests
 *
 * Invariants, not coordinates. A golden here would pass just as happily on a
 * wiggle that displaces in one fixed diagonal for every point, or one whose
 * tangential channel is a copy of its normal one — both of which are 2D by the
 * letter and wrong by the intent.
 *
 * The square's edges are axis-aligned on purpose: on the top edge the tangent
 * is exactly x and the normal exactly y, so "did it move tangentially" is
 * readable as "did x change" with no projection arithmetic to get wrong.
 */

import { roughen } from './pathOps';
import type { Pt } from './trimPath';

const SQUARE: Pt[] = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
];

/**
 * The subdivided-but-undisplaced outline, to compare positions against.
 *
 * A negligible amount rather than 0: `roughen` short-circuits on exactly 0 and
 * returns the four original points undivided, so that baseline would be indexed
 * against a 16-point result and every comparison would read the wrong point.
 */
const dense = (detail: number): Pt[] => roughen(SQUARE, true, 1e-12, detail, 0, 0, 0);

/** Local unit tangent and normal at `i`, from the UNDISPLACED outline. */
function frameAt(base: Pt[], i: number): { t: Pt; n: Pt } {
  const m = base.length;
  const prev = base[(i - 1 + m) % m]!;
  const next = base[(i + 1) % m]!;
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const len = Math.hypot(dx, dy) || 1;
  return { t: { x: dx / len, y: dy / len }, n: { x: -dy / len, y: dx / len } };
}

describe('the displacement has a component ALONG the path', () => {
  it('is not perpendicular to the outline at every point', () => {
    const base = dense(6);
    const out = roughen(SQUARE, true, 10, 6, 0, 3, 0);
    // Tangential component of each point's displacement. A normal-only
    // implementation makes every one of these exactly zero.
    const along = out.map((p, i) => {
      const { t } = frameAt(base, i);
      return (p.x - base[i]!.x) * t.x + (p.y - base[i]!.y) * t.y;
    });
    const moved = along.filter((a) => Math.abs(a) > 1e-6);
    // Most points, not merely one: a single non-zero could come from a corner
    // where the averaged tangent is degenerate rather than from a real channel.
    expect(moved.length).toBeGreaterThan(along.length / 2);
  });

  it('slides points along a straight edge, not only off it', () => {
    // The top edge runs from (0,0) to (100,0): tangent is x, normal is y. On a
    // normal-only wiggle every point here keeps its x EXACTLY.
    //
    // A majority rather than all of them: the angle channel is noise, so an
    // individual point can legitimately draw a rotation near zero and barely
    // slide. Requiring every point would make this pass or fail on the seed,
    // which is a flaky test wearing a strict one's clothes.
    const detail = 8;
    const base = dense(detail);
    const out = roughen(SQUARE, true, 10, detail, 0, 5, 0);
    const onTopEdge = base
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => Math.abs(p.y) < 1e-6 && p.x > 1e-6 && p.x < 100 - 1e-6);
    expect(onTopEdge.length).toBeGreaterThan(2); // the premise: there ARE such points
    const slid = onTopEdge.filter(({ p, i }) => Math.abs(out[i]!.x - p.x) > 0.1);
    expect(slid.length).toBeGreaterThan(onTopEdge.length / 2);
  });

  it('the direction varies point to point, rather than one fixed offset angle', () => {
    // A single rotation applied to every point would be 2D by the letter and
    // wrong by the intent: the whole outline would lean the same way. The angle
    // between each displacement and its own normal must actually spread.
    const base = dense(6);
    const out = roughen(SQUARE, true, 10, 6, 0, 9, 0);
    const angles = out.map((p, i) => {
      const { t, n } = frameAt(base, i);
      const dx = p.x - base[i]!.x;
      const dy = p.y - base[i]!.y;
      // atan2 of the tangential over the normal component — signed, and
      // independent of the magnitude channel.
      return Math.atan2(dx * t.x + dy * t.y, dx * n.x + dy * n.y);
    });
    const spread = Math.max(...angles) - Math.min(...angles);
    expect(spread).toBeGreaterThan(1); // radians — well over a fixed-offset zero
  });

  it('never displaces further than Size — the direction is free, the reach is not', () => {
    // The reason this is direction × magnitude and not two independent
    // components: two components each bounded by Size reach Size·√2 at the
    // corner, and "Size is the most it can move" is the contract users read off
    // the control.
    const base = dense(6);
    for (const amount of [1, 6, 25]) {
      const out = roughen(SQUARE, true, amount, 6, 0, 3, 0);
      for (let i = 0; i < out.length; i++) {
        const d = Math.hypot(out[i]!.x - base[i]!.x, out[i]!.y - base[i]!.y);
        expect(d).toBeLessThanOrEqual(amount + 1e-6);
      }
    }
  });
});

describe('2D displacement does not break what already held', () => {
  it('amount 0 is still an exact no-op', () => {
    expect(roughen(SQUARE, true, 0, 4)).toEqual(SQUARE);
  });

  it('is still a pure function of its arguments', () => {
    expect(roughen(SQUARE, true, 9, 5, 1.5, 11, 40))
      .toEqual(roughen(SQUARE, true, 9, 5, 1.5, 11, 40));
  });

  it('a different seed still changes the DIRECTION channel too', () => {
    // The seed is mixed in ahead of the channel term, so it must move both. If
    // only the magnitude channel responded, two layers at different seeds would
    // lean their displacements identically — a visible repetition.
    const base = dense(6);
    const alongFor = (seed: number): number[] => {
      const out = roughen(SQUARE, true, 10, 6, 0, seed, 0);
      return out.map((p, i) => {
        const { t } = frameAt(base, i);
        return (p.x - base[i]!.x) * t.x + (p.y - base[i]!.y) * t.y;
      });
    };
    expect(alongFor(1)).not.toEqual(alongFor(2));
  });

  it('correlation 100 equalises the MAGNITUDE, both channels being shared', () => {
    // One shared magnitude and one shared rotation give every point the same
    // |displacement| while its direction still follows its own frame. This is
    // the check that would fail if correlation were applied to the magnitude
    // channel alone.
    const base = dense(4);
    const out = roughen(SQUARE, true, 10, 4, 0, 3, 100);
    const dists = out.map((p, i) => Math.hypot(p.x - base[i]!.x, p.y - base[i]!.y));
    for (const d of dists) expect(d).toBeCloseTo(dists[0]!, 9);
    expect(dists[0]!).toBeGreaterThan(0);
  });
});
