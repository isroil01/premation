/**
 * Marquee — the rubber-band selection rectangle. Tracks an anchor and a moving
 * corner in world space and reports the normalized rect plus the selection
 * "mode": dragging right/down favors *contain* (window) selection, dragging
 * left favors *intersect* (crossing) selection — the CAD/Illustrator idiom.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import * as R from '../math/Rect';

export type MarqueeMode = 'intersect' | 'contain';

export class Marquee {
  private anchor: Vec2 | null = null;
  private moving: Vec2 | null = null;

  get active(): boolean {
    return this.anchor !== null;
  }

  begin(worldPoint: Vec2): void {
    this.anchor = { ...worldPoint };
    this.moving = { ...worldPoint };
  }

  update(worldPoint: Vec2): void {
    if (!this.anchor) return;
    this.moving = { ...worldPoint };
  }

  end(): Rect | null {
    const rect = this.rect();
    this.anchor = null;
    this.moving = null;
    return rect;
  }

  cancel(): void {
    this.anchor = null;
    this.moving = null;
  }

  /** Current normalized world rect, or null when inactive. */
  rect(): Rect | null {
    if (!this.anchor || !this.moving) return null;
    return R.fromPoints(this.anchor, this.moving);
  }

  /**
   * Selection semantics based on drag direction: dragging leftward (moving.x <
   * anchor.x) uses crossing/intersect; rightward uses window/contain.
   */
  mode(): MarqueeMode {
    if (!this.anchor || !this.moving) return 'intersect';
    return this.moving.x >= this.anchor.x ? 'contain' : 'intersect';
  }
}
