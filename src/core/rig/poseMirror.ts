/**
 * Pose values and left/right mirroring: pure, so the swap is testable without an
 * engine (the writes are `poseWriteCommands`, rigEdits.ts; the actions rigPoseActions.ts).
 *
 * ## Which bones are opposites
 *
 * `side` lives on controllers (rigPresets.ts): a bone takes the side of the
 * controller linked to it, or of the IK goal whose chain it is in, and a child
 * with no side of its own inherits its parent's. A bone claimed by both sides
 * (a chain long enough to reach the spine) is centre, as is one with a `centre`
 * controller. Opposites are then found by STRUCTURE, parents first: a bone pairs
 * with an opposite-side bone under the same parent, or under its parent's
 * opposite, nearest its reflection. So the quadruped's fore and hind legs pair,
 * while its head and tail, on different branches, stay as they are. A rig with
 * no sides has no pairs.
 *
 * ## Mirroring is not swapping values
 *
 * The biped's arms rest at 0.72π and 0.28π: copying one arm's rotation onto the
 * other points it across the body. What swaps is the pose's offset from the BIND
 * pose, reflected. Under one parent the reflection flips the parent's x (that is
 * how the presets place a pair); under a mirrored pair of parents the frames are
 * themselves reflected, so it flips y. An IK goal or pole is layer space, and
 * reflects about the rig's centre line (the rest x of a root with no opposite;
 * the layer origin without one, which is where the presets centre).
 */

import type { RigPose } from '@motion/engine-api';
import type { Bone } from './skeleton';
import { ikChainIds } from './rigDeform';
import { bindPoseBones, type SkeletonRig } from './skeletonCommands';

/** A bone's live pose in the rig's units (radians, multipliers). */
export interface BonePoseValue {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/** An IK goal's live pose (layer space). */
export interface GoalPoseValue {
  x: number;
  y: number;
  pole?: { x: number; y: number };
  mode: 'ik' | 'fk';
}

export interface RigPoseValues {
  bones: ReadonlyMap<string, BonePoseValue>;
  /** By the bone the goal is on; enabled goals only. */
  goals: ReadonlyMap<string, GoalPoseValue>;
}

/** The pose values of an engine `getRigPose` answer, of `ids` only when given. */
export function poseValues(pose: RigPose, ids?: ReadonlySet<string>): RigPoseValues {
  const bones = new Map<string, BonePoseValue>();
  for (const b of pose.bones) {
    if (!ids || ids.has(b.id)) bones.set(b.id, { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY });
  }
  const goals = new Map<string, GoalPoseValue>();
  for (const g of pose.ik) {
    if (!g.enabled || (ids && !ids.has(g.bone))) continue;
    goals.set(g.bone, {
      x: g.x, y: g.y, mode: g.mode === 'fk' ? 'fk' : 'ik',
      ...(g.pole.length === 2 ? { pole: { x: g.pole[0]!, y: g.pole[1]! } } : {}),
    });
  }
  return { bones, goals };
}

/**
 * What a pose action on `ids` covers: those bones (empty = the whole skeleton),
 * plus every IK chain any of them is in. A chain is posed by its goal, which
 * lives on the chain's last bone, so selecting the upper arm alone must still
 * carry the goal, or the action changes nothing the solver shows.
 */
export function poseScope(rig: SkeletonRig | undefined, ids: readonly string[]): Set<string> {
  const bones = rig?.bones ?? [];
  const known = new Set(bones.map((b) => b.id));
  const picked = ids.filter((id) => known.has(id));
  if (picked.length === 0) return known;
  const scope = new Set(picked);
  for (const goal of rig?.ikTargets ?? []) {
    if (goal.enabled === false) continue;
    const chain = ikChainIds(bones, goal.boneId, goal.chainLength);
    if (chain.some((id) => scope.has(id))) for (const id of chain) scope.add(id);
  }
  return scope;
}

type Side = 'left' | 'right' | 'centre';

/** Each sided bone's side (see the header); a bone with no entry has none. */
function boneSides(rig: SkeletonRig): Map<string, Side> {
  const bones = rig.bones ?? [];
  const sides = new Map<string, Side>();
  const claim = (id: string, side: Side): void => {
    const had = sides.get(id);
    sides.set(id, had === undefined || had === side ? side : 'centre');
  };
  for (const c of rig.controllers ?? []) {
    if (c.link.kind === 'bone') claim(c.link.boneId, c.side);
    else {
      const goal = rig.ikTargets?.find((g) => g.boneId === c.link.boneId);
      for (const id of ikChainIds(bones, c.link.boneId, goal?.chainLength)) claim(id, c.side);
    }
  }
  // Parent-first, so a chain of unmarked children inherits all the way down.
  const byId = new Map(bones.map((b) => [b.id, b]));
  const sideOf = (b: Bone, depth: number): Side | undefined => {
    const own = sides.get(b.id);
    if (own || !b.parentId || depth > bones.length) return own;
    const parent = byId.get(b.parentId);
    const inherited = parent ? sideOf(parent, depth + 1) : undefined;
    if (inherited) sides.set(b.id, inherited);
    return inherited;
  };
  for (const b of bones) sideOf(b, 0);
  return sides;
}

function depthOf(b: Bone, byId: ReadonlyMap<string, Bone>): number {
  let depth = 0;
  for (let cur = b; cur.parentId && depth <= byId.size; depth += 1) {
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    cur = parent;
  }
  return depth;
}

/** Each bone's opposite, both ways round: a bone with no opposite is absent. */
export function mirrorPairs(rig: SkeletonRig | undefined): Map<string, string> {
  const pairs = new Map<string, string>();
  if (!rig) return pairs;
  const sides = boneSides(rig);
  const rest = bindPoseBones(rig);
  const byId = new Map(rest.map((b) => [b.id, b]));
  const sided = (side: Side): Bone[] => rest.filter((b) => sides.get(b.id) === side);
  const lefts = sided('left');
  const rights = sided('right');
  const maxDepth = Math.max(0, ...lefts.map((b) => depthOf(b, byId)));
  // A level at a time, so a child can test whether its parents paired.
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidates: Array<{ l: Bone; r: Bone; distance: number }> = [];
    for (const l of lefts) {
      if (depthOf(l, byId) !== depth) continue;
      for (const r of rights) {
        if (depthOf(r, byId) !== depth) continue;
        const shared = l.parentId === r.parentId;
        if (!shared && !(l.parentId && pairs.get(l.parentId) === r.parentId)) continue;
        const distance = shared ? Math.hypot(l.x + r.x, l.y - r.y) : Math.hypot(l.x - r.x, l.y + r.y);
        candidates.push({ l, r, distance });
      }
    }
    // Closest first, so an unmatched extra bone cannot take another's opposite.
    candidates.sort((a, b) => a.distance - b.distance);
    for (const { l, r } of candidates) {
      if (pairs.has(l.id) || pairs.has(r.id)) continue;
      pairs.set(l.id, r.id);
      pairs.set(r.id, l.id);
    }
  }
  return pairs;
}

