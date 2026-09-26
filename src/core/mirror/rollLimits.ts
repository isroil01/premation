/**
 * A ROLL edit's limits over the document MIRROR (B4) — the twin of the timeline
 * controller's `rollLimitsFor` / @motion/timeline `rollLimits`, in comp frames.
 * Pure: takes the two layers' mirror headers, never the engine.
 *
 * Each layer's bar is its `LayerTiming`: the bar `[inPoint, outPoint)`, the
 * comp time its source time 0 plays at (`startTime`, so the source-in is
 * `inPoint - startTime`) and, for a bounded source, the source's length on the
 * comp axis (`sourceDuration`; absent = unbounded — a still, a shape, text).
 *
 *   max  how far the cut can move RIGHT: the left bar's tail handle (source
 *        left after its out point) and the right bar's room (it keeps a frame)
 *   min  how far LEFT (≤ 0): the left bar's room, the right bar's head handle
 *        (source before its in point) and the comp start
 *
 * A locked layer pins the cut ({0, 0}).
 */

import { flicksToSeconds, type LayerInfo } from '@motion/engine-api';

export function mirrorRollLimits(
  left: Pick<LayerInfo, 'timing' | 'switches'> | undefined,
  right: Pick<LayerInfo, 'timing' | 'switches'> | undefined,
  fps: number,
  minDuration = 1,
): { min: number; max: number } | null {
  if (!left || !right || !(fps > 0)) return null;
  if (left.switches.locked || right.switches.locked) return { min: 0, max: 0 };
  const f = (t: number): number => Math.round(flicksToSeconds(t) * fps);
  const INF = Number.POSITIVE_INFINITY;
  const lIn = f(left.timing.inPoint);
  const lOut = f(left.timing.outPoint);
  const rIn = f(right.timing.inPoint);
  const rOut = f(right.timing.outPoint);
  const lSourceOut = lOut - f(left.timing.startTime);
  const rSourceIn = rIn - f(right.timing.startTime);
  const leftTail = left.timing.sourceDuration === undefined ? INF : Math.max(0, f(left.timing.sourceDuration) - lSourceOut);
  const rightRoom = Math.max(0, rOut - rIn - minDuration);
  const max = Math.min(leftTail, rightRoom);
  const rightHead = right.timing.sourceDuration === undefined ? INF : Math.max(0, rSourceIn);
  const leftRoom = Math.max(0, lOut - lIn - minDuration);
  const back = Math.min(leftRoom, rightHead, Math.max(0, rIn));
  return { min: back === 0 ? 0 : -back, max };
}
