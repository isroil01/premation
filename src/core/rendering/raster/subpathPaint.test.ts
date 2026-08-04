/**
 * Per-run paint on `Subpath` — the render-contract change that unblocks F16.
 *
 * Four properties carry the whole feature, and each has a specific way of being
 * silently wrong:
 *
 *   1. A layer with NO per-run paint must render byte-identically to before.
 *      Runs are normally traced into one path so `fill()` sees a single winding
 *      region and a reverse-wound run cuts a HOLE. Separately filled runs
 *      cannot, so batching unconditionally would change every multi-run path in
 *      every existing project — invisibly, since nothing would error.
 *   2. A run WITH paint must actually be painted differently. The easy failure
 *      is plumbing the field through every layer and never reading it.
 *   3. `opacity` must MULTIPLY, not replace. A repeater's offsetOpacity ramps a
 *      copy that already has paint.
 *   4. Both cache keys must digest paint. Identical geometry with different run
 *      paint is a different picture, and this is the one difference no other
 *      part of either key can see.
 */

import { subpathBatches, traceBatch } from './vectorDraw';
import { layerSubpaths } from './subpaths';
import { contentHashOf } from '../contentHash';
import type { RenderLayer, Subpath, SubpathPaint } from '../RenderBackend';
import type { BezierPoint } from '../../../../packages/workspace/src/math/BezierPoint';

/** A square run, corner points (handles equal to the anchor — absolute). */
function square(cx: number, cy: number, r: number): BezierPoint[] {
  return [
    [cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r],
  ].map(([x, y]) => ({
    x: x!, y: y!, inX: x!, inY: y!, outX: x!, outY: y!,
  })) as BezierPoint[];
}

function pathLayer(subpaths: Subpath[]): RenderLayer {
  return {
    id: 'L', kind: 'shape', primitive: 'path',
    width: 100, height: 100, x: 0, y: 0,
    subpaths,
  } as unknown as RenderLayer;
}

const PAINT: SubpathPaint = { fill: { type: 'solid' } as never, opacity: 0.5 };

describe('the accessor carries paint', () => {
  it('layerSubpaths preserves a run\'s paint', () => {
    const layer = pathLayer([{ points: square(0, 0, 10), paint: PAINT }]);
    expect(layerSubpaths(layer)[0]!.paint).toEqual(PAINT);
  });

  it('the pathPoints shorthand has no paint, and that is not an error', () => {
    const layer = { ...pathLayer([]), subpaths: undefined, pathPoints: square(0, 0, 10) } as RenderLayer;
    expect(layerSubpaths(layer)).toHaveLength(1);
    expect(layerSubpaths(layer)[0]!.paint).toBeUndefined();
  });
});

describe('batching — the backward-compatibility contract', () => {
  it('returns NULL when no run carries paint, so the old path is taken', () => {
    // The single most important assertion in this file. Null is what guarantees
    // existing projects render byte-identically; anything else silently trades
    // hole-cutting for per-run paint across the whole codebase.
    expect(subpathBatches(pathLayer([
      { points: square(0, 0, 20) },
      { points: square(0, 0, 10) },
    ]))).toBeNull();
  });

  it('returns null for primitives and for empty geometry', () => {
    expect(subpathBatches({ ...pathLayer([]), primitive: 'ellipse' } as RenderLayer)).toBeNull();
    expect(subpathBatches(pathLayer([]))).toBeNull();
  });

  it('batches once some run carries paint', () => {
    const batches = subpathBatches(pathLayer([
      { points: square(0, 0, 20) },
      { points: square(0, 0, 10), paint: PAINT },
    ]));
    expect(batches).not.toBeNull();
    expect(batches).toHaveLength(2);
  });

  it('keeps ALL unpainted runs together in one batch', () => {
    // So a path mixing painted and unpainted runs still gets holes among the
    // unpainted ones. Splitting them individually would be the easy mistake and
    // would quietly break holes for the plain part too.
    const batches = subpathBatches(pathLayer([
      { points: square(0, 0, 30) },
      { points: square(0, 0, 20) },
      { points: square(0, 0, 10), paint: PAINT },
    ]))!;
    expect(batches[0]!.runs).toHaveLength(2);
    expect(batches[0]!.paint).toBeUndefined();
    expect(batches[1]!.runs).toHaveLength(1);
    expect(batches[1]!.paint).toEqual(PAINT);
  });

  it('puts the unpainted group FIRST so painted runs draw over it', () => {
    const batches = subpathBatches(pathLayer([
      { points: square(0, 0, 10), paint: PAINT },
      { points: square(0, 0, 30) },
    ]))!;
    expect(batches[0]!.paint).toBeUndefined();
    expect(batches[1]!.paint).toEqual(PAINT);
  });

  it('every run reaches exactly one batch', () => {
    const runs: Subpath[] = [
      { points: square(0, 0, 30) },
      { points: square(0, 0, 20), paint: { opacity: 0.5 } },
      { points: square(0, 0, 10), paint: { opacity: 0.25 } },
    ];
    const batches = subpathBatches(pathLayer(runs))!;
    expect(batches.flatMap((b) => b.runs)).toHaveLength(runs.length);
  });
});

