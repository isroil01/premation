import { shapeOutline, zigzag, roundCorners, puckerBloat, twist, applyPathOp, type PathOp } from './pathOps';
import type { Pt } from './trimPath';

const square: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

describe('shapeOutline', () => {
  it('rect → 4 centred corners', () => {
    expect(shapeOutline('rect', 100, 60)).toEqual([
      { x: -50, y: -30 },
      { x: 50, y: -30 },
      { x: 50, y: 30 },
      { x: -50, y: 30 },
    ]);
  });
  it('ellipse → N points on the ellipse', () => {
    const pts = shapeOutline('ellipse', 100, 100, 4);
    expect(pts).toHaveLength(4);
    expect(pts[0]!.x).toBeCloseTo(50);
    expect(pts[1]!.y).toBeCloseTo(50);
  });
});

describe('zigzag', () => {
  it('offsets interior points perpendicular, alternating sign', () => {
    // one horizontal edge (0,0)→(4,0), 2 segments, amplitude 1
    const out = zigzag([{ x: 0, y: 0 }, { x: 4, y: 0 }], false, 1, 2);
    // vertex (0,0), interior at t=0.5 → (2,0) + perp(0,1)*+1 = (2,1), then end vertex (4,0)
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 1 },
      { x: 4, y: 0 },
    ]);
  });
  it('adds ridges to every edge of a closed shape', () => {
    const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const out = zigzag(sq, true, 2, 3);
    // 4 edges × 3 points each = 12
    expect(out).toHaveLength(12);
  });
});

describe('roundCorners', () => {
  it('cuts each corner back along both edges', () => {
    const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const out = roundCorners(sq, true, 3, 1); // steps 1 → just the two cut points per corner
    // corner (0,0): neighbours (0,10) and (10,0) → cut points (0,3) and (3,0)
    expect(out).toContainEqual({ x: 0, y: 3 });
    expect(out).toContainEqual({ x: 3, y: 0 });
    expect(out.length).toBe(8); // 2 points × 4 corners
  });
  it('clamps the radius to half the shortest edge', () => {
    const sq: Pt[] = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const out = roundCorners(sq, true, 100, 1); // radius clamps to 2
    expect(out).toContainEqual({ x: 2, y: 0 });
  });
  it('leaves too-small paths untouched', () => {
    expect(roundCorners([{ x: 0, y: 0 }, { x: 1, y: 1 }], true, 5)).toHaveLength(2);
  });
});

describe('puckerBloat', () => {
  it('bloat (amount > 0) pushes points out from the centroid', () => {
    // centroid (5,5); +100% → f=2; (0,0) → (5,5) + (-5,-5)*2 = (-5,-5)
    const out = puckerBloat(square, 100);
    expect(out[0]).toEqual({ x: -5, y: -5 });
    expect(out[2]).toEqual({ x: 15, y: 15 });
  });
  it('pucker (amount < 0) pulls points in toward the centroid', () => {
    const out = puckerBloat(square, -50); // f=0.5
    expect(out[0]).toEqual({ x: 2.5, y: 2.5 });
  });
});

describe('twist', () => {
  it('rotates outer points around the centroid (90° → quarter turn)', () => {
    // all corners at max radius → full 90° rotation about (5,5)
    const out = twist(square, 90);
    expect(out[0]!.x).toBeCloseTo(10);
    expect(out[0]!.y).toBeCloseTo(0);
    expect(out[1]!.x).toBeCloseTo(10);
    expect(out[1]!.y).toBeCloseTo(10);
  });
  it('a zero angle is identity', () => {
    expect(twist(square, 0)).toEqual(square);
  });
});

describe('applyPathOp', () => {
  it('routes to the configured operator, none is identity', () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(applyPathOp(pts, true, { type: 'none', amount: 5, detail: 2 } as PathOp)).toEqual(pts);
    expect(applyPathOp(pts, true, { type: 'zigzag', amount: 2, detail: 2 }).length).toBeGreaterThan(pts.length);
    expect(applyPathOp(square, true, { type: 'pucker', amount: 100, detail: 0 })[0]).toEqual({ x: -5, y: -5 });
    expect(applyPathOp(square, true, { type: 'twist', amount: 0, detail: 0 })).toEqual(square);
  });
});

describe('offsetPath', () => {
  const { offsetPath } = require('./pathOps');
  const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it('amount 0 is a no-op', () => {
    expect(offsetPath(sq, true, 0)).toEqual(sq);
  });

  it('moves every corner diagonally by the same distance', () => {
    const out = offsetPath(sq, true, 2);
    // Uniform offset: every point moves the same distance.
    const dists = out.map((p: Pt, i: number) => Math.hypot(p.x - sq[i]!.x, p.y - sq[i]!.y));
    for (const d of dists) expect(d).toBeCloseTo(dists[0]!, 6);
    expect(dists[0]).toBeGreaterThan(0);
  });

  it('negative amount moves points the opposite way', () => {
    const grow = offsetPath(sq, true, 2);
    const shrink = offsetPath(sq, true, -2);
    expect(shrink[0]!.x).toBeCloseTo(2 * sq[0]!.x - grow[0]!.x, 6);
    expect(shrink[0]!.y).toBeCloseTo(2 * sq[0]!.y - grow[0]!.y, 6);
  });

  it('open paths offset endpoints along their single edge normal', () => {
    const line: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const out = offsetPath(line, false, 3);
    expect(out[0]!.y).toBeCloseTo(3);
    expect(out[1]!.y).toBeCloseTo(3);
    expect(out[0]!.x).toBeCloseTo(0);
  });
});

