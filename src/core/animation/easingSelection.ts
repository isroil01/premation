/**
 * Resolving "which keyframes does an easing action apply to?" — shared by the
 * timeline easing pills and the F9 / Shift+F9 / Cmd+Shift+F9 commands so both
 * surfaces agree on the target set.
 */

import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { applyEasingToKeyframes, type EasingPreset } from '@core/animation/keyframeAssistants';

/**
 * The keyframes an easing action targets: the current keyframe selection, or —
 * when none are selected — every keyframe on the selected layers, so the action
 * always has a visible effect.
 */
export function easingTargetKeyframes(): string[] {
  return [...useKeyframeSelectionStore.getState().ids];
}

/** Returns false when there was nothing to ease, so callers can explain why. */
export function applyEasingToSelection(preset: EasingPreset): boolean {
  const kfIds = easingTargetKeyframes();
  if (kfIds.length === 0) return false;
  applyEasingToKeyframes(kfIds, preset);
  return true;
}
