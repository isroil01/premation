/**
 * Taper and Wave reach pixels — `strokeShapeProfiled`.
 *
 * ## Rule 5·0 — the observable, the layer, the medium
 *
 * The observable is THE OUTLINE THAT GETS FILLED: a tapered stroke is narrower
 * at its tapered end, a waved one leaves the original centreline. That is
 * produced by Canvas2D path calls, so the medium is a RECORDING context — the
 * `moveTo`/`lineTo` sequence the function actually emits, not a re-derivation of
 * what it should emit.
 *
 * Recovering the width from those coordinates is what makes this a real check
 * rather than a restatement: the ring is `[...left, ...right.reverse()]`, so
 * vertex `i` on the left pairs with `ring[len − 1 − i]` on the right, and the
 * distance between them IS the stroke width at that point. The expected width
 * comes from `taperWidthFactorAt`, which was pinned to paper values separately.
 *
 * ## Rule 3a — never a straight line
 *
 * A straight path has one normal everywhere, so a ribbon built with a constant
 * normal, or with the offset applied in the wrong axis, looks correct on it.
 * The fixture is a curve, and `the fixture actually curves` says so.
 *
 * ## The property the identity short-circuit exists for
 *
 * An untapered stroke must be BYTE-identical to one with no taper at all — not
 * "numerically equal to within a float". That is why `strokeShapeProfiled`
 * refuses identity profiles instead of computing a factor of 1 everywhere: the
 * tapered path is never taken, so there is no arithmetic to differ (§2·0).
 */

import { strokeShapeProfiled } from './vectorDraw';
import { IDENTITY_TAPER, IDENTITY_WAVE, taperWidthFactorAt, type StrokeTaper, type StrokeWave } from '@core/scene/strokeProfile';
import type { Stroke } from '@core/paint/stroke';
import type { RenderLayer } from '../RenderBackend';

interface Pt { x: number; y: number }

/** Records the path the function emits. Nothing is re-derived here. */
function recordingCtx(): CanvasRenderingContext2D & { ring: Pt[]; fills: number; strokes: number } {
  const ring: Pt[] = [];
  const api = {
    ring, fills: 0, strokes: 0,
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 0,
    save() {}, restore() {},
    beginPath() { ring.length = 0; },
    moveTo(x: number, y: number) { ring.push({ x, y }); },
    lineTo(x: number, y: number) { ring.push({ x, y }); },
    closePath() {},
    fill() { (api as { fills: number }).fills += 1; },
    stroke() { (api as { strokes: number }).strokes += 1; },
    setLineDash() {}, ellipse() {}, rect() {}, clip() {}, arcTo() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
  };
  return api as unknown as CanvasRenderingContext2D & { ring: Pt[]; fills: number; strokes: number };
}

/** An OPEN, genuinely curved path — see rule 3a in the header. */
const CURVE = [
  { x: -80, y: 0, inX: -80, inY: 0, outX: -40, outY: -60 },
  { x: 0, y: -40, inX: -40, inY: -60, outX: 40, outY: -20 },
  { x: 80, y: 0, inX: 40, inY: -20, outX: 80, outY: 0 },
];

const WIDTH = 10;

function layer(): RenderLayer {
  return {
    id: 'p', kind: 'shape', primitive: 'path',
    x: 0, y: 0, width: 200, height: 120, opacity: 1, visible: true,
    pathPoints: CURVE, pathOpen: true,
  } as unknown as RenderLayer;
}

function stroke(extra: Partial<Stroke> = {}): Stroke {
  return {
    enabled: true, color: '#ffffff', width: WIDTH, opacity: 1,
    align: 'center', dash: [], cap: 'butt', join: 'miter', ...extra,
  } as Stroke;
}

/** Width recovered from the recorded ring at pair index `i`. */
const widthAtPair = (ring: Pt[], i: number): number => {
  const a = ring[i]!;
  const b = ring[ring.length - 1 - i]!;
  return Math.hypot(a.x - b.x, a.y - b.y);
};

