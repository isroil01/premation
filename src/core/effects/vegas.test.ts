/**
 * Vegas geometry — the contour, and the walk along it.
 *
 * Two independent pieces, guarded separately, because they fail differently: a
 * wrong contour puts the lights on the wrong shape, a wrong walk puts them in
 * the wrong places on the right shape. Nothing here touches a canvas.
 *
 * EVERY expected value below is hand-computed FIRST, from the case table and
 * the fixture, and written out in the comment that precedes it. A test derived
 * from the implementation cannot disagree with the implementation.
 *
 * The fixtures use alpha 200 with threshold 100 on purpose: the crossing is
 * then at (100 - 0) / (200 - 0) = exactly 0.5, so every contour vertex lands on
 * a half-integer and the arithmetic can be done on paper. With 255 and 128 the
 * same crossings sit at 0.502 and every expectation would need a tolerance
 * wide enough to hide a real error.
 */

import {
  extractAlphaContours,
  arcTable,
  pointAtArc,
  walkArc,
  vegasSegments,
  type ContourPoint,
} from './vegas';

const ON = 200;
const THR = 100;

/** An alpha plane with `on` listing the opaque cells as [x, y]. */
function plane(w: number, h: number, on: ReadonlyArray<readonly [number, number]>): Uint8Array {
  const a = new Uint8Array(w * h);
  for (const [x, y] of on) a[y * w + x] = ON;
  return a;
}

/** Every cell of an inclusive box. */
function box(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
}

const xy = (pts: ReadonlyArray<ContourPoint>): Array<[number, number]> =>
  pts.map((p) => [Number(p.x.toFixed(6)), Number(p.y.toFixed(6))]);

/**
 * Twice the signed area (the shoelace sum), in SCREEN coordinates where y
 * points down. Sign is the winding, and the winding is the direction the lights
 * travel.
 */
function shoelace(pts: ReadonlyArray<ContourPoint>): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function perimeter(pts: ReadonlyArray<ContourPoint>): number {
  return arcTable(pts).total;
}

/**
 * Length of an OPEN polyline.
 *
 * Not `arcTable().total`, which closes the run — for a light that laps the
 * whole contour the start and end coincide, the closing edge is zero, and the
 * "half the closed total" shortcut silently reports half the real length.
 */
function runLength(pts: ReadonlyArray<ContourPoint>): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return s;
}

