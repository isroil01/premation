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

import { Matrix4Math, type Matrix4, type Vec3 } from '@motion/scene';
import {
  composeNodeWorld3d,
  resolveNode3DTransform,
  type Node3DTransform,
} from './nodeMatrix';
import { parentWorldMatrixAt, nodeWorldWithParents3d } from './liveWorld3d';
import defaultSceneGraph from './DefaultSceneGraph';
import { defaultAnimation, type Keyframe } from '@motion/animation';
import { is3DEnabled } from './threeD';
import { readNodeModelSource } from './modelMesh';
import { bumpScene } from '@stores/sceneStore';

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

/**
 * Solve the chain: TOTAL euler degrees (rotation + orientation) per joint.
 * Pure — no graph reads, no writes. `locals` is root→tip; the LAST entry is
 * the end effector and comes back unchanged.
 */
export function solveCcdChain(
  locals: Node3DTransform[],
  rootParentWorld: Matrix4 | null,
  targetWorld: Vec3,
  opts: IkOptions = {},
): { x: number; y: number; z: number }[] {
  const o = { ...IK_DEFAULTS, ...opts };
  const n = locals.length;
  const totals = locals.map((l) => ({
    x: l.rotationX + l.orientationX,
    y: l.rotationY + l.orientationY,
    z: l.rotationZ + l.orientationZ,
  }));
  if (n < 2) return totals;

  // World chain for the CURRENT totals (orientation folded into rotation,
  // orientation zeroed — compose sums them, so this is the same matrix).
  const worlds: Matrix4[] = new Array(n);
  const composeAt = (i: number): Matrix4 => composeNodeWorld3d({
    ...locals[i]!,
    rotationX: totals[i]!.x, rotationY: totals[i]!.y, rotationZ: totals[i]!.z,
    orientationX: 0, orientationY: 0, orientationZ: 0,
  });
  const rebuild = (from: number): void => {
    for (let i = from; i < n; i++) {
      const own = composeAt(i);
      const p = i === 0 ? rootParentWorld : worlds[i - 1]!;
      worlds[i] = p ? Matrix4Math.multiply(p, own) : own;
    }
  };
  rebuild(0);
  const originOf = (m: Matrix4): Vec3 => ({ x: m[12]!, y: m[13]!, z: m[14]! });

  for (let iter = 0; iter < o.iterations; iter++) {
    for (let i = n - 2; i >= 0; i--) {
      const jp = originOf(worlds[i]!);
      const tip = originOf(worlds[n - 1]!);
      const v1 = { x: tip.x - jp.x, y: tip.y - jp.y, z: tip.z - jp.z };
      const v2 = { x: targetWorld.x - jp.x, y: targetWorld.y - jp.y, z: targetWorld.z - jp.z };
      const l1 = Math.hypot(v1.x, v1.y, v1.z);
      const l2 = Math.hypot(v2.x, v2.y, v2.z);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      const dot = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (l1 * l2)));
      let angle = Math.acos(dot);
      if (angle < 1e-4) continue;
      angle = Math.min(angle, o.maxStepRad);
      let ax = v1.y * v2.z - v1.z * v2.y;
      let ay = v1.z * v2.x - v1.x * v2.z;
      let az = v1.x * v2.y - v1.y * v2.x;
      const al = Math.hypot(ax, ay, az);
      if (al < 1e-9) continue; // exactly opposed: no unique plane, let a later joint break the tie
      ax /= al; ay /= al; az /= al;

      // World rotation about the joint's origin, folded into the joint's
      // LOCAL frame: L' = P⁻¹ · T(jp)·R·T(−jp) · P · L.
      const R = axisAngleMatrix(ax, ay, az, angle);
      const P = i === 0 ? rootParentWorld : worlds[i - 1]!;
      const world = worlds[i]!;
      // T(jp)·R·T(−jp)·W, written directly: rotate W's basis and swing its
      // origin around jp.
      const rw = Matrix4Math.multiply(R, [
        world[0]!, world[1]!, world[2]!, world[3]!,
        world[4]!, world[5]!, world[6]!, world[7]!,
        world[8]!, world[9]!, world[10]!, world[11]!,
        world[12]! - jp.x, world[13]! - jp.y, world[14]! - jp.z, world[15]!,
      ]);
      rw[12] = rw[12]! + jp.x; rw[13] = rw[13]! + jp.y; rw[14] = rw[14]! + jp.z;
      let newLocal: Matrix4 = rw;
      if (P) {
        const pInv = Matrix4Math.invert(P);
        if (!pInv) continue;
        newLocal = Matrix4Math.multiply(pInv, rw);
      }
      const e = matrixToEulerDeg(newLocal);
      totals[i] = e;
      rebuild(i);
    }
    const tip = originOf(worlds[n - 1]!);
    const err = Math.hypot(tip.x - targetWorld.x, tip.y - targetWorld.y, tip.z - targetWorld.z);
    if (err <= o.tolerance) break;
  }
  return totals;
}

