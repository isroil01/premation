/**
 * 3D IK on ordinary layers — CCD over a parent chain of 3D nulls.
 *
 * An imported glTF skeleton's joints are plain layers, so IK here is not a
 * special rig object: the solver reads a chain of parented 3D layers, aims
 * the chain's TIP (the last joint's origin) at a world-space target, and
 * produces per-joint euler rotations in the engine's own convention. Two
 * consumers:
 *
 *   • `applyIk3D` — write the solved pose once (a posing tool);
 *   • `bakeIk3D` — solve per frame against an animated target layer and land
 *     REAL rotation keyframes on the joints. Animate one null flying around,
 *     bake, and the arm follows it — then everything downstream is ordinary
 *     keyframes: graph editor, speed ramps, The Smoother. No IK runtime, no
 *     evaluation-order problem, nothing new for the renderer. This is the
 *     same "bake to first-class keyframes" philosophy as the glTF clip
 *     importer, and it composes with skinning for free (skin follows joints).
 *
 * CCD (cyclic coordinate descent) rather than FABRIK: CCD works directly on
 * ROTATIONS, so there is no position-chain-to-rotation reconstruction step,
 * and per-step damping gives stable, natural-looking convergence on the
 * 2–5 joint chains rigs actually use. The last joint in the chain is the end
 * effector — its own rotation cannot move its origin, so it keeps whatever
 * rotation it has (FK on the wrist survives IK on the arm).
 *
 * Euler bookkeeping: `Matrix4Math.compose` SUMS rotation + orientation per
 * axis before building R (= Rz·Ry·Rx), so the solver works in TOTAL angles
 * and subtracts orientation when writing back — exact, not approximate.
 */

import {  type Matrix4 } from '@motion/scene';
import {  type Keyframe } from '@motion/animation';

const DEG = 180 / Math.PI;

export interface IkOptions {
  /** CCD sweeps over the chain. */
  iterations?: number;
  /** Stop early when the tip lands within this many px of the target. */
  tolerance?: number;
  /** Per-step rotation clamp, radians — the damping that keeps CCD stable. */
  maxStepRad?: number;
}

/** Solver defaults. Exported so the inspector's fields can seed from them
 *  rather than repeating three numbers that would then drift. */
export const IK_DEFAULTS: Required<IkOptions> = { iterations: 12, tolerance: 0.5, maxStepRad: 0.6 };

/** Rodrigues axis-angle → column-major rotation matrix (axis unit-length). */
export function axisAngleMatrix(ax: number, ay: number, az: number, angle: number): Matrix4 {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * ax * ax + c, t * ax * ay + s * az, t * ax * az - s * ay, 0,
    t * ax * ay - s * az, t * ay * ay + c, t * ay * az + s * ax, 0,
    t * ax * az + s * ay, t * ay * az - s * ax, t * az * az + c, 0,
    0, 0, 0, 1,
  ];
}

/**
 * Rotation part of an affine matrix → Tait-Bryan degrees for the engine's
 * R = Rz·Ry·Rx (the inverse of `Matrix4Math.compose`'s rotation block; the
 * same extraction `gltfRotationToEulerDeg` pins by round-trip test). Scale is
 * normalized out of the basis columns first.
 */
export function matrixToEulerDeg(m: Matrix4): { x: number; y: number; z: number } {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
  const r00 = m[0]! / sx, r10 = m[1]! / sx, r20 = m[2]! / sx;
  const r21 = m[6]! / sy;
  const r22 = m[10]! / sz;
  const r01 = m[4]! / sy, r11 = m[5]! / sy;
  const syn = -r20; // compose: r20 = −sin(y)
  if (Math.abs(syn) > 0.999999) {
    return { x: 0, y: syn > 0 ? 90 : -90, z: Math.atan2(-r01, r11) * DEG };
  }
  return {
    x: Math.atan2(r21, r22) * DEG,
    y: Math.asin(syn) * DEG,
    z: Math.atan2(r10, r00) * DEG,
  };
}

/** One solved joint of a bake: its X / Y / Z rotation keys (t = composition seconds). */
export interface Ik3DBakeJoint {
  id: string;
  rx: Keyframe[];
  ry: Keyframe[];
  rz: Keyframe[];
}
