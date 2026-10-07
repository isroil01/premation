import { liquifyDabInto, liquifyFieldOf, liquifyGridFor, sampleLiquifyField, type LiquifyDab } from './liquifyField';

const W = 640;
const H = 320;
const grid = liquifyGridFor(W, H);
const dab = (o: Partial<LiquifyDab>): LiquifyDab => ({ tool: 'warp', x: 320, y: 160, radius: 60, pressure: 1, dx: 0, dy: 0, seed: 1, ...o });

describe('Liquify field (AE parity 5.5)', () => {
  it('sizes the grid to the box and starts flat', () => {
    expect(grid.cols).toBe(64);
    expect(grid.rows).toBe(32);
    const f = liquifyFieldOf(undefined, undefined, grid);
    expect(f).toHaveLength(65 * 33 * 2);
    expect(f.every((v) => v === 0)).toBe(true);
    // A stored field for another grid is not reused.
    expect(liquifyFieldOf([1, 2], [3, 3], grid).every((v) => v === 0)).toBe(true);
  });

  it('Warp pushes along the drag, strongest at the centre, nothing outside the brush', () => {
    const f = liquifyDabInto(liquifyFieldOf(undefined, undefined, grid), grid, W, H, dab({ dx: 10, dy: 0 }));
    const centre = sampleLiquifyField(f, grid, W, H, 320, 160);
    const edge = sampleLiquifyField(f, grid, W, H, 370, 160);
    const outside = sampleLiquifyField(f, grid, W, H, 500, 160);
    expect(centre.x).toBeCloseTo(10, 5);
    expect(edge.x).toBeGreaterThan(0);
    expect(edge.x).toBeLessThan(centre.x);
    expect(outside.x).toBe(0);
    expect(centre.y).toBeCloseTo(0, 9);
  });

  it('Pucker and Bloat move reads out from / in toward the centre; Twirl turns them', () => {
    const p = liquifyDabInto(liquifyFieldOf(undefined, undefined, grid), grid, W, H, dab({ tool: 'pucker' }));
    // Right of the centre, Pucker reads from farther right: offset (read = p − offset) is negative x.
    expect(sampleLiquifyField(p, grid, W, H, 340, 160).x).toBeLessThan(0);
    const b = liquifyDabInto(liquifyFieldOf(undefined, undefined, grid), grid, W, H, dab({ tool: 'bloat' }));
    expect(sampleLiquifyField(b, grid, W, H, 340, 160).x).toBeGreaterThan(0);
    const t = liquifyDabInto(liquifyFieldOf(undefined, undefined, grid), grid, W, H, dab({ tool: 'twirlCW' }));
    const o = sampleLiquifyField(t, grid, W, H, 350, 160);
    expect(Math.abs(o.y)).toBeGreaterThan(0.1);
  });

  it('Reconstruction relaxes the field back toward flat', () => {
    const f = liquifyDabInto(liquifyFieldOf(undefined, undefined, grid), grid, W, H, dab({ dx: 20 }));
    const before = sampleLiquifyField(f, grid, W, H, 320, 160).x;
    liquifyDabInto(f, grid, W, H, dab({ tool: 'reconstruction' }));
    expect(sampleLiquifyField(f, grid, W, H, 320, 160).x).toBeLessThan(before);
  });

  it('Turbulence is deterministic for a seed', () => {
    const a = liquifyDabInto(liquifyFieldOf(undefined, undefined, grid), grid, W, H, dab({ tool: 'turbulence', seed: 5 }));
    const b = liquifyDabInto(liquifyFieldOf(undefined, undefined, grid), grid, W, H, dab({ tool: 'turbulence', seed: 5 }));
    expect(a).toEqual(b);
    expect(a.some((v) => v !== 0)).toBe(true);
  });
});
