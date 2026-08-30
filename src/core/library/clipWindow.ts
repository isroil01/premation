/**
 * Give an inserted library item the clip bar its own animation deserves.
 *
 * ── The bug this exists for ────────────────────────────────────────────
 * `syncFromScene` seeds every new generative layer a bar of `{ start: 0,
 * duration: <the whole composition> }`, because for a shape or a text layer the
 * user just drew, that is the right answer — it exists for as long as the comp
 * does.
 *
 * It is the wrong answer for a library item, which is not a blank layer but a
 * finished piece of choreography with a KNOWN length, dropped at a KNOWN time.
 * A 0.9-second lower third inserted at two seconds arrived as a bar spanning
 * the entire ten-second comp starting at zero — so the timeline said nothing
 * true about when the thing plays or when it is over, which is most of what a
 * timeline is for.
 *
 * ── Why trimming, rather than setting start and duration ───────────────
 * `trimStart` advances `sourceIn` by the same delta it moves `start`, so the
 * clip's source mapping (`sourceFrameAt`) stays the identity it was. The
 * item's keyframes are authored at absolute composition times; anything that
 * moved the bar WITHOUT compensating would slide the animation out from under
 * them. Trimming narrows the window and leaves the content exactly where it was
 * authored — which is the whole point of doing this at insert time rather than
 * asking the user to trim it afterwards.
 *
 * End before start, always: moving the head first can momentarily invert the
 * clip, which the timeline clamps — and the clamp is what silently produced
 * one-frame bars. Same order, and the same reason, as `lottieLibrary`'s
 * `applyClipTimings`.
 *
 * ── The last frame is part of the animation ────────────────────────────
 * Clip spans are end-EXCLUSIVE, and a choreography's final keyframe sits at
 * exactly its duration. A window of `[t0, t0 + duration]` therefore ends one
 * frame BEFORE the pose the whole animation was travelling toward, and the
 * settled state — the thing the user actually wants to look at — never renders.
 * The window runs one frame past the duration for that reason, and the library
 * insert suite catches it if that is ever "simplified" away.
 */

import { getTimelineController } from '@core/timeline/TimelineController';

/**
 * The shortest window worth creating.
 *
 * Below about this a bar is a sliver the user cannot grab with a mouse, and an
 * item whose choreography really is that short is better served by a bar it can
 * be dragged and trimmed by. Two frames at 30fps.
 */
const MIN_WINDOW_SEC = 2 / 30;

/**
 * Trim `nodeId`'s clip to `[startSec, startSec + durationSec]`.
 *
 * A no-op when the node has no clip (nothing was seeded, or the caller ran
 * before `syncFromScene`) or when the duration is not a usable length — a
 * library item with no animation at all is a static element, and a static
 * element's bar should stay full-length exactly as a hand-drawn layer's does.
 *
 * Returns true when a window was applied.
 */
export function setInsertedClipWindow(nodeId: string, startSec: number, durationSec: number): boolean {
  if (!Number.isFinite(startSec) || !Number.isFinite(durationSec)) return false;
  if (durationSec < MIN_WINDOW_SEC) return false;

  const controller = getTimelineController();
  const clip = controller.getLayersForNode(nodeId)[0];
  if (!clip) return false;

  const start = Math.max(0, startSec);
  // One frame past the duration — see the header. Without it the item's
  // settling pose is trimmed off and the insert appears to end mid-move.
  const fps = controller.fpsForNode(nodeId) || 30;
  controller.trimClipTo(clip.id, 'end', start + durationSec + 1 / fps);
  controller.trimClipTo(clip.id, 'start', start);
  // The index caches layers per track array; a trim mutates the clip in place,
  // so nothing else invalidates it.
  controller.invalidateLayerIndex();
  return true;
}
