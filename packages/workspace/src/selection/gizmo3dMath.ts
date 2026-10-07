/**
 * The 3D gizmo's drag math (AE parity 4.6), pure and unit-tested: trackball
 * rotation written back as the layer's X/Y/Z Rotation, axis-projected scale,
 * increment snapping and values typed while dragging.
 *
 * Rotation convention: the renderer's (matrix4.ts `compose`), R = Rz · Ry · Rx
 * with X/Y/Z Rotation in degrees; a layer's world rotation is
 * parent · Orientation · R (gizmo3d.ts `getGizmoBasis`).
 */

import { Matrix4Math, type Matrix4, type Vec3 } from '@motion/scene';

/** Row-major 3×3. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export interface EulerDeg {
  rotX: number;
  rotY: number;
  rotZ: number;
}

const DEG = Math.PI / 180;

/** R = Rz · Ry · Rx from degrees (matrix4.ts compose). */
export function eulerToMat3(e: EulerDeg): Mat3 {
  const cx = Math.cos(e.rotX * DEG), sx = Math.sin(e.rotX * DEG);
  const cy = Math.cos(e.rotY * DEG), sy = Math.sin(e.rotY * DEG);
  const cz = Math.cos(e.rotZ * DEG), sz = Math.sin(e.rotZ * DEG);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const o: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  }
  return o as unknown as Mat3;
}

