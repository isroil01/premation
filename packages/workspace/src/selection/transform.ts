/**
 * Transform math for the selection gizmo — pure functions the tools use to turn
 * a handle drag into new geometry. Kept separate from the tool so the behavior
 * is unit-testable without any input plumbing.
 *
 * Two resize models live here, and the difference is not cosmetic:
 *
 *   • `resizeBounds`           — holds the edge/corner OPPOSITE the grabbed
 *                                handle fixed (the design-tool convention).
 *   • `resizeBoundsAboutPivot` — holds an arbitrary point fixed, which is what
 *                                this editor uses with the layer's ANCHOR.
 *
 * The anchor version is the correct one here because the renderer places a
 * layer as `position + R·S·(local − anchor)`: the anchor is the one point that
 * does not move when Scale changes. Scaling about the opposite corner therefore
 * produces a result the Scale property alone cannot express — it silently moves
 * Position too, so a keyframed scale and a handle drag of the same magnitude
 * disagree. Scaling about the anchor leaves Position alone, exactly like the
 * keyframed property.
 *
 * Both clamp to a minimum size without flipping. Rotation is the signed angle
 * swept around a pivot.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import type { HandleId } from './handles';

/**
 * New axis-aligned bounds after dragging `handle` to `pointer` (world space),
 * holding the opposite edge/corner fixed. `rotate` handles return the input
 * unchanged (they don't resize). `uniform` (Shift) locks the original aspect
 * ratio, scaling both axes by the dominant axis's factor.
 */
export function resizeBounds(
  orig: Rect,
  handle: HandleId,
  pointer: Vec2,
  center: boolean = false,
  minSize = 4,
  uniform = false,
): Rect {
  let left = orig.x;
  let right = orig.x + orig.width;
  let top = orig.y;
  let bottom = orig.y + orig.height;

  const movesLeft = handle === 'w' || handle === 'nw' || handle === 'sw';
  const movesRight = handle === 'e' || handle === 'ne' || handle === 'se';
  const movesTop = handle === 'n' || handle === 'nw' || handle === 'ne';
  const movesBottom = handle === 's' || handle === 'sw' || handle === 'se';

  if (center) {
    const cx = orig.x + orig.width / 2;
    const cy = orig.y + orig.height / 2;
    if (movesLeft) {
      const dx = pointer.x - orig.x;
      left = orig.x + dx;
      right = orig.x + orig.width - dx;
      if (right - left < minSize) { left = cx - minSize / 2; right = cx + minSize / 2; }
    }
    if (movesRight) {
      const dx = pointer.x - (orig.x + orig.width);
      right = orig.x + orig.width + dx;
      left = orig.x - dx;
      if (right - left < minSize) { left = cx - minSize / 2; right = cx + minSize / 2; }
    }
    if (movesTop) {
      const dy = pointer.y - orig.y;
      top = orig.y + dy;
      bottom = orig.y + orig.height - dy;
      if (bottom - top < minSize) { top = cy - minSize / 2; bottom = cy + minSize / 2; }
    }
    if (movesBottom) {
      const dy = pointer.y - (orig.y + orig.height);
      bottom = orig.y + orig.height + dy;
      top = orig.y - dy;
      if (bottom - top < minSize) { top = cy - minSize / 2; bottom = cy + minSize / 2; }
    }
  } else {
    if (movesLeft) left = Math.min(pointer.x, right - minSize);
    if (movesRight) right = Math.max(pointer.x, left + minSize);
    if (movesTop) top = Math.min(pointer.y, bottom - minSize);
    if (movesBottom) bottom = Math.max(pointer.y, top + minSize);
  }

  const rect = { x: left, y: top, width: right - left, height: bottom - top };
  if (!uniform || orig.width <= 0 || orig.height <= 0) return rect;

  // Aspect lock: scale both axes by whichever axis the drag changed most,
  // anchored at the fixed corner/edge (or the center in center mode).
  const sx = rect.width / orig.width;
  const sy = rect.height / orig.height;
  const s = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
  const w = Math.max(minSize, orig.width * s);
  const h = Math.max(minSize, orig.height * s);
  const cx = orig.x + orig.width / 2;
  const cy = orig.y + orig.height / 2;
  if (center) return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
  // Fixed side per axis; edge handles keep the untouched axis centered.
  const x = movesLeft ? orig.x + orig.width - w : movesRight ? orig.x : cx - w / 2;
  const y = movesTop ? orig.y + orig.height - h : movesBottom ? orig.y : cy - h / 2;
  return { x, y, width: w, height: h };
}

