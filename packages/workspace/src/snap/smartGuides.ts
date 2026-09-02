/**
 * smartGuides — the measuring half of snapping.
 *
 * `SnapEngine` answers "where does this edge want to land". That is alignment,
 * and alignment alone is what the workspace has drawn since it shipped: a pink
 * line saying two edges agree, with no number attached and no notion of the
 * SPACE between things. Figma's smart guides are the other half — how far the
 * dragged box is from its neighbours, and whether those distances are equal.
 *
 * Everything here is a pure function over axis-aligned rects in ONE space (the
 * caller's — world/comp units in this app) with no engine state, so it can be
 * unit-tested with plain numbers and reused by the overlay without a Workspace.
 *
 * ## Definitions used throughout
 *
 *  • A neighbour sits "to the left" of the box when its RIGHT edge is at or
 *    before the box's LEFT edge **and** the two overlap vertically. The overlap
 *    requirement is what keeps a distant, unrelated layer in another corner of
 *    the comp from claiming to be "24px away" — a distance drawn between two
 *    boxes that share no band is a line through empty space, which is exactly
 *    the noise that makes bad smart guides worse than none.
 *  • A gap's `cross` is the midpoint of that shared band: where the dimension
 *    line is drawn so it visibly touches both boxes.
 *  • `radius` is the snap threshold in the SAME units as the rects (the caller
 *    converts screen px → world at the current zoom, as `Workspace.snapRect`
 *    already does for alignment snapping).
 */

import type { Rect } from '../math/Rect';

const EPS = 1e-6;

/** Which side of the dragged box a measurement is on. */
export type GapSide = 'left' | 'right' | 'top' | 'bottom';

/**
 * One measured distance between two boxes, plus where to draw it.
 *
 * `from`/`to` run along `axis` (the axis the distance is measured along) and
 * `cross` is the perpendicular coordinate of the dimension line.
 */
export interface Gap {
  side: GapSide;
  axis: 'x' | 'y';
  /** Edge-to-edge distance, never negative. */
  distance: number;
  from: number;
  to: number;
  cross: number;
  /** The neighbour the distance was measured to. */
  other: Rect;
}

/** How the dragged box could be moved to make two gaps equal. */
export interface SpacingCandidate {
  axis: 'x' | 'y';
  /** Signed move along `axis` that equalizes the run. */
  delta: number;
  /** The gap every span in `spans` has once `delta` is applied. */
  gap: number;
  /** |delta| — how far off equal it is right now; smaller wins. */
  distance: number;
  /** The run of equal gaps, measured AFTER `delta` is applied. */
  spans: Gap[];
}

/** A neighbour whose width/height matches the dragged box's. */
export interface SizeCandidate {
  axis: 'x' | 'y';
  /** Signed size change that would make them identical. */
  delta: number;
  /** The neighbour's size on `axis`. */
  size: number;
  distance: number;
  other: Rect;
}

export interface SmartGuideInfo {
  /** Nearest neighbour on each side (at most four entries). */
  gaps: Gap[];
  /** Best equal-spacing candidate per axis, nearest first. */
  spacing: SpacingCandidate[];
  /** Equal-size matches, nearest first. */
  sizes: SizeCandidate[];
}

const left = (r: Rect): number => r.x;
const right = (r: Rect): number => r.x + r.width;
const top = (r: Rect): number => r.y;
const bottom = (r: Rect): number => r.y + r.height;

/** Interval overlap on one axis: `[lo, hi]` or null when they miss. */
function overlap(
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
): { lo: number; hi: number } | null {
  const lo = Math.max(aLo, bLo);
  const hi = Math.min(aHi, bHi);
  return hi > lo - EPS ? { lo, hi } : null;
}

/** The perpendicular coordinate a dimension line between `a` and `b` sits at. */
function crossFor(a: Rect, b: Rect, axis: 'x' | 'y'): number {
  const band =
    axis === 'x'
      ? overlap(top(a), bottom(a), top(b), bottom(b))
      : overlap(left(a), right(a), left(b), right(b));
  if (band) return (band.lo + band.hi) / 2;
  // No shared band (only reachable via `measureBetween`, which measures two
  // named boxes rather than searching): halfway between the two centres, so the
  // line at least points from one to the other.
  const ca = axis === 'x' ? (top(a) + bottom(a)) / 2 : (left(a) + right(a)) / 2;
  const cb = axis === 'x' ? (top(b) + bottom(b)) / 2 : (left(b) + right(b)) / 2;
  return (ca + cb) / 2;
}

