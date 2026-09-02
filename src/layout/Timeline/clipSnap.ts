/**
 * Snapping for a CLIP-bar drag — pure time math, no DOM.
 *
 * Dragging a bar used to quantize to whole FRAMES and nothing else, which is
 * the one snap that never helps you build an edit: it drops the bar on a frame
 * boundary you were already going to land near, and gives you no help at all
 * butting one layer against the next, lining an in-point up with the playhead,
 * or filling the work area. Those are the alignments people actually make, and
 * every one of them had to be done by eye at the current zoom.
 *
 * What a dragged bar may latch onto:
 *   • the PLAYHEAD,
 *   • another CLIP's start or end, on any track (never one being dragged),
 *   • a comp or layer MARKER,
 *   • the WORK AREA in/out,
 *   • the comp start / end,
 *   • the frame grid, as the fallback quantization.
 *
 * Unlike `keyframeSnap`, kind is NOT a hard priority here: the nearest target
 * wins, and kind only breaks a tie. A keyframe drag has one obvious deliberate
 * target (the playhead) and a dense field of accidental ones; a clip drag is
 * the opposite — the bar you are butting up against is usually much closer than
 * the playhead, and letting a distant playhead outrank it would fight the user.
 *
 * The radius is in PIXELS, converted here, so snapping feels the same at every
 * zoom — a seconds-based radius would snap across half the comp when zoomed out
 * and be unreachable when zoomed in.
 *
 * TIME UNIT: seconds, matching `TimelineClip.start` / `.duration` and the rest
 * of the timeline VIEW. (The engine stores clips in frames; the conversion
 * happens before the model reaches this module.)
 */

import type { TimelineTrack, TimelineMarker } from './TimelineModel';

export type ClipSnapKind = 'playhead' | 'clip' | 'marker' | 'workArea' | 'comp' | 'frame';

export interface ClipSnapTarget {
  time: number;
  kind: ClipSnapKind;
}

export interface ClipSnapOptions {
  /** Pixels per second — the zoom. */
  pixelsPerSecond: number;
  /** Frame duration in seconds (1 / fps). */
  frameDuration: number;
  /** Grab radius in screen pixels. */
  thresholdPx?: number;
  /** Alt/Option: free positioning — no snapping at all, not even the frame grid. */
  disabled?: boolean;
}

export const DEFAULT_CLIP_SNAP_THRESHOLD_PX = 8;

/**
 * Tie-break order when two targets sit at the same distance. Lower wins.
 * Only ever consulted for an exact tie, so it is a stability rule (the guide
 * line must not flicker between two coincident targets), not a priority.
 */
const KIND_RANK: Record<ClipSnapKind, number> = {
  playhead: 0,
  clip: 1,
  marker: 2,
  workArea: 3,
  comp: 4,
  frame: 5,
};

export interface CollectClipSnapTargetsInput {
  tracks: readonly TimelineTrack[];
  /** Clip ids being dragged — their edges are NOT targets (a bar must not snap
   *  to itself, which would pin it in place). */
  excludeClipIds?: readonly string[] | ReadonlySet<string>;
  /** Playhead, in comp seconds. */
  playheadTime?: number;
  /** Composition markers. Layer markers are read off the tracks. */
  markers?: readonly TimelineMarker[];
  workArea?: { start: number; end: number } | null;
  /** Comp length in seconds; 0 and this become `comp` targets. */
  compDuration?: number;
}

/**
 * Build the target list for a clip drag from the timeline model.
 *
 * Duplicates are collapsed (a dozen layers all starting at 0 should be ONE
 * target, not twelve equally-distant ones), keeping the highest-ranked kind at
 * each time so the guide line is labelled by the most meaningful thing there.
 */
