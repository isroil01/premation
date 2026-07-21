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
import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import type { ProjectFile } from '@core/types';

const KEY = 'recovery';

export interface RecoverySnapshot {
  projectId?: string;
  savedAt: number;
  time: number;
  /** Full document (v1.1+). Older snapshots carry only `scene`/`anim`. */
  doc?: EditorDocument;
  scene: ProjectFile;
  anim: AnimSnapshot;
}

/**
 * The editor's project id, read from the route.
 *
 * The app uses a HashRouter, so the route lives in `location.hash` — reading
 * `location.pathname` yielded `/` in dev and the index.html path under
 * Electron's file://, so this never matched and the entire recovery subsystem
 * was inert.
 */
function currentProjectId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const from = (s: string): string | undefined => s.match(/\/editor\/([^/?#]+)/)?.[1];
  return from(window.location.hash) ?? from(window.location.pathname);
}

/** Snapshot the current editable state (deep-cloned). */
export function captureRecovery(time: number): RecoverySnapshot | null {
  const projectId = currentProjectId();
  if (!projectId || projectId.trim() === '') return null;
  const doc = captureDocument();
  return {
    projectId,
    savedAt: 0, // stamped at persist time (Date.now lives at the call site)
    time,
    doc: structuredClone(doc),
    // Kept for snapshots written by older builds / readers.
    scene: structuredClone(doc.scene),
    anim: doc.animation,
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
  // The dashboard calls this BEFORE the editor boots (Create & Launch), when
  // core services aren't registered yet — there is nothing to clear then, and
  // throwing here broke the entire launch flow.
  try {
    getSettingsManager().delete(KEY);
  } catch {
    /* app not booted — no settings, so no snapshot to clear */
  }
}

/** Restore a snapshot into the live engines (non-destructive). Returns the time. */
export function restoreRecovery(snap: RecoverySnapshot): number {
  if (snap.doc) {
    restoreDocument(structuredClone(snap.doc));
  } else {
    // Pre-1.1 snapshot: scene + animation only.
    sceneProjectIO.restore(structuredClone(snap.scene));
    defaultAnimation.restore(snap.anim);
  }
  return snap.time;
}
