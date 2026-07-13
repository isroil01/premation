/**
 * Pinhole camera projection for the 2.5D compositor. Given a 3D point in comp
 * space and a camera, returns the on-screen position, a uniform `scale` factor
 * (how much bigger/smaller the layer draws at that depth), and `depth` for
 * back-to-front painter sorting. Pure, framework-free.
 *
 * Model (After Effects convention): the camera looks down +z at the comp plane
 * (z = 0). The default camera sits `focalLength` *behind* the plane, so a layer
 * at z = 0 projects at scale 1; moving a layer to +z (further) shrinks it, to
 * -z (closer) enlarges it. `focalLength` derives from a field of view.
 */

import type { Vec3 } from '../types';

export interface Camera3D {
  /** Camera position in comp space. z is negative when pulled back from the plane. */
  position: Vec3;
  /** Distance from the camera to the projection plane (px). */
  focalLength: number;
}

export interface Projected {
  x: number;
  y: number;
  /** Uniform perspective scale at this depth (1 = on the comp plane). */
  scale: number;
  /** Distance from the camera along z; larger = further (sort descending to paint). */
  depth: number;
}

/** Focal length (px) for a horizontal field of view over a comp of `width`. */
export function focalLengthForFov(width: number, fovDeg: number): number {
  const fov = Math.max(1, Math.min(179, fovDeg)) * (Math.PI / 180);
  return width / 2 / Math.tan(fov / 2);
}

/**
 * The default one-node camera for a comp: centred on the comp, pulled back by
 * `focalLength` so the plane renders 1:1. `fovDeg` defaults to AE's ~40°-ish
 * "50mm" comp-framing feel.
 */
export function defaultCamera(width: number, height: number, fovDeg = 39.6): Camera3D {
  const focalLength = focalLengthForFov(width, fovDeg);
  return { position: { x: width / 2, y: height / 2, z: -focalLength }, focalLength };
}

/** Smallest distance from the camera we will project (avoids divide blow-ups). */
const NEAR = 1;

/** Project a comp-space point through the camera to screen space + scale + depth. */
export function projectPoint(p: Vec3, cam: Camera3D): Projected {
  const dist = p.z - cam.position.z; // > 0 when the point is in front of the camera
  const clamped = dist < NEAR ? NEAR : dist;
  const scale = cam.focalLength / clamped;
  return {
    x: cam.position.x + (p.x - cam.position.x) * scale,
    y: cam.position.y + (p.y - cam.position.y) * scale,
    scale,
    depth: clamped,
  };
}
