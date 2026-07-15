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
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import type { ProjectFile } from '@core/types';

const KEY = 'recovery';

export interface RecoverySnapshot {
  projectId?: string;
  savedAt: number;
  time: number;
  scene: ProjectFile;
  anim: AnimSnapshot;
}

/** Snapshot the current editable state (deep-cloned). */
export function captureRecovery(time: number): RecoverySnapshot | null {
  const match = typeof window !== 'undefined' ? window.location.pathname.match(/\/editor\/([^/]+)/) : null;
  const projectId = match ? match[1] : undefined;
  if (!projectId || projectId.trim() === '') return null;
  return {
    projectId,
    savedAt: 0, // stamped at persist time (Date.now lives at the call site)
    time,
    scene: structuredClone(sceneProjectIO.capture()),
    anim: defaultAnimation.snapshot(),
  };
}

export function persistRecovery(snap: RecoverySnapshot | null): void {
  if (!snap || !snap.projectId) return;
  getSettingsManager().set(KEY, snap);
}

export function readRecovery(): RecoverySnapshot | null {
  const v = getSettingsManager().get<RecoverySnapshot | null>(KEY, null);
  return v && typeof v.savedAt === 'number' && v.scene && typeof v.projectId === 'string' && v.projectId.trim() !== '' ? v : null;
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