/**
 * The gap from `a` to `b` on one side of `a`, or null when `b` is not on that
 * side (it overlaps `a` on the measured axis, or shares no band on the other).
 */
export function gapBetween(a: Rect, b: Rect, side: GapSide): Gap | null {
  const axis: 'x' | 'y' = side === 'left' || side === 'right' ? 'x' : 'y';
  const band =
    axis === 'x'
      ? overlap(top(a), bottom(a), top(b), bottom(b))
      : overlap(left(a), right(a), left(b), right(b));
  if (!band) return null;
  let from: number;
  let to: number;
  if (side === 'left') {
    if (right(b) > left(a) + EPS) return null;
    from = right(b);
    to = left(a);
  } else if (side === 'right') {
    if (left(b) < right(a) - EPS) return null;
    from = right(a);
    to = left(b);
  } else if (side === 'top') {
    if (bottom(b) > top(a) + EPS) return null;
    from = bottom(b);
    to = top(a);
  } else {
    if (top(b) < bottom(a) - EPS) return null;
    from = bottom(a);
    to = top(b);
  }
  return {
    side,
    axis,
    distance: Math.max(0, to - from),
    from,
    to,
    cross: (band.lo + band.hi) / 2,
    other: b,
  };
}

const SIDES: readonly GapSide[] = ['left', 'right', 'top', 'bottom'];

/**
 * The nearest neighbour on each of the four sides, as measured distances.
 *
 * Neighbours that overlap `bounds` on the measured axis are skipped: an
 * intersection has no gap to report, and reporting 0 for it would draw a badge
 * on top of the box being dragged.
 */
export function nearestGaps(bounds: Rect, others: readonly Rect[]): Gap[] {
  const out: Gap[] = [];
  for (const side of SIDES) {
    let best: Gap | null = null;
    for (const o of others) {
      const g = gapBetween(bounds, o, side);
      if (!g) continue;
      if (best === null || g.distance < best.distance) best = g;
    }
    if (best) out.push(best);
  }
  return out;
}

