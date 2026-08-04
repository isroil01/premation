/**
 * Vegas — runs lights ALONG the layer's own alpha contour.
 *
 * Every other member of the Generate family draws a pattern from a formula and
 * clips it to the layer. Vegas is the one whose geometry comes FROM the layer:
 * the contour is not a detail of the implementation, it is the effect. Dash
 * spacing, the direction the lights travel and what `rotation` animates are all
 * defined in ARC LENGTH around that outline.
 *
 * ── Why this is a real module and not a corner of generatePatterns ──────
 *
 * Canvas cannot stroke a raster's alpha edge. Getting the outline requires
 * marching squares over the alpha channel to extract closed contours, and
 * placing lights on it requires an arc-length walk. Both are geometry with
 * their own failure modes, so both are pure and tested here, separately from
 * the drawing.
 *
 * The tempting shortcut — stroke the layer's bounding box — renders something
 * plausible on the rectangular layers people most often reach for, which is
 * exactly what makes it dangerous: it looks correct right up until someone
 * applies it to text, and it is indistinguishable from the finished effect in a
 * screenshot. It was deleted rather than shipped, and this is the replacement.
 */

import type { Effect } from './effects';
import { effectNumber, paramsOf } from './effects';

export interface ContourPoint {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ── Marching squares ─────────────────────────────────────────────────

/**
 * Alpha at a grid position, with everything OUTSIDE the grid reading as fully
 * transparent.
 *
 * The virtual border of zeros is what makes every contour CLOSED. Without it a
 * shape touching the canvas edge produces an open run, the stitcher below finds
 * no successor for its last segment, and the walk that follows would place
 * lights along a loop that does not exist. Cells are iterated from -1 so the
 * border is genuinely visited rather than assumed.
 */
function sampleAt(alpha: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  return alpha[y * w + x] ?? 0;
}

/**
 * Where between two corner samples the threshold is crossed, 0..1.
 *
 * Linear rather than a fixed midpoint, because an antialiased edge — which is
 * every shape and every glyph this will actually be used on — carries the
 * sub-pixel position of the true edge in its alpha ramp. Snapping to midpoints
 * would stair-step the contour and make the lights jitter as a layer moves.
 * Equal samples cannot be crossed at all and return the midpoint, which is
 * unreachable in practice (the case is only generated when the two corners
 * straddle the threshold) but keeps the function total.
 */
function crossing(a: number, b: number, threshold: number): number {
  const d = b - a;
  if (d === 0) return 0.5;
  return clamp((threshold - a) / d, 0, 1);
}

/** The four edge midpoints of one cell, named by side. */
type Side = 'T' | 'R' | 'B' | 'L';

/**
 * The marching-squares case table, DERIVED rather than copied.
 *
 * Corner bits: TL=8, TR=4, BR=2, BL=1, set when that corner's alpha is at or
 * above the threshold ("inside").
 *
 * Every segment is DIRECTED, with the convention **inside on the left**. In
 * screen coordinates (x right, y down) the left of a direction (dx, dy) is
 * (dy, -dx) — walk right and your left hand points up. Each entry below was
 * checked against that: case 8 (only TL inside) crosses the top and left edges,
 * and travelling L→T gives direction (+0.5, -0.5), whose left normal
 * (-0.5, -0.5) points up-left, at TL. Inside, as required.
 *
 * The direction is not cosmetic. It is what makes consecutive segments chain
 * end-to-start in the stitcher, and it is what fixes which way the lights
 * travel around the shape — a table with a consistent but MIRRORED convention
 * would stitch just as happily and run the lights backwards.
 */
const CASES: ReadonlyArray<ReadonlyArray<readonly [Side, Side]>> = [
  /*  0 ····                       */ [],
  /*  1 BL                         */ [['B', 'L']],
  /*  2 BR                         */ [['R', 'B']],
  /*  3 BL BR                      */ [['R', 'L']],
  /*  4 TR                         */ [['T', 'R']],
  /*  5 TR BL — saddle, see below  */ [],
  /*  6 TR BR                      */ [['T', 'B']],
  /*  7 TR BR BL                   */ [['T', 'L']],
  /*  8 TL                         */ [['L', 'T']],
  /*  9 TL BL                      */ [['B', 'T']],
  /* 10 TL BR — saddle, see below  */ [],
  /* 11 TL BL BR                   */ [['R', 'T']],
  /* 12 TL TR                      */ [['L', 'R']],
  /* 13 TL TR BL                   */ [['B', 'R']],
  /* 14 TL TR BR                   */ [['L', 'B']],
  /* 15 ▪▪▪▪                       */ [],
];

/**
 * The two ambiguous cases, resolved by the cell's CENTRE.
 *
 * In case 5 the two inside corners are diagonally opposite, and the cell is
 * consistent with either "two separate blobs touching at a point" or "one waist
 * passing through". Averaging the four corners is the standard tie-break and is
 * the one that agrees with what a finer sampling of the same image would show.
 *
 * Guessing instead — always picking one pairing — produces contours that are
 * locally valid and globally wrong: two shapes fuse, or one pinches into two,
 * and the light count changes with it.
 */
function saddle(bits: number, centreInside: boolean): ReadonlyArray<readonly [Side, Side]> {
  if (bits === 5) {
    // TR and BL inside. Connected through the centre → the OUTSIDE corners TL
    // and BR become the isolated ones.
    return centreInside ? [['T', 'L'], ['B', 'R']] : [['T', 'R'], ['B', 'L']];
  }
  // bits === 10: TL and BR inside.
  return centreInside ? [['R', 'T'], ['L', 'B']] : [['L', 'T'], ['R', 'B']];
}

/** Quantised key for endpoint matching. */
function key(p: ContourPoint): string {
  return `${Math.round(p.x * 1e6)}:${Math.round(p.y * 1e6)}`;
}

/**
 * Closed contours of the alpha channel at `threshold`, in canvas pixels.
 *
 * `alpha[y * w + x]`, 0..255. Contours are returned with a DETERMINISTIC
 * starting vertex — the lexicographically smallest point — rather than
 * wherever the raster scan happened to enter the loop. That matters because
 * `rotation` is measured from the contour's start: tying it to scan order would
 * make the lights jump to a different phase when the layer's raster is padded
 * (an effect added below it changes the padding) even though nothing about the
 * shape moved.
 */
export function extractAlphaContours(
  alpha: ArrayLike<number>,
  w: number,
  h: number,
  threshold: number,
): ContourPoint[][] {
  if (w <= 0 || h <= 0) return [];
  const s = (x: number, y: number): number => sampleAt(alpha, w, h, x, y);

  // Directed segments in a LIST, indexed by start point to a LIST of indices.
  //
  // ── Why the multiplicity is not optional ────────────────────────────
  //
  // This was a single `Map<startKey, segment>`, on the assumption that each
  // crossing point starts exactly one segment. It does not, and the case is
  // common rather than exotic: when a corner sample equals the threshold
  // EXACTLY, `crossing` returns 0 or 1 and the crossing point lands precisely on
  // a grid corner, where it coincides with the crossings of the perpendicular
  // edges. With 8-bit alpha and a default threshold of 128, a pixel of exactly
  // 128 is ordinary — a plain antialiased star produced 85 such collisions.
  //
  // Keyed by start alone, each collision silently DISCARDED one segment, the
  // walk then ran into an already-consumed point, and one closed contour came
  // apart into partial chains: the star traced as six contours instead of one,
  // four of them three-point specks. Every light was then placed on a fragment.
  //
  // Consuming per SEGMENT rather than per point fixes it, because two segments
  // legitimately leaving one point is exactly what a self-touching contour is.
  const segs: Array<{ a: ContourPoint; b: ContourPoint }> = [];
  const byStart = new Map<string, number[]>();

  for (let cy = -1; cy < h; cy++) {
    for (let cx = -1; cx < w; cx++) {
      const tl = s(cx, cy);
      const tr = s(cx + 1, cy);
      const br = s(cx + 1, cy + 1);
      const bl = s(cx, cy + 1);
      const bits =
        (tl >= threshold ? 8 : 0) | (tr >= threshold ? 4 : 0) |
        (br >= threshold ? 2 : 0) | (bl >= threshold ? 1 : 0);
      if (bits === 0 || bits === 15) continue;

      const pts: Record<Side, ContourPoint> = {
        T: { x: cx + crossing(tl, tr, threshold), y: cy },
        R: { x: cx + 1, y: cy + crossing(tr, br, threshold) },
        B: { x: cx + crossing(bl, br, threshold), y: cy + 1 },
        L: { x: cx, y: cy + crossing(tl, bl, threshold) },
      };

      const cellSegs =
        bits === 5 || bits === 10
          ? saddle(bits, (tl + tr + br + bl) / 4 >= threshold)
          : CASES[bits]!;

      for (const [a, b] of cellSegs) {
        const k = key(pts[a]);
        const list = byStart.get(k);
        if (list) list.push(segs.length);
        else byStart.set(k, [segs.length]);
        segs.push({ a: pts[a], b: pts[b] });
      }
    }
  }

  const contours: ContourPoint[][] = [];
  const consumed = new Array<boolean>(segs.length).fill(false);
  /** The first segment leaving `k` that no chain has taken yet. */
  const nextFrom = (k: string): number => {
    for (const i of byStart.get(k) ?? []) if (!consumed[i]) return i;
    return -1;
  };
  for (let start = 0; start < segs.length; start++) {
    if (consumed[start]) continue;
    const loop: ContourPoint[] = [];
    let i = start;
    while (i >= 0 && !consumed[i]) {
      consumed[i] = true;
      loop.push(segs[i]!.a);
      i = nextFrom(key(segs[i]!.b));
    }
    // A loop needs three distinct points to enclose anything; two is a
    // degenerate spur from a single stray pixel and has no arc to walk.
    if (loop.length >= 3) contours.push(rotateToCanonicalStart(loop));
  }
  return contours;
}

/** Rotate a closed loop so it begins at its lexicographically smallest point. */
function rotateToCanonicalStart(loop: ContourPoint[]): ContourPoint[] {
  let best = 0;
  for (let i = 1; i < loop.length; i++) {
    const p = loop[i]!;
    const q = loop[best]!;
    if (p.y < q.y || (p.y === q.y && p.x < q.x)) best = i;
  }
  return best === 0 ? loop : [...loop.slice(best), ...loop.slice(0, best)];
}

// ── Arc-length walk ──────────────────────────────────────────────────

export interface ArcTable {
  /** Cumulative length from vertex 0 to vertex i, length n. */
  cum: number[];
  /** Total perimeter, INCLUDING the closing edge back to vertex 0. */
  total: number;
}

/** Cumulative arc lengths around a CLOSED contour. */
export function arcTable(pts: ReadonlyArray<ContourPoint>): ArcTable {
  const n = pts.length;
  const cum = new Array<number>(n).fill(0);
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    cum[i] = acc;
  }
  // The closing edge is part of the perimeter — a loop's last vertex joins its
  // first. Omitting it would make every dash drift by that edge's length per
  // lap, which reads as the lights slowly sliding out of phase.
  const total = n > 1 ? acc + Math.hypot(pts[0]!.x - pts[n - 1]!.x, pts[0]!.y - pts[n - 1]!.y) : 0;
  return { cum, total };
}