/** Signed angle (radians) swept from `start` to `current` around `pivot`. */
export function rotationDelta(pivot: Vec2, start: Vec2, current: Vec2): number {
  const a0 = Math.atan2(start.y - pivot.y, start.x - pivot.x);
  const a1 = Math.atan2(current.y - pivot.y, current.x - pivot.x);
  let d = a1 - a0;
  // Normalize to (-π, π] so a full turn doesn't accumulate jumps.
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * True when the handle resizes. Every handle does now — the rotate grip is
 * gone and rotation is a tool mode — so this is always true. Kept because
 * callers read better with the intent spelled out than with the constant.
 */
export function isResizeHandle(_handle: HandleId): boolean {
  return true;
}

/**
 * New bounds after dragging `handle` to `pointer` while holding `pivot` fixed.
 *
 * Scale per axis is the ratio of the dragged edge's distance from the pivot,
 * before and after. An axis the handle does not move keeps a factor of 1, and
 * an edge that starts ON the pivot has no ratio to take (division by zero), so
 * it holds at 1 rather than exploding.
 *
 * Does not flip: the factor is clamped positive and to `minSize`, matching
 * `resizeBounds`. Dragging a handle through the pivot stops at the minimum
 * instead of turning the layer inside out.
 */
export function resizeBoundsAboutPivot(
  orig: Rect,
  handle: HandleId,
  pointer: Vec2,
  pivot: Vec2,
  minSize = 4,
  uniform = false,
): Rect {
  const movesLeft = handle === 'w' || handle === 'nw' || handle === 'sw';
  const movesRight = handle === 'e' || handle === 'ne' || handle === 'se';
  const movesTop = handle === 'n' || handle === 'nw' || handle === 'ne';
  const movesBottom = handle === 's' || handle === 'sw' || handle === 'se';

  const EPS = 1e-6;
  const factor = (edge: number, target: number, axisPivot: number): number => {
    const from = edge - axisPivot;
    if (Math.abs(from) < EPS) return 1;
    return (target - axisPivot) / from;
  };

  let sx = 1;
  let sy = 1;
  if (movesLeft) sx = factor(orig.x, pointer.x, pivot.x);
  else if (movesRight) sx = factor(orig.x + orig.width, pointer.x, pivot.x);
  if (movesTop) sy = factor(orig.y, pointer.y, pivot.y);
  else if (movesBottom) sy = factor(orig.y + orig.height, pointer.y, pivot.y);

  if (uniform && orig.width > 0 && orig.height > 0) {
    // Whichever axis the drag changed most drives both — the same rule
    // `resizeBounds` uses for Shift.
    const s = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    if (movesLeft || movesRight || movesTop || movesBottom) {
      sx = s;
      sy = s;
    }
  }

  // No flipping, and never below the minimum size.
  const clamp = (s: number, extent: number): number => {
    if (extent <= 0) return Math.max(s, EPS);
    return Math.max(s, minSize / extent);
  };
  sx = clamp(sx, orig.width);
  sy = clamp(sy, orig.height);

  return {
    x: pivot.x + (orig.x - pivot.x) * sx,
    y: pivot.y + (orig.y - pivot.y) * sy,
    width: orig.width * sx,
    height: orig.height * sy,
  };
}
