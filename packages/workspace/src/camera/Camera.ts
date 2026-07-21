/**
 * Camera — the 2D view onto the infinite canvas. Holds a world-space `center`
 * (the point under the viewport middle) and `zoom` (screen pixels per world
 * unit). Produces the world→screen affine matrix and the coordinate conversions
 * every tool relies on. Pure math; a perspective/3D camera can slot in later
 * behind the same matrix output.
 *
 * Convention matches `@motion/renderer`'s `Camera2D`:
 *   screen = (world − center) · zoom + viewportSize / 2
 */

import type { Vec2 } from '../math/Vec2';
import type { Mat2D } from '../math/Mat2D';
import type { Rect } from '../math/Rect';
import type { Size } from '../math';
import * as Mat from '../math/Mat2D';

export interface CameraState {
  /** World-space point at the center of the viewport. */
  center: Vec2;
  /** Zoom factor: screen pixels per world unit (1 = 1:1). */
  zoom: number;
}

export interface CameraOptions {
  center?: Vec2;
  zoom?: number;
  minZoom?: number;
  maxZoom?: number;
}

export class Camera {
  private centerX = 0;
  private centerY = 0;
  private zoomLevel = 1;
  private minZoom = 0.02;
  private maxZoom = 256;
  private viewW = 1;
  private viewH = 1;
  private locked = false;

  constructor(opts: CameraOptions = {}) {
    if (opts.center) {
      this.centerX = opts.center.x;
      this.centerY = opts.center.y;
    }
    if (opts.minZoom !== undefined) this.minZoom = opts.minZoom;
    if (opts.maxZoom !== undefined) this.maxZoom = opts.maxZoom;
    this.zoomLevel = this.clampZoom(opts.zoom ?? 1);
  }

  // ── State ────────────────────────────────────────────────────────
  getState(): CameraState {
    return { center: { x: this.centerX, y: this.centerY }, zoom: this.zoomLevel };
  }

  setState(state: CameraState): void {
    this.centerX = state.center.x;
    this.centerY = state.center.y;
    this.zoomLevel = this.clampZoom(state.zoom);
  }

  get center(): Vec2 {
    return { x: this.centerX, y: this.centerY };
  }

  get zoom(): number {
    return this.zoomLevel;
  }

  setViewportSize(width: number, height: number): void {
    this.viewW = Math.max(1, width);
    this.viewH = Math.max(1, height);
  }

  get viewportSize(): Size {
    return { width: this.viewW, height: this.viewH };
  }

  setZoomLimits(min: number, max: number): void {
    this.minZoom = min;
    this.maxZoom = max;
    this.zoomLevel = this.clampZoom(this.zoomLevel);
  }

  get zoomLimits(): { min: number; max: number } {
    return { min: this.minZoom, max: this.maxZoom };
  }

  // ── Lock (fixed workspace) ───────────────────────────────────────
  /**
   * When locked ("fixed workspace" mode), interactive panning is a no-op and
   * zoom stays anchored on the viewport centre, so the composition never drifts
   * off-screen. Programmatic framing (fit, centerOn, setState) is unaffected.
   */
  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  // ── Pan ──────────────────────────────────────────────────────────
  /** Set the world point shown at the viewport center. */
  setCenter(center: Vec2): void {
    this.centerX = center.x;
    this.centerY = center.y;
  }

  /** Pan by a delta expressed in **screen pixels** (drag with the hand tool). */
  panByScreen(dxPx: number, dyPx: number): void {
    if (this.locked) return;
    this.centerX -= dxPx / this.zoomLevel;
    this.centerY -= dyPx / this.zoomLevel;
  }

  /** Pan by a delta expressed in **world units**. */
  panByWorld(dx: number, dy: number): void {
    if (this.locked) return;
    this.centerX += dx;
    this.centerY += dy;
  }