const TAPER: StrokeTaper = {
  ...IDENTITY_TAPER, startLength: 0.5, startWidth: 0.2,
};

describe('the fixture is unclean, as rule 3a requires', () => {
  it('POSITIVE CONTROL: the fixture actually curves', () => {
    const t0 = Math.atan2(CURVE[1]!.y - CURVE[0]!.y, CURVE[1]!.x - CURVE[0]!.x);
    const t1 = Math.atan2(CURVE[2]!.y - CURVE[1]!.y, CURVE[2]!.x - CURVE[1]!.x);
    expect(Math.abs(t0 - t1)).toBeGreaterThan(0.5);
  });
});

describe('what it refuses, so the ordinary stroke still runs', () => {
  it.each([
    ['an identity taper and wave', {}],
    ['a taper that is identity by width', { taper: IDENTITY_TAPER }],
    ['a wave that is identity by amount', { wave: IDENTITY_WAVE }],
    ['a DASHED stroke — the deferred interaction', { taper: TAPER, dash: [8, 4] }],
  ])('refuses %s', (_label, extra) => {
    const ctx = recordingCtx();
    expect(strokeShapeProfiled(ctx, stroke(extra as Partial<Stroke>), layer())).toBe(false);
    expect({ fills: ctx.fills, points: ctx.ring.length }).toEqual({ fills: 0, points: 0 });
  });

  it('refuses a non-path primitive', () => {
    const ctx = recordingCtx();
    const rect = { ...layer(), primitive: 'rect' } as unknown as RenderLayer;
    expect(strokeShapeProfiled(ctx, stroke({ taper: TAPER }), rect)).toBe(false);
  });

  it('refuses a zero-width stroke', () => {
    const ctx = recordingCtx();
    expect(strokeShapeProfiled(ctx, stroke({ taper: TAPER, width: 0 }), layer())).toBe(false);
  });

  it('POSITIVE CONTROL: it ACCEPTS a real taper, so the refusals are not vacuous', () => {
    const ctx = recordingCtx();
    expect(strokeShapeProfiled(ctx, stroke({ taper: TAPER }), layer())).toBe(true);
    expect(ctx.fills).toBe(1);
  });
});

describe('a tapered stroke fills a ribbon whose width follows the profile', () => {
  it('never STROKES — it fills, because Canvas2D cannot vary lineWidth', () => {
    const ctx = recordingCtx();
    strokeShapeProfiled(ctx, stroke({ taper: TAPER }), layer());
    expect({ fills: ctx.fills, strokes: ctx.strokes }).toEqual({ fills: 1, strokes: 0 });
  });

  it('emits a closed ring — an even number of points, at least 6', () => {
    const ctx = recordingCtx();
    strokeShapeProfiled(ctx, stroke({ taper: TAPER }), layer());
    expect(ctx.ring.length % 2).toBe(0);
    expect(ctx.ring.length).toBeGreaterThanOrEqual(6);
  });

  it('is NARROW at the tapered start and FULL width past the ramp', () => {
    // Anchored to which END, which a symmetric taper could not show.
    const ctx = recordingCtx();
    strokeShapeProfiled(ctx, stroke({ taper: TAPER }), layer());
    const n = ctx.ring.length / 2;
    expect(widthAtPair(ctx.ring, 0)).toBeCloseTo(WIDTH * TAPER.startWidth, 4);
    expect(widthAtPair(ctx.ring, n - 1)).toBeCloseTo(WIDTH, 4);
  });

  it('matches the PROFILE at every vertex, not just the ends', () => {
    // The profile function was pinned to paper values in its own suite; this
    // asserts the ribbon actually follows it along the whole path.
    const ctx = recordingCtx();
    strokeShapeProfiled(ctx, stroke({ taper: TAPER }), layer());
    const n = ctx.ring.length / 2;
    // Arc fractions the ribbon was built from, recovered from the LEFT side by
    // walking it — the same walk, so a systematic error here would show as a
    // mismatch rather than cancelling out.
    const left = ctx.ring.slice(0, n);
    const arc: number[] = [0];
    for (let i = 1; i < n; i++) {
      arc.push(arc[i - 1]! + Math.hypot(left[i]!.x - left[i - 1]!.x, left[i]!.y - left[i - 1]!.y));
    }
    const total = arc[n - 1]!;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const expected = WIDTH * taperWidthFactorAt(TAPER, arc[i]! / total);
      worst = Math.max(worst, Math.abs(widthAtPair(ctx.ring, i) - expected));
    }
    // Loose: the left side's arc length is not the centreline's once the ribbon
    // widens, so this is a shape check, not an equality. A ribbon that ignored
    // the profile fails it by ~8px.
    expect(worst).toBeLessThan(WIDTH * 0.35);
  });

  it('a taper at the END narrows the other end instead', () => {
    // The direction claim, run the other way round.
    const ctx = recordingCtx();
    const endTaper: StrokeTaper = { ...IDENTITY_TAPER, endLength: 0.5, endWidth: 0.2 };
    strokeShapeProfiled(ctx, stroke({ taper: endTaper }), layer());
    const n = ctx.ring.length / 2;
    expect(widthAtPair(ctx.ring, 0)).toBeCloseTo(WIDTH, 4);
    expect(widthAtPair(ctx.ring, n - 1)).toBeCloseTo(WIDTH * 0.2, 4);
  });
});

