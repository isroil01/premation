/**
 * Snapping for a keyframe drag — pure time math, no DOM.
 *
 * Dragging used to quantize to whole FRAMES and nothing else, which is the one
 * snap that never helps you line anything up: it gets you onto a frame boundary
 * you were already going to land near, and gives you no help at all hitting the
 * playhead or another property's keyframe — the two things people actually
 * align to when building a stagger.
 *
 * The rules, in priority order:
 *   1. the PLAYHEAD, because that is the deliberate target,
 *   2. another KEYFRAME (never one being dragged),
 *   3. the frame grid, which is the fallback quantization.
 *
 * Priority is not "nearest wins" between kinds: a playhead 4px away beats a
 * keyframe 1px away, because the user parked the playhead there on purpose.
 * Within a kind the nearest wins.
 *
 * The threshold is in PIXELS, converted here, so snapping feels the same at
 * every zoom — a seconds-based threshold would snap across half the comp when
 * zoomed out and be unreachable when zoomed in.
 */

export type SnapKind = 'playhead' | 'keyframe' | 'frame';

export interface SnapTarget {
  time: number;
  kind: SnapKind;
}

export interface SnapOptions {
  /** Pixels per second — the zoom. */
  pixelsPerSecond: number;
  /** Frame duration in seconds (1 / fps). */
  frameDuration: number;
  /** Playhead position, in the same time base as the keyframes. */
  playheadTime?: number;
  /** Times of every OTHER keyframe on screen (the dragged ones are excluded by
   *  the caller — a keyframe must not snap to itself). */
  keyframeTimes?: readonly number[];
  /** Grab radius in screen pixels. */
  thresholdPx?: number;
  /** Alt/Option: free positioning — no snapping at all, not even the frame grid. */
  disabled?: boolean;
}

export const DEFAULT_SNAP_THRESHOLD_PX = 8;

/**
 * Resolve a dragged time to its snapped time plus what it snapped to
 * (`null` when nothing was in range and the frame grid did the work).
 */
export function snapKeyframeTime(time: number, opts: SnapOptions): { time: number; target: SnapTarget | null } {
  const { pixelsPerSecond, frameDuration, playheadTime, keyframeTimes, disabled } = opts;
  if (disabled) return { time, target: null };

  const thresholdPx = opts.thresholdPx ?? DEFAULT_SNAP_THRESHOLD_PX;
  // A zero/negative zoom would make every time "within range".
  const thresholdSec = pixelsPerSecond > 0 ? thresholdPx / pixelsPerSecond : 0;

  if (thresholdSec > 0) {
    if (playheadTime !== undefined && Math.abs(playheadTime - time) <= thresholdSec) {
      return { time: playheadTime, target: { time: playheadTime, kind: 'playhead' } };
    }
    let best: number | null = null;
    let bestDist = thresholdSec;
    for (const t of keyframeTimes ?? []) {
      const d = Math.abs(t - time);
      // `<=` so an exact tie with the threshold still snaps; strict `<` against
      // the running best keeps the FIRST of two equidistant targets, which is
      // stable as the pointer moves rather than flickering between them.
      if (d <= bestDist && (best === null || d < bestDist)) {
        best = t;
        bestDist = d;
      }
    }
    if (best !== null) return { time: best, target: { time: best, kind: 'keyframe' } };
  }

  // Fall back to the frame grid — the previous behaviour, now the last resort.
  if (frameDuration > 0) {
    const snapped = Math.round(time / frameDuration) * frameDuration;
    return { time: snapped, target: { time: snapped, kind: 'frame' } };
  }
  return { time, target: null };
}

export type ValueSnapKind = 'keyframe' | 'zero' | 'step';

export interface ValueSnapTarget {
  value: number;
  kind: ValueSnapKind;
}

export interface ValueSnapOptions {
  /**
   * Screen pixels per value unit — `INNER_H / (maxV - minV)` on the graph.
   * Threshold is converted to value space so snap feel stays zoom-stable.
   */
  pixelsPerUnit: number;
  /** Other keyframe values currently on screen (exclude the dragged set). */
  keyframeValues?: readonly number[];
  thresholdPx?: number;
  disabled?: boolean;
  /** Lowest-priority nice step in value units (e.g. 1). */
  step?: number;
}

/**
 * Snap a dragged VALUE to another keyframe’s value, then 0, then an optional
 * step grid. Same pixel-threshold idea as {@link snapKeyframeTime}.
 */
export function snapKeyframeValue(
  value: number,
  opts: ValueSnapOptions,
): { value: number; target: ValueSnapTarget | null } {
  if (opts.disabled) return { value, target: null };
  const thresholdPx = opts.thresholdPx ?? DEFAULT_SNAP_THRESHOLD_PX;
  const ppu = opts.pixelsPerUnit;
  if (!(ppu > 0) || !(thresholdPx > 0)) return { value, target: null };
  const threshold = thresholdPx / ppu;

  let best: number | null = null;
  let bestDist = threshold;
  for (const v of opts.keyframeValues ?? []) {
    const d = Math.abs(v - value);
    if (d <= bestDist && (best === null || d < bestDist)) {
      best = v;
      bestDist = d;
    }
  }
  if (best !== null) return { value: best, target: { value: best, kind: 'keyframe' } };

  if (Math.abs(value) <= threshold) {
    return { value: 0, target: { value: 0, kind: 'zero' } };
  }

  const step = opts.step;
  if (step && step > 0) {
    const snapped = Math.round(value / step) * step;
    if (Math.abs(snapped - value) <= threshold) {
      return { value: snapped, target: { value: snapped, kind: 'step' } };
    }
  }

  return { value, target: null };
}

/**
 * Snap a whole multi-keyframe drag as ONE body.
 *
 * Snapping each keyframe independently would shear the group apart: two keys
 * 3 frames apart would both land on the playhead and collapse into one. So the
 * best snap across the group is found, and the resulting OFFSET is applied to
 * every member — the group keeps its internal spacing and one member lands
 * exactly on target.
 */
export function snapKeyframeGroup(
  times: readonly number[],
  opts: SnapOptions,
): { delta: number; target: SnapTarget | null } {
  if (times.length === 0) return { delta: 0, target: null };

  let bestDelta = 0;
  let bestTarget: SnapTarget | null = null;
  let bestDist = Infinity;
  let bestRank = Infinity;
  const rank: Record<SnapKind, number> = { playhead: 0, keyframe: 1, frame: 2 };

  for (const t of times) {
    const { time: snapped, target } = snapKeyframeTime(t, opts);
    if (!target) continue;
    const r = rank[target.kind];
    const d = Math.abs(snapped - t);
    // Better kind always wins; within a kind, the closest member wins.
    if (r < bestRank || (r === bestRank && d < bestDist)) {
      bestRank = r;
      bestDist = d;
      bestDelta = snapped - t;
      bestTarget = target;
    }
  }
  return { delta: bestDelta, target: bestTarget };
}
