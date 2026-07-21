/**
 * projectDocumentIO — the project's save/load document.
 *
 * The ProjectManager used to be wired to `sceneProjectIO`, which captures the
 * SCENE GRAPH AND NOTHING ELSE. So `File ▸ Save` wrote a `.motion` containing
 * geometry with no keyframes, no comp settings and no timeline: reopening it
 * gave you back the shapes and silently dropped every animation you'd authored.
 *
 * This registers the full EditorDocument instead — the same one the cloud
 * autosave and `File ▸ Export ▸ Project` use, so all three round-trip through
 * one shape and a file written by any of them opens in the others.
 */

import type { ProjectDocumentIO } from '@core/project/ProjectManager';
import type { ProjectFile } from '@core/types';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { defaultAnimation } from '@motion/animation';

/** True when the payload is a scene-only file rather than a full document. */
function isLegacySceneFile(doc: EditorDocument | ProjectFile): doc is ProjectFile {
  return Array.isArray((doc as ProjectFile).nodes);
}

export const projectDocumentIO: ProjectDocumentIO<EditorDocument> = {
  createEmpty: (name) => ({
    version: '1.1.0',
    scene: sceneProjectIO.createEmpty(name),
    animation: { tracks: {}, expressions: {} },
  }),

  capture: () => captureDocument(),

  restore: (doc) => {
    // A `.motion` written by an older build is a bare ProjectFile — restore the
    // scene from it directly rather than silently opening an empty project.
    if (isLegacySceneFile(doc)) {
      sceneProjectIO.restore(doc);
      defaultAnimation.clear();
      return;
    }
    restoreDocument(doc);
  },
};
