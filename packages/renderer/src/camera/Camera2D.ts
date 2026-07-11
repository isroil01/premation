/**
 * 2D camera for an infinite canvas: pan (center in world units) + zoom. Produces
 * the view and projection matrices the renderer uploads, and converts between
 * screen pixels and world coordinates (hit-testing, panning). Pure math — no GPU,
 * no DOM. A perspective camera can slot in later behind the same matrix output.
 */

import { Mat3 } from '../core/math/Mat3';
import type { Vec2 } from '../core/math/Vec2';
import type { Size } from '../core/math/geometry';

export interface CameraState {
  /** World-space point at the center of the viewport. */
  center: Vec2;
  /** Zoom factor: screen pixels per world unit (1 = 1:1). */
  zoom: number;
}

export class Camera2D {
  private center: Vec2 = { x: 0, y: 0 };
  private zoomLevel = 1;
  private viewport: Size = { width: 1, height: 1 };
  private minZoom = 0.02;
  private maxZoom = 64;

  getState(): CameraState {
    return { center: { ...this.center }, zoom: this.zoomLevel };
  }

  setState(state: CameraState): void {
    this.center = { ...state.center };
    this.zoomLevel = this.clampZoom(state.zoom);
  }

  setViewport(width: number, height: number): void {
    this.viewport = { width: Math.max(1, width), height: Math.max(1, height) };
  }

  setZoomLimits(min: number, max: number): void {
    this.minZoom = min;
    this.maxZoom = max;
    this.zoomLevel = this.clampZoom(this.zoomLevel);
  }

  get zoom(): number {
    return this.zoomLevel;
  }

  /** Pan by a delta expressed in **screen pixels**. */
  panByScreen(dxPx: number, dyPx: number): void {
    this.center = {
      x: this.center.x - dxPx / this.zoomLevel,
      y: this.center.y - dyPx / this.zoomLevel,
    };
  }

  /** Zoom by a multiplicative factor, keeping the given screen anchor fixed. */
  zoomBy(factor: number, anchorScreen?: Vec2): void {
    const anchor = anchorScreen ?? { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    const worldBefore = this.screenToWorld(anchor);
    this.zoomLevel = this.clampZoom(this.zoomLevel * factor);
    const worldAfter = this.screenToWorld(anchor);
    // Shift center so the anchor points at the same world position after zoom.
    this.center = {
      x: this.center.x + (worldBefore.x - worldAfter.x),
      y: this.center.y + (worldBefore.y - worldAfter.y),
    };
  }

  /** View matrix: world → view (centered, scaled by zoom). Column-major Mat3. */
  viewMatrix(): Mat3 {
    // translate(-center) then scale(zoom)
    const t = Mat3.translation(-this.center.x, -this.center.y);
    const s = Mat3.scaling(this.zoomLevel, this.zoomLevel);
    return Mat3.multiply(s, t);
  }

  /** Projection: view/screen pixels → clip space [-1,1], Y-down (screen convention). */
  projectionMatrix(): Mat3 {
    const { width, height } = this.viewport;
    // Map [-w/2, w/2] × [-h/2, h/2] to clip; flip Y so +Y is downward on screen.
    return Mat3.ortho(-width / 2, width / 2, height / 2, -height / 2);
  }

  /** Combined world → clip matrix (projection · view). */
  viewProjectionMatrix(): Mat3 {
    return Mat3.multiply(this.projectionMatrix(), this.viewMatrix());
  }

  screenToWorld(screen: Vec2): Vec2 {
    // screen (0..w, 0..h, origin top-left) → centered pixels → world
    const cx = screen.x - this.viewport.width / 2;
    const cy = screen.y - this.viewport.height / 2;
    return { x: this.center.x + cx / this.zoomLevel, y: this.center.y + cy / this.zoomLevel };
  }

  worldToScreen(world: Vec2): Vec2 {
    const cx = (world.x - this.center.x) * this.zoomLevel;
    const cy = (world.y - this.center.y) * this.zoomLevel;
    return { x: cx + this.viewport.width / 2, y: cy + this.viewport.height / 2 };
  }

  private clampZoom(z: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, z));
  }
}
