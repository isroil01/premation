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

export function usePlaybackClock(): void {
  const playing = useWorkspaceStore((s) =>
    s.activeId ? s.workspaces[s.activeId]?.playing ?? false : false,
  );

  const lastRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const controller = getTimelineController();
    // Keep the engine's play-state in sync with the store flag the transport flips.
    if (playing && !controller.isPlaying) controller.play();
    if (!playing && controller.isPlaying) controller.pause();

    if (!playing) {
      lastRef.current = undefined;
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

      // The engine advances its playhead and mirrors seconds into the store.
      const stillPlaying = controller.tick(dtMs);
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
