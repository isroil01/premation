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
  /**
   * Where the camera's optical axis meets the screen — the comp centre.
   *
   * This must NOT track the camera. `projectPoint` previously used
   * `position.x/y` for both the eye and the principal point, which made the
   * camera term cancel algebraically at z = 0 (scale = 1), so panning the
   * camera in X/Y moved nothing and layers at other depths drifted the wrong
   * way. It looked correct only because the default camera sits at the comp
   * centre, where the two coincide.
   */
  principal: { x: number; y: number };
  /**
   * Optional look orientation, degrees. `yaw` turns the camera about its
   * vertical (Y) axis, `pitch` tilts about its horizontal (X) axis. Absent or
   * zero orientation follows the EXACT legacy projection path, so unrotated
   * cameras render byte-identically.
   */
  orientation?: { yaw: number; pitch: number };
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
  return {
    position: { x: width / 2, y: height / 2, z: -focalLength },
    focalLength,
    principal: { x: width / 2, y: height / 2 },
  };
}

/**
 * The six axis-aligned orthographic views (AE's Front/Back/Left/Right/Top/
 * Bottom). Unlike the perspective camera these are PARALLEL projections — no
 * foreshortening (`scale` is always 1) — so a flat comp appears edge-on (a
 * line) in any side/top view, and only 3D-offset layers spread apart. That is
 * the whole point of an orthographic view: it shows true depth relationships
 * without perspective distortion.
 */
export type OrthoView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

type Axis3 = readonly [number, number, number];

/**
 * Each view's screen basis: which world direction is screen-right and which is
 * screen-down. The into-screen depth axis is `right × cross down`, so the set is
 * self-consistent by construction. Comp space is y-DOWN, so "Top" looks from
 * −Y. `front` is the identity for the z=0 plane, matching the default view.
 */
const ORTHO_BASIS: Record<OrthoView, { right: Axis3; down: Axis3 }> = {
  front:  { right: [1, 0, 0],  down: [0, 1, 0] },
  back:   { right: [-1, 0, 0], down: [0, 1, 0] },
  left:   { right: [0, 0, -1], down: [0, 1, 0] },
  right:  { right: [0, 0, 1],  down: [0, 1, 0] },
  top:    { right: [1, 0, 0],  down: [0, 0, -1] },
  bottom: { right: [1, 0, 0],  down: [0, 0, 1] },
};

const dot3 = (a: Axis3, x: number, y: number, z: number): number => a[0] * x + a[1] * y + a[2] * z;
const cross3 = (a: Axis3, b: Axis3): Axis3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Project a comp-space point through one of the orthographic views.
 *
 * The scene is framed about the comp centre, so `front` reproduces the ordinary
 * 2D view exactly (a point at z = 0 maps to itself). `scale` is 1 — orthographic
 * views do not foreshorten; `depth` is the signed distance along the view axis
 * for back-to-front painter sorting.
 */
export function projectOrtho(p: Vec3, view: OrthoView, width: number, height: number): Projected {
  const { right, down } = ORTHO_BASIS[view];
  const cx = width / 2;
  const cy = height / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const dz = p.z; // comp plane sits at z = 0, so the plane is the depth origin
  const into = cross3(right, down);
  return {
    x: cx + dot3(right, dx, dy, dz),
    y: cy + dot3(down, dx, dy, dz),
    scale: 1,
    depth: dot3(into, dx, dy, dz),
  };
}

/** Smallest distance from the camera we will project (avoids divide blow-ups). */
const NEAR = 1;

const DEG = Math.PI / 180;

