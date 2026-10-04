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

/**
 * The shortest window worth creating.
 *
 * Below about this a bar is a sliver the user cannot grab with a mouse, and an
 * item whose choreography really is that short is better served by a bar it can
 * be dragged and trimmed by. Two frames at 30fps.
 */
const MIN_WINDOW_SEC = 2 / 30;

/**
 * The bar {@link setInsertedClipWindow} trims a NEW layer's default bar to, as
 * fragment data (frames of the comp at `fps`): `[startSec, startSec +
 * durationSec + 1 frame]`, `sourceIn` advanced with the head so the source
 * mapping stays the identity. Null when no window applies (the default bar).
 * Pure — what an engine-client insert puts on the layer it builds.
 */
export function insertedClipWindow(
  startSec: number,
  durationSec: number,
  fps: number,
  compFrames: number,
): { start: number; duration: number; sourceIn: number; sourceDuration: null } | null {
  if (!Number.isFinite(startSec) || !Number.isFinite(durationSec)) return null;
  if (durationSec < MIN_WINDOW_SEC || !(fps > 0) || !(compFrames > 0)) return null;
  const start = Math.round(Math.max(0, startSec) * fps);
  const end = Math.round((Math.max(0, startSec) + durationSec + 1 / fps) * fps);
  const head = Math.min(start, Math.max(start, end) - 1);
  return { start: head, duration: Math.max(1, end - head), sourceIn: head, sourceDuration: null };
}
