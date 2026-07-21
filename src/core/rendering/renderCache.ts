/**
 * renderCache — lightweight bookkeeping of the most recently rendered viewport
 * frame time. The workspace render loop calls `mark(time)` after each frame so
 * other subsystems can cheaply ask "what frame is currently on screen?".
 *
 * NOTE: reconstructed as a minimal, side-effect-free module. The import existed
 * in `useWorkspace` (from a parallel change) but its source file was never
 * present on disk, which broke the whole app build. This restores a green build
 * with the smallest behaviour that satisfies the single caller (`mark`). Frame
 * pixel caching itself lives in `frameCache.ts` (`viewportFrameCache`).
 */

class RenderCache {
  private lastFrame: number | null = null;

  /** Record the time (seconds) of the frame just rendered to the viewport. */
  mark(time: number): void {
    if (Number.isFinite(time)) this.lastFrame = time;
  }

  /** The last marked frame time, or null before the first render. */
  lastMarked(): number | null {
    return this.lastFrame;
  }
}

const renderCache = new RenderCache();
export default renderCache;
