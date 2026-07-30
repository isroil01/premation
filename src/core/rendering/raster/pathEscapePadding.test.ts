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

const pt = (x: number, y: number, h: Partial<Record<'inX' | 'inY' | 'outX' | 'outY', number>> = {}) =>
  ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0, ...h });

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
    // An anchor inside the box whose handle reaches out still bulges out.
    const pad = rasterPadding(shape({ pathPoints: [pt(-50, -50), pt(50, -50), pt(40, 0, { outX: 30 })] as never }));
    expect(pad).toBeGreaterThanOrEqual(20);
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
