/**
 * Selection handles — the 8 resize handles + 1 rotate handle derived from a
 * selection's bounding box. Computed in whatever space the bounds are given
 * (world or screen); the overlay/tool decides. Handle ids follow compass
 * conventions so a resize tool can map a grabbed handle to an anchor edge.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export interface Handle {
  id: HandleId;
  position: Vec2;
  kind: 'resize' | 'rotate';
}

export interface HandleOptions {
  /** Distance from the top-center to the rotate handle, in the bounds' units. */
  rotateOffset?: number;
}

/** Compute handles for a bounds rect. Order: corners, edges, then rotate. */
export function computeHandles(bounds: Rect, opts: HandleOptions = {}): Handle[] {
  const { x, y, width, height } = bounds;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const rotateOffset = opts.rotateOffset ?? 24;
  return [
    { id: 'nw', position: { x, y }, kind: 'resize' },
    { id: 'n', position: { x: cx, y }, kind: 'resize' },
    { id: 'ne', position: { x: x + width, y }, kind: 'resize' },
    { id: 'e', position: { x: x + width, y: cy }, kind: 'resize' },
    { id: 'se', position: { x: x + width, y: y + height }, kind: 'resize' },
    { id: 's', position: { x: cx, y: y + height }, kind: 'resize' },
    { id: 'sw', position: { x, y: y + height }, kind: 'resize' },
    { id: 'w', position: { x, y: cy }, kind: 'resize' },
    { id: 'rotate', position: { x: cx, y: y - rotateOffset }, kind: 'rotate' },
  ];
}

/** The resize cursor type appropriate for each handle. */
export function handleCursor(id: HandleId): string {
  switch (id) {
    case 'n':
    case 's':
      return 'resize-n';
    case 'e':
    case 'w':
      return 'resize-e';
    case 'ne':
    case 'sw':
      return 'resize-ne';
    case 'nw':
    case 'se':
      return 'resize-nw';
    case 'rotate':
      return 'rotate';
  }
}

/** Hit-test handles at a point (same space as the handles), radius in units. */
export function pickHandle(handles: readonly Handle[], point: Vec2, radius: number): Handle | null {
  let best: Handle | null = null;
  let bestDist = radius;
  for (const h of handles) {
    const d = Math.hypot(h.position.x - point.x, h.position.y - point.y);
    if (d <= bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return best;
}
