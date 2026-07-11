import { resizeBounds, rotationDelta, isResizeHandle } from '../selection/transform';
import * as R from '../math/Rect';

describe('resizeBounds', () => {
  const box = R.rect(0, 0, 100, 100);

  it('grows from a corner, holding the opposite corner fixed', () => {
    expect(resizeBounds(box, 'se', { x: 150, y: 120 })).toEqual({ x: 0, y: 0, width: 150, height: 120 });
    expect(resizeBounds(box, 'nw', { x: -20, y: -10 })).toEqual({ x: -20, y: -10, width: 120, height: 110 });
  });

  it('moves only one edge for side handles', () => {
    expect(resizeBounds(box, 'e', { x: 40, y: 999 })).toEqual({ x: 0, y: 0, width: 40, height: 100 });
    expect(resizeBounds(box, 'n', { x: 999, y: 30 })).toEqual({ x: 0, y: 30, width: 100, height: 70 });
  });

  it('clamps to a minimum size without flipping', () => {
    const r = resizeBounds(box, 'e', { x: -50, y: 0 }, 4);
    expect(r.width).toBe(4);
    expect(r.x).toBe(0);
  });

  it('leaves bounds unchanged for the rotate handle', () => {
    expect(resizeBounds(box, 'rotate', { x: 999, y: 999 })).toEqual(box);
  });
});

describe('rotationDelta', () => {
  const pivot = { x: 0, y: 0 };

  it('measures a quarter turn', () => {
    const d = rotationDelta(pivot, { x: 10, y: 0 }, { x: 0, y: 10 });
    expect(d).toBeCloseTo(Math.PI / 2);
  });

  it('is signed', () => {
    const d = rotationDelta(pivot, { x: 10, y: 0 }, { x: 0, y: -10 });
    expect(d).toBeCloseTo(-Math.PI / 2);
  });

  it('takes the short way around', () => {
    const d = rotationDelta(pivot, { x: 1, y: -0.1 }, { x: 1, y: 0.1 });
    expect(Math.abs(d)).toBeLessThan(Math.PI / 2);
  });
});

describe('isResizeHandle', () => {
  it('separates resize handles from the rotate handle', () => {
    expect(isResizeHandle('se')).toBe(true);
    expect(isResizeHandle('rotate')).toBe(false);
  });
});