export function transposeMat3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Rotation by `angleRad` about the unit `axis` (right-handed, Rodrigues). */
export function axisAngleMat3(axis: Vec3, angleRad: number): Mat3 {
  const len = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const x = axis.x / len, y = axis.y / len, z = axis.z / len;
  const c = Math.cos(angleRad), s = Math.sin(angleRad), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

/** The nearest equivalent of `deg` to `ref` (whole turns added or removed). */
function nearestTurn(deg: number, ref: number): number {
  return deg + Math.round((ref - deg) / 360) * 360;
}

/**
 * X/Y/Z Rotation (degrees) of a rotation matrix, R = Rz · Ry · Rx. Of the two
 * solutions the one closest to `ref` wins, each angle unwrapped to the turn
 * nearest `ref` — so a trackball drag never flips a layer's values by 180° or
 * snaps its turn count back to (-180, 180].
 */
export function mat3ToEuler(m: Mat3, ref: EulerDeg = { rotX: 0, rotY: 0, rotZ: 0 }): EulerDeg {
  const sy = Math.max(-1, Math.min(1, -m[6]));
  const y = Math.asin(sy);
  let a: EulerDeg;
  let b: EulerDeg;
  if (Math.abs(Math.cos(y)) > 1e-6) {
    const x = Math.atan2(m[7], m[8]);
    const z = Math.atan2(m[3], m[0]);
    a = { rotX: x / DEG, rotY: y / DEG, rotZ: z / DEG };
    b = { rotX: a.rotX + 180, rotY: 180 - a.rotY, rotZ: a.rotZ + 180 };
  } else {
    // Gimbal lock: only X − Z (or X + Z) is defined — keep Z where it was.
    const z = ref.rotZ * DEG;
    const sign = sy > 0 ? 1 : -1;
    // R = Rz·Ry(±90)·Rx: m01 = sign·sin(x−sign·z)·…; solve x from the free pair.
    const x = Math.atan2(sign * m[1], m[4]) + sign * z;
    a = { rotX: x / DEG, rotY: sign * 90, rotZ: ref.rotZ };
    b = a;
  }
  const unwrap = (e: EulerDeg): EulerDeg => ({
    rotX: nearestTurn(e.rotX, ref.rotX),
    rotY: nearestTurn(e.rotY, ref.rotY),
    rotZ: nearestTurn(e.rotZ, ref.rotZ),
  });
  const ua = unwrap(a);
  const ub = unwrap(b);
  const dist = (e: EulerDeg): number => Math.abs(e.rotX - ref.rotX) + Math.abs(e.rotY - ref.rotY) + Math.abs(e.rotZ - ref.rotZ);
  return dist(ub) < dist(ua) ? ub : ua;
}

/** The rotation part of a column-major parent matrix (scale removed per axis); identity when absent. */
export function parentRotationMat3(parent: readonly number[] | undefined): Mat3 {
  if (!parent || parent.length !== 16) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const col = (j: number): Vec3 => {
    const v = { x: parent[j * 4]!, y: parent[j * 4 + 1]!, z: parent[j * 4 + 2]! };
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  };
  const c0 = col(0), c1 = col(1), c2 = col(2);
  return [c0.x, c1.x, c2.x, c0.y, c1.y, c2.y, c0.z, c1.z, c2.z];
}

/** What sits between the world and a layer's own X/Y/Z Rotation. */
export interface RotationFrame {
  parent?: readonly number[];
  orientation?: { x: number; y: number; z: number };
}

/**
 * The layer's X/Y/Z Rotation after turning it by `angleRad` about the WORLD
 * axis `axis` (a trackball / view-ring drag): with B = parentRot · Orientation,
 * world = B · R, so the new R = Bᵀ · Q · B · R.
 */
export function rotateEulerAboutWorldAxis(start: EulerDeg, frame: RotationFrame | undefined, axis: Vec3, angleRad: number): EulerDeg {
  const o = frame?.orientation;
  const orient = o ? eulerToMat3({ rotX: o.x, rotY: o.y, rotZ: o.z }) : eulerToMat3({ rotX: 0, rotY: 0, rotZ: 0 });
  const B = mulMat3(parentRotationMat3(frame?.parent), orient);
  const Q = axisAngleMat3(axis, angleRad);
  const R = eulerToMat3(start);
  return mat3ToEuler(mulMat3(mulMat3(transposeMat3(B), mulMat3(Q, B)), R), start);
}

/**
 * Free trackball (AE: dragging inside the rotation sphere): the pointer's
 * travel since the grab, in screen px, turns about the view's up axis
 * (horizontal travel) and right axis (vertical travel) — one axis-angle, so
 * a diagonal drag is one smooth turn. `right` / `down` are the view's screen
 * axes in the world. `degPerPx` sets the speed (0.5° per px, AE's feel).
 */
export function trackballRotation(dxPx: number, dyPx: number, right: Vec3, down: Vec3, degPerPx = 0.5): { axis: Vec3; angleRad: number } {
  const len = Math.hypot(dxPx, dyPx);
  if (len < 1e-9) return { axis: { x: 0, y: 1, z: 0 }, angleRad: 0 };
  // Dragging right turns the near side right: about the view's DOWN axis
  // (the renderer's y is down); dragging down turns it down: about RIGHT, negated.
  const ux = dxPx / len, uy = dyPx / len;
  const axis = {
    x: down.x * ux - right.x * uy,
    y: down.y * ux - right.y * uy,
    z: down.z * ux - right.z * uy,
  };
  return { axis, angleRad: -len * degPerPx * DEG };
}

/**
 * Axis-projected scale: the factor for dragging a scale handle that sits
 * `handleScreen` px from the gizmo centre along `screenDir` (unit), by the
 * pointer travel `(dx, dy)` — travel along the axis as drawn on screen, so a
 * handle that points down-left grows when dragged down-left. Never below 1%.
 */
export function axisScaleFactor(dx: number, dy: number, screenDir: { x: number; y: number }, handleScreen: number): number {
  const along = dx * screenDir.x + dy * screenDir.y;
  return Math.max(0.01, 1 + along / Math.max(handleScreen, 1));
}

/** Snap `value` to multiples of `step` (increment snapping while Shift is held). */
export function snapIncrement(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

/**
 * A value typed while dragging (Blender / Cinema style): digits, one '.', a
 * leading '-'; Backspace removes a character. Returns the new buffer, or
 * null when the key is not part of a number.
 */
export function typedValueKey(buffer: string, key: string): string | null {
  if (key === 'Backspace') return buffer.slice(0, -1);
  if (key === '-') return buffer.startsWith('-') ? buffer.slice(1) : `-${buffer}`;
  if (key === '.' || key === ',') return buffer.includes('.') ? buffer : `${buffer === '' || buffer === '-' ? `${buffer}0` : buffer}.`;
  if (/^[0-9]$/.test(key)) return buffer + key;
  return null;
}

/** The typed buffer as a number, or null while it is not one yet ('', '-', '.'). */
export function typedValue(buffer: string): number | null {
  if (!/[0-9]/.test(buffer)) return null;
  const v = Number(buffer);
  return Number.isFinite(v) ? v : null;
}

/**
 * Anchor-point (pivot) edit: moving the pivot by the world delta `d` while
 * the layer stays where it is. The anchor moves by d expressed in the
 * layer's own (unscaled, unrotated) space; Position moves by d in the
 * parent's space — the two cancel on screen.
 * `world` = parent · Orientation · R · diag(scale) (the layer's linear part).
 */
export function pivotEdit(
  d: Vec3,
  frame: RotationFrame | undefined,
  rot: EulerDeg,
  scale: { x: number; y: number; z: number },
): { anchorDelta: Vec3; parentDelta: Vec3 } {
  const parent = frame?.parent && frame.parent.length === 16 ? (frame.parent as Matrix4) : null;
  // Parent space: undo the parent's linear part (rotation and scale).
  let pd = d;
  if (parent) {
    const inv = Matrix4Math.invert(parent);
    // The linear part only (a delta has no translation) — and not
    // `transformVector`, which normalises.
    if (inv) pd = { x: inv[0]! * d.x + inv[4]! * d.y + inv[8]! * d.z, y: inv[1]! * d.x + inv[5]! * d.y + inv[9]! * d.z, z: inv[2]! * d.x + inv[6]! * d.y + inv[10]! * d.z };
  }
  const o = frame?.orientation;
  const B = mulMat3(o ? eulerToMat3({ rotX: o.x, rotY: o.y, rotZ: o.z }) : eulerToMat3({ rotX: 0, rotY: 0, rotZ: 0 }), eulerToMat3(rot));
  const Bt = transposeMat3(B);
  const l = { x: Bt[0] * pd.x + Bt[1] * pd.y + Bt[2] * pd.z, y: Bt[3] * pd.x + Bt[4] * pd.y + Bt[5] * pd.z, z: Bt[6] * pd.x + Bt[7] * pd.y + Bt[8] * pd.z };
  const safe = (s: number): number => (Math.abs(s) > 1e-9 ? s : 1e-9);
  return { anchorDelta: { x: l.x / safe(scale.x), y: l.y / safe(scale.y), z: l.z / safe(scale.z) }, parentDelta: pd };
}
