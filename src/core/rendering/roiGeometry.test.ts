import { roiHandleAt, resizeRoi, rectFromDrag, clampRoi, ROI_MIN_SIZE } from './roiGeometry';

const ROI = { x: 100, y: 100, width: 200, height: 100 }; // corners (100,100)-(300,200)

describe('roiHandleAt', () => {
  it('finds each corner within tolerance', () => {
    expect(roiHandleAt(ROI, { x: 100, y: 100 }, 6)).toBe('nw');
    expect(roiHandleAt(ROI, { x: 300, y: 100 }, 6)).toBe('ne');
    expect(roiHandleAt(ROI, { x: 300, y: 200 }, 6)).toBe('se');
    expect(roiHandleAt(ROI, { x: 100, y: 200 }, 6)).toBe('sw');
  });

  it('finds an edge only alongside that edge', () => {
    expect(roiHandleAt(ROI, { x: 200, y: 100 }, 6)).toBe('n');
    expect(roiHandleAt(ROI, { x: 300, y: 150 }, 6)).toBe('e');
    expect(roiHandleAt(ROI, { x: 200, y: 200 }, 6)).toBe('s');
    expect(roiHandleAt(ROI, { x: 100, y: 150 }, 6)).toBe('w');
  });

  it('prefers a corner over an edge at the intersection', () => {
    // Right at (300,100) both the top edge and the right edge are near; the
    // corner must win so a diagonal drag scales both axes.
    expect(roiHandleAt(ROI, { x: 300, y: 100 }, 6)).toBe('ne');
  });

  it('returns null for the interior — it passes through to selection', () => {
    expect(roiHandleAt(ROI, { x: 200, y: 150 }, 6)).toBeNull();
  });

  it('returns null well outside the rectangle', () => {
    expect(roiHandleAt(ROI, { x: 500, y: 500 }, 6)).toBeNull();
  });
});

describe('resizeRoi', () => {
  it('moves only the dragged edge', () => {
    // Drag the east edge out to x=350: width grows, left edge stays.
    expect(resizeRoi(ROI, 'e', { x: 350, y: 999 })).toEqual({ x: 100, y: 100, width: 250, height: 100 });
    // Drag the north edge up to y=40: top moves, bottom stays.
    expect(resizeRoi(ROI, 'n', { x: 999, y: 40 })).toEqual({ x: 100, y: 40, width: 200, height: 160 });
  });

  it('moves both edges for a corner', () => {
    expect(resizeRoi(ROI, 'se', { x: 400, y: 300 })).toEqual({ x: 100, y: 100, width: 300, height: 200 });
    expect(resizeRoi(ROI, 'nw', { x: 50, y: 50 })).toEqual({ x: 50, y: 50, width: 250, height: 150 });
  });

  it('can invert when an edge crosses its opposite (clamp fixes it up)', () => {
    const inverted = resizeRoi(ROI, 'e', { x: 40, y: 0 }); // west of the left edge
    expect(inverted.width).toBeLessThan(0);
    const fixed = clampRoi(inverted, 1920, 1080);
    expect(fixed.width).toBeGreaterThanOrEqual(ROI_MIN_SIZE);
  });
});

describe('rectFromDrag', () => {
  it('builds a rect from two corners', () => {
    expect(rectFromDrag({ x: 10, y: 20 }, { x: 60, y: 90 })).toEqual({ x: 10, y: 20, width: 50, height: 70 });
  });
});

describe('clampRoi', () => {
  it('flips a rectangle dragged up-and-left', () => {
    expect(clampRoi({ x: 300, y: 200, width: -200, height: -100 }, 1920, 1080)).toEqual({ x: 100, y: 100, width: 200, height: 100 });
  });

  it('keeps the rectangle inside the comp', () => {
    const r = clampRoi({ x: 1800, y: 1000, width: 400, height: 400 }, 1920, 1080);
    expect(r.x + r.width).toBeLessThanOrEqual(1920);
    expect(r.y + r.height).toBeLessThanOrEqual(1080);
  });

  it('enforces the minimum size', () => {
    const r = clampRoi({ x: 100, y: 100, width: 2, height: 1 }, 1920, 1080);
    expect(r.width).toBe(ROI_MIN_SIZE);
    expect(r.height).toBe(ROI_MIN_SIZE);
  });

  it('rounds to whole pixels', () => {
    const r = clampRoi({ x: 10.4, y: 20.6, width: 100.5, height: 50.5 }, 1920, 1080);
    expect(Number.isInteger(r.x) && Number.isInteger(r.width)).toBe(true);
  });
});
