/**
 * THE GATE for folding the repeater into `fx.pathOps`.
 *
 * The question this must answer BEFORE any fold-in ships: would the reorder
 * arrows on a repeater card change rendered output, or would they move a
 * control that does nothing?
 *
 * F16 blocked this because copies are emitted as separate RenderLayers sharing
 * one geometry and differing only by transform deltas, so an operator "after"
 * the repeater applied the same pure function to identical geometry — position
 * in the chain was inert. Per-run paint removed the reason copies could not be
 * baked into geometry; this measures whether baking them makes order matter.
 *
 * Expected values are hand-computed FIRST (see each test), so these can
 * disagree with the implementation rather than restating it.
 */

import { zigzag, type PolyRun } from './pathOps';
import type { Pt } from './trimPath';

/**
 * The fold-in's geometry step, written here as the minimal thing under test:
 * replicate the runs N times, transforming copy k by the ladder.
 *
 * Deliberately NOT imported from a shipped module — the gate has to be able to
 * say "do not build this", and a gate that depends on the thing it is gating
 * cannot run before it exists.
 */
function repeatRuns(
  runs: readonly PolyRun[],
  copies: number,
  offsetX: number,
  offsetY: number,
  offsetRotationDeg: number,
  offsetScale: number,
): PolyRun[] {
  const out: PolyRun[] = [];
  for (let k = 0; k < copies; k++) {
    // The ladder at rung k, composed iteratively exactly as `ladderAtInteger`
    // does: each step adds the offset in its accumulated rotation frame.
    let x = 0, y = 0, rot = 0, scale = 1;
    for (let i = 0; i < k; i++) {
      rot += offsetRotationDeg;
      const rad = (rot * Math.PI) / 180;
      x += offsetX * Math.cos(rad) - offsetY * Math.sin(rad);
      y += offsetX * Math.sin(rad) + offsetY * Math.cos(rad);
      scale *= offsetScale;
    }
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    for (const r of runs) {
      out.push({
        closed: r.closed,
        pts: r.pts.map((p): Pt => {
          const sx = p.x * scale, sy = p.y * scale;
          return { x: sx * cos - sy * sin + x, y: sx * sin + sy * cos + y };
        }),
      });
    }
  }
  return out;
}

const zz = (runs: readonly PolyRun[], amount: number, segments: number): PolyRun[] =>
  runs.map((r) => ({ pts: zigzag(r.pts, r.closed, amount, segments), closed: r.closed }));

/** One open run from (0,0) to (10,0). */
const BASE: PolyRun[] = [{ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false }];