/** The point at arc position `s` (wrapping) around a closed contour. */
export function pointAtArc(
  pts: ReadonlyArray<ContourPoint>,
  t: ArcTable,
  s: number,
): ContourPoint {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0 };
  if (t.total <= 0) return { x: pts[0]!.x, y: pts[0]!.y };
  const u = ((s % t.total) + t.total) % t.total;
  // Last vertex first: `cum` has no entry for the closing edge, so a position
  // beyond cum[n-1] belongs to it and the loop below would never find a match.
  let i = n - 1;
  for (let j = 0; j < n - 1; j++) {
    if (u < t.cum[j + 1]!) { i = j; break; }
  }
  const segLen = (i === n - 1 ? t.total : t.cum[i + 1]!) - t.cum[i]!;
  const f = segLen > 0 ? (u - t.cum[i]!) / segLen : 0;
  const a = pts[i]!;
  const b = pts[(i + 1) % n]!;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/**
 * The polyline covering `len` of arc starting at `from`, wrapping the seam.
 *
 * Emitted as ONE run rather than split at the seam: a light that straddles
 * vertex 0 is one light, and cutting it in two would put a stroke join and two
 * end caps in the middle of it — visible at any width above a hairline.
 */
export function walkArc(
  pts: ReadonlyArray<ContourPoint>,
  t: ArcTable,
  from: number,
  len: number,
): ContourPoint[] {
  const n = pts.length;
  if (n < 2 || t.total <= 0 || len <= 0) return [];
  const span = Math.min(len, t.total);
  const out: ContourPoint[] = [pointAtArc(pts, t, from)];
  const start = ((from % t.total) + t.total) % t.total;
  // Arc position of vertex k in UNWRAPPED space, so a walk that laps the seam
  // keeps increasing instead of resetting to zero.
  const arcOf = (k: number): number => t.cum[k % n]! + t.total * Math.floor(k / n);
  let k = 0;
  while (k < n && t.cum[k]! <= start) k++;
  const target = start + span;
  // BOUNDED by the vertex count, not merely by the arc test.
  //
  // `span` is clamped to one perimeter, so a run can pass at most every vertex
  // once and `k` can advance at most `n` times. Relying on `arcOf` increasing to
  // end the loop makes termination depend on an invariant held somewhere else —
  // and when that invariant was deliberately broken to check this function's
  // guard, the loop did not draw the wrong thing, it allocated until the process
  // died. A wrong picture is debuggable; a hang is a hang. The bound turns any
  // future breakage into a visibly wrong run instead.
  const last = k + n;
  while (k <= last && arcOf(k) < target) {
    out.push({ x: pts[k % n]!.x, y: pts[k % n]!.y });
    k++;
  }
  out.push(pointAtArc(pts, t, start + span));
  return out;
}