  // ── Zoom ─────────────────────────────────────────────────────────
  /** Multiply zoom by `factor`, keeping the given screen anchor fixed. */
  zoomBy(factor: number, anchorScreen?: Vec2): void {
    // In fixed mode, always anchor on the viewport centre so zooming keeps the
    // composition centred instead of walking it toward the cursor.
    const anchor = this.locked
      ? { x: this.viewW / 2, y: this.viewH / 2 }
      : anchorScreen ?? { x: this.viewW / 2, y: this.viewH / 2 };
    const before = this.screenToWorld(anchor);
    this.zoomLevel = this.clampZoom(this.zoomLevel * factor);
    const after = this.screenToWorld(anchor);
    this.centerX += before.x - after.x;
    this.centerY += before.y - after.y;
  }

  /** Set an absolute zoom level, keeping the given screen anchor fixed. */
  zoomTo(zoom: number, anchorScreen?: Vec2): void {
    const clamped = this.clampZoom(zoom);
    if (clamped === this.zoomLevel) return;
    this.zoomBy(clamped / this.zoomLevel, anchorScreen);
  }

  /** Zoom keeping the cursor's world point pinned (the standard scroll-zoom). */
  zoomToCursor(factor: number, cursorScreen: Vec2): void {
    this.zoomBy(factor, cursorScreen);
  }

  /** Frame a world-space rect within the viewport with optional padding (px). */
  zoomToRect(worldRect: Rect, padding = 32): void {
    const availW = Math.max(1, this.viewW - padding * 2);
    const availH = Math.max(1, this.viewH - padding * 2);
    const w = Math.max(1e-6, worldRect.width);
    const h = Math.max(1e-6, worldRect.height);
    const zoom = Math.min(availW / w, availH / h);
    this.zoomLevel = this.clampZoom(zoom);
    this.centerX = worldRect.x + worldRect.width / 2;
    this.centerY = worldRect.y + worldRect.height / 2;
  }

  /** Reset to origin at 1:1. */
  reset(): void {
    this.centerX = 0;
    this.centerY = 0;
    this.zoomLevel = this.clampZoom(1);
  }

  /** Center on a world point without changing zoom. */
  centerOn(worldPoint: Vec2): void {
    this.centerX = worldPoint.x;
    this.centerY = worldPoint.y;
  }

  // ── Matrices & coordinate conversion ─────────────────────────────
  /** World → screen affine matrix (feed screen output to the renderer/overlay). */
  worldToScreenMatrix(): Mat2D {
    const z = this.zoomLevel;
    return {
      a: z,
      b: 0,
      c: 0,
      d: z,
      e: this.viewW / 2 - this.centerX * z,
      f: this.viewH / 2 - this.centerY * z,
    };
  }

  /** Screen → world affine matrix. */
  screenToWorldMatrix(): Mat2D {
    return Mat.invert(this.worldToScreenMatrix());
  }

  screenToWorld(screen: Vec2): Vec2 {
    return {
      x: this.centerX + (screen.x - this.viewW / 2) / this.zoomLevel,
      y: this.centerY + (screen.y - this.viewH / 2) / this.zoomLevel,
    };
  }

  worldToScreen(world: Vec2): Vec2 {
    return {
      x: (world.x - this.centerX) * this.zoomLevel + this.viewW / 2,
      y: (world.y - this.centerY) * this.zoomLevel + this.viewH / 2,
    };
  }

  /** Convert a screen-pixel distance to world units at the current zoom. */
  screenDistanceToWorld(pixels: number): number {
    return pixels / this.zoomLevel;
  }

  /** The world-space rectangle currently visible (for culling / grid extent). */
  visibleWorldRect(): Rect {
    const halfW = this.viewW / 2 / this.zoomLevel;
    const halfH = this.viewH / 2 / this.zoomLevel;
    return {
      x: this.centerX - halfW,
      y: this.centerY - halfH,
      width: halfW * 2,
      height: halfH * 2,
    };
  }

  private clampZoom(z: number): number {
    if (!Number.isFinite(z) || z <= 0) return this.minZoom;
    return Math.min(this.maxZoom, Math.max(this.minZoom, z));
  }
}
