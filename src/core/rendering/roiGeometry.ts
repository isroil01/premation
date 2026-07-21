/**
 * Region-of-Interest geometry — pure, so the drag maths is unit-testable
 * without a canvas or the interaction engine.
 *
 * The renderer paints the ROI border and dims the surround; this module answers
 * "which edge/corner is the pointer grabbing" and "where does the rectangle go
 * when that grip is dragged". All coordinates are COMPOSITION space (px). The
 * caller converts the screen tolerance to comp px (tol / view.scale) so a grip
 * stays the same size on screen at any zoom.
 */

import type { RegionOfInterest } from '@stores/guidesStore';

/** The eight resize grips, plus null for "not on a grip". */
export type RoiHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | null;

export const ROI_MIN_SIZE = 8;

interface Pt {
  x: number;
  y: number;
}

/**
 * Which grip (if any) the comp-space point `p` is over, within `tol` px.
 *
 * Corners win over edges (they sit at the intersection), so a diagonal drag
 * resizes both axes rather than one. Only the edges are interactive — the
 * interior passes through to layer selection, exactly as in AE, so the ROI
 * never blocks picking a layer inside it.
 */
export function roiHandleAt(roi: RegionOfInterest, p: Pt, tol: number): RoiHandle {
  const x0 = roi.x;
  const y0 = roi.y;
  const x1 = roi.x + roi.width;
  const y1 = roi.y + roi.height;
  const nearX0 = Math.abs(p.x - x0) <= tol;
  const nearX1 = Math.abs(p.x - x1) <= tol;
  const nearY0 = Math.abs(p.y - y0) <= tol;
  const nearY1 = Math.abs(p.y - y1) <= tol;
  const withinX = p.x >= x0 - tol && p.x <= x1 + tol;
  const withinY = p.y >= y0 - tol && p.y <= y1 + tol;

  // Corners first.
  if (nearX0 && nearY0) return 'nw';
  if (nearX1 && nearY0) return 'ne';
  if (nearX1 && nearY1) return 'se';
  if (nearX0 && nearY1) return 'sw';
  // Edges — only when the point runs alongside that edge.
  if (nearY0 && withinX) return 'n';
  if (nearY1 && withinX) return 's';
  if (nearX0 && withinY) return 'w';
  if (nearX1 && withinY) return 'e';
  return null;
}

/**
 * The rectangle after dragging `handle` to comp-space point `p`.
 *
 * Each grip moves only the edge(s) it owns; the opposite edges stay put. The
 * result may be inverted (dragging a right edge past the left) or tiny — the
 * caller runs it through {@link clampRoi} to normalize and bound it.
 */
export function resizeRoi(roi: RegionOfInterest, handle: RoiHandle, p: Pt): RegionOfInterest {
  if (!handle) return roi;
  let x0 = roi.x;
  let y0 = roi.y;
  let x1 = roi.x + roi.width;
  let y1 = roi.y + roi.height;

  if (handle === 'nw' || handle === 'w' || handle === 'sw') x0 = p.x;
  if (handle === 'ne' || handle === 'e' || handle === 'se') x1 = p.x;
  if (handle === 'nw' || handle === 'n' || handle === 'ne') y0 = p.y;
  if (handle === 'sw' || handle === 's' || handle === 'se') y1 = p.y;

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A fresh rectangle from two comp-space corners (drawing a new ROI). */
export function rectFromDrag(a: Pt, b: Pt): RegionOfInterest {
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

/**
 * Normalize a rectangle: flip negative width/height, clamp inside the comp, and
 * enforce a minimum size so a region can never collapse to nothing.
 */
export function clampRoi(roi: RegionOfInterest, compW: number, compH: number, minSize = ROI_MIN_SIZE): RegionOfInterest {
  // Flip if inverted.
  let x = roi.width < 0 ? roi.x + roi.width : roi.x;
  let y = roi.height < 0 ? roi.y + roi.height : roi.y;
  let w = Math.abs(roi.width);
  let h = Math.abs(roi.height);

  // Enforce a minimum, then keep the whole rect inside the comp.
  w = Math.max(minSize, Math.min(w, compW));
  h = Math.max(minSize, Math.min(h, compH));
  x = Math.max(0, Math.min(x, compW - w));
  y = Math.max(0, Math.min(y, compH - h));

  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

/** The cursor CSS for a grip, so the pointer signals what it will do. */
export function roiHandleCursor(handle: RoiHandle): string {
  switch (handle) {
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    default:
      return '';
  }
}
