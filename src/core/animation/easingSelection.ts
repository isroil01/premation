/**
 * Resolving "which keyframes does an easing action apply to?" — shared by the
 * timeline easing pills and the F9 / Shift+F9 / Cmd+Shift+F9 commands so both
 * surfaces agree on the target set.
 */

import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';

/**
 * The keyframes an easing action targets: the current keyframe selection, or —
 * when none are selected — every keyframe on the selected layers, so the action
 * always has a visible effect.
 */
export function easingTargetKeyframes(): string[] {
  return [...useKeyframeSelectionStore.getState().ids];
}
