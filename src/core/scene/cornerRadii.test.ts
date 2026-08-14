import {
  clampCornerRadii,
  resolveCornerRadii,
  uniformCornerRadii,
  type CornerRadiiTuple,
} from './cornerRadii';

describe('cornerRadii', () => {
  it('resolves missing individuals from the uniform radius', () => {
    expect(resolveCornerRadii({ cornerRadius: 12 })).toEqual([12, 12, 12, 12]);
    expect(resolveCornerRadii({ cornerRadius: 12, cornerRadiusTL: 4 })).toEqual([4, 12, 12, 12]);
  });

  it('clamps adjacent corners so they fit the box', () => {
    const r = clampCornerRadii(100, 50, [80, 80, 80, 80]);
    expect(r[0] + r[1]).toBeLessThanOrEqual(100 + 1e-6);
    expect(r[1] + r[2]).toBeLessThanOrEqual(50 + 1e-6);
  });

  it('uniform helper matches four equal values', () => {
    expect(uniformCornerRadii(8)).toEqual([8, 8, 8, 8]);
  });

  it('accepts a CornerRadiiTuple round-trip shape', () => {
    const t: CornerRadiiTuple = [1, 2, 3, 4];
    expect(clampCornerRadii(200, 200, t)).toEqual([1, 2, 3, 4]);
  });
});
