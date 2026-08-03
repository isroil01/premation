/**
 * Responsive time — protected regions (M7).
 *
 * ── The problem ──────────────────────────────────────────────────────
 * A lower-third is authored at, say, 5s: 0.6s of intro animation, a hold, and
 * 0.6s of outro. Stretch it to 8s uniformly and the intro takes 0.96s — the
 * animation is now sluggish, and the reason the template looked good is gone.
 * Stretch it to 3s and the intro is 0.36s, too fast to read.
 *
 * What a user actually means by "make it longer" is *hold the middle longer*.
 * Protected regions say so: marked spans keep their AUTHORED duration under any
 * stretch, and only the unprotected remainder absorbs the difference. That is
 * the single thing that makes one lower-third reusable at any length.
 *
 * ── Where this composes ──────────────────────────────────────────────
 * `compToKeyframeTime` in TimelineController is the ONLY axis keyframes are
 * sampled on. This is a piecewise-linear map applied BEFORE that chain —
 * stretched comp time → authored comp time — so everything downstream (precomp
 * remaps, clip retime, per-layer stretch) keeps working on authored time and
 * needs no knowledge of it. Adding a parallel time path instead would let
 * keyframes and the clip bar drift apart, which is the failure mode
 * `getRemappedTime`'s "one axis" rule exists to prevent.
 *
 * Pure and self-contained: no scene graph, no stores. Every edge case below is
 * a real authoring state, not a defensive flourish.
 */

/** A span of AUTHORED time that must keep its duration under any stretch. */
export interface ProtectedRegion {
  startSec: number;
  endSec: number;
}

/** Normalise: drop empties/invalid, clamp into [0, duration], sort, merge overlaps.
 *
 *  Overlapping regions are MERGED rather than summed — two overlapping protected
 *  spans protect their union once. Summing would over-count the protected total
 *  and shrink the flexible remainder below what is actually there, which shows up
 *  as a template that refuses to stretch for no visible reason. */
