/**
 * User-facing feedback for timeline / inspector layer switches.
 *
 * These flags are wired end-to-end; the usual complaint is that nothing
 * appears to change because a second gate is off, the stack is empty, or the
 * copy overstated what the flag does (guide layers stay visible in the viewer).
 */

import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { useUIStore } from '@stores/uiStore';
import { getNodeEffects } from '@core/effects/effects';

function notify(message: string, level: 'info' | 'warning' | 'success' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 3200 });
}

/**
 * Turn on a layer's motion-blur opt-in. If the composition master is off,
 * enable it too so the row switch actually changes pixels (AE dual-gate).
 * Warn when draft preview is suppressing samples.
 */
export function enableLayerMotionBlurWithFeedback(nodeId: string, setLayer: (id: string, on: boolean) => void): void {
  setLayer(nodeId, true);
  const mb = useMotionBlurStore.getState();
  if (!mb.enabled) {
    mb.setEnabled(true);
    notify('Motion Blur enabled for this layer and the composition', 'success');
  }
  if (useRenderQualityStore.getState().draft) {
    notify('Draft preview is on — motion blur samples are paused until draft is off', 'warning');
  }
}

/** Disable layer motion blur without touching the composition master. */
export function disableLayerMotionBlur(nodeId: string, setLayer: (id: string, on: boolean) => void): void {
  setLayer(nodeId, false);
}

/**
 * Toggle adjustment layer. Empty stacks do not change pixels — say so.
 */
export function setAdjustmentWithFeedback(
  nodeId: string,
  on: boolean,
  setAdjustment: (id: string, on: boolean) => void,
): void {
  setAdjustment(nodeId, on);
  if (on && getNodeEffects(nodeId).length === 0) {
    notify('Adjustment layer is on — add effects to grade layers beneath it', 'info');
  }
}

/** Copy for guide-layer arming: visible in the viewer, omitted from export. */
export function guideLayerArmedMessage(plural = false): string {
  return plural
    ? 'Guide layers — visible while editing, omitted from export'
    : 'Guide layer — visible while editing, omitted from export';
}

export function guideLayerDisarmedMessage(plural = false): string {
  return plural ? 'No longer guide layers' : 'No longer a guide layer';
}

export function notifyGuideLayerChange(on: boolean, plural = false): void {
  notify(on ? guideLayerArmedMessage(plural) : guideLayerDisarmedMessage(plural), 'success');
}
