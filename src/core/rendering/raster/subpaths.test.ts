/**
 * Multi-subpath geometry — the render contract carries a LIST of runs.
 *
 * A shape's geometry was a single polyline (`RenderLayer.pathPoints`), which is
 * the reason Trim Paths could only ever annotate the stroke: cutting a path into
 * two visible arcs produces two runs and there was nowhere to put the second.
 * `trimPolyline` has returned `Pt[][]` since it was written; the list died
 * inside `strokeTrimmed` and never reached the renderer.
 *
 * These guards pin the three things that make the lifted contract safe:
 *
 *  1. ONE reader. `layerSubpaths` is the only code that knows about both
 *     `pathPoints` and `subpaths`, so the fill and the stroke cannot end up
 *     reading different fields — the §2·0 failure this shape invites.
 *  2. The trace draws EVERY run into ONE Canvas path, so `fill()` sees one
 *     region and `stroke()` sees independent runs. Asserted against a recording
 *     context — jsdom has no canvas, and the pixels are gated by
 *     `packages/render-tests` (real Chromium) instead.
 *  3. Run STRUCTURE is in both cache keys. A path split 2+2 and the same points
 *     split 1+3 are different drawings and must not share a texture.
 */

import { layerSubpaths, hasPathGeometry, assertSinglePathSource } from './subpaths';
import { rasterPadding, shapePath } from './vectorDraw';
import { contentHashOf } from '../contentHash';
import type { RenderLayer } from '../RenderBackend';
import { corner } from '../../../../packages/workspace/src/math/BezierPoint';

function shape(over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id: 's', kind: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    width: 100, height: 100, fill: '#f00', visible: true, primitive: 'path',
    ...over,
  } as unknown as RenderLayer;
}

/** Records the path commands `shapePath` issues. jsdom has no 2D context. */
interface Recorded { op: string; args: number[] }
function recordingCtx(): { ctx: CanvasRenderingContext2D; log: Recorded[] } {
  const log: Recorded[] = [];
  const push = (op: string) => (...args: number[]) => { log.push({ op, args }); };
  const ctx = {
    beginPath: push('beginPath'),
    moveTo: push('moveTo'),
    lineTo: push('lineTo'),
    bezierCurveTo: push('bezierCurveTo'),
    closePath: push('closePath'),
    ellipse: push('ellipse'),
    rect: push('rect'),
    arcTo: push('arcTo'),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, log };
}

const runA = [corner(-40, -40), corner(40, -40), corner(40, 40)];
const runB = [corner(-40, 40), corner(-40, 0)];

describe('layerSubpaths — the one reader', () => {
  it('wraps the pathPoints shorthand into a single run', () => {
    const runs = layerSubpaths(shape({ pathPoints: runA }));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.points).toBe(runA);
  });

  it('carries the layer-level pathOpen onto the wrapped run', () => {
    expect(layerSubpaths(shape({ pathPoints: runA, pathOpen: true }))[0]!.open).toBe(true);
    expect(layerSubpaths(shape({ pathPoints: runA }))[0]!.open).toBe(false);
  });

  it('returns the list verbatim when subpaths are present', () => {
    const runs = layerSubpaths(shape({ subpaths: [{ points: runA, open: true }, { points: runB, open: true }] }));
    expect(runs).toHaveLength(2);
    expect(runs[1]!.points).toBe(runB);
  });

  it('is empty for a primitive with no path geometry — a rect is not "nothing to draw"', () => {
    expect(layerSubpaths(shape({ primitive: 'rect' }))).toEqual([]);
    expect(hasPathGeometry(shape({ primitive: 'rect' }))).toBe(false);
  });

  it('rejects a layer carrying BOTH fields — the invariant writers must hold', () => {
    expect(() => assertSinglePathSource(shape({ pathPoints: runA, subpaths: [{ points: runB }] }))).toThrow(
      /mutually exclusive/,
    );
    expect(() => assertSinglePathSource(shape({ subpaths: [{ points: runB }] }))).not.toThrow();
    expect(() => assertSinglePathSource(shape({ pathPoints: runA }))).not.toThrow();
  });
});

