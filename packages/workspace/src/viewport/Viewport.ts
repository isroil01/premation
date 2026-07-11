/**
 * Viewport — the rectangular window onto the infinite canvas. Owns pixel size,
 * device-pixel-ratio (High-DPI), and the DOM offset needed to map OS/screen
 * coordinates into viewport-local pixels. Pure state; no DOM, no rendering.
 *
 * "CSS pixels" are the logical units tools and the camera work in. "Device
 * pixels" (CSS × dpr) are what a backing store / renderer allocates.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import type { Size } from '../math';

export interface ViewportState {
  /** Logical size in CSS pixels. */
  width: number;
  height: number;
  /** Device pixel ratio (>= 1 typically). */
  dpr: number;
  /** Offset of the viewport's top-left in screen/client space (CSS px). */
  offsetX: number;
  offsetY: number;
}

export interface ViewportOptions {
  width?: number;
  height?: number;
  dpr?: number;
  offsetX?: number;
  offsetY?: number;
}

export class Viewport {
  private width = 1;
  private height = 1;
  private dpr = 1;
  private offsetX = 0;
  private offsetY = 0;

  constructor(opts: ViewportOptions = {}) {
    this.width = Math.max(1, opts.width ?? 1);
    this.height = Math.max(1, opts.height ?? 1);
    this.dpr = Math.max(0.5, opts.dpr ?? 1);
    this.offsetX = opts.offsetX ?? 0;
    this.offsetY = opts.offsetY ?? 0;
  }

  getState(): ViewportState {
    return {
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
    };
  }

  /** Resize in CSS pixels. Returns true if anything changed. */
  resize(width: number, height: number): boolean {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    return true;
  }

  setDpr(dpr: number): boolean {
    const d = Math.max(0.5, dpr);
    if (d === this.dpr) return false;
    this.dpr = d;
    return true;
  }

  /** Set the viewport's position within screen/client space (CSS px). */
  setOffset(x: number, y: number): boolean {
    if (x === this.offsetX && y === this.offsetY) return false;
    this.offsetX = x;
    this.offsetY = y;
    return true;
  }

  get size(): Size {
    return { width: this.width, height: this.height };
  }

  get devicePixelSize(): Size {
    return { width: Math.round(this.width * this.dpr), height: Math.round(this.height * this.dpr) };
  }

  get devicePixelRatio(): number {
    return this.dpr;
  }

  get center(): Vec2 {
    return { x: this.width / 2, y: this.height / 2 };
  }

  /** Viewport-local bounds (top-left at 0,0). */
  get bounds(): Rect {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  /** Convert a screen/client point to viewport-local CSS pixels. */
  screenToViewport(screen: Vec2): Vec2 {
    return { x: screen.x - this.offsetX, y: screen.y - this.offsetY };
  }

  /** Convert a viewport-local point to screen/client space. */
  viewportToScreen(v: Vec2): Vec2 {
    return { x: v.x + this.offsetX, y: v.y + this.offsetY };
  }

  /** True if a viewport-local point is inside the visible window. */
  containsViewportPoint(p: Vec2): boolean {
    return p.x >= 0 && p.y >= 0 && p.x <= this.width && p.y <= this.height;
  }
}