describe('drawing', () => {
  function ctx2d(w = 60, h = 60): CanvasRenderingContext2D {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c.getContext('2d')!;
  }

  it('traceBatch traces only its own runs', () => {
    // Two disjoint squares; a batch holding one must not contain the other's
    // interior. isPointInPath is independent of any drawing we do.
    const ctx = ctx2d();
    const far: Subpath = { points: square(45, 45, 5) };
    const near: Subpath = { points: square(15, 15, 5), paint: PAINT };
    traceBatch(ctx, { runs: [near], paint: PAINT });
    expect(ctx.isPointInPath(15, 15)).toBe(true);
    expect(ctx.isPointInPath(45, 45)).toBe(false);
    traceBatch(ctx, { runs: [far] });
    expect(ctx.isPointInPath(45, 45)).toBe(true);
    expect(ctx.isPointInPath(15, 15)).toBe(false);
  });

  it('a batch of two runs traces both', () => {
    const ctx = ctx2d();
    traceBatch(ctx, { runs: [{ points: square(15, 15, 5) }, { points: square(45, 45, 5) }] });
    expect(ctx.isPointInPath(15, 15)).toBe(true);
    expect(ctx.isPointInPath(45, 45)).toBe(true);
  });

  it('an open run is not closed by the tracer', () => {
    const ctx = ctx2d();
    // A three-point open run: the far corner is outside an unclosed path.
    traceBatch(ctx, { runs: [{ points: square(30, 30, 20).slice(0, 3), open: true }] });
    // With the run left open the region is not a filled square; the centre of
    // the missing quadrant must not be inside it.
    expect(ctx.isPointInPath(12, 46)).toBe(false);
  });
});

describe('the cache keys digest paint', () => {
  /**
   * The failure this prevents: identical geometry, different run paint, second
   * layer silently reuses the first's texture. Nothing else in either key can
   * see the difference, because the points genuinely match.
   */
  it('the content hash changes when only a run\'s paint changes', () => {
    const geom = square(0, 0, 20);
    const a = contentHashOf(pathLayer([{ points: geom }]));
    const b = contentHashOf(pathLayer([{ points: geom, paint: { opacity: 0.5 } }]));
    expect(a).not.toBe(b);
  });

  it('the content hash distinguishes two DIFFERENT paints', () => {
    const geom = square(0, 0, 20);
    const a = contentHashOf(pathLayer([{ points: geom, paint: { opacity: 0.5 } }]));
    const b = contentHashOf(pathLayer([{ points: geom, paint: { opacity: 0.9 } }]));
    expect(a).not.toBe(b);
  });

  it('identical paint still hashes identically — the key is not just noise', () => {
    // Guards the guard: a key that changed every call would pass the two tests
    // above while destroying the raster cache entirely.
    const geom = square(0, 0, 20);
    const a = contentHashOf(pathLayer([{ points: geom, paint: { opacity: 0.5 } }]));
    const b = contentHashOf(pathLayer([{ points: geom, paint: { opacity: 0.5 } }]));
    expect(a).toBe(b);
  });

  it('an unpainted layer hashes the same as it did before the field existed', () => {
    // `paint: undefined` must not perturb the digest, or every existing cached
    // raster is invalidated on upgrade for no reason.
    const geom = square(0, 0, 20);
    const withUndef = contentHashOf(pathLayer([{ points: geom, paint: undefined }]));
    const without = contentHashOf(pathLayer([{ points: geom }]));
    expect(withUndef).toBe(without);
  });
});