describe('shapePath — every run reaches the trace', () => {
  it('emits one moveTo per run inside a single beginPath', () => {
    const { ctx, log } = recordingCtx();
    shapePath(ctx, shape({ subpaths: [{ points: runA, open: true }, { points: runB, open: true }] }));
    expect(log.filter((c) => c.op === 'beginPath')).toHaveLength(1);
    const moves = log.filter((c) => c.op === 'moveTo');
    expect(moves).toHaveLength(2);
    expect(moves[0]!.args).toEqual([-40, -40]);
    expect(moves[1]!.args).toEqual([-40, 40]);
  });

  it('leaves OPEN runs unclosed and closes closed ones', () => {
    const open = recordingCtx();
    shapePath(open.ctx, shape({ subpaths: [{ points: runA, open: true }, { points: runB, open: true }] }));
    expect(open.log.filter((c) => c.op === 'closePath')).toHaveLength(0);

    const closed = recordingCtx();
    shapePath(closed.ctx, shape({ subpaths: [{ points: runA }, { points: runB }] }));
    expect(closed.log.filter((c) => c.op === 'closePath')).toHaveLength(2);
  });

  it('draws the single-run shorthand exactly as it did before subpaths existed', () => {
    const viaShorthand = recordingCtx();
    shapePath(viaShorthand.ctx, shape({ pathPoints: runA }));
    const viaList = recordingCtx();
    shapePath(viaList.ctx, shape({ subpaths: [{ points: runA, open: false }] }));
    expect(viaShorthand.log).toEqual(viaList.log);
  });

  it('an open run stops at its last point — no closing segment back to the start', () => {
    // 3 anchors: closed traces 3 curve segments, open traces 2.
    const closed = recordingCtx();
    shapePath(closed.ctx, shape({ subpaths: [{ points: runA }] }));
    const open = recordingCtx();
    shapePath(open.ctx, shape({ subpaths: [{ points: runA, open: true }] }));
    expect(closed.log.filter((c) => c.op === 'bezierCurveTo')).toHaveLength(3);
    expect(open.log.filter((c) => c.op === 'bezierCurveTo')).toHaveLength(2);
  });
});

describe('rasterPadding — measures every run, not just the first', () => {
  it('grows for geometry that escapes the box in the SECOND run', () => {
    const inside = [corner(-40, -40), corner(40, -40)];
    const escaping = [corner(-90, 0), corner(0, 0)];
    const pad = rasterPadding(shape({ subpaths: [{ points: inside, open: true }, { points: escaping, open: true }] }));
    // -90 is 40px outside the −50..50 box. Before the lift this returned 0:
    // the function read `pathPoints`, which a multi-run layer does not have.
    expect(pad).toBeGreaterThanOrEqual(40);
  });

  it('is unchanged for the single-run shorthand', () => {
    const pts = [corner(-66, 0), corner(50, -50), corner(0, 50)];
    expect(rasterPadding(shape({ subpaths: [{ points: pts }] }))).toBe(rasterPadding(shape({ pathPoints: pts })));
  });
});

describe('cache keys carry run STRUCTURE', () => {
  const all = [corner(0, 0), corner(10, 0), corner(10, 10), corner(0, 10)];
  const split2x2 = shape({ subpaths: [{ points: all.slice(0, 2), open: true }, { points: all.slice(2), open: true }] });
  const split1x3 = shape({ subpaths: [{ points: all.slice(0, 1), open: true }, { points: all.slice(1), open: true }] });

  it('two different splits of the same points hash differently', () => {
    expect(contentHashOf(split2x2)).not.toBe(contentHashOf(split1x3));
  });

  it('distinguishes splits that share a first run — the tail is hashed too', () => {
    // Same opening run; the remainder split one way or two. A key built from
    // only the first run (or from a flattened point list) collapses these.
    const a = shape({ subpaths: [{ points: all.slice(0, 2), open: true }, { points: all.slice(2, 4), open: true }] });
    const b = shape({ subpaths: [
      { points: all.slice(0, 2), open: true },
      { points: all.slice(2, 3), open: true },
      { points: all.slice(3, 4), open: true },
    ] });
    expect(contentHashOf(a)).not.toBe(contentHashOf(b));
  });

  it('joining the runs into one changes the hash', () => {
    expect(contentHashOf(shape({ subpaths: [{ points: all, open: true }] }))).not.toBe(contentHashOf(split2x2));
  });

  it('open vs closed changes the hash — same points, different drawing', () => {
    expect(contentHashOf(shape({ subpaths: [{ points: all, open: true }] })))
      .not.toBe(contentHashOf(shape({ subpaths: [{ points: all, open: false }] })));
  });

  it('the shorthand and the equivalent one-run list hash the SAME', () => {
    // Same drawing ⇒ same texture. If these diverged, lifting the contract
    // would silently invalidate every cached shape texture in the app.
    expect(contentHashOf(shape({ pathPoints: all }))).toBe(contentHashOf(shape({ subpaths: [{ points: all, open: false }] })));
  });
});
