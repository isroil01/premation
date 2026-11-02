import { dragBrush, isClickTravel, stepBrushSize } from './brushFeel';

describe('[ and ] step the brush size', () => {
  it('steps by 1 under 10, 5 under 50, 10 above, and stays in 2…200', () => {
    expect(stepBrushSize(5, true)).toBe(6);
    expect(stepBrushSize(5, false)).toBe(4);
    expect(stepBrushSize(24, true)).toBe(25);
    expect(stepBrushSize(24, false)).toBe(20);
    expect(stepBrushSize(60, true)).toBe(70);
    expect(stepBrushSize(2, false)).toBe(2);
    expect(stepBrushSize(200, true)).toBe(200);
  });
});

describe('Ctrl-drag sizes the brush', () => {
  it('moves the size with the pointer and clamps it', () => {
    expect(dragBrush({ size: 24, hardness: 100 }, 30, 'size')).toEqual({ size: 54, hardness: 100 });
    expect(dragBrush({ size: 24, hardness: 100 }, -400, 'size')).toEqual({ size: 2, hardness: 100 });
  });
  it('with Shift moves the hardness, half a percent per pixel', () => {
    expect(dragBrush({ size: 24, hardness: 100 }, -40, 'hardness')).toEqual({ size: 24, hardness: 80 });
    expect(dragBrush({ size: 24, hardness: 10 }, -400, 'hardness').hardness).toBe(0);
  });
});

it('only a press that did not move waits for a double-click', () => {
  expect(isClickTravel(0)).toBe(true);
  expect(isClickTravel(3)).toBe(true);
  expect(isClickTravel(3.5)).toBe(false);
});
