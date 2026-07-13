import { repeaterCopies, defaultRepeater, type Repeater } from './repeater';

const base: Repeater = {
  copies: 3,
  offsetX: 100,
  offsetY: 0,
  offsetRotation: 0,
  offsetScale: 1,
  offsetOpacity: 1,
};

describe('repeaterCopies', () => {
  it('copy 0 is always the untouched original', () => {
    expect(repeaterCopies(base)[0]).toEqual({ index: 0, dx: 0, dy: 0, drot: 0, scaleMul: 1, opacityMul: 1 });
  });

  it('a pure X offset marches copies in a straight line', () => {
    const c = repeaterCopies(base);
    expect(c).toHaveLength(3);
    expect(c[1]!.dx).toBeCloseTo(100);
    expect(c[2]!.dx).toBeCloseTo(200);
    expect(c[1]!.dy).toBeCloseTo(0);
  });

  it('accumulates scale and opacity multiplicatively', () => {
    const c = repeaterCopies({ ...base, offsetScale: 0.5, offsetOpacity: 0.8 });
    expect(c[1]!.scaleMul).toBeCloseTo(0.5);
    expect(c[2]!.scaleMul).toBeCloseTo(0.25);
    expect(c[2]!.opacityMul).toBeCloseTo(0.64);
  });

  it('a rotation offset composes the offset in the rotated frame (traces a square)', () => {
    // offsetRotation 90° + offsetX 100 → copies step (0,100),(-100,100),(-100,0)…
    const c = repeaterCopies({ ...base, copies: 5, offsetRotation: 90 });
    expect(c[1]!.dx).toBeCloseTo(0);
    expect(c[1]!.dy).toBeCloseTo(100);
    expect(c[2]!.dx).toBeCloseTo(-100);
    expect(c[2]!.dy).toBeCloseTo(100);
    expect(c[3]!.dx).toBeCloseTo(-100);
    expect(c[3]!.dy).toBeCloseTo(0);
    // Fourth step returns to the origin → closed square.
    expect(c[4]!.dx).toBeCloseTo(0);
    expect(c[4]!.dy).toBeCloseTo(0);
    expect(c[2]!.drot).toBeCloseTo(180);
  });

  it('clamps copies to at least 1', () => {
    expect(repeaterCopies({ ...base, copies: 0 })).toHaveLength(1);
    expect(repeaterCopies({ ...base, copies: 3.9 })).toHaveLength(3);
  });

  it('default repeater is a sensible fan of 6', () => {
    expect(defaultRepeater().copies).toBe(6);
    expect(repeaterCopies(defaultRepeater())).toHaveLength(6);
  });
});
