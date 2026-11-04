import { isScaleMember, linkedScaleValues, linkedValue } from './linkedScale';

describe('Constrain Proportions', () => {
  it('keeps the ratio rather than copying the number', () => {
    expect(linkedScaleValues('scaleX', 2, { scaleX: 1, scaleY: 0.5 })).toEqual({ scaleX: 2, scaleY: 1 });
  });

  it('reaches every dimension of a 3D layer', () => {
    expect(linkedScaleValues('scaleY', 3, { scaleX: 1, scaleY: 1.5, scaleZ: 2 })).toEqual({ scaleX: 2, scaleY: 3, scaleZ: 4 });
  });

  it('carries the sign of a flipped dimension', () => {
    expect(linkedScaleValues('scaleX', 2, { scaleX: 1, scaleY: -1 })).toEqual({ scaleX: 2, scaleY: -2 });
  });

  it('takes the edited number when scaling up from zero, where no ratio exists', () => {
    expect(linkedValue(0, 1.5, 0)).toBe(1.5);
    expect(linkedScaleValues('scaleX', 1.5, { scaleX: 0, scaleY: 0 })).toEqual({ scaleX: 1.5, scaleY: 1.5 });
  });

  it('leaves a zero partner at zero while the edited side has a ratio', () => {
    expect(linkedValue(1, 2, 0)).toBe(0);
  });

  it('knows the Scale tracks and nothing else', () => {
    expect(isScaleMember('scaleZ')).toBe(true);
    expect(isScaleMember('x')).toBe(false);
  });
});
