/**
 * The pure pieces of the paint tools' layer space (paintSpace.ts): comp point → paint-local
 * through a 2D affine plus anchor, a world ray → a 3D layer's plane, and the local brush size a comp
 * diameter covers. No document reads.
 */

import { Matrix, Matrix4Math, Project3D, type Matrix2D, type Matrix4, type Vec3 } from '@motion/scene';

type Pt = { x: number; y: number };

/** Comp point → paint-local through a 2D world affine plus anchor; null when
 *  the affine is singular (a layer scaled to zero has no surface to paint). */
export function local2D(world: Matrix2D, anchor: Pt, cp: Pt): Pt | null {
  const det = world.a * world.d - world.b * world.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const q = Matrix.transformPoint(Matrix.invert(world), cp);
  return { x: q.x + anchor.x, y: q.y + anchor.y };
}

/**
 * A world-space ray → paint-local on a 3D layer's plane, or null when the ray
 * misses it (edge-on) or the layer matrix is singular. The 3D model matrix
 * already un-anchors, so its local plane coordinates are the paint's.
 */
export function local3D(world: Matrix4, ray: Project3D.Ray3D): Pt | null {
  const inv = Matrix4Math.invert(world);
  if (!inv) return null;
  const point = Matrix4Math.transformPoint(world, { x: 0, y: 0, z: 0 });
  const zTip = Matrix4Math.transformPoint(world, { x: 0, y: 0, z: 1 });
  const normal: Vec3 = { x: zTip.x - point.x, y: zTip.y - point.y, z: zTip.z - point.z };
  const hit = Project3D.intersectRayPlane(ray, point, normal);
  if (!hit) return null;
  // A hit BEHIND the eye is the plane's mirror image, not what is on screen.
  const along =
    (hit.x - ray.origin.x) * ray.direction.x
    + (hit.y - ray.origin.y) * ray.direction.y
    + (hit.z - ray.origin.z) * ray.direction.z;
  if (along < 0) return null;
  const q = Matrix4Math.transformPoint(inv, hit);
  return Number.isFinite(q.x) && Number.isFinite(q.y) ? { x: q.x, y: q.y } : null;
}

/**
 * A comp-pixel brush diameter in the layer's local units AT `cp`: the local
 * area one comp pixel covers there, square-rooted. Measured through the same
 * mapping the points use, so parent scale, animated scale and 3D foreshortening
 * all count — the stroke commits at the width that was previewed. Null when
 * the mapping has no answer near `cp`.
 */
export function localBrushSizeVia(toLocal: (cp: Pt) => Pt | null, cp: Pt, compSize: number): number | null {
  const o = toLocal(cp);
  const u = toLocal({ x: cp.x + 1, y: cp.y });
  const v = toLocal({ x: cp.x, y: cp.y + 1 });
  if (!o || !u || !v) return null;
  const area = Math.abs((u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x));
  const k = Math.sqrt(area);
  return Number.isFinite(k) && k > 0 ? compSize * k : null;
}