/** Neighbours on one side, nearest first. */
function sideGaps(bounds: Rect, others: readonly Rect[], side: GapSide): Gap[] {
  const out: Gap[] = [];
  for (const o of others) {
    const g = gapBetween(bounds, o, side);
    if (g) out.push(g);
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

function shift(r: Rect, axis: 'x' | 'y', delta: number): Rect {
  return axis === 'x' ? { ...r, x: r.x + delta } : { ...r, y: r.y + delta };
}

/**
 * A candidate from its spans — null when any span failed to materialize, which
 * is how a "run" that stops overlapping after the move is discarded rather than
 * drawn as a half-run.
 */
function candidate(axis: 'x' | 'y', delta: number, spans: (Gap | null)[]): SpacingCandidate | null {
  const kept: Gap[] = [];
  for (const s of spans) {
    if (!s) return null;
    kept.push(s);
  }
  const first = kept[0];
  if (!first) return null;
  return { axis, delta, gap: first.distance, distance: Math.abs(delta), spans: kept };
}

/**
 * Where the dragged box would sit if its spacing matched its neighbours'.
 *
 * Three shapes, all of them things Figma offers and all of them worth having:
 *
 *  1. **Centred between two.** A neighbour on each side, unequal gaps → move to
 *     the middle. `delta = (right − left) / 2`.
 *  2. **Chained left.** The gap to the nearest left neighbour A matches the gap
 *     from A to ITS nearest left neighbour B → continue the rhythm.
 *  3. **Chained right.** The mirror of 2.
 *
 * A candidate is only returned when the move needed is within `radius` — i.e.
 * the user is already almost there, which is what makes this an assist rather
 * than a teleport. Sorted nearest-first; the caller takes the first per axis.
 */
export function spacingCandidates(
  bounds: Rect,
  others: readonly Rect[],
  radius: number,
): SpacingCandidate[] {
  const out: SpacingCandidate[] = [];
  const axes: ReadonlyArray<{ axis: 'x' | 'y'; before: GapSide; after: GapSide }> = [
    { axis: 'x', before: 'left', after: 'right' },
    { axis: 'y', before: 'top', after: 'bottom' },
  ];
  for (const { axis, before, after } of axes) {
    const beforeGaps = sideGaps(bounds, others, before);
    const afterGaps = sideGaps(bounds, others, after);
    const a = beforeGaps[0];
    const c = afterGaps[0];

    // 1. Centre between the two nearest neighbours.
    if (a && c) {
      const delta = (c.distance - a.distance) / 2;
      if (Math.abs(delta) <= radius) {
        const moved = shift(bounds, axis, delta);
        const cand = candidate(axis, delta, [
          gapBetween(moved, a.other, before),
          gapBetween(moved, c.other, after),
        ]);
        if (cand) out.push(cand);
      }
    }

    // 2/3. Continue an existing rhythm on either side.
    for (const [near, side] of [
      [a, before],
      [c, after],
    ] as ReadonlyArray<[Gap | undefined, GapSide]>) {
      if (!near) continue;
      // The neighbour's own nearest neighbour, further out in the same
      // direction — the run this box would be joining.
      const beyond = sideGaps(near.other, others, side)[0];
      if (!beyond) continue;
      const delta = side === before ? beyond.distance - near.distance : near.distance - beyond.distance;
      if (Math.abs(delta) > radius) continue;
      const moved = shift(bounds, axis, delta);
      const cand = candidate(axis, delta, [
        gapBetween(near.other, beyond.other, side),
        gapBetween(moved, near.other, side),
      ]);
      if (cand) out.push(cand);
    }
  }
  out.sort((p, q) => p.distance - q.distance);
  return out;
}

/**
 * Neighbours the dragged box is nearly the same size as.
 *
 * Reported per axis, nearest first. `delta` is what would have to be ADDED to
 * the box's size to match — a resize gesture can apply it; a move gesture uses
 * the match only to light up the neighbour that agrees.
 */
export function equalSizeCandidates(
  bounds: Rect,
  others: readonly Rect[],
  radius: number,
): SizeCandidate[] {
  const out: SizeCandidate[] = [];
  const axes: ReadonlyArray<{ axis: 'x' | 'y'; size: (r: Rect) => number }> = [
    { axis: 'x', size: (r) => r.width },
    { axis: 'y', size: (r) => r.height },
  ];
  for (const { axis, size } of axes) {
    const mine = size(bounds);
    if (mine <= EPS) continue;
    for (const o of others) {
      const theirs = size(o);
      if (theirs <= EPS) continue;
      const delta = theirs - mine;
      if (Math.abs(delta) > radius) continue;
      out.push({ axis, delta, size: theirs, distance: Math.abs(delta), other: o });
    }
  }
  out.sort((p, q) => p.distance - q.distance);
  return out;
}

/**
 * Everything a live gesture wants to know at once.
 *
 * `spacing` is filtered to the best candidate per axis, because two competing
 * equalizations on the same axis cannot both be applied and drawing both would
 * claim a snap that will not happen.
 */
export function smartGuides(
  bounds: Rect,
  others: readonly Rect[],
  radius: number,
): SmartGuideInfo {
  const spacing: SpacingCandidate[] = [];
  const seen = new Set<'x' | 'y'>();
  for (const c of spacingCandidates(bounds, others, radius)) {
    if (seen.has(c.axis)) continue;
    seen.add(c.axis);
    spacing.push(c);
  }
  const sizes: SizeCandidate[] = [];
  const seenSize = new Set<'x' | 'y'>();
  for (const s of equalSizeCandidates(bounds, others, radius)) {
    if (seenSize.has(s.axis)) continue;
    seenSize.add(s.axis);
    sizes.push(s);
  }
  return { gaps: nearestGaps(bounds, others), spacing, sizes };
}

/**
 * The distances between two NAMED boxes — Alt-hover measuring.
 *
 * Unlike `nearestGaps` this searches nothing and rejects nothing: the user has
 * pointed at both boxes, so an answer is owed even for boxes that share no
 * band (the line is then drawn between their centres' level). Axes the two
 * overlap on produce no span, because "how far apart" is not a question with an
 * answer there.
 */
export function measureBetween(a: Rect, b: Rect): Gap[] {
  const out: Gap[] = [];
  if (right(b) <= left(a) + EPS) {
    out.push({ side: 'left', axis: 'x', distance: left(a) - right(b), from: right(b), to: left(a), cross: crossFor(a, b, 'x'), other: b });
  } else if (left(b) >= right(a) - EPS) {
    out.push({ side: 'right', axis: 'x', distance: left(b) - right(a), from: right(a), to: left(b), cross: crossFor(a, b, 'x'), other: b });
  }
  if (bottom(b) <= top(a) + EPS) {
    out.push({ side: 'top', axis: 'y', distance: top(a) - bottom(b), from: bottom(b), to: top(a), cross: crossFor(a, b, 'y'), other: b });
  } else if (top(b) >= bottom(a) - EPS) {
    out.push({ side: 'bottom', axis: 'y', distance: top(b) - bottom(a), from: bottom(a), to: top(b), cross: crossFor(a, b, 'y'), other: b });
  }
  return out;
}
