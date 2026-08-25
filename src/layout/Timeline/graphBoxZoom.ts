/**
 * Horizontal box-zoom for the graph editor — map a dragged time span (in svg
 * pixels at the current zoom) to a new pixels-per-second and scrollLeft so that
 * span fills the viewport. Pure so the zoom math is unit-tested without React.
 */

export interface BoxZoomInput {
  /** Svg x of the box corners (order-independent). */
  x0: number;
  x1: number;
  /** Current horizontal zoom (svg x = t * currentPps). */
  currentPps: number;
  viewportW: number;
  minPps: number;
  maxPps: number;
  /** Ignore boxes thinner than this (accidental Alt-clicks). */
  minSpanPx?: number;
}

export interface BoxZoomResult {
  pps: number;
  /** scrollLeft so the box's left edge lands at the viewport's left. */
  scrollLeft: number;
  t0: number;
  t1: number;
}

/**
 * Returns null when the drag is too small to count as a zoom, or inputs are
 * degenerate.
 */
export function computeBoxZoomFromSvg(input: BoxZoomInput): BoxZoomResult | null {
  const { x0, x1, viewportW, minPps, maxPps, currentPps } = input;
  const minSpanPx = input.minSpanPx ?? 8;
  if (!(viewportW > 0) || !(currentPps > 0) || !(maxPps >= minPps) || !(minPps > 0)) return null;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const spanPx = right - left;
  if (spanPx < minSpanPx) return null;
  const t0 = left / currentPps;
  const t1 = right / currentPps;
  const spanSec = t1 - t0;
  if (!(spanSec > 0)) return null;
  const pps = Math.min(maxPps, Math.max(minPps, viewportW / spanSec));
  return { pps, scrollLeft: Math.max(0, t0 * pps), t0, t1 };
}
