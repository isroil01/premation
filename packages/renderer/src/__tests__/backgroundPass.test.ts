/**
 * Where the composition background gets painted, per view.
 *
 * The bug this pins: the six ortho views and the custom views painted NO
 * backdrop at all, so switching a comp to Left view threw away its background
 * colour — a dark comp and a light one rendered identically, over the same
 * pasteboard grey. Active Camera was the only view that showed it.
 *
 * Measured as clip-space COVERAGE of the emitted quad rather than by pixel
 * diff: the backdrop is one unit quad through one matrix, so the area it covers
 * is the whole behaviour, and it decomposes into two independent variables —
 * which rect, and whether the 2D camera moves it.
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

describe("backdrop 'viewport' — the ortho and custom views", () => {
  it('covers the entire clip volume', () => {
    const e = extent(backdropMvp('viewport', framingViewport(), COMP));
    expect(e.x0).toBeCloseTo(-1, 6);
    expect(e.x1).toBeCloseTo(1, 6);
    expect(e.y0).toBeCloseTo(-1, 6);
    expect(e.y1).toBeCloseTo(1, 6);
  });

  it('is INDEPENDENT of the 2D pan/zoom camera — that is what makes it uncroppable', () => {
    // The whole point: in a Left view the comp plane is edge-on and the comp
    // rect is meaningless, so the fill must not track it.
    const zoomedOut = framingViewport();
    zoomedOut.camera.setState({ center: { x: -5000, y: 900 }, zoom: 0.05 });
    const zoomedIn = framingViewport();
    zoomedIn.camera.setState({ center: { x: 400, y: 200 }, zoom: 8 });

    const a = extent(backdropMvp('viewport', zoomedOut, COMP));
    const b = extent(backdropMvp('viewport', zoomedIn, COMP));
    expect(a).toEqual(b);
    expect(a.x0).toBeCloseTo(-1, 6);
    expect(a.x1).toBeCloseTo(1, 6);
  });

  it('does not depend on the composition size either', () => {
    const vp = framingViewport();
    const square = extent(backdropMvp('viewport', vp, { width: 100, height: 100 }));
    const wide = extent(backdropMvp('viewport', vp, { width: 4096, height: 128 }));
    expect(square).toEqual(wide);
  });

  it('degenerate comp size still covers the viewport', () => {
    // A zero-size comp is not reachable through the UI, but a backdrop that
    // silently vanished on one would be exactly the failure this test exists
    // to prevent — and `modelFromRect` would collapse to a point here.
    const e = extent(backdropMvp('viewport', framingViewport(), { width: 0, height: 0 }));
    expect(e.x1 - e.x0).toBeCloseTo(2, 6);
    expect(e.y1 - e.y0).toBeCloseTo(2, 6);
  });
});

describe("backdrop 'frame' — Active Camera (the default, unchanged)", () => {
  it('covers exactly the clip volume when the camera frames the comp', () => {
    const e = extent(backdropMvp('frame', framingViewport(), COMP));
    expect(e.x0).toBeCloseTo(-1, 6);
    expect(e.x1).toBeCloseTo(1, 6);
    expect(e.y0).toBeCloseTo(-1, 6);
    expect(e.y1).toBeCloseTo(1, 6);
  });

  it('TRACKS the 2D camera — zooming out shrinks the artboard against the pasteboard', () => {
    const vp = framingViewport();
    vp.camera.setState({ center: { x: COMP.width / 2, y: COMP.height / 2 }, zoom: 0.5 });
    const e = extent(backdropMvp('frame', vp, COMP));
    // Half zoom ⇒ the comp occupies half the clip volume, still centred.
    expect(e.x1 - e.x0).toBeCloseTo(1, 6);
    expect(e.y1 - e.y0).toBeCloseTo(1, 6);
    expect(e.x0 + e.x1).toBeCloseTo(0, 6);
  });

  it('panning moves it off-centre', () => {
    const vp = framingViewport();
    vp.camera.setState({ center: { x: COMP.width / 2 + COMP.width, y: COMP.height / 2 }, zoom: 1 });
    const e = extent(backdropMvp('frame', vp, COMP));
    // Panned one full comp width right ⇒ the comp sits one full width left.
    expect(e.x1).toBeCloseTo(-1, 6);
  });

  it('is byte-identical to the pre-existing comp-rect matrix, so no existing scene moves', () => {
    const vp = framingViewport();
    vp.camera.setState({ center: { x: 123, y: 456 }, zoom: 0.37 });
    expect(backdropMvp('frame', vp, COMP)).toEqual(
      Mat3.multiply(vp.camera.viewProjectionMatrix(), Mat3.multiply(Mat3.translation(0, 0), Mat3.scaling(COMP.width, COMP.height))),
    );
  });
});
