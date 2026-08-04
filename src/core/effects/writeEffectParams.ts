/**
 * The ONE place an effect parameter is written from the UI.
 *
 * ## Why this exists (a §2·0 at the interaction layer)
 *
 * "When does editing a parameter create a keyframe?" had two answers in this
 * codebase and nothing forcing them to agree:
 *
 *   * transform props — `ports.applyNodePropsKeyframed`:
 *     `autoKeyframe || hasAnyTrack(group)` , so the Auto-Keyframe preference
 *     counts;
 *   * effect params — the inspector's own `ValueField.onChange`:
 *     `isAnimated(path)` alone, so the preference does not.
 *
 * That difference is a real inconsistency and it is NOT resolved here —
 * changing when an effect param autokeys would alter behaviour every existing
 * project depends on, which is a decision, not a refactor. What is resolved is
 * the thing that would have made it worse: a canvas handle needs the same rule
 * as the numeric field beside it, and a second copy of the rule would guarantee
 * they eventually disagreed. Both now call this.
 *
 * Logged as F22 in COMPOSITING_PLAN so the divergence is visible rather than
 * embedded.
 *
 * ## One gesture, one undo entry
 *
 * `mergeKey` collapses a drag's hundreds of writes into a single history entry,
 * the same way `PuppetEditCommand`'s transaction and `applyNodePropsKeyframed`'s
 * merge key do. The caller passes a key that is stable for the whole gesture and
 * distinct between gestures.
 */

import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { effectPropPath, updateEffectParam } from './effects';

/**
 * Write one or more numeric params of an effect, keyframing the ones that are
 * already animated and setting the static value on the ones that are not.
 *
 * The split is PER PARAM, not per call. A Bezier Warp handle carries an X and a
 * Y, and a user can perfectly well have keyframed only one of them; keyframing
 * both because one is animated would silently start an animation they did not
 * ask for, and keyframing neither would throw away the one they did.
 *
 * Returns the paths that were keyframed, so a caller can assert on them —
 * "a drag with the stopwatch off writes no keyframe" is the half that regresses
 * silently, and it needs something to observe.
 */
export function writeEffectParams(
  nodeId: string,
  effectId: string,
  values: Readonly<Record<string, number>>,
  opts: { time: number; mergeKey: string; label?: string },
): string[] {
  const layerT = compToKeyframeTime(nodeId, opts.time);
  const keyed: Array<{ path: string; value: number }> = [];
  const statics: Array<[string, number]> = [];

  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const path = effectPropPath(effectId, key);
    if (defaultAnimation.isAnimated(nodeId, path)) keyed.push({ path, value });
    else statics.push([key, value]);
  }

  // Statics first: `updateEffectParam` rewrites the whole effect list, and doing
  // it after the keyframe edit would land outside that edit's transaction.
  for (const [key, value] of statics) updateEffectParam(nodeId, effectId, key, value);

  if (keyed.length > 0) {
    runAnimEdit(
      opts.label ?? 'Set Effect Parameter',
      () => {
        for (const k of keyed) defaultAnimation.setKeyframe(nodeId, k.path, layerT, k.value);
      },
      opts.mergeKey,
    );
  }
  return keyed.map((k) => k.path);
}
