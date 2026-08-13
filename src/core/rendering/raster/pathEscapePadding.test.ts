/**
 * The raster has to be big enough for the path that is actually drawn.
 *
 * `rasterPadding` sized the texture from the STROKE alone. A path operator
 * moves points — Zigzag displaces them perpendicular by its `amount` — so the
 * outline provably leaves the layer's w×h box, and the mitred spike tips were
 * sliced off at the texture edge. Measured on the `shape-path-op-zigzag` golden
 * scene: inked extent 238px against the reference's 262px, and 22% of the
 * stroke's pixels simply absent. After the fix both extents are 262px and the
 * stroke pixel counts agree to within one pixel.
 *
 * Asserted here on the pure function so the arithmetic is pinned without a GPU.
 */

import { rasterPadding } from './vectorDraw';
import type { RenderLayer } from '../RenderBackend';
import { corner } from '../../../../packages/workspace/src/math/BezierPoint';

/**
 * A point in the SAME convention production uses.
 *
 * Handles are ABSOLUTE positions: `corner()` sets `inX === outX === x`
 * (BezierPoint.ts:15), and `shapePath` passes them straight to
 * `bezierCurveTo`. This helper used to default them to literal `0`, which is
 * not a corner — it is a handle pinned at the origin — and every expectation
 * below was fitted to `rasterPadding`'s matching misreading of `x + inX`. A
 * test double modelling a different system than production: it pinned the bug
 * instead of catching it (F17).
 */
const pt = (x: number, y: number, h: Partial<Record<'inX' | 'inY' | 'outX' | 'outY', number>> = {}) =>
  ({ ...corner(x, y), ...h });

function shape(over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id: 's', kind: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    width: 100, height: 100, fill: '#f00', visible: true, primitive: 'path',
    ...over,
  } as unknown as RenderLayer;
}

describe('rasterPadding — path escape', () => {
  it('is zero for a path that stays inside its box', () => {
    // Centred local space: the box spans −50..50 on both axes.
    expect(rasterPadding(shape({ pathPoints: [pt(-50, -50), pt(50, -50), pt(0, 50)] as never }))).toBe(0);
  });

  it('grows by how far the path leaves the box', () => {
    // 16px out on x — a Zigzag of amount 16.
    const pad = rasterPadding(shape({ pathPoints: [pt(-66, 0), pt(50, -50), pt(0, 50)] as never }));
    expect(pad).toBeGreaterThanOrEqual(16);
    expect(pad).toBeLessThanOrEqual(18); // +1 rounding guard, nothing more
  });

  it('adds the STROKE on top of the escape — the stroke follows the path out', () => {
    const pts = [pt(-66, 0), pt(50, -50), pt(0, 50)] as never;
    const bare = rasterPadding(shape({ pathPoints: pts }));
    const stroked = rasterPadding(shape({
      pathPoints: pts,
      stroke: { enabled: true, color: '#fff', width: 8, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' },
    } as never));
    // This is the whole defect: the old code took max(escape, stroke) — here it
    // must be escape PLUS the band drawn around wherever the path went.
    expect(stroked).toBeGreaterThanOrEqual(bare + 8);
  });

  it('counts BEZIER HANDLES, not just anchors', () => {
    // Every ANCHOR is inside the −50..50 box; the handle at x=70 is not. The
    // curve bulges toward it, so the raster has to cover it.
    const pad = rasterPadding(shape({ pathPoints: [pt(-50, -50), pt(50, -50), pt(40, 0, { outX: 70 })] as never }));
    expect(pad).toBeGreaterThanOrEqual(20);
  });

  it('reads handles as ABSOLUTE, the way shapePath draws them', () => {
    // The regression this pins: a corner's handles equal its anchor, so a shape
    // that fits its box needs NO padding. Read as offsets, `x + inX` doubles
    // every coordinate and a 100×100 layer whose points sit exactly on the edge
    // pads 50px for geometry that never left.
    expect(rasterPadding(shape({ pathPoints: [pt(-50, -50), pt(50, -50), pt(50, 50)] as never }))).toBe(0);
    // And an INWARD handle cannot manufacture escape either.
    expect(rasterPadding(shape({ pathPoints: [pt(-50, -50), pt(50, -50), pt(45, 0, { outX: 10 })] as never }))).toBe(0);
  });

  it('is bounded — an absurd path clips rather than allocating without limit', () => {
    const pad = rasterPadding(shape({ pathPoints: [pt(-9000, 0), pt(50, -50), pt(0, 50)] as never }));
    expect(pad).toBeLessThanOrEqual(512);
  });

  it('leaves a plain stroked rect exactly as it was', () => {
    // No pathPoints → the stroke-only rule, untouched.
    expect(rasterPadding(shape({
      primitive: 'rect',
      stroke: { enabled: true, color: '#fff', width: 8, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' },
    } as never))).toBe(9); // ceil(8 + 1)
  });
});