/** Project a comp-space point through the camera to screen space + scale + depth. */
export function projectPoint(p: Vec3, cam: Camera3D): Projected {
  const yaw = cam.orientation?.yaw ?? 0;
  const pitch = cam.orientation?.pitch ?? 0;
  if (yaw !== 0 || pitch !== 0) {
    // Rotated camera: bring the point into CAMERA SPACE — translate by the
    // eye, then undo the camera's yaw (about Y) and pitch (about X) — and
    // apply the same pinhole divide the straight path uses.
    let vx = p.x - cam.position.x;
    let vy = p.y - cam.position.y;
    let vz = p.z - cam.position.z;
    // Ry(−yaw)
    const cy = Math.cos(-yaw * DEG);
    const sy = Math.sin(-yaw * DEG);
    const x1 = cy * vx + sy * vz;
    const z1 = -sy * vx + cy * vz;
    vx = x1;
    vz = z1;
    // Rx(−pitch)
    const cx = Math.cos(-pitch * DEG);
    const sx = Math.sin(-pitch * DEG);
    const y1 = cx * vy - sx * vz;
    const z2 = sx * vy + cx * vz;
    vy = y1;
    vz = z2;
    const clamped = vz < NEAR ? NEAR : vz;
    const scale = cam.focalLength / clamped;
    return {
      x: cam.principal.x + vx * scale,
      y: cam.principal.y + vy * scale,
      scale,
      depth: clamped,
    };
  }
  const dist = p.z - cam.position.z; // > 0 when the point is in front of the camera
  const clamped = dist < NEAR ? NEAR : dist;
  const scale = cam.focalLength / clamped;
  return {
    x: cam.principal.x + (p.x - cam.position.x) * scale,
    y: cam.principal.y + (p.y - cam.position.y) * scale,
    scale,
    depth: clamped,
  };
}

/**
 * The look orientation (yaw, pitch in DEGREES) that points a camera at `eye`
 * toward `target` — a two-node camera's Point of Interest. Derived to be the
 * exact inverse of `projectPoint`'s rotated path: the target then projects to
 * the principal point (screen centre). A target directly along −z (the default
 * camera looking at the comp centre) yields zero orientation, i.e. the legacy
 * one-node path. Pure and framework-free.
 */
export function lookAtOrientation(eye: Vec3, target: Vec3): { yaw: number; pitch: number } {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const h = Math.hypot(dx, dz);
  // yaw about Y so the horizontal component aligns to +z; pitch about X so the
  // vertical component zeroes out. Matches projectPoint's Ry(−yaw)·Rx(−pitch).
  // `+ 0` normalises a JS `-0` (from atan2(-0, …)) to `+0` so callers comparing
  // against a zero orientation don't trip on Object.is(-0, 0).
  const yaw = Math.atan2(dx, dz) / DEG + 0;
  const pitch = Math.atan2(-dy, h) / DEG + 0;
  return { yaw, pitch };
}

/**
 * ORBIT the camera about a point of interest: keep the distance from `poi`,
 * swing by yaw/pitch (degrees), and return the eye position + the orientation
 * that keeps `poi` centred. yaw = pitch = 0 returns the base configuration
 * unchanged. Exact when the base offset is along −z (the default camera);
 * panned cameras orbit about their own POI-relative axis.
 */
export function orbitCamera(
  basePosition: Vec3,
  poi: Vec3,
  yaw: number,
  pitch: number,
): { position: Vec3; orientation: { yaw: number; pitch: number } } {
  if (yaw === 0 && pitch === 0) {
    return { position: basePosition, orientation: { yaw: 0, pitch: 0 } };
  }
  const ox = basePosition.x - poi.x;
  const oy = basePosition.y - poi.y;
  const oz = basePosition.z - poi.z;
  // Rx(pitch) then Ry(yaw) applied to the base offset.
  const cx = Math.cos(pitch * DEG);
  const sx = Math.sin(pitch * DEG);
  const y1 = cx * oy - sx * oz;
  const z1 = sx * oy + cx * oz;
  const cy = Math.cos(yaw * DEG);
  const sy = Math.sin(yaw * DEG);
  const x2 = cy * ox + sy * z1;
  const z2 = -sy * ox + cy * z1;
  return {
    position: { x: poi.x + x2, y: poi.y + y1, z: poi.z + z2 },
    orientation: { yaw, pitch },
  };
}
