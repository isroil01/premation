import { resizeBounds, resizeBoundsAboutPivot, rotationDelta, isResizeHandle } from '../selection/transform';
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
    const r = resizeBounds(box, 'e', { x: -50, y: 0 }, false, 4);
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
  it('is true for every handle now that the rotate grip is gone', () => {
    for (const id of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
      expect(isResizeHandle(id)).toBe(true);
    }
  });
});

describe('resizeBoundsAboutPivot', () => {
  const box = R.rect(0, 0, 100, 100);

  it('holds the pivot fixed instead of the opposite corner', () => {
    // Pivot at the centre: dragging SE to (100, 100) is a no-op at scale 1,
    // and dragging it to (150, 150) doubles the box about the centre.
    const pivot = { x: 50, y: 50 };
    expect(resizeBoundsAboutPivot(box, 'se', { x: 100, y: 100 }, pivot)).toEqual(box);
    expect(resizeBoundsAboutPivot(box, 'se', { x: 150, y: 150 }, pivot)).toEqual({
      x: -50, y: -50, width: 200, height: 200,
    });
  });

  it('agrees with the opposite-corner model when the pivot IS that corner', () => {
    // The two models are the same function with a different fixed point, so
    // they must coincide where the fixed point coincides.
    const pivot = { x: 0, y: 0 }; // the NW corner, opposite an SE drag
    expect(resizeBoundsAboutPivot(box, 'se', { x: 150, y: 120 }, pivot)).toEqual(
      resizeBounds(box, 'se', { x: 150, y: 120 }),
    );
  });

  it('leaves the untouched axis alone for an edge handle', () => {
    const r = resizeBoundsAboutPivot(box, 'e', { x: 150, y: 999 }, { x: 50, y: 50 });
    expect(r.height).toBe(100);
    expect(r.y).toBe(0);
  });

  it('does not flip when dragged through the pivot', () => {
    const r = resizeBoundsAboutPivot(box, 'se', { x: -500, y: -500 }, { x: 50, y: 50 }, 4);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(r.width).toBeCloseTo(4, 6);
  });

  it('holds at scale 1 when the dragged edge starts ON the pivot', () => {
    // No ratio to take — the alternative is a division by zero.
    const r = resizeBoundsAboutPivot(box, 'w', { x: 40, y: 0 }, { x: 0, y: 50 });
    expect(r.width).toBe(100);
  });

  it('Shift locks the aspect ratio', () => {
    const r = resizeBoundsAboutPivot(box, 'se', { x: 200, y: 110 }, { x: 50, y: 50 }, 4, true);
    expect(r.width / r.height).toBeCloseTo(1, 6);
  });
});