describe('extractAlphaContours — marching squares', () => {
  /**
   * A 2×2 opaque block at x,y ∈ [2,3] in a 6×6 plane.
   *
   * Worked cell by cell from the case table, before running anything. Cells are
   * named by their top-left corner; a cell's corners are TL(cx,cy) TR(cx+1,cy)
   * BR(cx+1,cy+1) BL(cx,cy+1), and bits are TL=8 TR=4 BR=2 BL=1.
   *
   *   (1,1) bits 2  (BR)        R→B    (2,1.5) → (1.5,2)
   *   (2,1) bits 3  (BR BL)     R→L    (3,1.5) → (2,1.5)
   *   (3,1) bits 1  (BL)        B→L    (3.5,2) → (3,1.5)
   *   (1,2) bits 6  (TR BR)     T→B    (1.5,2) → (1.5,3)
   *   (2,2) bits 15             —      interior, no segment
   *   (3,2) bits 9  (TL BL)     B→T    (3.5,3) → (3.5,2)
   *   (1,3) bits 4  (TR)        T→R    (1.5,3) → (2,3.5)
   *   (2,3) bits 12 (TL TR)     L→R    (2,3.5) → (3,3.5)
   *   (3,3) bits 8  (TL)        L→T    (3,3.5) → (3.5,3)
   *
   * Chained end-to-start that is one loop of eight vertices — a square with its
   * corners cut, which is what a 2×2 block's half-pixel contour must be.
   */
  const BLOCK = plane(6, 6, box(2, 2, 3, 3));

  it('traces a 2×2 block as the exact octagon the case table predicts', () => {
    const cs = extractAlphaContours(BLOCK, 6, 6, THR);
    expect(cs).toHaveLength(1);
    expect(xy(cs[0]!)).toEqual([
      [2, 1.5], [1.5, 2], [1.5, 3], [2, 3.5], [3, 3.5], [3.5, 3], [3.5, 2], [3, 1.5],
    ]);
  });

  /**
   * Perimeter: four cut corners of length hypot(0.5, 0.5) and four straight
   * runs of length 1.
   *   4 × 0.70710678 + 4 × 1 = 6.82842712
   */
  it('has the perimeter that geometry implies, closing edge included', () => {
    const cs = extractAlphaContours(BLOCK, 6, 6, THR);
    expect(perimeter(cs[0]!)).toBeCloseTo(6.82842712, 6);
  });

  /**
   * THE DIRECTIONAL GUARD, and the one that has to be ABSOLUTE.
   *
   * The case table is built with "inside on the left". Mirror it and every
   * segment reverses: the stitcher chains it just as happily, the contour has
   * the same vertices and the same perimeter, and the lights run backwards
   * around the shape. Nothing above would notice.
   *
   * Hand-computed shoelace for the eight vertices in order:
   *   1.75 + 1.5 − 0.75 − 3.5 − 3.25 − 3.5 − 0.75 + 1.5 = −7  →  area −3.5
   *
   * The MAGNITUDE checks the shape: a 2×2 square spanning 1.5..3.5 is area 4,
   * less four corner triangles of 0.125, = 3.5. The SIGN checks the direction:
   * negative is counter-clockwise on screen (y down), which is what puts the
   * material on the left of travel. Asserted as a signed number, not as
   * "opposite to the hole" — that comparison survives mirroring the whole table
   * and would be a difference assertion wearing a directional one's clothes.
   */
  it('winds with the MATERIAL ON THE LEFT — signed, not merely consistent', () => {
    const cs = extractAlphaContours(BLOCK, 6, 6, THR);
    expect(shoelace(cs[0]!)).toBeCloseTo(-3.5, 9);
  });

  /**
   * A 5×5 opaque block at [1,5] with a single transparent pixel at (3,3).
   *
   * The hole's four cells, worked from the table:
   *   (2,2) bits 13 (TL TR BL)  B→R    (2.5,3) → (3,2.5)
   *   (3,2) bits 14 (TL TR BR)  L→B    (3,2.5) → (3.5,3)
   *   (2,3) bits 11 (TL BR BL)  R→T    (3,3.5) → (2.5,3)
   *   (3,3) bits 7  (TR BR BL)  T→L    (3.5,3) → (3,3.5)
   *
   * One diamond of four vertices around the missing pixel. Canonical start is
   * the smallest (y, x), which is (3, 2.5).
   */
  const RING = plane(7, 7, box(1, 5, 5, 5).concat(box(1, 1, 5, 4)).filter(([x, y]) => !(x === 3 && y === 3)));

  it('finds the HOLE as a second contour, not just the outside', () => {
    const cs = extractAlphaContours(RING, 7, 7, THR);
    expect(cs).toHaveLength(2);
    const inner = cs.find((c) => c.length === 4)!;
    expect(xy(inner)).toEqual([[3, 2.5], [3.5, 3], [3, 3.5], [2.5, 3]]);
    // Diagonals of 1 and 1 → area 1/2; four edges of hypot(0.5,0.5).
    expect(perimeter(inner)).toBeCloseTo(2.82842712, 6);
  });

  /**
   * A hole must wind the OPPOSITE way, or "material on the left" is false for
   * half the contours a shape has and the lights on a counter run backwards.
   *
   * Hand-computed shoelace for the diamond: 0.25 + 3.25 + 0.25 − 2.75 = 1 →
   * area +0.5, positive, against the outside's negative.
   */
  it('winds a hole the OPPOSITE way, so material stays on the left', () => {
    const cs = extractAlphaContours(RING, 7, 7, THR);
    const inner = cs.find((c) => c.length === 4)!;
    const outer = cs.find((c) => c.length !== 4)!;
    expect(shoelace(inner)).toBeCloseTo(0.5, 9);
    expect(shoelace(outer)).toBeLessThan(0);
  });

  /**
   * The outer contour of the [1,5] block: straight runs of 4 and four cut
   * corners. 4 × 4 + 4 × 0.70710678 = 18.82842712.
   */
  it('measures the outer ring contour independently of the hole', () => {
    const cs = extractAlphaContours(RING, 7, 7, THR);
    const outer = cs.find((c) => c.length !== 4)!;
    expect(perimeter(outer)).toBeCloseTo(18.82842712, 6);
  });

  /**
   * A shape running off the edge of the plane still closes.
   *
   * The grid is padded with a virtual border of transparent samples precisely
   * for this: without it the boundary cells are never visited, the loop has no
   * successor for its last segment, and the walk would place lights along an
   * open run. A 2×2 block in the CORNER is the case that exercises two borders
   * at once.
   */
  it('closes a contour that touches the plane edge', () => {
    const corner = plane(4, 4, box(0, 0, 1, 1));
    const cs = extractAlphaContours(corner, 4, 4, THR);
    expect(cs).toHaveLength(1);
    // Same octagon shape as the interior block, translated: it spans
    // -0.5..1.5 in both axes, so the perimeter is identical.
    expect(perimeter(cs[0]!)).toBeCloseTo(6.82842712, 6);
    expect(cs[0]!.some((p) => p.x < 0 || p.y < 0)).toBe(true);
  });

  it('finds nothing in a fully TRANSPARENT plane', () => {
    expect(extractAlphaContours(plane(5, 5, []), 5, 5, THR)).toEqual([]);
  });

  /**
   * A fully OPAQUE plane is NOT empty — it has an alpha edge, at its own
   * boundary, and Vegas must trace it. That is the full-bleed case: a solid, or
   * an image that fills its layer, whose contour is the layer rectangle.
   *
   * This expectation was written the other way round first, on the assumption
   * that "no interior edge" meant "no contour". The virtual transparent border
   * is exactly what makes it wrong, and the behaviour is the one users want.
   *
   * Perimeter, hand-computed: the contour spans -0.5..4.5, so four straight
   * runs of 4 and four cut corners — 4 × 4 + 4 × 0.70710678 = 18.82842712.
   */
  it('traces the BOUNDARY of a fully opaque plane — the full-bleed case', () => {
    const cs = extractAlphaContours(plane(5, 5, box(0, 0, 4, 4)), 5, 5, THR);
    expect(cs).toHaveLength(1);
    expect(perimeter(cs[0]!)).toBeCloseTo(18.82842712, 6);
  });

  /**
   * THE DEGENERATE CROSSING, which is a regression guard for a real defect.
   *
   * When a corner sample equals the threshold EXACTLY, `crossing` returns 0 or
   * 1 and the crossing point lands precisely on a grid CORNER — where it
   * coincides with the crossings of the perpendicular edges through that same
   * corner. Several segments then share one endpoint.
   *
   * This is ordinary, not exotic. With 8-bit alpha and the default threshold of
   * 128, a pixel of exactly 128 turns up on any antialiased edge; a plain
   * five-pointed star produced 85 such collisions.
   *
   * The stitcher first keyed segments by their start point alone, so each
   * collision silently DISCARDED one segment, the walk then ran into a
   * consumed point and stopped, and one contour came apart into partial chains.
   * The star traced as SIX contours instead of one — four of them three-point
   * specks — and every light was placed on a fragment. It looked busy and
   * plausible, which is exactly why the render-test subject had to be something
   * whose contour could be checked.
   *
   * The fixture makes every crossing degenerate at once: a 3x3 block of alpha
   * exactly AT the threshold, so every 0-to-100 crossing solves to t = 1 and
   * every 100-to-0 crossing to t = 0. Both land on the inside pixels' own
   * corners, so the contour is the integer square (1,1)..(3,3).
   *
   * Hand-computed: one contour, a 2x2 square, so the signed area is -4 —
   * negative for the same "material on the left" reason as the octagon above.
   * Area is used rather than the vertex list because coincident crossings also
   * produce zero-length segments, which add duplicate vertices without moving
   * anything; the enclosed area is exactly what they cannot change.
   */
  it('does not lose segments when crossings land ON a grid corner', () => {
    const AT = new Uint8Array(5 * 5);
    for (const [x, y] of box(1, 1, 3, 3)) AT[y * 5 + x] = THR; // EXACTLY the threshold
    const cs = extractAlphaContours(AT, 5, 5, THR);
    expect(cs).toHaveLength(1);
    expect(shoelace(cs[0]!)).toBeCloseTo(-4, 9);
  });

  /**
   * THE SADDLE. Two opaque pixels touching only at a corner.
   *
   *   (1,1) and (2,2) opaque, (2,1) and (1,2) transparent.
   *
   * Cell (1,1) sees TL=(1,1) IN, TR=(2,1) OUT, BR=(2,2) IN, BL=(1,2) OUT →
   * bits 10, the ambiguous case. Its four corners average (200+0+200+0)/4 = 100,
   * which is >= the threshold of 100, so the centre reads INSIDE and the two
   * pixels are joined into ONE contour through the waist.
   *
   * Dropping the threshold below the average would separate them into two. The
   * point of the case is that the answer is decided by a measurement rather
   * than by whichever pairing the table happened to list first.
   */
  it('resolves a diagonal saddle by the CENTRE, not by a fixed pairing', () => {
    const diag = plane(5, 5, [[1, 1], [2, 2]]);
    // Centre average 100 >= 100 → joined.
    expect(extractAlphaContours(diag, 5, 5, 100)).toHaveLength(1);
    // Centre average 100 < 101 → separate. Same pixels, same cell, different
    // answer, which is only possible if the centre is actually consulted.
    expect(extractAlphaContours(diag, 5, 5, 101)).toHaveLength(2);
  });
});

