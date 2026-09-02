/**
 * Knife geometry. The properties asserted here are the ones a cut can silently
 * get wrong: AREA (a cap drawn to the wrong crossing loses or gains region),
 * CLOSEDNESS (an uncapped half is a stroke, not a shape), and the no-op case
 * (a line that misses must leave the layer's own array untouched, or the tool
 * records an undo entry for nothing).
 */

import { cutPathsWithLine, runFromPolygon, type CutSubpath, type CutPoint } from './pathCut';

/** Flatten a run densely enough that a bezier half-circle's area is trustworthy. */
function flatten(run: CutSubpath, perSeg = 64): Array<{ x: number; y: number }> {
  const pts = run.points;
  const n = pts.length;
  const count = run.open ? n - 1 : n;
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg;
      const u = 1 - t;
      out.push({
        x: u * u * u * a.x + 3 * u * u * t * a.outX + 3 * u * t * t * b.inX + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * a.outY + 3 * u * t * t * b.inY + t * t * t * b.y,
      });
    }
  }
  if (run.open) out.push({ x: pts[n - 1]!.x, y: pts[n - 1]!.y });
  return out;
}

function area(run: CutSubpath): number {
  const p = flatten(run);
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i]!;
    const r = p[(i + 1) % p.length]!;
    a += q.x * r.y - r.x * q.y;
  }
  return Math.abs(a / 2);
}

function bounds(run: CutSubpath): { minX: number; maxX: number; minY: number; maxY: number } {
  const p = flatten(run);
  return {
    minX: Math.min(...p.map((q) => q.x)),
    maxX: Math.max(...p.map((q) => q.x)),
    minY: Math.min(...p.map((q) => q.y)),
    maxY: Math.max(...p.map((q) => q.y)),
  };
}

/** Axis-aligned rectangle centred on the origin, corner handles (the app's rect). */
function rect(w: number, h: number): CutSubpath {
  return runFromPolygon([
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ]);
}

/** A real bezier circle — four cubics, kappa handles. Curvature must survive. */
const K = 0.5522847498307936;
function circle(r: number): CutSubpath {
  const pt = (x: number, y: number, ix: number, iy: number, ox: number, oy: number): CutPoint => ({
    x, y, inX: ix, inY: iy, outX: ox, outY: oy,
  });
  const k = r * K;
  return {
    open: false,
    points: [
      pt(r, 0, r, -k, r, k),
      pt(0, r, k, r, -k, r),
      pt(-r, 0, -r, k, -r, -k),
      pt(0, -r, -k, -r, k, -r),
    ],
  };
}

describe('cutPathsWithLine — closed paths', () => {
  it('a vertical cut through a rectangle gives two rectangles of the expected area', () => {
    const src = [rect(100, 60)];
    // Off-centre so the two halves must differ — a symmetric cut would pass
    // even if the capping paired the crossings the wrong way round.
    const out = cutPathsWithLine(src, { x: -20, y: -999 }, { x: -20, y: 999 });
    expect(out).toHaveLength(2);
    for (const r of out) expect(r.open).toBe(false);

    const areas = out.map(area).sort((a, b) => a - b);
    // Left piece is 30 wide, right piece 70; both 60 tall.
    expect(areas[0]).toBeCloseTo(30 * 60, 6);
    expect(areas[1]).toBeCloseTo(70 * 60, 6);
    expect(areas[0]! + areas[1]!).toBeCloseTo(100 * 60, 6);

    const left = out.find((r) => bounds(r).maxX < -19.9)!;
    const right = out.find((r) => bounds(r).minX > -20.1)!;
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(bounds(left).minX).toBeCloseTo(-50, 9);
    expect(bounds(right).maxX).toBeCloseTo(50, 9);
  });

  it('a horizontal cut through a bezier circle gives two halves', () => {
    const r = 50;
    const out = cutPathsWithLine([circle(r)], { x: -999, y: 0 }, { x: 999, y: 0 });
    expect(out).toHaveLength(2);

    // The four-cubic circle is not a circle — it overshoots πr² by ~0.02%. The
    // cut is measured against the SHAPE, not against the ideal it approximates,
    // or this test would be asserting the accuracy of kappa.
    const full = area(circle(r));
    expect(full).toBeCloseTo(Math.PI * r * r, -1);
    for (const half of out) {
      expect(half.open).toBe(false);
      expect(area(half)).toBeCloseTo(full / 2, 6);
    }
    expect(area(out[0]!) + area(out[1]!)).toBeCloseTo(full, 6);

    // The cut is where it was asked for, and the curve is still a curve: the
    // arc reaches the full radius away from the line.
    const top = out.find((h) => bounds(h).maxY > 1)!;
    const bottom = out.find((h) => bounds(h).minY < -1)!;
    expect(bounds(top).minY).toBeCloseTo(0, 6);
    expect(bounds(top).maxY).toBeCloseTo(r, 6);
    expect(bounds(bottom).maxY).toBeCloseTo(0, 6);
    expect(bounds(bottom).minY).toBeCloseTo(-r, 6);
  });

  it('an off-axis cut still partitions the whole area', () => {
    const src = [rect(80, 80)];
    const out = cutPathsWithLine(src, { x: -100, y: -100 }, { x: 100, y: 100 });
    expect(out).toHaveLength(2);
    const total = out.reduce((s, r) => s + area(r), 0);
    expect(total).toBeCloseTo(80 * 80, 6);
    // A diagonal through the centre halves it.
    expect(area(out[0]!)).toBeCloseTo(3200, 6);
    expect(area(out[1]!)).toBeCloseTo(3200, 6);
  });

  it('a cut through two opposite corners is still one clean split', () => {
    // The degenerate case: every crossing lands exactly ON an anchor, so the
    // root solve reports t=1 of one segment and t=0 of the next for the same
    // point. Without the anchor snap this produced four crossings and a
    // scrambled pair of slivers.
    const out = cutPathsWithLine([rect(40, 40)], { x: -20, y: -20 }, { x: 20, y: 20 });
    expect(out).toHaveLength(2);
    expect(area(out[0]!)).toBeCloseTo(800, 6);
    expect(area(out[1]!)).toBeCloseTo(800, 6);
  });
});

