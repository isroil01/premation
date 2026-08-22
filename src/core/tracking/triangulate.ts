/**
 * Two-view midpoint triangulation — classical SfM landmark init.
 *
 * Rays from each camera through the normalised image point; return the
 * midpoint of the shortest segment between the skew lines (Hartley &
 * Zisserman §12.2). Null when the baseline is degenerate or both depths ≤ 0.
 */

export type Vec3 = { x: number; y: number; z: number };

export interface CameraRt {
  /** World→camera rotation 3×3 row-major. */
  R: number[][];
  /** Camera centre in world (eye), not the classic t = −R C. */
  C: Vec3;
}

/** Direction of the back-projected ray in world for a normalised (x,y,1) point. */
function rayDir(R: number[][], xn: number, yn: number): Vec3 {
  // Camera-space direction (xn, yn, 1); world = Rᵀ · d_cam (R is world→cam).
  const dcx = xn;
  const dcy = yn;
  const dcz = 1;
  return {
    x: R[0]![0]! * dcx + R[1]![0]! * dcy + R[2]![0]! * dcz,
    y: R[0]![1]! * dcx + R[1]![1]! * dcy + R[2]![1]! * dcz,
    z: R[0]![2]! * dcx + R[1]![2]! * dcy + R[2]![2]! * dcz,
  };
}

function norm(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function scale(v: Vec3, k: number): Vec3 {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Triangulate a landmark seen as normalised image coords (already K⁻¹) in two views.
 */
export function triangulateMidpoint(
  cam1: CameraRt,
  cam2: CameraRt,
  x1: { x: number; y: number },
  x2: { x: number; y: number },
): Vec3 | null {
  let d1 = rayDir(cam1.R, x1.x, x1.y);
  let d2 = rayDir(cam2.R, x2.x, x2.y);
  const n1 = norm(d1);
  const n2 = norm(d2);
  if (n1 < 1e-12 || n2 < 1e-12) return null;
  d1 = scale(d1, 1 / n1);
  d2 = scale(d2, 1 / n2);

  const r = sub(cam1.C, cam2.C);
  const a = dot(d1, d1);
  const b = dot(d1, d2);
  const c = dot(d2, d2);
  const d = dot(d1, r);
  const e = dot(d2, r);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-12) return null;
  const s = (b * e - c * d) / denom;
  const t = (a * e - b * d) / denom;
  if (s <= 0 || t <= 0) return null;
  const p1 = add(cam1.C, scale(d1, s));
  const p2 = add(cam2.C, scale(d2, t));
  return scale(add(p1, p2), 0.5);
}

/**
 * Project world point with camera (R, C) and intrinsics → image pixels.
 * Same convention as planarPose / Project3D: cam = R · (X − C), u = cx + f·x/z.
 */
export function projectPoint(
  R: number[][],
  C: Vec3,
  X: Vec3,
  f: number,
  cx: number,
  cy: number,
): { u: number; v: number } | null {
  const dx = X.x - C.x;
  const dy = X.y - C.y;
  const dz = X.z - C.z;
  const xc = R[0]![0]! * dx + R[0]![1]! * dy + R[0]![2]! * dz;
  const yc = R[1]![0]! * dx + R[1]![1]! * dy + R[1]![2]! * dz;
  const zc = R[2]![0]! * dx + R[2]![1]! * dy + R[2]![2]! * dz;
  if (!(zc > 1e-6)) return null;
  return { u: cx + (f * xc) / zc, v: cy + (f * yc) / zc };
}