export function normalizeRegions(
  regions: readonly ProtectedRegion[] | undefined,
  durationSec: number,
): ProtectedRegion[] {
  if (!regions || regions.length === 0 || !(durationSec > 0)) return [];
  const clamped = regions
    .map((r) => ({
      startSec: Math.max(0, Math.min(durationSec, Math.min(r.startSec, r.endSec))),
      endSec: Math.max(0, Math.min(durationSec, Math.max(r.startSec, r.endSec))),
    }))
    .filter((r) => r.endSec - r.startSec > 1e-9)
    .sort((a, b) => a.startSec - b.startSec);

  const out: ProtectedRegion[] = [];
  for (const r of clamped) {
    const last = out[out.length - 1];
    if (last && r.startSec <= last.endSec + 1e-9) {
      last.endSec = Math.max(last.endSec, r.endSec);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Total authored seconds that cannot be stretched. */
export function protectedTotal(regions: readonly ProtectedRegion[]): number {
  return regions.reduce((sum, r) => sum + (r.endSec - r.startSec), 0);
}

/**
 * Map a time on the STRETCHED timeline back to the AUTHORED timeline.
 *
 * Protected spans pass through 1:1; the gaps between them scale by whatever
 * factor makes the totals work out. Returns `t` unchanged when there is nothing
 * to do, so the common case costs one comparison.
 *
 * If the target is shorter than the protected total, the flexible parts collapse
 * to zero and the protected spans still play at their authored speed — the
 * result is longer than requested. That is deliberate: the alternative is
 * squeezing the very animation the user marked as un-squeezable, and a template
 * that comes out slightly long is recoverable where one whose intro has been
 * crushed is not.
 */
export function stretchedToAuthored(
  t: number,
  authoredDurationSec: number,
  targetDurationSec: number,
  regions: readonly ProtectedRegion[] | undefined,
): number {
  if (!(authoredDurationSec > 0) || !(targetDurationSec > 0)) return t;

  const prot = normalizeRegions(regions, authoredDurationSec);
  if (prot.length === 0) {
    // No protected spans: a plain uniform stretch.
    return t * (authoredDurationSec / targetDurationSec);
  }

  const protTotal = protectedTotal(prot);
  const flexAuthored = Math.max(0, authoredDurationSec - protTotal);
  const flexTarget = Math.max(0, targetDurationSec - protTotal);
  // No flexible time to redistribute — every second is protected, so the
  // template simply is its authored length.
  if (flexAuthored <= 1e-9) return t;
  const scale = flexTarget / flexAuthored;

  // Walk the authored timeline, tracking where each segment lands on the
  // stretched one, and invert whichever segment `t` falls in.
  let authoredCursor = 0;
  let stretchedCursor = 0;
  for (const r of prot) {
    // Flexible gap before this region.
    const gapAuthored = r.startSec - authoredCursor;
    if (gapAuthored > 1e-9) {
      const gapStretched = gapAuthored * scale;
      if (t < stretchedCursor + gapStretched) {
        const local = t - stretchedCursor;
        return authoredCursor + (scale > 1e-9 ? local / scale : 0);
      }
      authoredCursor += gapAuthored;
      stretchedCursor += gapStretched;
    }
    // The protected region itself — 1:1.
    const protLen = r.endSec - r.startSec;
    if (t < stretchedCursor + protLen) {
      return authoredCursor + (t - stretchedCursor);
    }
    authoredCursor += protLen;
    stretchedCursor += protLen;
  }

  // Trailing flexible tail.
  const tailAuthored = authoredDurationSec - authoredCursor;
  if (tailAuthored > 1e-9) {
    const local = t - stretchedCursor;
    return authoredCursor + (scale > 1e-9 ? local / scale : 0);
  }
  // Past the end: carry on at authored speed rather than clamping, so a
  // playhead beyond the template does not freeze on the last frame.
  return authoredCursor + (t - stretchedCursor);
}

/** The stretched duration a target implies, given what cannot be squeezed. */
export function effectiveDuration(
  authoredDurationSec: number,
  targetDurationSec: number,
  regions: readonly ProtectedRegion[] | undefined,
): number {
  const prot = normalizeRegions(regions, authoredDurationSec);
  return Math.max(targetDurationSec, protectedTotal(prot));
}

/** Smallest region a drag may produce. Below this a region is invisible and
 *  un-grabbable, so a user could lose one by nudging an edge. */
export const MIN_REGION_SEC = 0.05;

/**
 * Clamp a proposed edge position so the region set stays ordered and disjoint.
 *
 * THE POINT: this runs at the INTERACTION layer, before the value is written —
 * not as validation afterwards. `stretchedToAuthored` walks regions assuming
 * they are sorted and non-overlapping; `normalizeRegions` repairs violations by
 * merging, which silently swallows a region the user can still see a handle
 * for. Clamping the drag means the invalid state is never constructed, so there
 * is nothing to repair and nothing to explain.
 *
 * `regions` must be sorted (the store keeps them so). `index` is the region
 * being edited; neighbours bound it, and the composition bounds the ends.
 */
export function clampRegionEdge(
  regions: readonly ProtectedRegion[],
  index: number,
  edge: 'start' | 'end',
  proposedSec: number,
  durationSec: number,
): number {
  const r = regions[index];
  if (!r) return proposedSec;
  const prev = regions[index - 1];
  const next = regions[index + 1];

  // Neighbours are held MIN_REGION_SEC apart rather than merely non-crossing.
  // Two regions that touch exactly are merged by normalizeRegions — correct for
  // the map, wrong for the user, who is still looking at two sets of handles for
  // what has silently become one region.
  if (edge === 'start') {
    const lo = prev ? prev.endSec + MIN_REGION_SEC : 0;
    const hi = r.endSec - MIN_REGION_SEC;
    return Math.max(Math.min(lo, hi), Math.min(hi, proposedSec));
  }
  const lo = r.startSec + MIN_REGION_SEC;
  const hi = next ? next.startSec - MIN_REGION_SEC : durationSec;
  return Math.min(Math.max(lo, hi), Math.max(lo, proposedSec));
}

/**
 * A new region placed in the largest free gap, or null when there is no room.
 *
 * Returning null rather than a zero-width region is deliberate: a control that
 * appears to work and produces nothing is worse than one that is visibly
 * unavailable.
 */
export function proposeRegion(
  regions: readonly ProtectedRegion[],
  durationSec: number,
): ProtectedRegion | null {
  const sorted = normalizeRegions(regions, durationSec);
  const gaps: ProtectedRegion[] = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.startSec - cursor > 1e-9) gaps.push({ startSec: cursor, endSec: r.startSec });
    cursor = Math.max(cursor, r.endSec);
  }
  if (durationSec - cursor > 1e-9) gaps.push({ startSec: cursor, endSec: durationSec });

  let best: ProtectedRegion | null = null;
  let bestLen = 0;
  for (const g of gaps) {
    const len = g.endSec - g.startSec;
    if (len > bestLen) { bestLen = len; best = g; }
  }
  if (!best) return null;
  // Needs room for the region itself PLUS separation from its neighbours, or
  // the proposal would be merged into one of them the moment it is written.
  const inset = best.startSec > 0 ? MIN_REGION_SEC : 0;
  const usable = bestLen - inset - (best.endSec < durationSec ? MIN_REGION_SEC : 0);
  if (usable < MIN_REGION_SEC) return null;
  // Up to a quarter of the gap, floored at the minimum: visible without
  // swallowing the flexible middle it was placed in.
  const len = Math.max(MIN_REGION_SEC, Math.min(usable, bestLen / 4));
  const start = best.startSec + inset;
  return { startSec: start, endSec: start + len };
}
