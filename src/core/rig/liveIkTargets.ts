/**
 * The ONE place a stored IK target becomes a live, solvable one.
 *
 * ## Why this exists as a function
 *
 * `buildSnapshot`, `BoneOverlay` and `PuppetOverlay` each had their own copy of
 * this — same filter, same four `sample` calls, same object literal — and they
 * had already drifted: **PuppetOverlay never sampled the pole at all**, so a
 * layer carrying both a puppet rig and a skeleton with a keyframed pole
 * previewed without the pole and rendered with it. Nothing failed; the two
 * pictures just disagreed. That is §2·0's shape, caught in the act.
 *
 * It is also the seam the IK/FK mode has to cross. The mode decides whether a
 * chain is solved at all, so gating it in three places would mean three chances
 * for a chain to be FK in the viewport and IK in the export. Here there is one.
 */

import { defaultAnimation } from '@motion/animation';
import type { IKTarget, SkeletonRig } from './skeletonCommands';
import type { IkTargetResolved } from './rigDeform';
import { chainModeAt, chainModePropPath } from './ikfk';

/** The slice of the animation engine this needs — nothing more. */
export interface IkSampler {
  sample(nodeId: string, path: string, timeSec: number): unknown;
}

/** `ikTarget.<boneId>.x` etc — one speller for every IK-related track name. */
export function ikTargetPropPath(boneId: string, axis: 'x' | 'y'): string {
  return `ikTarget.${boneId}.${axis}`;
}
export function ikPolePropPath(boneId: string, axis: 'x' | 'y'): string {
  return `ikPole.${boneId}.${axis}`;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Resolve a rig's IK targets at `timeSec`: live positions, live poles, and the
 * per-chain mode applied.
 *
 * A chain in **FK mode is omitted entirely** rather than passed through with a
 * flag. `applyIk` overrides the local rotations of every chain it is given, so a
 * target that reached it in FK mode would drive the chain no matter what any
 * downstream check said — the only way for FK to mean FK is for the target not
 * to arrive. Omission is also what makes the mode free at the solver: bones
 * outside every chain already keep their FK pose untouched, which is exactly
 * the behaviour FK mode wants.
 */
export function resolveActiveIkTargets(
  rig: Pick<SkeletonRig, 'ikTargets'> | undefined,
  nodeId: string,
  timeSec: number,
  anim: IkSampler = defaultAnimation,
): IkTargetResolved[] {
  const out: IkTargetResolved[] = [];
  for (const tg of rig?.ikTargets ?? []) {
    if (tg.enabled === false) continue;
    if (chainModeOf(tg, nodeId, timeSec, anim) === 'fk') continue;

    const liveX = anim.sample(nodeId, ikTargetPropPath(tg.boneId, 'x'), timeSec);
    const liveY = anim.sample(nodeId, ikTargetPropPath(tg.boneId, 'y'), timeSec);
    const poleX = anim.sample(nodeId, ikPolePropPath(tg.boneId, 'x'), timeSec);
    const poleY = anim.sample(nodeId, ikPolePropPath(tg.boneId, 'y'), timeSec);
    const pole =
      num(poleX) || num(poleY)
        ? { x: num(poleX) ? poleX : (tg.pole?.x ?? 0), y: num(poleY) ? poleY : (tg.pole?.y ?? 0) }
        : tg.pole;

    out.push({
      boneId: tg.boneId,
      x: num(liveX) ? liveX : tg.x,
      y: num(liveY) ? liveY : tg.y,
      chainLength: tg.chainLength,
      ...(pole ? { pole } : {}),
    });
  }
  return out;
}

/** A chain's mode at a time — the track wins over the stored value. */
export function chainModeOf(
  target: Pick<IKTarget, 'boneId' | 'ikMode'>,
  nodeId: string,
  timeSec: number,
  anim: IkSampler = defaultAnimation,
): 'ik' | 'fk' {
  return chainModeAt(anim.sample(nodeId, chainModePropPath(target.boneId), timeSec), target.ikMode);
}
