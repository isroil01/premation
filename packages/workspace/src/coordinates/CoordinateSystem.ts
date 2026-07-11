/**
 * CoordinateSystem — the single authority for converting points between every
 * space the editor deals with. Ties the Viewport (screen offset) and Camera
 * (world transform) together and layers node transforms on top for local/parent
 * spaces.
 *
 * Spaces:
 *   screen   — OS/client pixels (raw pointer event coords)
 *   viewport — pixels relative to the canvas top-left (screen − offset)
 *   world    — the infinite canvas, what the camera looks at
 *   parent   — a node's parent's local space
 *   local    — a node's own space (its worldMatrix maps local→world)
 *
 * Viewport and screen differ only by the canvas's page offset. World is reached
 * through the camera. Local/parent need a node's world matrix.
 */

import type { Vec2 } from '../math/Vec2';
import type { Mat2D } from '../math/Mat2D';
import * as Mat from '../math/Mat2D';
import type { Camera } from '../camera/Camera';
import type { Viewport } from '../viewport/Viewport';

export class CoordinateSystem {
  constructor(
    private readonly camera: Camera,
    private readonly viewport: Viewport,
  ) {}

  // ── screen ⇄ viewport ────────────────────────────────────────────
  screenToViewport(screen: Vec2): Vec2 {
    return this.viewport.screenToViewport(screen);
  }

  viewportToScreen(v: Vec2): Vec2 {
    return this.viewport.viewportToScreen(v);
  }

  // ── viewport ⇄ world (viewport pixels are the camera's screen space) ──
  viewportToWorld(v: Vec2): Vec2 {
    return this.camera.screenToWorld(v);
  }

  worldToViewport(world: Vec2): Vec2 {
    return this.camera.worldToScreen(world);
  }

  // ── screen ⇄ world (the common case for pointer input) ───────────
  screenToWorld(screen: Vec2): Vec2 {
    return this.camera.screenToWorld(this.viewport.screenToViewport(screen));
  }

  worldToScreen(world: Vec2): Vec2 {
    return this.viewport.viewportToScreen(this.camera.worldToScreen(world));
  }

  // ── world ⇄ local (via a node's world matrix) ────────────────────
  worldToLocal(world: Vec2, nodeWorldMatrix: Mat2D): Vec2 {
    return Mat.apply(Mat.invert(nodeWorldMatrix), world);
  }

  localToWorld(local: Vec2, nodeWorldMatrix: Mat2D): Vec2 {
    return Mat.apply(nodeWorldMatrix, local);
  }

  // ── local ⇄ parent (child-of-parent via both world matrices) ─────
  localToParent(local: Vec2, nodeWorldMatrix: Mat2D, parentWorldMatrix: Mat2D): Vec2 {
    const world = Mat.apply(nodeWorldMatrix, local);
    return Mat.apply(Mat.invert(parentWorldMatrix), world);
  }

  parentToLocal(parent: Vec2, nodeWorldMatrix: Mat2D, parentWorldMatrix: Mat2D): Vec2 {
    const world = Mat.apply(parentWorldMatrix, parent);
    return Mat.apply(Mat.invert(nodeWorldMatrix), world);
  }

  // ── convenience: screen straight to a node's local space ─────────
  screenToLocal(screen: Vec2, nodeWorldMatrix: Mat2D): Vec2 {
    return this.worldToLocal(this.screenToWorld(screen), nodeWorldMatrix);
  }

  localToScreen(local: Vec2, nodeWorldMatrix: Mat2D): Vec2 {
    return this.worldToScreen(this.localToWorld(local, nodeWorldMatrix));
  }
}