/**
 * The IK chain ENDING at `tipId`: walk up through consecutive 3D ancestors,
 * stopping at an imported model's root (the layer holding the source) or a
 * non-3D layer. Returns root→tip, at most `maxJoints` long.
 */
export function ikChainFromTip(tipId: string, maxJoints = 8): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  for (let id: string | null = tipId; id && !seen.has(id) && chain.length < maxJoints; ) {
    seen.add(id);
    const node = defaultSceneGraph.getNode(id);
    if (!node || !is3DEnabled(node)) break;
    chain.unshift(id);
    if (readNodeModelSource(node)) break; // the imported root anchors the rig
    id = node.parent ?? null;
  }
  return chain;
}

/** Locals for the chain at `time`, with total-euler overrides where given. */
function chainLocals(
  chainIds: string[],
  time: number,
  totalsOverride?: { x: number; y: number; z: number }[],
): Node3DTransform[] | null {
  const locals: Node3DTransform[] = [];
  for (let i = 0; i < chainIds.length; i++) {
    const node = defaultSceneGraph.getNode(chainIds[i]!);
    const t = node ? resolveNode3DTransform(node, time) : null;
    if (!t) return null;
    const ov = totalsOverride?.[i];
    locals.push(ov
      ? {
          ...t,
          rotationX: ov.x - t.orientationX,
          rotationY: ov.y - t.orientationY,
          rotationZ: ov.z - t.orientationZ,
        }
      : t);
  }
  return locals;
}

/** Solve once at `time` and WRITE the pose onto the joints' rotation props. */
export function applyIk3D(chainIds: string[], targetWorld: Vec3, time: number, opts?: IkOptions): boolean {
  const locals = chainLocals(chainIds, time);
  if (!locals || locals.length < 2) return false;
  const rootParent = parentWorldMatrixAt(chainIds[0]!, time);
  const totals = solveCcdChain(locals, rootParent, targetWorld, opts);
  for (let i = 0; i < chainIds.length - 1; i++) {
    const node = defaultSceneGraph.getNode(chainIds[i]!);
    const tr = node?.components.find((c) => c.type === 'Transform');
    if (!node || !tr) continue;
    defaultSceneGraph.writeProp(node.id, tr.id, 'rotationX', totals[i]!.x - locals[i]!.orientationX);
    defaultSceneGraph.writeProp(node.id, tr.id, 'rotationY', totals[i]!.y - locals[i]!.orientationY);
    defaultSceneGraph.writeProp(node.id, tr.id, 'rotation', totals[i]!.z - locals[i]!.orientationZ);
  }
  bumpScene();
  return true;
}

/**
 * Bake IK against an ANIMATED target layer: solve every frame in [t0, t1],
 * land rotationX/rotationY/rotation keyframes on each solved joint. Frames
 * chain (each solve seeds from the previous pose) so the motion is continuous
 * rather than N independent flips. Returns the frame count, 0 on a chain or
 * target that cannot resolve.
 */
export function bakeIk3D(
  chainIds: string[],
  targetLayerId: string,
  t0: number,
  t1: number,
  fps: number,
  opts?: IkOptions,
): number {
  if (chainIds.length < 2 || !(fps > 0) || t1 < t0) return 0;
  const targetNode = defaultSceneGraph.getNode(targetLayerId);
  if (!targetNode) return 0;
  const frameCount = Math.max(1, Math.round((t1 - t0) * fps) + 1);
  const tracks = chainIds.slice(0, -1).map(() => ({
    rx: [] as Keyframe[], ry: [] as Keyframe[], rz: [] as Keyframe[],
  }));
  let prevTotals: { x: number; y: number; z: number }[] | undefined;
  for (let f = 0; f < frameCount; f++) {
    const t = t0 + f / fps;
    const targetM = nodeWorldWithParents3d(targetNode, t);
    const locals = chainLocals(chainIds, t, prevTotals);
    if (!targetM || !locals) return 0;
    const target = { x: targetM[12]!, y: targetM[13]!, z: targetM[14]! };
    const totals = solveCcdChain(locals, parentWorldMatrixAt(chainIds[0]!, t), target, opts);
    prevTotals = totals;
    for (let i = 0; i < chainIds.length - 1; i++) {
      const tr = tracks[i]!;
      tr.rx.push({ t, value: totals[i]!.x - locals[i]!.orientationX, easing: 'linear' });
      tr.ry.push({ t, value: totals[i]!.y - locals[i]!.orientationY, easing: 'linear' });
      tr.rz.push({ t, value: totals[i]!.z - locals[i]!.orientationZ, easing: 'linear' });
    }
  }
  for (let i = 0; i < chainIds.length - 1; i++) {
    defaultAnimation.setTrackKeyframes(chainIds[i]!, 'rotationX', tracks[i]!.rx);
    defaultAnimation.setTrackKeyframes(chainIds[i]!, 'rotationY', tracks[i]!.ry);
    defaultAnimation.setTrackKeyframes(chainIds[i]!, 'rotation', tracks[i]!.rz);
  }
  bumpScene();
  return frameCount;
}
