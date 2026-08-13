/**
 * `offsetAlongNormals` — the shared geometry half of DECISION D4.
 *
 * ## Rule 3a — never on a straight line
 *
 * A straight horizontal centreline has ONE normal everywhere, so every
 * per-vertex bug this function can have is invisible on it: a normal computed
 * from the wrong neighbour pair, a normal that ignores the local tangent
 * entirely, an off-by-one in the index passed to `distanceAt`. Every geometric
 * assertion below runs on a CURVE. `the fixture actually curves` is the positive
 * control that says so rather than trusting it, and one straight-line case is
 * kept ONLY where the expected answer is independently derivable by hand.
 *
 * ## Rule 2b — a symmetric distance cannot show a swap
 *
 * Offsetting by a CONSTANT distance produces two sides that are mirror images,
 * so exchanging them is undetectable. The varying-distance fixture is what makes
 * a left/right swap visible, and the direction claim is anchored to a normal
 * computed BY HAND from the definition (+x travel ⇒ normal +y), not to whatever
 * the implementation returned.
 */

import { offsetAlongNormals, closedRibbon, type OffsetPoint } from '../utils/pathOffset';

/** A quarter-circle of radius 100, centred at the origin. Curvature everywhere. */
const ARC: OffsetPoint[] = Array.from({ length: 9 }, (_, i) => {
  const t = (i / 8) * (Math.PI / 2);
  return { x: Math.cos(t) * 100, y: Math.sin(t) * 100 };
});

/** Distinct per vertex, and monotonic, so an index slip moves the answer. */
const varying = (i: number): number => 4 + i * 3;

