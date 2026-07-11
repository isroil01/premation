import { Mat3 } from '../core/math/Mat3';
import { Color } from '../core/math/Color';
import { Rect } from '../core/math/geometry';

describe('Mat3', () => {
  it('identity is neutral under multiply', () => {
    const a = Mat3.compose(10, 20, 0.5, 2, 3);
    const r = Mat3.multiply(a, Mat3.identity());
    expect(Mat3.equals(r, a)).toBe(true);
  });

  it('compose maps the unit quad origin to the translation', () => {
    const m = Mat3.compose(100, 50, 0, 2, 3);
    expect(Mat3.transformPoint(m, { x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
    expect(Mat3.transformPoint(m, { x: 1, y: 1 })).toEqual({ x: 102, y: 53 });
  });

  it('invert round-trips a point through an affine transform', () => {
    const m = Mat3.compose(30, -12, 0.7, 1.5, 2.5);
    const inv = Mat3.invert(m)!;
    const p = { x: 4, y: 9 };
    const back = Mat3.transformPoint(inv, Mat3.transformPoint(m, p));
    expect(back.x).toBeCloseTo(p.x, 5);
    expect(back.y).toBeCloseTo(p.y, 5);
  });

  it('ortho maps its rectangle corners to clip space', () => {
    const m = Mat3.ortho(-100, 100, -50, 50);
    expect(Mat3.transformPoint(m, { x: 100, y: 50 }).x).toBeCloseTo(1, 5);
    expect(Mat3.transformPoint(m, { x: -100, y: -50 }).x).toBeCloseTo(-1, 5);
  });

  it('returns null when inverting a singular matrix', () => {
    const singular = Mat3.scaling(0, 0);
    expect(Mat3.invert(singular)).toBeNull();
  });
});

describe('Color', () => {
  it('parses hex forms', () => {
    expect(Color.equals(Color.fromHex('#ff0000'), Color.of(1, 0, 0, 1))).toBe(true);
    expect(Color.equals(Color.fromHex('#00ff0080'), Color.of(0, 1, 0, 128 / 255))).toBe(true);
    expect(Color.equals(Color.fromHex('#f00'), Color.of(1, 0, 0, 1))).toBe(true);
  });
});

describe('Rect', () => {
  it('detects intersection and computes it', () => {
    const a = Rect.of(0, 0, 10, 10);
    const b = Rect.of(5, 5, 10, 10);
    expect(Rect.intersects(a, b)).toBe(true);
    expect(Rect.intersection(a, b)).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(Rect.intersects(a, Rect.of(100, 100, 1, 1))).toBe(false);
  });
});
