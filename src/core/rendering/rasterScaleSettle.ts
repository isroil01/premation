/**
 * Zoom-settle filter for the vector raster scale.
 *
 * During a wheel/pinch gesture the viewport's scale changes every frame, and
 * every resolution-tier crossing re-rasterizes EVERY vector layer inside one
 * frame — a hitch per crossing, which is what made zooming feel stuttery. The
 * filter keeps serving the last SETTLED scale while the input keeps moving
 * (existing textures are reused, stretched — briefly soft, exactly AE's
 * behaviour), and adopts the new scale once the input has been quiet for
 * `settleMs`, firing `onSettled` so the host can repaint sharp at rest.
 *
 * Pure timing/state — extracted from MotionRendererBackend so it can be unit
 * tested without a GPU. The backend gates it to the interactive viewport;
 * auxiliary backends (export, thumbnails, the harness) render at a constant
 * scale where this is a pass-through from the first sample.
 */

export interface RasterScaleSettle {
  /** Feed this frame's target scale; returns the scale to rasterize at. */
  sample(target: number): number;
  /** Cancel any pending adoption (call on dispose). */
  dispose(): void;
}

export function createRasterScaleSettle(
  onSettled: () => void,
  settleMs = 160,
): RasterScaleSettle {
  let settled = 0;
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    sample(target: number): number {
      if (!(target > 0) || !Number.isFinite(target)) return settled || 1;
      if (settled === 0) {
        settled = target;
        return target;
      }
      // Relative epsilon, not strict equality: a re-fit can recompute the same
      // zoom with float jitter, and a strict comparison would keep the settle
      // timer (and its repaints) churning forever on a parked viewport.
      if (Math.abs(target - settled) <= settled * 1e-6) return settled;
      pending = target;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        settled = pending || settled;
        onSettled();
      }, settleMs);
      return settled;
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
