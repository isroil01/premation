import { smoothContour } from './traceBitmap';

/**
 * Traced TYPE must keep its corners. The default smoothing fits a Catmull–Rom
 * tangent through every vertex, sized by the span between its neighbours: on a
 * simplified letter (long straight runs between sharp turns) that bulged every
 * stem and rounded every corner — "PREMIUM" traced as melted letters, and 3D
 * text extrusion, which builds its solid from this outline, extruded the melt.
 */
const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];

describe('smoothContour with a corner angle', () => {
  it('leaves a right-angle corner sharp — no handles at all', () => {
    for (const p of smoothContour(square, 0.55, 38)) {
      expect([p.inX, p.inY, p.outX, p.outY]).toEqual([p.x, p.y, p.x, p.y]);
    }
  });

  it('without one, the same square is rounded (the behaviour traced artwork keeps)', () => {
    const p = smoothContour(square, 0.55)[0]!;
    expect(Math.hypot(p.outX - p.x, p.outY - p.y)).toBeGreaterThan(10);
  });

  it('a vertex on a straight run gets handles ALONG the run, so the stem cannot bulge', () => {
    const stem = [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 300 }, { x: 40, y: 300 }, { x: 40, y: 0 }];
    const mid = smoothContour(stem, 0.55, 38)[1]!;
    expect(mid.inX).toBeCloseTo(0); expect(mid.outX).toBeCloseTo(0);
  });

  it('sizes each handle by its OWN segment, not the neighbour span', () => {
    // A gentle bend between a short and a long segment.
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 210, y: 20 }, { x: 210, y: 200 }, { x: 0, y: 200 }];
    const p = smoothContour(pts, 0.55, 38)[1]!;
    const inLen = Math.hypot(p.inX - p.x, p.inY - p.y), outLen = Math.hypot(p.outX - p.x, p.outY - p.y);
    expect(inLen).toBeLessThan(10 / 3 + 0.01);
    expect(outLen).toBeGreaterThan(inLen * 10);
  });

  it('keeps a round shape round: a 24-gon stays smooth at every vertex', () => {
    const ring = Array.from({ length: 24 }, (_, i) => ({ x: Math.cos((i / 24) * 2 * Math.PI) * 50, y: Math.sin((i / 24) * 2 * Math.PI) * 50 }));
    for (const p of smoothContour(ring, 0.55, 38)) expect(Math.hypot(p.outX - p.x, p.outY - p.y)).toBeGreaterThan(1);
  });
});