export function collectClipSnapTargets(input: CollectClipSnapTargetsInput): ClipSnapTarget[] {
  const excluded =
    input.excludeClipIds instanceof Set
      ? input.excludeClipIds
      : new Set(input.excludeClipIds ?? []);

  const byTime = new Map<number, ClipSnapKind>();
  const add = (time: number, kind: ClipSnapKind): void => {
    if (!Number.isFinite(time)) return;
    const prev = byTime.get(time);
    if (prev === undefined || KIND_RANK[kind] < KIND_RANK[prev]) byTime.set(time, kind);
  };

  if (input.playheadTime !== undefined) add(input.playheadTime, 'playhead');

  for (const track of input.tracks) {
    for (const clip of track.clips ?? []) {
      if (excluded.has(clip.id)) continue;
      add(clip.start, 'clip');
      add(clip.start + clip.duration, 'clip');
    }
    for (const m of track.markers ?? []) add(m.time, 'marker');
  }

  for (const m of input.markers ?? []) add(m.time, 'marker');

  if (input.workArea) {
    add(input.workArea.start, 'workArea');
    add(input.workArea.end, 'workArea');
  }

  add(0, 'comp');
  if (input.compDuration !== undefined && input.compDuration > 0) add(input.compDuration, 'comp');

  const out: ClipSnapTarget[] = [];
  for (const [time, kind] of byTime) out.push({ time, kind });
  return out;
}

/**
 * Resolve ONE dragged edge to its snapped time plus what it hit.
 *
 * `target` is null only when snapping is disabled or there is no frame grid —
 * a frame-grid landing reports itself as `kind: 'frame'` so the caller can
 * decide (as the timeline does) not to draw a guide line for it.
 */
export function snapClipTime(
  time: number,
  targets: readonly ClipSnapTarget[],
  opts: ClipSnapOptions,
): { time: number; target: ClipSnapTarget | null } {
  if (opts.disabled) return { time, target: null };

  const thresholdPx = opts.thresholdPx ?? DEFAULT_CLIP_SNAP_THRESHOLD_PX;
  // A zero/negative zoom would put every time "within range".
  const thresholdSec = opts.pixelsPerSecond > 0 ? thresholdPx / opts.pixelsPerSecond : 0;

  if (thresholdSec > 0) {
    let best: ClipSnapTarget | null = null;
    let bestDist = Infinity;
    for (const t of targets) {
      const d = Math.abs(t.time - time);
      if (d > thresholdSec) continue;
      // Strictly nearer wins; an exact tie falls back to kind rank, which is
      // stable as the pointer moves instead of flickering between the two.
      if (d < bestDist || (d === bestDist && best !== null && KIND_RANK[t.kind] < KIND_RANK[best.kind])) {
        best = t;
        bestDist = d;
      }
    }
    if (best) return { time: best.time, target: best };
  }

  // Fall back to the frame grid — the previous behaviour, now the last resort.
  if (opts.frameDuration > 0) {
    const snapped = Math.round(time / opts.frameDuration) * opts.frameDuration;
    return { time: snapped, target: { time: snapped, kind: 'frame' } };
  }
  return { time, target: null };
}

/**
 * Snap a whole bar by considering EVERY edge that is moving, and return the one
 * offset to apply to all of them.
 *
 * Snapping each edge on its own would deform the clip: a bar dragged near two
 * targets would have its head pulled to one and its tail to the other, silently
 * changing its duration in the middle of a MOVE. So the best snap across the
 * edges is found and its delta applied to the bar as a body — the duration is
 * preserved and one edge lands exactly on target. A trim passes a single edge
 * and gets the same math for free.
 */
export function snapClipEdges(
  edges: readonly number[],
  targets: readonly ClipSnapTarget[],
  opts: ClipSnapOptions,
): { delta: number; target: ClipSnapTarget | null } {
  let bestDelta = 0;
  let bestTarget: ClipSnapTarget | null = null;
  let bestDist = Infinity;
  let bestRank = Infinity;

  for (const edge of edges) {
    const { time: snapped, target } = snapClipTime(edge, targets, opts);
    if (!target) continue;
    const d = Math.abs(snapped - edge);
    const rank = KIND_RANK[target.kind];
    // The frame grid never beats a real target, however close it happens to be:
    // it is the fallback, and letting it win would suppress the guide line for
    // an alignment the user was aiming at.
    const isFallback = target.kind === 'frame';
    const bestIsFallback = bestTarget?.kind === 'frame';
    const better =
      bestTarget === null ||
      (bestIsFallback && !isFallback) ||
      (bestIsFallback === isFallback && (d < bestDist || (d === bestDist && rank < bestRank)));
    if (better) {
      bestDelta = snapped - edge;
      bestTarget = target;
      bestDist = d;
      bestRank = rank;
    }
  }

  return { delta: bestDelta, target: bestTarget };
}
