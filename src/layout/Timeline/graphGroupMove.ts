/**
 * Graph multi-keyframe drag — time body moves as one (AE parity).
 * Value deltas are applied by the caller (per-curve ranges differ).
 */

import { snapKeyframeGroup, type SnapTarget } from './keyframeSnap';

export interface GraphGroupMemberStart {
  nodeId: string;
  prop: string;
  /** Layer-local keyframe time at pointer-down. */
  startT: number;
  /** Comp-space time at pointer-down. */
  startCompT: number;
  startValue: number;
  minV: number;
  maxV: number;
}

export interface GraphGroupTimePlan {
  /** New comp times, parallel to `members`. */
  compTimes: number[];
  snapTarget: SnapTarget | null;
  /** Comp-space delta after snap (added to every startCompT). */
  delta: number;
}

/**
 * Plan new comp times for a multi-diamond drag. The grabbed key's proposed
 * time sets the group delta; snapKeyframeGroup then shifts the whole body.
 */
export function planGraphGroupTimes(opts: {
  members: ReadonlyArray<GraphGroupMemberStart>;
  grabIndex: number;
  rawGrabCompT: number;
  duration: number;
  pixelsPerSecond: number;
  frameDuration: number;
  playheadTime: number;
  /** Comp times of keyframes NOT in the moving set. */
  otherCompTimes: readonly number[];
  disableSnap: boolean;
}): GraphGroupTimePlan {
  const { members, grabIndex, duration } = opts;
  if (members.length === 0) return { compTimes: [], snapTarget: null, delta: 0 };
  const grab = members[grabIndex] ?? members[0]!;
  const dt = opts.rawGrabCompT - grab.startCompT;
  const moved = members.map((m) => m.startCompT + dt);
  const { delta: snapDelta, target } = snapKeyframeGroup(moved, {
    pixelsPerSecond: opts.pixelsPerSecond,
    frameDuration: opts.frameDuration,
    playheadTime: opts.playheadTime,
    keyframeTimes: opts.otherCompTimes,
    disabled: opts.disableSnap,
  });
  const delta = dt + snapDelta;
  return {
    compTimes: members.map((m) => Math.max(0, Math.min(duration, m.startCompT + delta))),
    snapTarget: target,
    delta,
  };
}

/** Absolute value after applying the grabbed diamond's value delta. */
export function applyGroupValueDelta(
  member: GraphGroupMemberStart,
  grab: GraphGroupMemberStart,
  newGrabValue: number,
): number {
  const dv = newGrabValue - grab.startValue;
  const v = member.startValue + dv;
  return Math.max(member.minV, Math.min(member.maxV, v));
}
