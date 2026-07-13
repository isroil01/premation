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
