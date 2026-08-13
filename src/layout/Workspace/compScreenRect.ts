/**
 * The composition rectangle in viewport screen pixels.
 *
 * Used to place the transparency checkerboard exactly under the comp — the
 * checkerboard is a DOM element behind the canvas, and the canvas draws the
 * comp through the GPU, so the two must agree at every zoom level or a hairline
 * of checker shows past the comp edge (or a gap opens at the seam).
 *
 * Pure, so the rounding rule can be tested at fractional zoom without a canvas
 * or a camera. The rule is the point: BOTH edges are rounded independently and
 * the size is their difference, rather than rounding the origin and the size.
 * Rounding a size makes the right edge drift by up to a pixel relative to where
 * the left edge landed, and the drift changes as you pan — a seam that shimmers
 * while you scroll is worse than one that is consistently a pixel out.
 */

/** A rectangle in CSS pixels, relative to the stage element. */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Maps a comp-space point to stage screen pixels. */
export type WorldToScreen = (p: { x: number; y: number }) => { x: number; y: number };

/**
 * The comp's screen rect, from its two opposite corners in comp space.
 *
 * Both corners are transformed rather than deriving the size from the zoom
 * factor: the camera may flip or rotate an axis in some views, and min/max
 * keeps the rect well-formed instead of producing a negative width.
 */
export function compScreenRect(
  worldToScreen: WorldToScreen,
  compWidth: number,
  compHeight: number,
): ScreenRect {
  const a = worldToScreen({ x: 0, y: 0 });
  const b = worldToScreen({ x: compWidth, y: compHeight });

  const left = Math.round(Math.min(a.x, b.x));
  const top = Math.round(Math.min(a.y, b.y));
  const right = Math.round(Math.max(a.x, b.x));
  const bottom = Math.round(Math.max(a.y, b.y));

  return { left, top, width: right - left, height: bottom - top };
}