describe('GATE: does the repeater card position change output?', () => {
  /**
   * Hand-computed, before running anything.
   *
   * Zigzag on the open run a=(0,0) b=(10,0) with segments=2 emits a, then one
   * interior point at t=0.5 displaced along the unit perpendicular, then b.
   * dx=10, dy=0, len=10, so the perpendicular (-dy/len, dx/len) is (0,1).
   * With amplitude 1 the interior point is (5, 1).
   *
   *   zigzag THEN repeat, offsetScale 2:
   *     zigzag(base)      -> (0,0) (5,1) (10,0)
   *     copy 1 = x2       -> (0,0) (10,2) (20,0)     midpoint y = 2
   *
   *   repeat THEN zigzag:
   *     copy 1            -> (0,0) (20,0)
   *     zigzag(copy 1)    -> (0,0) (10,1) (20,0)     midpoint y = 1
   *
   * The amplitude is carried through the scale in one order and applied after
   * it in the other. 2 != 1, so the arrows matter.
   */
  it('ORDER MATTERS when the repeater scales: copy 1 midpoint is 2 vs 1', () => {
    const zigzagThenRepeat = repeatRuns(zz(BASE, 1, 2), 2, 0, 0, 0, 2);
    const repeatThenZigzag = zz(repeatRuns(BASE, 2, 0, 0, 0, 2), 1, 2);

    // Copy 1 is the second run in each result.
    const a = zigzagThenRepeat[1]!.pts;
    const b = repeatThenZigzag[1]!.pts;

    expect(a.map((p) => [p.x, p.y])).toEqual([[0, 0], [10, 2], [20, 0]]);
    expect(b.map((p) => [p.x, p.y])).toEqual([[0, 0], [10, 1], [20, 0]]);
    expect(a[1]!.y).not.toBeCloseTo(b[1]!.y, 6);
  });

  /**
   * THE SPECIAL-CASE CHECK, which is the part the trim gate nearly got wrong.
   *
   * A repeater whose only offset is a TRANSLATION commutes with zigzag, and it
   * commutes for a reason that does not generalise: translation is rigid, so it
   * moves the ruffle without resizing it. A gate measured on a translate-only
   * repeater — the DEFAULT configuration, offsetX 80 and offsetScale 1 — would
   * have reported the arrows inert and blocked a feature that works.
   */
  it('SPECIAL CASE: a translate-only repeater commutes — this is why the case matters', () => {
    const zigzagThenRepeat = repeatRuns(zz(BASE, 1, 2), 2, 80, 0, 0, 1);
    const repeatThenZigzag = zz(repeatRuns(BASE, 2, 80, 0, 0, 1), 1, 2);
    expect(zigzagThenRepeat[1]!.pts).toEqual(repeatThenZigzag[1]!.pts);
  });

  it('SPECIAL CASE: rotation alone also commutes — rigid, like translation', () => {
    const zigzagThenRepeat = repeatRuns(zz(BASE, 1, 2), 2, 0, 0, 90, 1);
    const repeatThenZigzag = zz(repeatRuns(BASE, 2, 0, 0, 90, 1), 1, 2);
    for (let i = 0; i < 3; i++) {
      expect(zigzagThenRepeat[1]!.pts[i]!.x).toBeCloseTo(repeatThenZigzag[1]!.pts[i]!.x, 9);
      expect(zigzagThenRepeat[1]!.pts[i]!.y).toBeCloseTo(repeatThenZigzag[1]!.pts[i]!.y, 9);
    }
  });

  it('SPECIAL CASE: one copy is the identity, so nothing can differ', () => {
    expect(repeatRuns(zz(BASE, 1, 2), 1, 0, 0, 0, 2))
      .toEqual(zz(repeatRuns(BASE, 1, 0, 0, 0, 2), 1, 2));
  });

  /**
   * The generalisation. SCALE is the ingredient that breaks commutation, because
   * every operator in the chain measures its effect in ABSOLUTE px — zigzag's
   * amplitude, Round Corners' radius, Offset Path's distance. Scaling the
   * geometry before the operator runs changes the ratio between the two; scaling
   * after it does not.
   *
   * So the arrows are meaningful for any repeater with offsetScale != 1, and
   * inert for one without. That is a real, explicable rule rather than an
   * accident of the sample.
   */
  it('the rule generalises: any offsetScale != 1 breaks commutation', () => {
    for (const s of [0.5, 1.5, 2, 3]) {
      const a = repeatRuns(zz(BASE, 1, 2), 2, 0, 0, 0, s)[1]!.pts[1]!.y;
      const b = zz(repeatRuns(BASE, 2, 0, 0, 0, s), 1, 2)[1]!.pts[1]!.y;
      expect({ s, differs: Math.abs(a - b) > 1e-9 }).toEqual({ s, differs: true });
    }
    // And is inert at exactly 1 — stated as the boundary, not assumed.
    const a1 = repeatRuns(zz(BASE, 1, 2), 2, 0, 0, 0, 1)[1]!.pts[1]!.y;
    const b1 = zz(repeatRuns(BASE, 2, 0, 0, 0, 1), 1, 2)[1]!.pts[1]!.y;
    expect(Math.abs(a1 - b1)).toBeLessThan(1e-9);
  });
});

/**
 * THE OTHER QUESTION the fold-in has to answer, measured here because it decides
 * whether "existing documents render identically" is achievable at all.
 *
 * Today a copy's offset is applied in COMP space: buildSnapshot emits
 * `x: px + c.dx`, i.e. the delta is added to the layer's comp position, AFTER
 * the layer's own rotation and scale have been accounted for. Baking copies into
 * layer-local geometry instead means the layer transform applies to the offsets
 * too.
 *
 * For an untransformed layer the two agree. For a rotated or scaled one they do
 * not, and the difference is not subtle.
 */
describe('GATE: does folding change where copies land on a TRANSFORMED layer?', () => {
  /**
   * Hand-computed. A repeater with offsetX 10 and a layer rotated 90 degrees.
   *
   *   comp-space (today):  the copy sits 10px along comp +X  -> (10, 0)
   *   local-space (folded): the offset is baked into geometry, then the layer's
   *                         90-degree rotation turns it            -> (0, 10)
   *
   * Same repeater, same layer, different place. Any project with a rotated or
   * scaled repeater layer would move on upgrade.
   */
  it('comp-space and local-space offsets differ on a rotated layer', () => {
    const localBaked = repeatRuns([{ pts: [{ x: 0, y: 0 }], closed: false }], 2, 10, 0, 0, 1);
    const copyLocal = localBaked[1]!.pts[0]!;
    expect([copyLocal.x, copyLocal.y]).toEqual([10, 0]);

    // Now apply a 90-degree layer rotation, which is what the renderer does to
    // baked geometry but NOT to a comp-space copy delta.
    const rad = Math.PI / 2;
    const rotated = {
      x: copyLocal.x * Math.cos(rad) - copyLocal.y * Math.sin(rad),
      y: copyLocal.x * Math.sin(rad) + copyLocal.y * Math.cos(rad),
    };
    expect(rotated.x).toBeCloseTo(0, 9);
    expect(rotated.y).toBeCloseTo(10, 9);

    // Today's comp-space copy stays at (10, 0) regardless of layer rotation.
    // 10 != 0, so the two models disagree for every non-zero rotation.
    expect(Math.abs(rotated.x - copyLocal.x)).toBeGreaterThan(1);
  });
});
