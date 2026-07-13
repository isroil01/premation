import { anchorCompensation } from './anchor';

describe('anchorCompensation (pan-behind)', () => {
  it('with no rotation/unit scale, position shifts by the anchor delta', () => {
    expect(anchorCompensation(10, 5, 0, 1, 1)).toEqual({ dx: 10, dy: 5 });
  });

  it('scales the delta by the layer scale', () => {
    expect(anchorCompensation(10, 0, 0, 2, 2)).toEqual({ dx: 20, dy: 0 });
  });

  it('rotates the delta by the layer rotation (90° turns +x into +y)', () => {
    const c = anchorCompensation(10, 0, 90, 1, 1);
    expect(c.dx).toBeCloseTo(0);
    expect(c.dy).toBeCloseTo(10);
  });

  it('is zero when the anchor does not move', () => {
    expect(anchorCompensation(0, 0, 45, 1, 1)).toEqual({ dx: 0, dy: 0 });
  });
});