/**
 * The lit runs for one contour.
 *
 * `segments` lights are spaced evenly around the perimeter, each occupying
 * `length` percent of its own slot; `rotation` slides the whole set around the
 * contour, a full lap per 360 degrees. That mapping is the one worth stating:
 * it makes a linear keyframe on `rotation` a constant-speed chase whatever the
 * shape is, which is the thing this effect exists to do.
 */
export function vegasSegments(
  contour: ReadonlyArray<ContourPoint>,
  segments: number,
  lengthPct: number,
  rotationDeg: number,
): ContourPoint[][] {
  const n = Math.max(1, Math.round(segments));
  const t = arcTable(contour);
  if (t.total <= 0) return [];
  const slot = t.total / n;
  const lit = clamp(lengthPct / 100, 0, 1) * slot;
  if (lit <= 0) return [];
  const phase = (rotationDeg / 360) * t.total;
  const out: ContourPoint[][] = [];
  for (let k = 0; k < n; k++) {
    const run = walkArc(contour, t, phase + k * slot, lit);
    if (run.length >= 2) out.push(run);
  }
  return out;
}

// ── The effect ───────────────────────────────────────────────────────

const str = (e: Effect, k: string, fb: string): string => {
  const v = paramsOf(e)[k];
  return typeof v === 'string' ? v : fb;
};

