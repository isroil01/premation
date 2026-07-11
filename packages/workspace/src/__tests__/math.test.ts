import * as V from '../math/Vec2';
import * as Mat from '../math/Mat2D';
import * as R from '../math/Rect';

describe('Vec2', () => {
  it('adds, subtracts, scales', () => {
    expect(V.add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
    expect(V.sub({ x: 3, y: 4 }, { x: 1, y: 2 })).toEqual({ x: 2, y: 2 });
    expect(V.scale({ x: 2, y: 3 }, 2)).toEqual({ x: 4, y: 6 });
  });

  it('measures distance and length', () => {
    expect(V.distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(V.length({ x: 3, y: 4 })).toBe(5);
  });

  it('lerps', () => {
    expect(V.lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
  });
});

describe('Mat2D', () => {
  it('composes translate + scale and inverts', () => {
    const m = Mat.multiply(Mat.translation(10, 20), Mat.scaling(2, 3));
    expect(Mat.apply(m, { x: 1, y: 1 })).toEqual({ x: 12, y: 23 });
    const inv = Mat.invert(m);
    const back = Mat.apply(inv, { x: 12, y: 23 });
    expect(back.x).toBeCloseTo(1);
    expect(back.y).toBeCloseTo(1);
  });

  it('rotates points', () => {
    const m = Mat.rotation(Math.PI / 2);
    const p = Mat.apply(m, { x: 1, y: 0 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
  });

  it('returns identity for singular inverse', () => {
    expect(Mat.invert({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toEqual(Mat.identity());
  });
});

describe('Rect', () => {
  it('builds from two points normalized', () => {
    expect(R.fromPoints({ x: 5, y: 5 }, { x: 1, y: 2 })).toEqual({ x: 1, y: 2, width: 4, height: 3 });
  });

  it('contains, intersects, unions', () => {
    const a = R.rect(0, 0, 10, 10);
    expect(R.containsPoint(a, { x: 5, y: 5 })).toBe(true);
    expect(R.containsPoint(a, { x: 15, y: 5 })).toBe(false);
    expect(R.intersects(a, R.rect(5, 5, 10, 10))).toBe(true);
    expect(R.intersects(a, R.rect(20, 20, 5, 5))).toBe(false);
    expect(R.union(a, R.rect(10, 10, 10, 10))).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });

  it('transforms an AABB under rotation', () => {
    const r = R.rect(-1, -1, 2, 2);
    const rotated = R.transform(r, Mat.rotation(Math.PI / 4));
    // A unit square rotated 45° has an AABB of side sqrt(2)*2 ≈ 2.828.
    expect(rotated.width).toBeCloseTo(Math.SQRT2 * 2);
  });

  it('unions a list', () => {
    const b = R.bounds([R.rect(0, 0, 5, 5), R.rect(10, 10, 5, 5)]);
    expect(b).toEqual({ x: 0, y: 0, width: 15, height: 15 });
    expect(R.bounds([])).toBeNull();
  });
});
