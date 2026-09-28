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