/** The layer's alpha plane, one byte per pixel. */
function alphaPlane(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * 4 + 3]!;
  return out;
}

/**
 * Draw the lights.
 *
 * NOT `source-atop`, unlike every other generator in this family. A light
 * STRADDLES the contour — half its width falls outside the layer's alpha — so
 * clipping to that alpha would shave every light in half lengthwise and the
 * effect would read as an inner glow. `bakedEffectSpread` pads the raster by
 * the width for the same reason.
 */
export function drawVegas(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const opacity = effectNumber(e, 'opacity') / 100;
  if (opacity <= 0 || w <= 0 || h <= 0) return;
  const lengthPct = effectNumber(e, 'length');
  if (lengthPct <= 0) return;
  const width = Math.max(0.1, effectNumber(e, 'width'));
  const segments = Math.max(1, Math.round(effectNumber(e, 'segments')));
  const rotation = effectNumber(e, 'rotation');
  const hardness = clamp(effectNumber(e, 'hardness'), 0, 100);
  // Clamped away from both ends: at 0 every pixel is "inside" and there is no
  // contour, at 255 only fully-opaque pixels are and an antialiased shape
  // contours along its own interior.
  const threshold = clamp(effectNumber(e, 'threshold'), 1, 254);
  const color = str(e, 'color', '#ffffff');

  const img = oc.getImageData(0, 0, w, h);
  const contours = extractAlphaContours(alphaPlane(img.data, w, h), w, h, threshold);
  if (contours.length === 0) return;

  oc.save();
  oc.globalAlpha = Math.min(1, opacity);
  oc.strokeStyle = color;
  oc.lineWidth = width;
  oc.lineCap = 'round';
  oc.lineJoin = 'round';
  // Hardness feathers the light's edge. 100 is a hard stroke; below that the
  // blur is proportional to the stroke's own width, so softening does not
  // change how thick the lights read.
  if (hardness < 100) oc.filter = `blur(${((100 - hardness) / 100) * width * 0.5}px)`;
  for (const contour of contours) {
    for (const run of vegasSegments(contour, segments, lengthPct, rotation)) {
      oc.beginPath();
      oc.moveTo(run[0]!.x, run[0]!.y);
      for (let i = 1; i < run.length; i++) oc.lineTo(run[i]!.x, run[i]!.y);
      oc.stroke();
    }
  }
  oc.restore();
}
