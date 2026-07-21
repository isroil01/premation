/**
 * Lottie bezier-path → engine `points` conversion.
 *
 * This is the payload of a Lottie *character* rig: an After Effects / Rive
 * IK+mesh rig is baked to per-frame animated bezier paths (`ty:'sh'`) at
 * export, so importing it needs no solver — only a faithful path conversion.
 *
 * Convention (verified against the renderer): the engine stores tangent
 * handles as ABSOLUTE coordinates in the same space as the vertex — the
 * Canvas2D backend draws `bezierCurveTo(curr.outX, curr.outY, next.inX,
 * next.inY, next.x, next.y)`. Lottie stores `i`/`o` as tangents RELATIVE to
 * their vertex. So: handle = vertex + tangent.
 *
 * Pure module — no scene/engine/DOM dependencies, fully unit-testable. The
 * importer's scene-wiring layer feeds these `DataKeyframe[]` straight into
 * `AnimationEngine.setDataTrack(nodeId, prop, { kind: 'points', ... })`.
 */

import type { DataKeyframe, DataPoint } from './dataTracks';

/** A single Lottie bezier shape value (the object inside `sh.ks.k[n].s[0]`). */
export interface LottieBezier {
  /** In-tangents, relative to each vertex. */
  i: Array<[number, number]>;
  /** Out-tangents, relative to each vertex. */
  o: Array<[number, number]>;
  /** Vertices, absolute (layer-local). */
  v: Array<[number, number]>;
  /** Closed outline. */
  c?: boolean;
}

/** Lottie property form for a shape path (`sh.ks`): static (`a:0`) or animated. */
export type LottieShapeProp =
  | { a?: 0; k: LottieBezier }
  | { a: 1; k: Array<{ t: number; s: [LottieBezier]; h?: number }> };

/** Convert one Lottie bezier to the engine's absolute-handle point list. */
export function lottieBezierToPoints(b: LottieBezier): { points: DataPoint[]; closed: boolean } {
  const n = b.v.length;
  const points: DataPoint[] = [];
  for (let k = 0; k < n; k++) {
    const [vx, vy] = b.v[k]!;
    const [ix, iy] = b.i[k] ?? [0, 0];
    const [ox, oy] = b.o[k] ?? [0, 0];
    points.push({
      x: vx,
      y: vy,
      inX: vx + ix,
      inY: vy + iy,
      outX: vx + ox,
      outY: vy + oy,
    });
  }
  return { points, closed: b.c ?? false };
}

/**
 * Convert a Lottie shape-path property into engine `points` keyframes.
 *
 * @param ks the `sh.ks` object (static or animated form)
 * @param frameRate the comp's `fr` — Lottie keyframe times are in frames; the
 *        engine works in seconds, so `t` is divided by `fr`.
 * @returns `{ keyframes, closed }`. Static paths yield one keyframe at t=0.
 */
export function lottiePathKeyframes(
  ks: LottieShapeProp,
  frameRate: number,
): { keyframes: DataKeyframe[]; closed: boolean } {
  const fr = frameRate > 0 ? frameRate : 30;

  if (ks.a === 1) {
    let closed = false;
    const keyframes: DataKeyframe[] = ks.k.map((kf) => {
      const bez = kf.s[0];
      const conv = lottieBezierToPoints(bez);
      closed = closed || conv.closed;
      return { t: kf.t / fr, value: conv.points };
    });
    // Keep t ascending; Lottie is usually sorted but do not assume it.
    keyframes.sort((p, q) => p.t - q.t);
    return { keyframes, closed };
  }

  const conv = lottieBezierToPoints(ks.k);
  return { keyframes: [{ t: 0, value: conv.points }], closed: conv.closed };
}

export function pointsToLottieBezier(
  points: Array<{ x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }>,
  closed = true,
): LottieBezier {
  const v: Array<[number, number]> = [];
  const i: Array<[number, number]> = [];
  const o: Array<[number, number]> = [];
  for (const pt of points) {
    const vx = pt.x;
    const vy = pt.y;
    v.push([vx, vy]);
    const inX = pt.inX !== undefined ? pt.inX - vx : 0;
    const inY = pt.inY !== undefined ? pt.inY - vy : 0;
    const outX = pt.outX !== undefined ? pt.outX - vx : 0;
    const outY = pt.outY !== undefined ? pt.outY - vy : 0;
    i.push([inX, inY]);
    o.push([outX, outY]);
  }
  return { v, i, o, c: closed };
}


