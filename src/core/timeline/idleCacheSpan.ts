/**
 * Which frames the idle pump should fill, and where it starts.
 *
 * Lifted out of the pump itself (`useWorkspace`'s idle-caching effect) because
 * it is the part that can be wrong without anything looking wrong: an off-by-one
 * at the work area's tail caches one frame past the loop, a missed clamp caches
 * frames the composition does not have, and picking the wrong start leaves the
 * head of the work area cold — which is exactly the part someone hits when they
 * press play on a loop for the second time.
 *
 * None of that needs a GPU to check, so none of it lives inside the effect.
 */

export interface IdleCacheSpanOptions {
  /** Current playhead, in comp frames. */
  playhead: number;
  /** Last frame the composition has. */
  lastCompFrame: number;
  fps: number;
  /**
   * The work area in SECONDS, `end` exclusive — the shape
   * `TimelineController.getWorkArea` returns. Null when none is set.
   */
  workArea: { start: number; end: number } | null;
  /** False: fall back to a short look-ahead ahead of the playhead. */
  wholeSpan: boolean;
  /** Look-ahead length when `wholeSpan` is false. */
  aheadSeconds: number;
}

export interface IdleCacheSpan {
  /** First frame of the span, inclusive. */
  start: number;
  /** Last frame of the span, inclusive. */
  end: number;
  /** Where this pass begins — the playhead when it is inside the span. */
  from: number;
  /** Frames in the span. One pass visits exactly this many. */
  length: number;
}

/**
 * Resolve the span, or null when there is nothing to fill.
 *
 * The work area wins when there is one, because that is what the user has said
 * they are working on and what After Effects fills. With none, the whole
 * composition. With the preference off, the old short window ahead of the
 * playhead, which is the behaviour anyone who turns it off is asking for.
 */
export function idleCacheSpan(options: IdleCacheSpanOptions): IdleCacheSpan | null {
  const { playhead, lastCompFrame, fps, workArea, wholeSpan, aheadSeconds } = options;
  if (lastCompFrame < 0 || fps <= 0) return null;

  const head = Math.min(Math.max(0, Math.round(playhead)), lastCompFrame);

  let start: number;
  let end: number;
  if (wholeSpan && workArea) {
    start = Math.max(0, Math.min(lastCompFrame, Math.round(workArea.start * fps)));
    // `getWorkArea`'s end is EXCLUSIVE (start + duration), so the last live
    // frame is one back. Passing it straight through would cache one frame
    // from OUTSIDE the work area — the same off-by-one the exporter had.
    end = Math.min(lastCompFrame, Math.round(workArea.end * fps) - 1);
  } else if (wholeSpan) {
    start = 0;
    end = lastCompFrame;
  } else {
    // Nothing is "ahead" of the last frame. Returning a one-frame span here
    // would send the pump through a full mask-render-restore cycle to cache the
    // frame already on screen.
    if (head >= lastCompFrame) return null;
    start = head + 1;
    end = Math.min(head + 1 + Math.round(fps * aheadSeconds), lastCompFrame);
  }

  if (end < start) return null;

  // Start where the user is looking, when that is inside the span: the frames
  // they are about to want are the ones just after the playhead. At the very
  // last frame of the span there is nothing "after", so the pass starts at the
  // head — which is where playback would wrap to anyway.
  const from = head >= start && head < end ? head + 1 : start;

  return { start, end, from, length: end - start + 1 };
}

/**
 * The next frame after `frame`, wrapping at the end of the span.
 *
 * Wrapping is not a detail: caching forward-only from the playhead leaves the
 * head of the work area cold, so playing the loop again — the single most
 * common thing anyone does with a work area — starts on the one part that was
 * never cached.
 */
export function nextSpanFrame(frame: number, span: IdleCacheSpan): number {
  return frame >= span.end ? span.start : frame + 1;
}
