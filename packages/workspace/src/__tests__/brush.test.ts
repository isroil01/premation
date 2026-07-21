/**
 * Brush ribbon math — the variable-width ink outline the BrushTool commits.
 */

import { ribbonOutline, drawToolOptions, BrushTool } from '../tools/builtin';

const flat = (n: number, pressure = 1) =>
  Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, pressure }));

describe('ribbonOutline', () => {
  it('returns an empty outline for fewer than 2 samples', () => {
    expect(ribbonOutline([], 10, 0, false)).toHaveLength(0);
    expect(ribbonOutline([{ x: 0, y: 0, pressure: 1 }], 10, 0, false)).toHaveLength(0);
  });

  it('produces a closed outline with 2× the sample count', () => {
    const out = ribbonOutline(flat(6), 10, 0, false);
    expect(out).toHaveLength(12); // left side + right side
  });

  it('a straight full-pressure stroke with no taper is size wide', () => {
    const out = ribbonOutline(flat(5), 10, 0, false);
    // Left points sit at +5, right points at -5 around y = 0.
    const ys = out.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(5, 5);
    expect(Math.min(...ys)).toBeCloseTo(-5, 5);
  });

  it('taper narrows the ends but not the middle', () => {
    const out = ribbonOutline(flat(11), 10, 100, false);
    const n = 11;
    const leftFirst = out[0]!;
    const leftMid = out[Math.floor(n / 2)]!;
    expect(Math.abs(leftFirst.y)).toBeLessThan(Math.abs(leftMid.y));
  });

  it('pressure scales the local width', () => {
    const soft = ribbonOutline(flat(5, 0.3), 10, 0, true);
    const hard = ribbonOutline(flat(5, 1), 10, 0, true);
    expect(Math.abs(soft[2]!.y)).toBeLessThan(Math.abs(hard[2]!.y));
  });

  it('ignores pressure when the option is off', () => {
    const soft = ribbonOutline(flat(5, 0.3), 10, 0, false);
    expect(Math.abs(soft[2]!.y)).toBeCloseTo(5, 5);
  });
});

describe('BrushTool', () => {
  it('registers with the expected id and exposes its ribbon as pendingPoints', () => {
    const tool = new BrushTool();
    expect(tool.id).toBe('brush');
    expect(tool.pendingPoints).toHaveLength(0);
  });

  it('drawToolOptions carries the brush and shape defaults', () => {
    expect(drawToolOptions.brushSize).toBeGreaterThan(0);
    expect(drawToolOptions.polygonSides).toBeGreaterThanOrEqual(3);
    expect(drawToolOptions.starPoints).toBeGreaterThanOrEqual(3);
  });
});