const dist = (a: OffsetPoint, b: OffsetPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('the fixture is unclean, as rule 3a requires', () => {
  it('POSITIVE CONTROL: the fixture actually curves', () => {
    // Tangent direction at the start vs the end. On a straight line these are
    // equal and every assertion below would hold for a constant-normal bug.
    const t0 = Math.atan2(ARC[1]!.y - ARC[0]!.y, ARC[1]!.x - ARC[0]!.x);
    const tN = Math.atan2(ARC[8]!.y - ARC[7]!.y, ARC[8]!.x - ARC[7]!.x);
    expect(Math.abs(t0 - tN)).toBeGreaterThan(1);
  });

  it('POSITIVE CONTROL: the distances really do differ per vertex', () => {
    // A constant distance cannot show an off-by-one in `distanceAt`.
    expect(new Set(ARC.map((_, i) => varying(i))).size).toBe(ARC.length);
  });
});

describe('the offset is perpendicular to the local tangent', () => {
  it('every offset direction is normal to the centred tangent', () => {
    const { left } = offsetAlongNormals(ARC, varying);
    for (let i = 0; i < ARC.length; i++) {
      const prev = ARC[Math.max(0, i - 1)]!;
      const next = ARC[Math.min(ARC.length - 1, i + 1)]!;
      // Tangent and offset, both derived HERE from the definition.
      const tx = next.x - prev.x;
      const ty = next.y - prev.y;
      const ox = left[i]!.x - ARC[i]!.x;
      const oy = left[i]!.y - ARC[i]!.y;
      const cos = (tx * ox + ty * oy) / (Math.hypot(tx, ty) * Math.hypot(ox, oy));
      expect({ i, perpendicular: Math.abs(cos) < 1e-9 }).toEqual({ i, perpendicular: true });
    }
  });
});

describe('the two sides', () => {
  it('sit at exactly the requested distance, per vertex', () => {
    const { left, right } = offsetAlongNormals(ARC, varying);
    for (let i = 0; i < ARC.length; i++) {
      expect(dist(left[i]!, ARC[i]!)).toBeCloseTo(varying(i), 9);
      expect(dist(right[i]!, ARC[i]!)).toBeCloseTo(varying(i), 9);
    }
  });

  it('are on OPPOSITE sides — the centre is their midpoint', () => {
    const { left, right } = offsetAlongNormals(ARC, varying);
    for (let i = 0; i < ARC.length; i++) {
      expect((left[i]!.x + right[i]!.x) / 2).toBeCloseTo(ARC[i]!.x, 9);
      expect((left[i]!.y + right[i]!.y) / 2).toBeCloseTo(ARC[i]!.y, 9);
    }
  });

  it('are NOT interchangeable — a swap is visible under a varying distance', () => {
    // Rule 2b's positive control. With a constant distance the two sides are
    // mirror images and this could not fail.
    const { left, right } = offsetAlongNormals(ARC, varying);
    expect(left).not.toEqual(right);
  });
});

describe('which side is which — anchored to the definition, not the output', () => {
  it('for travel along +x, the left offset is +y', () => {
    // Derived by hand: tangent (1,0) ⇒ normal (−ty, tx)/len = (0, 1). The one
    // straight-line case in this file, kept because the expected answer is
    // independently computable and the claim is about direction, not curvature.
    const line: OffsetPoint[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    const { left, right } = offsetAlongNormals(line, () => 5);
    expect({ lx: left[1]!.x, ly: left[1]!.y }).toEqual({ lx: 10, ly: 5 });
    expect({ rx: right[1]!.x, ry: right[1]!.y }).toEqual({ rx: 10, ry: -5 });
  });

  it('and reversing the path swaps the sides', () => {
    // The other half of the directional claim: "left" is relative to travel.
    const line: OffsetPoint[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    const fwd = offsetAlongNormals(line, () => 5);
    const rev = offsetAlongNormals([...line].reverse(), () => 5);
    expect(rev.left[1]!.y).toBeCloseTo(-fwd.left[1]!.y, 9);
  });
});

describe('inputs that must not produce NaN', () => {
  it('survives coincident neighbours', () => {
    // A stationary sample pair gives a zero-length tangent; the `|| 1` fallback
    // must yield a duplicated point rather than NaN, which a caller's smoothing
    // step can absorb.
    const pts: OffsetPoint[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }];
    const { left, right } = offsetAlongNormals(pts, () => 3);
    const finite = [...left, ...right].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    expect(finite).toBe(true);
  });

  it('returns empty below two points — there is no direction of travel', () => {
    expect(offsetAlongNormals([], () => 1)).toEqual({ left: [], right: [] });
    expect(offsetAlongNormals([{ x: 1, y: 2 }], () => 1)).toEqual({ left: [], right: [] });
  });

  it('a zero distance collapses both sides onto the centreline', () => {
    const { left, right } = offsetAlongNormals(ARC, () => 0);
    expect(left).toEqual(ARC.map((p) => ({ x: p.x, y: p.y })));
    expect(right).toEqual(left);
  });
});

describe('closedRibbon', () => {
  it('walks the left side forward and the right side back', () => {
    const sides = offsetAlongNormals(ARC, varying);
    const ring = closedRibbon(sides);
    expect(ring).toHaveLength(ARC.length * 2);
    expect(ring[0]).toEqual(sides.left[0]);
    expect(ring[ARC.length - 1]).toEqual(sides.left[ARC.length - 1]);
    // First point after the turn is the LAST right point — that is what makes
    // the ring close instead of crossing itself.
    expect(ring[ARC.length]).toEqual(sides.right[ARC.length - 1]);
    expect(ring[ring.length - 1]).toEqual(sides.right[0]);
  });

  it('closes: the last point is across the centreline from the first', () => {
    const ring = closedRibbon(offsetAlongNormals(ARC, varying));
    expect((ring[0]!.x + ring[ring.length - 1]!.x) / 2).toBeCloseTo(ARC[0]!.x, 9);
    expect((ring[0]!.y + ring[ring.length - 1]!.y) / 2).toBeCloseTo(ARC[0]!.y, 9);
  });

  it('is empty for an empty offset', () => {
    expect(closedRibbon({ left: [], right: [] })).toEqual([]);
  });
});

describe('the extraction preserved the arithmetic', () => {
  it('matches the formula ribbonOutline used inline before the move', () => {
    // A pin on the numbers, not a restatement of the new code: this is the OLD
    // body, transcribed from `builtin.ts` as it stood before DECISION D4. If a
    // later change to the primitive alters the brush's geometry, this fails —
    // which is the regression the extraction is most likely to cause and the
    // one the brush's own tests are too coarse to see.
    const widthAt = (i: number): number => varying(i) * 2;
    const n = ARC.length;
    const left: OffsetPoint[] = [];
    const right: OffsetPoint[] = [];
    for (let i = 0; i < n; i++) {
      const prev = ARC[Math.max(0, i - 1)]!;
      const next = ARC[Math.min(n - 1, i + 1)]!;
      const tx = next.x - prev.x;
      const ty = next.y - prev.y;
      const len = Math.hypot(tx, ty) || 1;
      const nx = -ty / len;
      const ny = tx / len;
      const w = widthAt(i) / 2;
      left.push({ x: ARC[i]!.x + nx * w, y: ARC[i]!.y + ny * w });
      right.push({ x: ARC[i]!.x - nx * w, y: ARC[i]!.y - ny * w });
    }

    const now = offsetAlongNormals(ARC, (i) => widthAt(i) / 2);
    expect(now.left).toEqual(left);
    expect(now.right).toEqual(right);
    expect(closedRibbon(now)).toEqual([...left, ...right.reverse()]);
  });
});
