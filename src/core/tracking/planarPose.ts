/**
 * Planar camera pose — a real (if constrained) 3D camera solve.
 *
 * Given ≥4 correspondences between a WORLD PLANE (the comp plane, z = 0) and
 * their IMAGE positions, plus known intrinsics (focal length in px, principal
 * point), recover where the camera stood and how it was oriented: the classic
 * plane-based pose (Zhang). H ≃ K·[r₁ r₂ t] — normalize out K, read the first
 * two rotation columns and the translation off the homography's columns,
 * complete r₃ = r₁×r₂, orthonormalize, invert to eye position.
 *
 * This is deliberately NOT structure-from-motion: no bundle adjustment, no
 * unknown focal, no non-planar structure. One tracked plane + a known lens →
 * a full 6-DoF camera path. That covers the screen-insert / wall-replacement
 * class of shots; parallax-rich SfM stays a separate project.
 *
 * Angle conventions match the engine exactly (verified against
 * `Project3D.projectPoint` in tests): world→camera is Rz(−roll)·Rx(−pitch)·
 * Ry(−yaw)·(p − C), image = principal + f·(x/z, y/z). The returned yaw goes
 * to `orientationY`, pitch to `orientationX`, roll to `orientationZ` — the
 * one-node camera's keyframeable orientation props.
 */

import { fitHomography } from '@motion/renderer';

type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };

export interface PlanarPose {
  /** Camera eye, comp/world units. */
  position: Vec3;
  /** Degrees — the engine's orientationY. */
  yawDeg: number;
  /** Degrees — orientationX. */
  pitchDeg: number;
  /** Degrees — orientationZ. */
  rollDeg: number;
  /** RMS reprojection error over the input pairs, image px. */
  rmsPx: number;
}

const RAD2DEG = 180 / Math.PI;

function norm3(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function scale3(v: Vec3, k: number): Vec3 {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

/**
 * Solve the camera pose from plane↔image correspondences.
 *
 * `plane` are world coordinates on the z=0 plane; `image` are pixels in the
 * same frame the intrinsics describe (principal `cx,cy`, focal `f` px).
 * Returns null when the homography is degenerate (collinear points, plane
 * edge-on) — callers skip that frame rather than write a garbage keyframe.
 */
export function solvePlanarPose(
  plane: readonly Vec2[],
  image: readonly Vec2[],
  f: number,
  cx: number,
  cy: number,
): PlanarPose | null {
  if (plane.length < 4 || image.length !== plane.length || f <= 0) return null;

  // Normalized image coordinates: the pinhole divide without K.
  const normalized = image.map((p) => ({ x: (p.x - cx) / f, y: (p.y - cy) / f }));
  const G = fitHomography(plane, normalized);
  if (!G) return null;

  // Columns of the math matrix [[a,b,c],[d,e,f],[g,h,1]] — column-major store.
  const g1: Vec3 = { x: G[0]!, y: G[1]!, z: G[2]! };
  const g2: Vec3 = { x: G[3]!, y: G[4]!, z: G[5]! };
  const g3: Vec3 = { x: G[6]!, y: G[7]!, z: G[8]! };

  const n1 = norm3(g1);
  const n2 = norm3(g2);
  if (n1 < 1e-9 || n2 < 1e-9) return null;
  // λ makes the rotation columns unit; its SIGN puts the plane in FRONT of
  // the camera (t·z > 0 at the plane origin — the engine's +z-forward rule).
  let lambda = 2 / (n1 + n2);
  if (g3.z * lambda < 0) lambda = -lambda;

  let c1 = scale3(g1, lambda);
  const c2raw = scale3(g2, lambda);
  const t = scale3(g3, lambda);

  // Orthonormalize [c1 c2 c3]: Gram-Schmidt, then complete the basis.
  const l1 = norm3(c1);
  if (l1 < 1e-9) return null;
  c1 = scale3(c1, 1 / l1);
  const dot12 = c1.x * c2raw.x + c1.y * c2raw.y + c1.z * c2raw.z;
  let c2: Vec3 = { x: c2raw.x - dot12 * c1.x, y: c2raw.y - dot12 * c1.y, z: c2raw.z - dot12 * c1.z };
  const l2 = norm3(c2);
  if (l2 < 1e-9) return null;
  c2 = scale3(c2, 1 / l2);
  const c3 = cross3(c1, c2);

  // M = world→camera rotation, columns c1 c2 c3 (math [row][col]).
  const M = [
    [c1.x, c2.x, c3.x],
    [c1.y, c2.y, c3.y],
    [c1.z, c2.z, c3.z],
  ] as const;

  // Eye: C = −Mᵀ t.
  const position: Vec3 = {
    x: -(M[0][0] * t.x + M[1][0] * t.y + M[2][0] * t.z),
    y: -(M[0][1] * t.x + M[1][1] * t.y + M[2][1] * t.z),
    z: -(M[0][2] * t.x + M[1][2] * t.y + M[2][2] * t.z),
  };

  // Decompose N = Mᵀ = Ry(yaw)·Rx(pitch)·Rz(roll):
  //   N[1][2] = −sin(pitch); N[0][2]/N[2][2] = tan(yaw); N[1][0]/N[1][1] = tan(roll).
  const N = [
    [M[0][0], M[1][0], M[2][0]],
    [M[0][1], M[1][1], M[2][1]],
    [M[0][2], M[1][2], M[2][2]],
  ] as const;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -N[1][2])));
  const yaw = Math.atan2(N[0][2], N[2][2]);
  const roll = Math.atan2(N[1][0], N[1][1]);

  // RMS reprojection through the recovered pose, in image px.
  let sq = 0;
  let count = 0;
  for (let i = 0; i < plane.length; i++) {
    const px = plane[i]!.x - position.x;
    const py = plane[i]!.y - position.y;
    const pz = -position.z;
    // p_cam = M · (p − C)
    const camX = M[0][0] * px + M[0][1] * py + M[0][2] * pz;
    const camY = M[1][0] * px + M[1][1] * py + M[1][2] * pz;
    const camZ = M[2][0] * px + M[2][1] * py + M[2][2] * pz;
    if (camZ <= 1e-6) continue;
    const u = cx + (f * camX) / camZ;
    const v = cy + (f * camY) / camZ;
    sq += (u - image[i]!.x) ** 2 + (v - image[i]!.y) ** 2;
    count += 1;
  }
  if (count === 0) return null;

  return {
    position,
    yawDeg: yaw * RAD2DEG,
    pitchDeg: pitch * RAD2DEG,
    rollDeg: roll * RAD2DEG,
    rmsPx: Math.sqrt(sq / count),
  };
}

/**
 * Unwrap a degree series in place so consecutive samples never jump by more
 * than 180° — atan2 seams (+179 → −179) otherwise become full-turn spins
 * between two keyframes.
 */
export function unwrapDegrees(series: number[]): number[] {
  for (let i = 1; i < series.length; i++) {
    let d = series[i]! - series[i - 1]!;
    while (d > 180) { series[i]! -= 360; d -= 360; }
    while (d < -180) { series[i]! += 360; d += 360; }
  }
  return series;
}
