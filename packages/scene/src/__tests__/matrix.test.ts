import { Matrix } from '../index';

describe('Matrix math', () => {
  it('identity leaves points unchanged', () => {
    const p = Matrix.transformPoint(Matrix.identity(), { x: 3, y: 5 });
    expect(p).toEqual({ x: 3, y: 5 });
  });

  it('composes translate/rotate/scale correctly', () => {
    const m = Matrix.compose({
      position: { x: 10, y: 20 },
      rotation: Math.PI / 2, // 90°
      scale: { x: 1, y: 1 },
      skew: { x: 0, y: 0 },
      anchor: { x: 0, y: 0 },
    });
    // Rotating (1,0) by 90° → (0,1), then translate → (10, 21).
    const p = Matrix.transformPoint(m, { x: 1, y: 0 });
    expect(p.x).toBeCloseTo(10, 6);
    expect(p.y).toBeCloseTo(21, 6);
  });

  it('scales around the anchor point', () => {
    const m = Matrix.compose({
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: { x: 2, y: 2 },
      skew: { x: 0, y: 0 },
      anchor: { x: 5, y: 5 },
    });
    // The anchor maps to position.
    const a = Matrix.transformPoint(m, { x: 5, y: 5 });
    expect(a.x).toBeCloseTo(0, 6);
    expect(a.y).toBeCloseTo(0, 6);
  });

  it('multiply then invert returns identity', () => {
    const a = Matrix.compose({ position: { x: 4, y: 9 }, rotation: 0.7, scale: { x: 2, y: 3 }, skew: { x: 0, y: 0 }, anchor: { x: 0, y: 0 } });
    const inv = Matrix.invert(a);
    const id = Matrix.multiply(a, inv);
    expect(Matrix.equals(id, Matrix.identity(), 1e-6)).toBe(true);
  });

  it('decompose recovers translation + scale', () => {
    const a = Matrix.compose({ position: { x: 12, y: -4 }, rotation: 0, scale: { x: 3, y: 5 }, skew: { x: 0, y: 0 }, anchor: { x: 0, y: 0 } });
    const d = Matrix.decompose(a);
    expect(d.position.x).toBeCloseTo(12, 6);
    expect(d.position.y).toBeCloseTo(-4, 6);
    expect(d.scale.x).toBeCloseTo(3, 6);
    expect(d.scale.y).toBeCloseTo(5, 6);
  });
});
