/**
 * Per-chain IK/FK mode, and the pose-preserving conversion between them.
 *
 * An animator poses an arm from the hand for a contact pose (IK) and from the
 * shoulder for the follow-through (FK), and has to switch mid-shot. The switch
 * is worthless if the limb moves when it happens — so the conversion, not the
 * flag, is the feature.
 *
 * ## Why there is almost no maths here
 *
 * Both directions already existed in the solver and nobody had noticed:
 *
 *   • **IK → FK** is `applyIk` itself. It does not return a separate pose — it
 *     OVERRIDES the chain bones' LOCAL rotations and returns the bones. Those
 *     rotations, evaluated as FK, reproduce the IK result by construction. The
 *     conversion is therefore exact rather than fitted: there is no residual to
 *     measure, because it is the same numbers read out of the same solve.
 *   • **FK → IK** is `boneTip` of the chain's end bone in the FK pose. Solving
 *     toward that point reproduces the pose it came from.
 *
 * Writing a fresh conversion would have been a second solver disagreeing with
 * the first at the edges (§2·0). What is added here is the read-out, the mode,
 * and the ordering.
 *
 * ## The bend side carries itself — checked, not assumed
 *
 * This file first claimed FK → IK loses the elbow side, and computed a pole to
 * carry it. That was wrong, and the solver says so in its own docstring:
 * without a pole `applyIk` PRESERVES THE CURRENT BEND SIDE and never flips it.
 * A pole is how you CHOOSE a side, not how you keep one.
 *
 * So passing a pole here was not merely redundant, it was harmful: a pole is a
 * side selector tested against the root→target line, and handing it the elbow
 * that already sits near that line perturbed the very pose the switch exists to
 * preserve. The round-trip guard caught it — measured as a real pose change,
 * not reasoned about.
 *
 * FK → IK therefore writes a target and nothing else.
 */

import { computeWorldTransforms, boneTip, type Bone } from './skeleton';
import { applyIk, ikChainIds, type IkTargetResolved } from './rigDeform';

/**
 * Which way a chain is driven this frame.
 *
 * Stored per IK target, because a target IS a chain — one field, not a parallel
 * list that could disagree about which chains exist.
 */
export type ChainMode = 'ik' | 'fk';

/** `ikMode.<boneId>` — the keyframeable track. ≥ 0.5 means IK. */
export function chainModePropPath(boneId: string): string {
  return `ikMode.${boneId}`;
}

/**
 * Resolve a chain's mode at a time.
 *
 * A HOLD, not a ramp: the sampled number is thresholded rather than blended,
 * because there is no meaningful half-IK pose. Interpolating the flag would
 * produce frames where the chain is neither driven nor free.
 */
export function chainModeAt(sampled: unknown, stored: ChainMode | undefined): ChainMode {
  if (typeof sampled === 'number' && Number.isFinite(sampled)) {
    return sampled >= 0.5 ? 'ik' : 'fk';
  }
  return stored ?? 'ik';
}

/** The numeric value a mode is stored as on its track. */
export function chainModeValue(mode: ChainMode): number {
  return mode === 'ik' ? 1 : 0;
}

/**
 * IK → FK: the chain's solved LOCAL rotations, keyed by bone id.
 *
 * Exact by construction — see the header. Returns only the chain's bones, so a
 * caller writing these cannot disturb a bone outside the chain it switched.
 */
export function solvedChainRotations(
  bones: readonly Bone[],
  targets: readonly IkTargetResolved[],
  boneId: string,
  chainLength?: number,
): Map<string, number> {
  const solved = applyIk(bones, targets);
  const ids = new Set(ikChainIds(solved, boneId, chainLength));
  const out = new Map<string, number>();
  for (const b of solved) {
    if (ids.has(b.id)) out.set(b.id, b.rotation);
  }
  return out;
}

/**
 * FK → IK: where the chain's effector is in the given pose.
 *
 * The tip of the END bone, which is the point an IK target names. Returns null
 * when the bone is unknown, so a caller writes nothing rather than a target at
 * the origin.
 */
export function effectorPosition(
  bones: readonly Bone[],
  boneId: string,
): { x: number; y: number } | null {
  const end = bones.find((b) => b.id === boneId);
  if (!end) return null;
  const world = computeWorldTransforms({ bones: [...bones] });
  const m = world.get(boneId);
  return m ? boneTip(m, end.length) : null;
}

/**
 * Everything a switch needs, computed from the CURRENT pose before anything is
 * written.
 *
 * Deliberately a pure read returning a plan, rather than a function that
 * mutates: the caller writes the mode and the values in one command, and the
 * order in which it does so cannot change what was measured. Computing the
 * effector after flipping the mode would read a pose the switch had already
 * disturbed — which is the whole bug this feature exists to avoid.
 */
export interface SwitchPlan {
  to: ChainMode;
  /** IK → FK: local rotations to write, by bone id. Empty going the other way. */
  rotations: Map<string, number>;
  /** FK → IK: where to put the target. Null going the other way. */
  target: { x: number; y: number } | null;
}

export function planChainSwitch(
  bones: readonly Bone[],
  targets: readonly IkTargetResolved[],
  boneId: string,
  to: ChainMode,
  chainLength?: number,
): SwitchPlan {
  if (to === 'fk') {
    // Read the pose the chain is IN — solved — and keep those rotations.
    return {
      to,
      rotations: solvedChainRotations(bones, targets, boneId, chainLength),
      target: null,
    };
  }
  // Going to IK: the chain is currently FK, so the pose is the bones as given.
  return {
    to,
    rotations: new Map(),
    target: effectorPosition(bones, boneId),
  };
}
