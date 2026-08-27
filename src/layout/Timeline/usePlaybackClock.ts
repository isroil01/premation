/**
 * usePlaybackClock — the real-time clock that pumps the Timeline Engine while
 * playing.
 *
 * The `@motion/timeline` engine (via {@link TimelineController}) is the single
 * authority for `time` / `playing`; it advances its own playhead on `tick(dtMs)`
 * (looping within its loop range or auto-pausing at the end) and mirrors the
 * result into the workspace store, which the rest of the UI reads. This hook is
 * just the wall-clock pump: on each frame while playing it feeds the engine the
 * elapsed milliseconds.
 *
 * Scheduling is visibility-aware: requestAnimationFrame while visible (smooth,
 * vsync-aligned), falling back to a timer when the window is hidden — rAF is
 * paused for hidden documents, and a desktop editor's playhead should keep
 * running when the window loses focus.
 *
 * Mount once, near the timeline host.
 */

import { useEffect, useRef } from 'react';
import { useWorkspaceStore } from '@stores/projectStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { videoDiag, playbackHealth, VIDEO_DIAG_LIVE_MS } from '@core/rendering/videoPlaybackDiag';

/** Element lag (ms behind the playhead) where the timeline starts slowing to
 *  meet the decoder. Under this, the rate trim absorbs it invisibly. */
const MEDIA_LAG_SLOW_MS = 100;

/**
 * How much of this tick's advance the slowest live video decoder can actually
 * sustain, in (0.4 … 1]. A decoder that cannot keep realtime on this machine
 * shows up as growing NEGATIVE drift in videoDiag; scaling the timeline's
 * advance by this factor is the decode half of the After Effects contract —
 * the playhead may never outrun the pipeline. The old behaviour chased the
 * starving decoder with forward hard seeks instead: a mid-GOP decode (frozen
 * picture, seconds long) every 1.5s, which read as "some parts freeze".
 */
function mediaPaceFactor(now: number): number {
  let factor = 1;
  for (const s of videoDiag.samples.values()) {
    if (now - s.updatedAt > VIDEO_DIAG_LIVE_MS) continue;
    if (s.seeking || s.ended) continue;
    // Cache-blit syncs report the element's position while its pixels are
    // NOT on screen (the cache is). Slowing the timeline for those turned
    // fully-cached playback — which needs no decoder at all — into a
    // fast/slow oscillation that tracked an invisible element's struggles.
    if (s.syncOnly) continue;
    if (s.driftMs < -MEDIA_LAG_SLOW_MS) {
      // −100ms lag ≈ 0.97; −500ms ≈ 0.7; −1s and beyond floors at 0.4 so a
      // dying element can never stall the transport outright.
      factor = Math.min(factor, Math.max(0.4, 1 + (s.driftMs / 1000) * 0.6));
    }
  }
  return factor;
}

export function usePlaybackClock(): void {
  const playing = useWorkspaceStore((s) =>
    s.activeTabId ? s.tabs[s.activeTabId]?.playing ?? false : false,
  );

  const lastRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const controller = getTimelineController();
    // Keep the engine's play-state in sync with the store flag the transport flips.
    if (playing && !controller.isPlaying) controller.play();
    if (!playing && controller.isPlaying) controller.pause();

    if (!playing) {
      lastRef.current = undefined;
      playbackHealth.realtimeFactor = 1;
      return;
    }

    let cancelled = false;
    const handle: { raf?: number; timer?: ReturnType<typeof setTimeout> } = {};

    const schedule = (fn: () => void): void => {
      if (typeof document !== 'undefined' && document.hidden) {
        handle.timer = setTimeout(fn, 1000 / 60);
      } else {
        handle.raf = requestAnimationFrame(fn);
      }
    };

    const tick = (): void => {
      if (cancelled) return;
      const now = performance.now();
      const last = lastRef.current ?? now;
      const dtMs = now - last;
      lastRef.current = now;

      // AFTER EFFECTS pacing, not Premiere pacing: the playhead may never
      // outrun rendering. Each pump tick advances at most ~1.5 comp frames,
      // so when a frame takes longer than its budget the TIMELINE slows down
      // and every frame still gets rendered and cached — the first pass over
      // a heavy comp plays slower than realtime, fills the preview cache
      // completely, and the next loop plays realtime from green. Unclamped
      // wall-clock deltas did the opposite: the playhead skipped whatever
      // rendering couldn't finish, the skipped frames never entered the
      // cache, and uncached spans stuttered forever ("some parts play, some
      // parts look broken"). On a machine that renders inside the budget the
      // clamp never engages (a 60Hz tick is ~0.5 frames at 30fps).
      const frameMs = 1000 / Math.max(1, controller.fps);
      const paced = Math.min(dtMs, frameMs * 1.5);
      const advance = paced * mediaPaceFactor(now);

      // Publish how close to realtime the transport ran (EMA). The audio
      // bridge mutes on sustained sub-realtime preview — the AE behaviour.
      if (dtMs > 0) {
        const inst = Math.min(1, advance / dtMs);
        playbackHealth.realtimeFactor += (inst - playbackHealth.realtimeFactor) * 0.15;
      }

      // The engine advances its playhead and mirrors seconds into the store.
      const stillPlaying = controller.tick(advance);
      if (!stillPlaying) return; // engine auto-paused (and cleared the store flag)
      schedule(tick);
    };

    schedule(tick);
    return () => {
      cancelled = true;
      if (handle.raf !== undefined) cancelAnimationFrame(handle.raf);
      if (handle.timer !== undefined) clearTimeout(handle.timer);
    };
  }, [playing]);
}

export default usePlaybackClock;
