/**
 * Where the composition backdrop lands in clip space.
 *
 * One unit quad through one matrix, so the area it covers IS the whole
 * behaviour — measured as clip-space coverage rather than by pixel diff, and
 * decomposed into the two independent variables: which rect, and how the 2D
 * pan/zoom camera moves it.
 *
 * The defect this guards: the six ortho views and the three custom views used to
 * paint no backdrop at all, so a comp switched to Left lost its artboard
 * entirely while its layers kept drawing. There is now no per-view branch left
 * to regress — `backdropMvp` takes no mode, and
 * `src/core/rendering/viewBackdrop.test.ts` proves the pass runs in every view.
 */

import { Mat3 } from '../core/math/Mat3';
import { Viewport } from '../viewport/Viewport';
import { backdropMvp } from '../rendergraph/passes/BackgroundPass';

const COMP = { width: 1920, height: 1080 };

/** The unit quad's corners in clip space under `mvp`. */
const corners = (mvp: Mat3): { x: number; y: number }[] =>
  [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ].map((p) => Mat3.transformPoint(mvp, p));

/** Axis-aligned clip-space extent of the covered quad. */
const extent = (mvp: Mat3) => {
  const c = corners(mvp);
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

/** A viewport whose 2D camera exactly frames the comp. */
const framingViewport = (): Viewport => {
  const vp = new Viewport({ width: COMP.width, height: COMP.height });
  vp.camera.setState({ center: { x: COMP.width / 2, y: COMP.height / 2 }, zoom: 1 });
  return vp;
};

describe('the backdrop covers the comp rect', () => {
  it('fills the clip volume when the camera frames the comp', () => {
    const e = extent(backdropMvp(framingViewport(), COMP));
    expect(e.x0).toBeCloseTo(-1, 6);
    expect(e.x1).toBeCloseTo(1, 6);
    expect(e.y0).toBeCloseTo(-1, 6);
    expect(e.y1).toBeCloseTo(1, 6);
  });

  it('TRACKS the 2D camera — zooming out shrinks the artboard against the pasteboard', () => {
    const vp = framingViewport();
    vp.camera.setState({ center: { x: COMP.width / 2, y: COMP.height / 2 }, zoom: 0.5 });
    const e = extent(backdropMvp(vp, COMP));
    // Half zoom ⇒ the comp occupies half the clip volume, still centred. This is
    // what makes it read as an ARTBOARD rather than a full-bleed wash, which is
    // the behaviour Active Camera has always had and the other views now share.
    expect(e.x1 - e.x0).toBeCloseTo(1, 6);
    expect(e.y1 - e.y0).toBeCloseTo(1, 6);
    expect(e.x0 + e.x1).toBeCloseTo(0, 6);
  });

  it('panning moves it off-centre', () => {
    const vp = framingViewport();
    vp.camera.setState({ center: { x: COMP.width / 2 + COMP.width, y: COMP.height / 2 }, zoom: 1 });
    const e = extent(backdropMvp(vp, COMP));
    // Panned one full comp width right ⇒ the comp sits one full width left.
    expect(e.x1).toBeCloseTo(-1, 6);
  });

  it('scales with the composition, not with some fixed frame', () => {
    const vp = framingViewport();
    const half = extent(backdropMvp(vp, { width: COMP.width / 2, height: COMP.height / 2 }));
    expect(half.x1 - half.x0).toBeCloseTo(1, 6);
    expect(half.y1 - half.y0).toBeCloseTo(1, 6);
  });

  it('is byte-identical to the pre-existing comp-rect matrix, so no existing scene moves', () => {
    const vp = framingViewport();
    vp.camera.setState({ center: { x: 123, y: 456 }, zoom: 0.37 });
    expect(backdropMvp(vp, COMP)).toEqual(
      Mat3.multiply(
        vp.camera.viewProjectionMatrix(),
        Mat3.multiply(Mat3.translation(0, 0), Mat3.scaling(COMP.width, COMP.height)),
      ),
    );
  });

  it('a degenerate zero-size comp collapses to a point rather than throwing', () => {
    // Not reachable through the UI, but `modelFromRect` scales by w/h and a NaN
    // matrix here would take the whole frame down, not just the backdrop.
    const e = extent(backdropMvp(framingViewport(), { width: 0, height: 0 }));
    for (const v of [e.x0, e.x1, e.y0, e.y1]) expect(Number.isFinite(v)).toBe(true);
  });
});