describe('wave displaces the centreline without changing the width', () => {
  const WAVE: StrokeWave = { amount: 12, wavelength: 60, phase: 0 };

  it('keeps the ribbon at full width everywhere', () => {
    // Wave moves the two sides TOGETHER — that is the whole distinction from
    // taper, and it is checkable directly.
    const ctx = recordingCtx();
    strokeShapeProfiled(ctx, stroke({ wave: WAVE }), layer());
    const n = ctx.ring.length / 2;
    for (let i = 0; i < n; i++) {
      expect(widthAtPair(ctx.ring, i)).toBeCloseTo(WIDTH, 3);
    }
  });

  it('moves the ribbon OFF the un-waved one', () => {
    // Compared by EXTENT, not index by index.
    //
    // The first version asserted the two rings had the same point count and
    // walked them in step. That was true when written and false the moment
    // `densifyForWave` landed — a wave samples the path more finely, so the
    // rings have different lengths by design. It failed deterministically and I
    // mis-read it as a flake for one run; a bounding box does not care how many
    // points describe it.
    const bbox = (ring: Pt[]) => ring.reduce(
      (b, p) => ({
        minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x),
        minY: Math.min(b.minY, p.y), maxY: Math.max(b.maxY, p.y),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    );
    const plain = recordingCtx();
    strokeShapeProfiled(plain, stroke({ taper: TAPER }), layer());
    const waved = recordingCtx();
    strokeShapeProfiled(waved, stroke({ taper: TAPER, wave: WAVE }), layer());

    const a = bbox(plain.ring);
    const b = bbox(waved.ring);
    // The wave pushes the ribbon off its own centreline, so it must reach
    // FURTHER than the unwaved one in at least one direction.
    const grew =
      b.minX < a.minX - 1 || b.maxX > a.maxX + 1 ||
      b.minY < a.minY - 1 || b.maxY > a.maxY + 1;
    expect(grew).toBe(true);
  });

  it('composes WITH taper — width still follows the profile while waving', () => {
    const ctx = recordingCtx();
    strokeShapeProfiled(ctx, stroke({ taper: TAPER, wave: WAVE }), layer());
    const n = ctx.ring.length / 2;
    expect(widthAtPair(ctx.ring, 0)).toBeCloseTo(WIDTH * TAPER.startWidth, 3);
    expect(widthAtPair(ctx.ring, n - 1)).toBeCloseTo(WIDTH, 3);
  });
});
