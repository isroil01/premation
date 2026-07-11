/**
 * Transform math for the selection gizmo — pure functions the tools use to turn
 * a handle drag into new geometry. Kept separate from the tool so the behavior
 * is unit-testable without any input plumbing.
 *
 * Resize keeps the edge/corner opposite the grabbed handle fixed (the standard
 * design-tool behavior) and clamps to a minimum size without flipping. Rotation
 * is measured as the signed angle swept around a pivot.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import type { HandleId } from './handles';

/**
 * New axis-aligned bounds after dragging `handle` to `pointer` (world space),
 * holding the opposite edge/corner fixed. `rotate` handles return the input
 * unchanged (they don't resize).
 */
export function resizeBounds(orig: Rect, handle: HandleId, pointer: Vec2, minSize = 4): Rect {
  let left = orig.x;
  let right = orig.x + orig.width;
  let top = orig.y;
  let bottom = orig.y + orig.height;

  const movesLeft = handle === 'w' || handle === 'nw' || handle === 'sw';
  const movesRight = handle === 'e' || handle === 'ne' || handle === 'se';
  const movesTop = handle === 'n' || handle === 'nw' || handle === 'ne';
  const movesBottom = handle === 's' || handle === 'sw' || handle === 'se';

  if (movesLeft) left = Math.min(pointer.x, right - minSize);
  if (movesRight) right = Math.max(pointer.x, left + minSize);
  if (movesTop) top = Math.min(pointer.y, bottom - minSize);
  if (movesBottom) bottom = Math.max(pointer.y, top + minSize);

  return { x: left, y: top, width: right - left, height: bottom - top };
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

/** True when the handle resizes (vs. the rotate handle). */
export function isResizeHandle(handle: HandleId): boolean {
  return handle !== 'rotate';
}
