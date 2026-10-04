/**
 * rigDeform — the ONE evaluation path for skeleton posing (FK + IK) and for
 * composing skeleton skinning with puppet-pin deformation. buildSnapshot (live
 * preview AND export ride the same call) and the canvas overlays all evaluate
 * through here, so what the overlay shows is what renders.
 *
 * ── Composition order (skeleton + puppet on ONE layer) ─────────────────────
 * The puppet solve runs in REST space, then the skeleton skinning maps the
 * puppet-refined vertices into posed space:
 *
 *     rest mesh ──deform(pins)──▶ puppet-refined ──LBS(skeleton)──▶ posed
 *
 * Why this order (and not "pose the rest mesh with the skeleton, then run the
 * puppet against the posed configuration"):
 *   • ARAP's reduced Cholesky factorisation is keyed on the REST mesh + handle
 *     set (see arap.ts). A skeleton-posed rest state would change every frame,
 *     forcing an O(m³) refactor per frame (or a churny factor cache) — this
 *     order keeps the rest configuration frame-invariant, so the existing
 *     caching (and bit-determinism) is untouched.
 *   • It is temporally stable: pin weights and ARAP edge weights never depend
 *     on the animated pose, so there is no frame-to-frame binding swim.
 *   • Semantically it still delivers the AE/Rive contract — the skeleton is
 *     the coarse pose and pins refine on top: a pin's rest anchor AND its
 *     displacement are carried through the skeleton skinning, so a pin bound
 *     to a forearm keeps refining the forearm wherever the arm swings, and a
 *     bone rotation moves regions no pin holds.
 * Skinning weights are bound at REST vertex positions (not the puppet-moved
 * ones) so puppet animation cannot re-weight the skeleton binding.
 *
 * Deterministic throughout: pure arithmetic, fixed iteration counts, caches
 * keyed on value signatures. Same input → bit-identical output.
 */

import type { Bone } from './skeleton';
import { computeWorldTransforms,  boneRoot, boneTip } from './skeleton';
import { solveTwoBone, solveFabrik, anglesFromJoints, type Vec2 } from './ik';

// ────────────────────────────────────────────────────────────────────────────
// IK — chain resolution and pose override
// ────────────────────────────────────────────────────────────────────────────

/** An IK target with its live (possibly keyframe-sampled) position, layer-local. */
export interface IkTargetResolved {
  boneId: string;
  x: number;
  y: number;
  /** Bones in the chain (the target bone + its ancestors). Default 2, max 8. */
  chainLength?: number;
  /**
   * Optional pole vector (layer-local): the side a two-bone chain bends toward.
   * Without it the solver preserves the CURRENT bend side, which never flips —
   * a pole is how you choose (and keyframe) the elbow/knee direction.
   */
  pole?: { x: number; y: number };
}

const MAX_CHAIN = 8;
const DEFAULT_CHAIN = 2;

/**
 * The bone ids an IK target drives: the target bone and its ancestors up to
 * `chainLength` bones, root-first. Used both by the solver and by the overlay
 * (dragging any bone of an active chain moves the TARGET, AE/DUIK-style).
 */
export function ikChainIds(
  bones: readonly Bone[],
  targetBoneId: string,
  chainLength = DEFAULT_CHAIN,
): string[] {
  const byId = new Map(bones.map((b) => [b.id, b]));
  const max = Math.max(1, Math.min(MAX_CHAIN, Math.floor(chainLength)));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(targetBoneId);
  while (cur && chain.length < max && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * Apply IK targets on top of FK-sampled bones: for each target, resolve the
 * chain (analytic two-bone for 2-bone chains, FABRIK for longer, direct aim
 * for a single bone) and override the chain bones' LOCAL rotations (radians —
 * the unit `fromTRS`/`computeWorldTransforms` consume) so the end bone's tip
 * reaches the target. Bones outside every chain keep their FK pose untouched.
 *
 * Write-back is delta-based: each chain link's solved world angle minus its
 * current world angle is added to the bone's local rotation (accumulating
 * upstream deltas), which is exact for arbitrary child root offsets and needs
 * no assumption that a child sits on its parent's tip.
 */
export function applyIk(bones: readonly Bone[], targets: readonly IkTargetResolved[]): Bone[] {
  const out = bones.map((b) => ({ ...b }));
  if (targets.length === 0 || out.length === 0) return out;
  const byId = new Map(out.map((b) => [b.id, b]));

  for (const t of targets) {
    const end = byId.get(t.boneId);
    if (!end) continue;
    const chainIds = ikChainIds(out, t.boneId, t.chainLength ?? DEFAULT_CHAIN);
    if (chainIds.length === 0) continue;
    const chain = chainIds.map((id) => byId.get(id)!);

    // Current pose of the whole skeleton (earlier targets' writes included).
    const world = computeWorldTransforms({ bones: out });
    const joints: Vec2[] = chain.map((b) => boneRoot(world.get(b.id)!));
    joints.push(boneTip(world.get(end.id)!, end.length));

    const lengths: number[] = [];
    let degenerate = false;
    for (let i = 0; i < joints.length - 1; i++) {
      const a = joints[i]!;
      const b = joints[i + 1]!;
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l < 1e-6) degenerate = true;
      lengths.push(l);
    }
    if (degenerate) continue;

    const target: Vec2 = { x: t.x, y: t.y };
    // Current world angle of each link (root_i → joint_{i+1}).
    const currentAngles = anglesFromJoints(joints);
    let solvedAngles: number[];

    if (chain.length === 1) {
      // Single-link chain: aim the bone straight at the target.
      const j0 = joints[0]!;
      solvedAngles = [Math.atan2(target.y - j0.y, target.x - j0.x)];
    } else if (chain.length === 2) {
      // Analytic two-bone (arm/leg). Preserve the current bend side so the
      // elbow/knee does not pop when the target crosses the chain line.
      const j0 = joints[0]!;
      const j1 = joints[1]!;
      const j2 = joints[2]!;
      let bendPositive: boolean;
      if (t.pole) {
        // Explicit pole: bend toward whichever side of the root→target line the
        // pole sits on. Deterministic and keyframeable, so the joint can be made
        // to flip rather than only holding its current side.
        const ax = target.x - j0.x;
        const ay = target.y - j0.y;
        const side = ax * (t.pole.y - j0.y) - ay * (t.pole.x - j0.x);
        bendPositive = side >= 0;
      } else {
        // Preserve the current bend side so the joint does not pop when the
        // target crosses the chain line.
        bendPositive =
          (j1.x - j0.x) * (j2.y - j1.y) - (j1.y - j0.y) * (j2.x - j1.x) >= 0;
      }
      const sol = solveTwoBone(j0, lengths[0]!, lengths[1]!, target, bendPositive);
      solvedAngles = [sol.angle1, sol.angle2];
    } else {
      const solved = solveFabrik(joints, lengths, target);
      solvedAngles = anglesFromJoints(solved);
    }

    // Delta write-back, accumulating upstream rotation into downstream links.
    let cumulative = 0;
    for (let i = 0; i < chain.length; i++) {
      const delta = solvedAngles[i]! - (currentAngles[i]! + cumulative);
      chain[i]!.rotation += delta;
      cumulative += delta;
    }
  }
  return out;
}