describe('the arc-length walk', () => {
  /** A 10×10 square, so every arc position is arithmetic anyone can check. */
  const SQ: ContourPoint[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it('measures the perimeter INCLUDING the closing edge', () => {
    const t = arcTable(SQ);
    expect(t.cum).toEqual([0, 10, 20, 30]);
    // 40, not 30. Omitting the closing edge would make every light drift by one
    // edge per lap — an animated chase sliding out of phase with itself.
    expect(t.total).toBe(40);
  });

  it('finds the point at an arc position, including on the closing edge', () => {
    const t = arcTable(SQ);
    expect(pointAtArc(SQ, t, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAtArc(SQ, t, 5)).toEqual({ x: 5, y: 0 });
    expect(pointAtArc(SQ, t, 15)).toEqual({ x: 10, y: 5 });
    expect(pointAtArc(SQ, t, 25)).toEqual({ x: 5, y: 10 });
    // Arc 35 is halfway along the closing edge (0,10) → (0,0), which has no
    // entry in `cum` at all.
    expect(pointAtArc(SQ, t, 35)).toEqual({ x: 0, y: 5 });
  });

  it('wraps arc positions past the perimeter and below zero', () => {
    const t = arcTable(SQ);
    expect(pointAtArc(SQ, t, 45)).toEqual({ x: 5, y: 0 });
    expect(pointAtArc(SQ, t, -5)).toEqual({ x: 0, y: 5 });
  });

  /**
   * A run from arc 3 to arc 13 crosses the corner at arc 10, so it must carry
   * the corner vertex: (3,0) → (10,0) → (10,3).
   */
  it('keeps the vertices a run passes through', () => {
    const t = arcTable(SQ);
    expect(walkArc(SQ, t, 3, 10)).toEqual([{ x: 3, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 3 }]);
  });

  /**
   * THE SEAM. A run from arc 38, length 5, passes arc 40 — the join back to
   * vertex 0 — and ends at arc 3.
   *
   * Hand-computed: 38 is 0.8 along the closing edge (0,10) → (0,0), so the
   * start is (0, 2). Then vertex 0 at (0,0), then the end at arc 43 ≡ 3, which
   * is (3,0).
   *
   * Emitted as ONE run of three points. Splitting it at the seam would put a
   * join and two end caps in the middle of a single light — visible at any
   * width above a hairline.
   */
  it('crosses the seam as ONE run, not two', () => {
    const t = arcTable(SQ);
    expect(walkArc(SQ, t, 38, 5)).toEqual([{ x: 0, y: 2 }, { x: 0, y: 0 }, { x: 3, y: 0 }]);
  });

  it('a zero or negative length lights nothing', () => {
    const t = arcTable(SQ);
    expect(walkArc(SQ, t, 0, 0)).toEqual([]);
    expect(walkArc(SQ, t, 0, -4)).toEqual([]);
  });
});

describe('vegasSegments — placing the lights', () => {
  const SQ: ContourPoint[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  /**
   * Four segments at 50% on a perimeter of 40: slot 10, lit 5, starting at arc
   * 0, 10, 20, 30 — one light on the first half of each side.
   */
  it('spaces the lights evenly and lights half of each slot', () => {
    const runs = vegasSegments(SQ, 4, 50, 0);
    expect(runs).toHaveLength(4);
    expect(runs.map((r) => [r[0]!.x, r[0]!.y])).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(runs.map((r) => [r[r.length - 1]!.x, r[r.length - 1]!.y]))
      .toEqual([[5, 0], [10, 5], [5, 10], [0, 5]]);
  });

  /**
   * `length` is a percent of the SLOT, not of the perimeter. That is what makes
   * the two controls independent: doubling the segment count must not also
   * halve how much of the shape is lit. 2 × (50% of 20) = 20 = 4 × (50% of 10).
   */
  it('keeps TOTAL lit length constant when only the count changes', () => {
    const lit = (n: number): number =>
      vegasSegments(SQ, n, 50, 0).reduce((sum, r) => sum + runLength(r), 0);
    expect(lit(2)).toBeCloseTo(20, 6);
    expect(lit(4)).toBeCloseTo(20, 6);
    expect(lit(8)).toBeCloseTo(20, 6);
  });

  /**
   * Rotation is a full lap per 360 degrees, so with four segments a rotation of
   * 90 degrees advances the pattern by exactly one slot — the set at 90 is the
   * set at 0, shifted by one index. That mapping is what makes a linear
   * keyframe on `rotation` a constant-speed chase whatever shape it is on.
   */
  it('rotation advances by a full lap per 360 degrees', () => {
    const at0 = vegasSegments(SQ, 4, 50, 0).map((r) => [r[0]!.x, r[0]!.y]);
    const at90 = vegasSegments(SQ, 4, 50, 90).map((r) => [r[0]!.x, r[0]!.y]);
    expect(at90).toEqual([...at0.slice(1), ...at0.slice(0, 1)]);
    // And a full turn is the identity.
    expect(vegasSegments(SQ, 4, 50, 360).map((r) => [r[0]!.x, r[0]!.y])).toEqual(at0);
  });

  it('a negative rotation runs the other way', () => {
    const back = vegasSegments(SQ, 4, 50, -90).map((r) => [r[0]!.x, r[0]!.y]);
    expect(back).toEqual([[0, 10], [0, 0], [10, 0], [10, 10]]);
  });

  it('length 0 lights nothing, length 100 lights the whole contour', () => {
    expect(vegasSegments(SQ, 4, 0, 0)).toEqual([]);
    const full = vegasSegments(SQ, 1, 100, 0);
    expect(full).toHaveLength(1);
    expect(runLength(full[0]!)).toBeCloseTo(40, 6);
  });

  it('survives a degenerate contour rather than dividing by zero', () => {
    expect(vegasSegments([{ x: 5, y: 5 }, { x: 5, y: 5 }], 3, 50, 0)).toEqual([]);
    expect(vegasSegments([], 3, 50, 0)).toEqual([]);
  });
});
