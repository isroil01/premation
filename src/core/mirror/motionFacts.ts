/**
 * Motion facts of a layer over the document mirror (B4) — what the viewport's
 * motion-path chrome gates on before it draws. Pure: takes a mirror reader.
 */

import type { Keyframe } from '@motion/engine-api';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorKeysRead {
  layerKeyframes(layer: string): ReadonlyMap<string, readonly Keyframe[]>;
}

/** Position as one property, or its separated dimensions (X / Y). */
const POSITION_PATHS = ['transform/position', 'transform/position/x', 'transform/position/y'] as const;

/** Whether the layer's Position (X or Y) is keyframed — the twin of `motionPath.hasPositionAnimation`. */
export function hasPositionKeys(m: MirrorKeysRead, layer: string): boolean {
  const keys = m.layerKeyframes(layer);
  return POSITION_PATHS.some((p) => (keys.get(p)?.length ?? 0) > 0);
}

/**
 * Whether the Position keys carry spatial tangents or a non-linear spatial
 * interpolation — the twin of `motionPath.hasPathTangents` (a key with no
 * stored interpolation reads `legacy` through the API).
 */
export function hasPositionTangents(m: MirrorKeysRead, layer: string): boolean {
  const keys = m.layerKeyframes(layer);
  return POSITION_PATHS.some((p) => (keys.get(p) ?? []).some((k) =>
    k.spatialIn.length > 0 || k.spatialOut.length > 0 || (k.spatialInterp !== 'legacy' && k.spatialInterp !== 'linear')));
}

/** Whether any property of the layer is keyframed (`AnimationEngine.animatedProps(id).length > 0`). */
export function hasAnyKeys(m: MirrorKeysRead, layer: string): boolean {
  for (const keys of m.layerKeyframes(layer).values()) if (keys.length > 0) return true;
  return false;
}