/**
 * The mirrored pose of the pairs `scope` touches (a pair swaps whole, even with
 * one bone in scope). Bones with no opposite are simply not in the result.
 */
export function mirrorPose(rig: SkeletonRig, live: RigPoseValues, scope: ReadonlySet<string>): RigPoseValues {
  const pairs = mirrorPairs(rig);
  const rest = bindPoseBones(rig);
  const restById = new Map(rest.map((b) => [b.id, b]));
  const bones = new Map<string, BonePoseValue>();
  const goals = new Map<string, GoalPoseValue>();
  const root = rest.find((b) => !b.parentId && !pairs.has(b.id));
  const axisX = root?.x ?? 0;
  const reflect = (p: { x: number; y: number }): { x: number; y: number } => ({ x: 2 * axisX - p.x, y: p.y });

  for (const [id, opposite] of pairs) {
    if (!scope.has(id) && !scope.has(opposite)) continue;
    const self = restById.get(id);
    const other = restById.get(opposite);
    const from = live.bones.get(opposite);
    if (!self || !other || !from) continue;
    const dx = from.x - other.x;
    const dy = from.y - other.y;
    const shared = self.parentId === other.parentId;
    bones.set(id, {
      x: self.x + (shared ? -dx : dx),
      y: self.y + (shared ? dy : -dy),
      rotation: self.rotation - (from.rotation - other.rotation),
      scaleX: from.scaleX,
      scaleY: from.scaleY,
    });

    // A goal only swaps with a goal: one chain in IK has nothing to take from an FK limb.
    const mine = live.goals.get(id);
    const theirs = live.goals.get(opposite);
    if (!mine || !theirs) continue;
    goals.set(id, {
      ...reflect(theirs),
      mode: theirs.mode,
      ...(mine.pole && theirs.pole ? { pole: reflect(theirs.pole) } : mine.pole ? { pole: mine.pole } : {}),
    });
  }
  return { bones, goals };
}
