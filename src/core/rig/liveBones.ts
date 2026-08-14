import type { Bone } from './skeleton';

/** Minimal animation reader used by every rig preview/render path. */
export interface BoneSampler {
  sample(nodeId: string, path: string, timeSec: number): unknown;
}

function numberOr(sampled: unknown, fallback: number): number {
  return typeof sampled === 'number' && Number.isFinite(sampled) ? sampled : fallback;
}

/**
 * The single stored-bone → live-bone conversion.
 *
 * Keeping this shared matters: buildSnapshot used to sample scale while both
 * authoring overlays sampled only position/rotation, so scaled bones rendered
 * somewhere other than their visible handles and weight preview.
 */
export function resolveLiveBones(
  bones: readonly Bone[],
  nodeId: string,
  timeSec: number,
  anim: BoneSampler,
): Bone[] {
  return bones.map((bone) => ({
    ...bone,
    rotation: numberOr(anim.sample(nodeId, `bone.${bone.id}.rotation`, timeSec), bone.rotation),
    x: numberOr(anim.sample(nodeId, `bone.${bone.id}.x`, timeSec), bone.x),
    y: numberOr(anim.sample(nodeId, `bone.${bone.id}.y`, timeSec), bone.y),
    scaleX: numberOr(anim.sample(nodeId, `bone.${bone.id}.scaleX`, timeSec), bone.scaleX ?? 1),
    scaleY: numberOr(anim.sample(nodeId, `bone.${bone.id}.scaleY`, timeSec), bone.scaleY ?? 1),
  }));
}