describe('roughen', () => {
  const { roughen } = require('./pathOps');
  const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it('amount 0 is a no-op', () => {
    expect(roughen(sq, true, 0, 4)).toEqual(sq);
  });

  it('subdivides: closed shape gains detail× points', () => {
    const out = roughen(sq, true, 1, 3);
    expect(out).toHaveLength(4 * 3);
  });

  it('is deterministic (same input → identical output)', () => {
    expect(roughen(sq, true, 2, 4)).toEqual(roughen(sq, true, 2, 4));
  });

  it('displacement scales with amount', () => {
    const small = roughen(sq, true, 1, 4);
    const big = roughen(sq, true, 5, 4);
    // Different amounts must land the same subdivided point differently.
    const dSmall = Math.hypot(small[1]!.x - big[1]!.x, small[1]!.y - big[1]!.y);
    expect(dSmall).toBeGreaterThan(0);
  });

  it('applyPathOp routes offset and roughen', () => {
    const off: PathOp = { type: 'offset', amount: 2, detail: 0 };
    const rough: PathOp = { type: 'roughen', amount: 2, detail: 3 };
    expect(applyPathOp(sq, true, off)).toHaveLength(4);
    expect(applyPathOp(sq, true, rough)).toHaveLength(12);
  });
});

// ── Wiggle Paths: the temporal half of roughen ──────────────────────
//
// These assert INVARIANTS rather than pinning coordinates. A frozen golden
// here would pass just as happily on a wiggle that jumps discontinuously or
// runs at the wrong rate — both of which look like plausible noise in a still.
describe('roughen over time (Wiggle Paths)', () => {
  const { roughen } = require('./pathOps');
  const sq: Pt[] = [
    { x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 },
  ];
  const maxDelta = (a: readonly Pt[], b: readonly Pt[]): number => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.hypot(a[i]!.x - b[i]!.x, a[i]!.y - b[i]!.y));
    return d;
  };

  it('phase 0 is byte-identical to the pre-temporal output', () => {
    // The back-compat contract: an old project has no wigglesPerSecond, reads
    // as 0, and must render exactly what it always did.
    expect(roughen(sq, true, 3, 4, 0, 0)).toEqual(roughen(sq, true, 3, 4));
  });

  it('a zero wiggle rate makes the outline independent of time', () => {
    const op: PathOp = { type: 'roughen', amount: 3, detail: 4, wigglesPerSecond: 0 };
    expect(applyPathOp(sq, true, op, 9.75)).toEqual(applyPathOp(sq, true, op, 0));
  });

  it('a non-zero wiggle rate makes the outline move', () => {
    const op: PathOp = { type: 'roughen', amount: 3, detail: 4, wigglesPerSecond: 2 };
    expect(maxDelta(applyPathOp(sq, true, op, 0), applyPathOp(sq, true, op, 0.25))).toBeGreaterThan(0);
  });

  it('is deterministic across calls at the same time (preview ≡ export)', () => {
    const op: PathOp = { type: 'roughen', amount: 4, detail: 3, wigglesPerSecond: 3, seed: 7 };
    expect(applyPathOp(sq, true, op, 1.37)).toEqual(applyPathOp(sq, true, op, 1.37));
  });

  it('is continuous — no snap between noise fields', () => {
    // Straddle a whole-numbered phase boundary, where a naive implementation
    // would swap noise fields outright. The step across it must be no larger
    // than a comparable step just inside one field.
    const op: PathOp = { type: 'roughen', amount: 5, detail: 4, wigglesPerSecond: 1 };
    const eps = 1e-3;
    const across = maxDelta(applyPathOp(sq, true, op, 1 - eps), applyPathOp(sq, true, op, 1 + eps));
    const within = maxDelta(applyPathOp(sq, true, op, 1.4), applyPathOp(sq, true, op, 1.4 + 2 * eps));
    expect(across).toBeLessThanOrEqual(Math.max(within, eps) * 10);
  });

  it('never displaces further than Size, at any phase', () => {
    // The amplitude bound is what stops an animated wiggle from tearing a
    // shape apart at some phase the eye never checks.
    const amount = 6;
    const base = roughen(sq, true, 0.0000001, 4, 0, 0); // same subdivision, ~undisplaced
    for (const phase of [0, 0.3, 0.5, 1.7, 12.25]) {
      const out = roughen(sq, true, amount, 4, phase, 0);
      expect(maxDelta(base, out)).toBeLessThanOrEqual(amount + 1e-6);
    }
  });

  it('different seeds decorrelate two otherwise identical layers', () => {
    const a = roughen(sq, true, 4, 4, 0.5, 0);
    const b = roughen(sq, true, 4, 4, 0.5, 99);
    expect(maxDelta(a, b)).toBeGreaterThan(0);
  });
});
