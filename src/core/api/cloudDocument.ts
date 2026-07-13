/**
 * Cloud document capture/restore.
 *
 * The editor's on-disk file format (ProjectFile) is scene-only. The backend
 * stores a richer, self-contained EditorDocument (scene + animation + comp) so
 * the AI and render services have everything they need. These helpers bridge the
 * two: capture the full document from the live engines, and restore all three
 * subsystems from one.
 */

import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import { useCompositionStore } from '@stores/compositionStore';
import type { ProjectFile } from '@core/types';
import type { CompositionSettings } from '@stores/compositionStore';

export interface EditorDocument {
  version: string;
  scene: ProjectFile;
  animation: AnimSnapshot;
  comp?: CompositionSettings;
  timeline?: unknown;
}

/** Snapshot scene + animation + comp into one self-contained document. */
export function captureDocument(): EditorDocument {
  return {
    version: '1.0.0',
    scene: sceneProjectIO.capture(),
    animation: defaultAnimation.snapshot(),
    comp: useCompositionStore.getState().comp(),
  };
}

/** Restore all subsystems from a full document. Tolerant of partial documents. */
export function restoreDocument(doc: EditorDocument): void {
  if (doc?.scene) sceneProjectIO.restore(doc.scene);
  if (doc?.animation) defaultAnimation.restore(doc.animation);
  if (doc?.comp) useCompositionStore.getState().update(doc.comp);
}
