/**
 * Crash recovery (spec §Trust Infrastructure).
 *
 * A recovery snapshot is a non-destructive copy of the editable state (scene +
 * animation + playhead) written to persistent settings by the autosave loop.
 * On next launch, if one exists, the app offers to restore the exact session.
 * Source assets are never touched — restoring only swaps in-memory state.
 */

import { getSettingsManager } from '@core/services/coreServices';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import defaultAnimation, { type AnimSnapshot } from '@core/animation/AnimationEngine';
import type { ProjectFile } from '@core/types';

const KEY = 'recovery';

export interface RecoverySnapshot {
  savedAt: number;
  time: number;
  scene: ProjectFile;
  anim: AnimSnapshot;
}

/** Snapshot the current editable state (deep-cloned). */
export function captureRecovery(time: number): RecoverySnapshot {
  return {
    savedAt: 0, // stamped at persist time (Date.now lives at the call site)
    time,
    scene: structuredClone(sceneProjectIO.capture()),
    anim: defaultAnimation.snapshot(),
  };
}

export function persistRecovery(snap: RecoverySnapshot): void {
  getSettingsManager().set(KEY, snap);
}

export function readRecovery(): RecoverySnapshot | null {
  const v = getSettingsManager().get<RecoverySnapshot | null>(KEY, null);
  return v && typeof v.savedAt === 'number' && v.scene ? v : null;
}

export function clearRecovery(): void {
  getSettingsManager().delete(KEY);
}

/** Restore a snapshot into the live engines (non-destructive). Returns the time. */
export function restoreRecovery(snap: RecoverySnapshot): number {
  sceneProjectIO.restore(structuredClone(snap.scene));
  defaultAnimation.restore(snap.anim);
  return snap.time;
}
