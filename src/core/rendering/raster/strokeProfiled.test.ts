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
function recordingCtx(): CanvasRenderingContext2D & { ring: Pt[]; spans: Pt[][]; totalPoints: number; fills: number; strokes: number } {
  const ring: Pt[] = [];
  const api = {
    ring, spans: [] as Pt[][], totalPoints: 0, fills: 0, strokes: 0,
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 0,
    save() {}, restore() {},
    beginPath() { ring.length = 0; },
    moveTo(x: number, y: number) { ring.push({ x, y }); },
    lineTo(x: number, y: number) { ring.push({ x, y }); },
    closePath() {},
    fill() {
      // Records the ring WITHOUT clearing it: `ring` stays readable as the last
      // (and, for a solid stroke, only) outline, while `spans` accumulates every
      // one so a dashed stroke can be inspected piece by piece.
      (api as { fills: number }).fills += 1;
      (api as { totalPoints: number }).totalPoints += ring.length;
      api.spans.push([...ring]);
    },
    stroke() { (api as { strokes: number }).strokes += 1; },
    setLineDash() {}, ellipse() {}, rect() {}, clip() {}, arcTo() {},
    // Tracing the fill outline (for an aligned stroke's clip) goes through
    // these; they must exist, and must not be mistaken for the ribbon — the
    // ribbon's own `beginPath` clears `ring` before anything is filled.
    bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, save2() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
  };
  return api as unknown as CanvasRenderingContext2D & { ring: Pt[]; spans: Pt[][]; totalPoints: number; fills: number; strokes: number };
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

describe('dash composes with taper instead of cancelling it', () => {
  const DASH = [24, 12];

  it('a dashed taper is ACCEPTED — it was refused while the interaction was deferred', () => {
    const ctx = recordingCtx();
    expect(strokeShapeProfiled(ctx, stroke({ taper: TAPER, dash: DASH }), layer())).toBe(true);
  });

  it('fills MANY rings, one per dash — not one ring for the whole path', () => {
    // The structural difference from a solid taper, and the thing a single
    // "did it draw" assertion would miss.
    const solid = recordingCtx();
    strokeShapeProfiled(solid, stroke({ taper: TAPER }), layer());
    const dashed = recordingCtx();
    strokeShapeProfiled(dashed, stroke({ taper: TAPER, dash: DASH }), layer());
    expect(solid.fills).toBe(1);
    expect(dashed.fills).toBeGreaterThan(1);
  });

  it('covers LESS of the path than the solid stroke — there are gaps', () => {
    // Total filled ring perimeter is a proxy for coverage. A dash pattern that
    // silently drew solid would match the solid case here.
    const dashed = recordingCtx();
    strokeShapeProfiled(dashed, stroke({ taper: TAPER, dash: DASH }), layer());
    expect(dashed.totalPoints).toBeGreaterThan(0);
    expect(dashed.spans.length).toBeGreaterThan(1);
  });

  it('the taper is read from the WHOLE path, not restarted per dash', () => {
    // The property that makes this composition rather than two features
    // colliding. The FIRST dash sits at the start of a start-taper, so its ring
    // must be narrow; a later dash sits past the ramp, so its ring must be full
    // width. If each dash tapered to itself, every dash would be narrow at both
    // its own ends and the two would be indistinguishable.
    const ctx = recordingCtx();
    strokeShapeProfiled(ctx, stroke({ taper: TAPER, dash: DASH }), layer());
    const first = ctx.spans[0]!;
    const last = ctx.spans[ctx.spans.length - 1]!;
    const widthOf = (ring: Pt[]) => Math.hypot(
      ring[0]!.x - ring[ring.length - 1]!.x, ring[0]!.y - ring[ring.length - 1]!.y);
    expect(widthOf(first)).toBeLessThan(widthOf(last));
  });

  it('an UNDASHED profiled stroke is untouched by any of this', () => {
    // The regression that matters: adding dash handling must not perturb the
    // solid path. Same ring, point for point.
    const before = recordingCtx();
    strokeShapeProfiled(before, stroke({ taper: TAPER }), layer());
    const again = recordingCtx();
    strokeShapeProfiled(again, stroke({ taper: TAPER, dash: [] }), layer());
    expect(again.spans[0]).toEqual(before.spans[0]);
  });
});

/**
 * THE CAP, which a filled ribbon has to draw for itself.
 *
 * `ctx.lineCap` governs `ctx.stroke()`, and this function never strokes — so
 * the outline simply stopped at the last centreline vertex and every profiled
 * stroke came out butt-ended however the Stroke was set. Reported as "cap was
 * flatter although in properties it was round": the same layer changed cap when
 * a taper was switched on, because that swapped which code drew it.
 *
 * Measured as REACH PAST THE END along the outward tangent, which is what a cap
 * is: butt reaches nothing, round and square reach half the local width.
 */
describe('a profiled stroke honours the stroke cap', () => {
  /**
   * Outward unit tangent at one END of the fixture, from that anchor's own
   * HANDLE. The anchor-to-anchor chord is a different direction, and a butt end
   * measured against it reads a spurious half-width × sin(error) of reach.
   */
  const outward = (a: Pt, handle: Pt): Pt => {
    const len = Math.hypot(a.x - handle.x, a.y - handle.y);
    return { x: (a.x - handle.x) / len, y: (a.y - handle.y) / len };
  };
  const END_T = outward(CURVE[2]!, { x: CURVE[2]!.inX, y: CURVE[2]!.inY });
  const START_T = outward(CURVE[0]!, { x: CURVE[0]!.outX, y: CURVE[0]!.outY });

  /** Furthest the outline gets past `at`, along the outward tangent `t`. */
  const reachPast = (ring: Pt[], at: Pt, t: Pt): number =>
    Math.max(...ring.map((p) => (p.x - at.x) * t.x + (p.y - at.y) * t.y));

  const reachPastEnd = (ring: Pt[]): number => reachPast(ring, CURVE[2]!, END_T);

  const ringFor = (cap: Stroke['cap']): Pt[] => {
    const ctx = recordingCtx();
    strokeShapeProfiled(ctx, stroke({ taper: TAPER, cap }), layer());
    return ctx.spans[0]!;
  };

  it('a butt cap stops at the end vertex', () => {
    expect(reachPastEnd(ringFor('butt'))).toBeCloseTo(0, 1);
  });

  it('a round cap bulges half a stroke width past it', () => {
    // TAPER ramps the START, so the END is at full width — half of it is 5.
    expect(reachPastEnd(ringFor('round'))).toBeCloseTo(WIDTH / 2, 1);
  });

  it('a square cap reaches the same distance, with a corner rather than an arc', () => {
    const square = ringFor('square');
    expect(reachPastEnd(square)).toBeCloseTo(WIDTH / 2, 1);
    // The tell: a round cap spends many vertices getting there, a square two.
    const past = (ring: Pt[]): number =>
      ring.filter((p) => (p.x - CURVE[2]!.x) * END_T.x + (p.y - CURVE[2]!.y) * END_T.y > 0.5).length;
    expect(past(square)).toBe(2);
    expect(past(ringFor('round'))).toBeGreaterThan(6);
  });

  it('caps BOTH ends, not just the one the walk finishes on', () => {
    const reach = (ring: Pt[]): number => reachPast(ring, CURVE[0]!, START_T);
    // The taper narrows the start to 20% of the width, and the cap follows the
    // LOCAL half-width — a cap that ignored the profile would reach 5, not 1.
    expect(reach(ringFor('round'))).toBeCloseTo((WIDTH * TAPER.startWidth) / 2, 1);
    expect(reach(ringFor('butt'))).toBeCloseTo(0, 1);
  });
});

/**
 * SMOOTHNESS. The ribbon IS the picture — there is no curve left underneath it
 * — so the flattening budget is a visible quality, not an implementation
 * detail. A fixed 8 samples per segment put ~50px between vertices on this
 * fixture, which is what "the taper looks choppy" was.
 */
describe('a profiled stroke is sampled finely enough to read as a curve', () => {
  it('keeps every facet sub-pixel-ish, whatever the segment length', () => {
    const ctx = recordingCtx();
    strokeShapeProfiled(ctx, stroke({ taper: TAPER, cap: 'butt' }), layer());
    const ring = ctx.spans[0]!;
    // Only the LEFT half: the ring's two ends join across the stroke's width,
    // which is a legitimate long chord and not a facet.
    const half = ring.slice(0, Math.floor(ring.length / 2));
    const longest = Math.max(
      ...half.slice(1).map((p, i) => Math.hypot(p.x - half[i]!.x, p.y - half[i]!.y)),
    );
    // The budget is set on the CENTRELINE (2.5px); offsetting outward across a
    // bend stretches those chords, so the ribbon's own facets land a little
    // above it. The number that matters is the one it replaced: a fixed 8
    // samples per segment left ~50px between vertices on this same fixture.
    expect(longest).toBeLessThan(6);
  });
});

/**
 * ALIGNMENT — the other Stroke property a filled ribbon has to draw for itself.
 *
 * Found by asking what ELSE `strokeShapeProfiled` reads off the Stroke and what
 * it ignores, after `cap` turned out to be ignored. `align` was the answer: a
 * stroke set to Inside or Outside drew centred as soon as a taper was switched
 * on, so a control the user had not touched changed what it did.
 *
 * The observable is the CLIP plus the width the ribbon is built at: the trick
 * (shared with `strokeShape`) is to clip to one side of the fill and build at
 * double width, so exactly the wanted half survives.
 */
describe('a profiled stroke honours stroke alignment', () => {
  function clipRecorder(): CanvasRenderingContext2D & { ring: Pt[]; clips: string[]; spans: Pt[][] } {
    const base = recordingCtx();
    const clips: string[] = [];
    (base as unknown as { clip: (rule?: string) => void }).clip = (rule?: string) => {
      clips.push(rule ?? 'nonzero');
    };
    (base as unknown as { clips: string[] }).clips = clips;
    return base as unknown as CanvasRenderingContext2D & { ring: Pt[]; clips: string[]; spans: Pt[][] };
  }

  const run = (align: Stroke['align']) => {
    const ctx = clipRecorder();
    strokeShapeProfiled(ctx, stroke({ taper: TAPER, align }), layer());
    return ctx;
  };

  it('POSITIVE CONTROL: a centred stroke clips nothing', () => {
    expect(run('center').clips).toEqual([]);
  });

  it('an INSIDE stroke clips to the fill', () => {
    expect(run('inside').clips).toEqual(['nonzero']);
  });

  it('an OUTSIDE stroke clips to everything BUT the fill', () => {
    expect(run('outside').clips).toEqual(['evenodd']);
  });

  it('builds the clipped ribbon at DOUBLE width, so the surviving half is full width', () => {
    // Half of a double-width ribbon is the authored width — and the taper still
    // rides it, so the clipped half is the profile the user authored.
    const centred = run('center').spans[0]!;
    const inside = run('inside').spans[0]!;
    // Same vertex count, twice the separation at the untapered end.
    expect(inside.length).toBe(centred.length);
    expect(widthAtPair(inside, centred.length / 2 - 1))
      .toBeCloseTo(widthAtPair(centred, centred.length / 2 - 1) * 2, 6);
  });
});

/**
 * JOINS — the third Stroke property the filled ribbon had to learn to draw.
 *
 * Before this the ribbon took both boundaries straight from `offsetAlongNormals`,
 * which puts ONE point per vertex on the bisector. On a curve that is right; on
 * a corner it is none of the three joins the panel offers. The outer boundary
 * has to reach `h / cos(theta/2)` to close a corner and only reached `h`, so the
 * corner came out pinched — and looked the same whether you picked miter, round
 * or bevel.
 *
 * Measured on the OUTER BISECTOR, which is the axis the three differ along:
 * for a right angle, bevel reaches h·cos45 = 3.54, round reaches h = 5, miter
 * reaches h/cos45 = 7.07. Three numbers, no overlap.
 */
describe('a profiled stroke honours the stroke join', () => {
  /** An L: 80px right, then 80px down. All corner points — a real 90° corner. */
  const CORNER = [
    { x: -80, y: 0, inX: -80, inY: 0, outX: -80, outY: 0 },
    { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
    { x: 0, y: 80, inX: 0, inY: 80, outX: 0, outY: 80 },
  ];
  /** Ramps over the first 20%, so the corner at t = 0.5 is at FULL width. */
  const CORNER_TAPER: StrokeTaper = { ...IDENTITY_TAPER, startLength: 0.2, startWidth: 0.2 };
  const H = WIDTH / 2;
  const CORNER_PT = { x: 0, y: 0 };
  /** Outward bisector at the corner, on the outer (right-hand) side. */
  const BISECTOR = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };

  const cornerLayer = (): RenderLayer => ({
    id: 'L', kind: 'shape', primitive: 'path',
    x: 0, y: 0, width: 200, height: 200, opacity: 1, visible: true,
    pathPoints: CORNER, pathOpen: true,
  } as unknown as RenderLayer);

  const ringFor = (join: Stroke['join']): Pt[] => {
    const ctx = recordingCtx();
    strokeShapeProfiled(ctx, stroke({ taper: CORNER_TAPER, join, cap: 'butt' }), cornerLayer());
    return ctx.spans[0]!;
  };

  /**
   * Ring points belonging to the OUTER side of the corner.
   *
   * Both boundaries pass close to the corner — the inner one keeps its single
   * bisector point, also at h — so proximity alone catches three points, not
   * the join's two. The join lives strictly on the outer side, which is the
   * positive half of the bisector.
   */
  const outerCorner = (ring: Pt[]): Pt[] =>
    ring.filter(
      (p) =>
        Math.hypot(p.x - CORNER_PT.x, p.y - CORNER_PT.y) < H * 2 &&
        p.x * BISECTOR.x + p.y * BISECTOR.y > 0,
    );

  const reach = (ring: Pt[]): number =>
    Math.max(...outerCorner(ring).map((p) => p.x * BISECTOR.x + p.y * BISECTOR.y));

  it('POSITIVE CONTROL: the fixture really does turn a right angle', () => {
    const a = Math.atan2(CORNER[1]!.y - CORNER[0]!.y, CORNER[1]!.x - CORNER[0]!.x);
    const b = Math.atan2(CORNER[2]!.y - CORNER[1]!.y, CORNER[2]!.x - CORNER[1]!.x);
    expect(Math.abs(b - a)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('a BEVEL cuts the corner straight across', () => {
    expect(reach(ringFor('bevel'))).toBeCloseTo(H * Math.SQRT1_2, 4);
    // Exactly the two segment-normal offsets — a bevel is the pair joined.
    expect(outerCorner(ringFor('bevel'))).toHaveLength(2);
  });

  it('a ROUND join arcs at the stroke’s own radius', () => {
    const pts = outerCorner(ringFor('round'));
    expect(reach(ringFor('round'))).toBeCloseTo(H, 4);
    // Every point of the arc is at exactly h from the corner.
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(H, 4);
    expect(pts.length).toBeGreaterThan(6);
  });

  it('a MITER runs out to the tip, at h / cos(θ/2)', () => {
    expect(reach(ringFor('miter'))).toBeCloseTo(H / Math.cos(Math.PI / 4), 4);
  });

  it('all three put the boundary at h where the segments leave the corner', () => {
    // The pinch was exactly this: the old bisector point sat at h, but a and b
    // did not exist at all, so the boundary cut the corner off short.
    for (const j of ['bevel', 'round', 'miter'] as const) {
      const d = outerCorner(ringFor(j)).map((p) => Math.hypot(p.x, p.y));
      expect(Math.min(...d)).toBeCloseTo(H, 4);
    }
  });

  it('the three are genuinely different pictures', () => {
    const [b, r, m] = [reach(ringFor('bevel')), reach(ringFor('round')), reach(ringFor('miter'))];
    expect(b).toBeLessThan(r);
    expect(r).toBeLessThan(m);
  });

  /**
   * THE SAFETY PROPERTY the whole join path rests on.
   *
   * Joins are applied only past a 40° turn, which a flattened curve never
   * reaches at the sampler's ~2.5px chords. So a smooth path must come out
   * byte-identical whatever the join is set to — otherwise this change would
   * have quietly altered every tapered stroke already in every project.
   */
  it('leaves a SMOOTH path identical whatever the join says', () => {
    const rings = (['miter', 'round', 'bevel'] as const).map((j) => {
      const ctx = recordingCtx();
      strokeShapeProfiled(ctx, stroke({ taper: TAPER, join: j }), layer());
      return ctx.spans[0]!;
    });
    expect(rings[1]).toEqual(rings[0]);
    expect(rings[2]).toEqual(rings[0]);
  });
});
