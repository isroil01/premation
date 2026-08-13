/**
 * What the user sees after a library card writes its choreography.
 *
 * Every insert in this folder authors keyframes STARTING AT THE PLAYHEAD, which
 * means the frame the user is looking at when the click lands is the
 * choreography's first keyframe — the pre-entrance state. Measured across the
 * catalogs: 13 of 24 Motion GFX items resolve to zero visible layers at that
 * frame (opacity 0 / scale 0 on every child), and all 12 layer-mode transitions
 * take the selected layer to opacity 0. The nodes were built, the keyframes
 * landed, the selection changed — and the canvas showed nothing, which is
 * indistinguishable from a button that does nothing. That is the whole of the
 * "the library tabs don't work when I add" report.
 *
 * So no insert ends at the write any more. It ends here: play the choreography
 * once from its start so the motion is actually seen, then park the playhead on
 * a frame where the result is VISIBLE — which is not always the end (an exit
 * transition settles invisible by definition, so it rests at its start).
 *
 * Honouring `editorReduceMotion`: no autoplay, jump straight to the resting
 * frame. The user still ends up looking at a frame that shows the result.
 */

import { getTimelineController } from '@core/timeline/TimelineController';
import { usePreferenceStore } from '@stores/preferenceStore';

export interface PreviewSpec {
  /** Seconds — where the choreography begins (the playhead at insert time). */
  from: number;
  /** Seconds — where the choreography ends. */
  to: number;
  /**
   * Seconds — the frame to rest on once the preview is over. Defaults to `to`.
   * Pass `from` for exits and `(from + to) / 2` for a transition solid, whose
   * only interesting frame is the one where it covers the cut.
   */
  restAt?: number;
}

/** Cancels the pending settle of the previous preview, so back-to-back clicks
 *  don't leave an older timer to yank the playhead out from under the newer
 *  one. */
let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Play `from → to` once, then rest on `restAt`.
 *
 * Returns immediately; the settle happens on a timer. Playback is driven by the
 * app's frame clock, so this only schedules the stop — it never pumps the
 * engine itself.
 */
export function previewChoreography(spec: PreviewSpec): void {
  const controller = getTimelineController();
  const rest = spec.restAt ?? spec.to;
  const span = Math.max(0, spec.to - spec.from);

  // The same abandon `cancelInsertPreview` performs — and now the same CODE.
  // This was a second copy of that function's body sitting a few lines above
  // it, which is how the exported one came to have no callers at all: it looked
  // dead because its only job was already being done inline.
  cancelInsertPreview();

  // Reduce-motion (and zero-length choreographies) skip straight to the frame
  // that shows the result — the point of the preview, without the motion.
  if (usePreferenceStore.getState().editorReduceMotion || span <= 0) {
    controller.seekSeconds(rest);
    return;
  }

  controller.seekSeconds(spec.from);
  controller.play();

  // A small tail so the last keyframe is actually reached before we stop —
  // the final frame lands on the tick at or after `to`, not before it.
  pending = setTimeout(() => {
    pending = null;
    // If the user took over the transport in the meantime, leave it alone:
    // yanking the playhead out of a deliberate playback is worse than not
    // settling. Only a preview still in flight gets parked.
    if (!controller.isPlaying) return;
    controller.pause();
    controller.seekSeconds(rest);
  }, span * 1000 + 80);
}

/** Abandon a scheduled settle — the transport is someone else's now. */
export function cancelInsertPreview(): void {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
}
