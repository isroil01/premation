/**
 * Pointer input through a layer's rig pose (B4 round 5) — the Puppet Pin
 * overlay's side of `getRigPose`. A pointer lands on the artwork AS DRAWN (the
 * puppet solve carried by the skeleton); pin positions are stored in the
 * puppet's REST space, so a drawn point goes back through the pose (unskin) and,
 * for a new pin's anchor, through the puppet solve (restPointFromDeformed). The
 * engine answers both (src/core/engine/rigOverlay.ts; C++ scene/rig_overlay.cpp).
 *
 * `RigPointerQueue` keeps a drag's writes in pointer order: each move's answer
 * arrives asynchronously, so the writes (and the gesture's end) are chained.
 */

import type { Vec2 } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';

export interface RigPointerAnswer {
  /** The point before the skeleton pose (the pin space). */
  rest: Vec2[];
  /** The puppet's rest anchor under it (a new pin's rest position). */
  anchors: Vec2[];
}

/** `points` (layer space, as drawn) of `layer` at comp `seconds` mapped back through the rig. */
export async function rigRestPoints(layer: string, seconds: number, points: Vec2[], authoring = true): Promise<RigPointerAnswer> {
  const res = await engine().query({ type: 'getRigPose', layer, time: compTime(seconds), points, authoring });
  if (!res.ok) return { rest: points, anchors: points };
  return { rest: res.value.rest, anchors: res.value.anchors };
}

/**
 * An affine fit of the rig pose around one drawn point (C2 drag performance):
 * `rest(local) = rest0 + (local − local0)·[jx jy]`. Built from ONE getRigPose
 * over three points (the grab point and unit steps in x and y); a drag then
 * maps every pointer move locally instead of round-tripping each one. Exact
 * without a skeleton (identity) and wherever one bone's transform covers the
 * grabbed region; a drag that crosses into another bone's influence is off by
 * the pose difference there — the trade for a drag that never waits.
 */
export interface RigDragBasis {
  local0: Vec2;
  rest0: Vec2;
  jx: Vec2;
  jy: Vec2;
}

export function applyRigDragBasis(b: RigDragBasis, local: Vec2): Vec2 {
  const dx = local.x - b.local0.x;
  const dy = local.y - b.local0.y;
  return { x: b.rest0.x + dx * b.jx.x + dy * b.jy.x, y: b.rest0.y + dx * b.jx.y + dy * b.jy.y };
}

/** The basis at `local` on `layer` at comp `seconds` (identity when the engine does not answer). */
export async function rigDragBasis(layer: string, seconds: number, local: Vec2, authoring = true): Promise<RigDragBasis> {
  const probes: Vec2[] = [local, { x: local.x + 1, y: local.y }, { x: local.x, y: local.y + 1 }];
  const { rest } = await rigRestPoints(layer, seconds, probes, authoring);
  const r0 = rest[0] ?? local;
  const r1 = rest[1] ?? { x: r0.x + 1, y: r0.y };
  const r2 = rest[2] ?? { x: r0.x, y: r0.y + 1 };
  return { local0: local, rest0: r0, jx: { x: r1.x - r0.x, y: r1.y - r0.y }, jy: { x: r2.x - r0.x, y: r2.y - r0.y } };
}

/** Serialises a drag's pointer-mapped writes: each runs after the previous one's answer. */
export class RigPointerQueue {
  private tail: Promise<void> = Promise.resolve();

  /** Map `point` through the rig, then run `write` with its rest point (in pointer order). */
  push(layer: string, seconds: number, point: Vec2, write: (rest: Vec2) => void): void {
    const answer = rigRestPoints(layer, seconds, [point]);
    this.tail = this.tail.then(async () => {
      const a = await answer;
      write(a.rest[0] ?? point);
    });
  }

  /** Run `fn` once every queued write has run. */
  then(fn: () => void | Promise<void>): Promise<void> {
    this.tail = this.tail.then(fn);
    return this.tail;
  }
}