describe('cutPathsWithLine — open paths', () => {
  it('an open polyline crossed once becomes two open paths', () => {
    const line = runFromPolygon([{ x: -50, y: 0 }, { x: 50, y: 0 }], true);
    const out = cutPathsWithLine([line], { x: 10, y: -10 }, { x: 10, y: 10 });
    expect(out).toHaveLength(2);
    for (const r of out) expect(r.open).toBe(true);
    const left = out.find((r) => r.points[0]!.x === -50)!;
    expect(left.points[left.points.length - 1]!.x).toBeCloseTo(10, 9);
    const right = out.find((r) => r !== left)!;
    expect(right.points[0]!.x).toBeCloseTo(10, 9);
    expect(right.points[right.points.length - 1]!.x).toBeCloseTo(50, 9);
  });

  it('an open path crossed twice becomes three open paths', () => {
    const zig = runFromPolygon([
      { x: -50, y: -20 }, { x: 0, y: 20 }, { x: 50, y: -20 },
    ], true);
    const out = cutPathsWithLine([zig], { x: -100, y: 0 }, { x: 100, y: 0 });
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.open)).toBe(true);
  });
});

describe('cutPathsWithLine — no-ops', () => {
  it('a line that misses the shape returns the very same array', () => {
    const src = [rect(100, 60)];
    const out = cutPathsWithLine(src, { x: -999, y: 200 }, { x: 999, y: 200 });
    // Identity, not just equality: the caller uses this to decide whether the
    // gesture is worth an undo entry.
    expect(out).toBe(src);
  });

  it('a line that only touches a corner does not cut', () => {
    // A tangency is a root but not a crossing. Splitting there would produce a
    // "half" with no interior.
    const src = [rect(40, 40)];
    const out = cutPathsWithLine(src, { x: -20, y: -60 }, { x: -20, y: 60 });
    expect(out).toBe(src);
  });

  it('a zero-length line is not a cut', () => {
    const src = [rect(40, 40)];
    expect(cutPathsWithLine(src, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(src);
  });

  it('cuts each run independently and keeps the ones it misses', () => {
    const a = rect(20, 20);
    const far: CutSubpath = {
      open: false,
      points: runFromPolygon([
        { x: 200, y: 200 }, { x: 240, y: 200 }, { x: 240, y: 240 }, { x: 200, y: 240 },
      ]).points,
    };
    const out = cutPathsWithLine([a, far], { x: 0, y: -100 }, { x: 0, y: 100 });
    // Two halves of the first, the second passed through untouched.
    expect(out).toHaveLength(3);
    expect(out).toContain(far);
  });
});
