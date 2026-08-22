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
import { DEFAULT_COMP_SETTINGS } from '@stores/projectStore';
import { DEFAULT_MOTION_BLUR_SETTINGS } from '@stores/motionBlurStore';
import { DEFAULT_GUIDES_SETTINGS } from '@stores/guidesStore';
import { DEFAULT_COLOR_MANAGEMENT_SETTINGS } from '@stores/colorManagementStore';

/**
 * The composition id `sceneProjectIO.createEmpty` gives the root node, and the
 * one the default workspace tab points at. They must agree or a new project
 * opens on a tab whose comp does not exist.
 */
const ROOT_COMP_ID = 'comp_root';

/** True when the payload is a scene-only file rather than a full document. */
function isLegacySceneFile(doc: EditorDocument | ProjectFile): doc is ProjectFile {
  return Array.isArray((doc as ProjectFile).nodes);
}

export const projectDocumentIO: ProjectDocumentIO<EditorDocument> = {
  /**
   * A blank document — every subsystem, not just the scene.
   *
   * `restoreDocument` is deliberately tolerant of partial documents (an old
   * file that predates a field must not have that field wiped), which meant a
   * document carrying ONLY scene + animation left comps, motion blur and guides
   * exactly as the previous project had them. So File ▸ New Project inherited
   * the last project's resolution, frame rate, duration and shutter settings —
   * a "new" project that silently exports at someone else's settings.
   *
   * Stating the defaults explicitly is what makes it a new project. Timelines
   * and workspace tabs cannot be expressed as an empty document (an absent key
   * means "keep", and there is no key that means "drop the ones I don't
   * mention") — `resetProjectWorkspace` handles those alongside this.
   */
  createEmpty: (name) => ({
    version: '1.1.0',
    scene: sceneProjectIO.createEmpty(name),
    animation: { tracks: {}, expressions: {} },
    comps: { [ROOT_COMP_ID]: { id: ROOT_COMP_ID, name: 'Composition 1', pristine: true, ...DEFAULT_COMP_SETTINGS } },
    motionBlur: { ...DEFAULT_MOTION_BLUR_SETTINGS },
    guides: { ...DEFAULT_GUIDES_SETTINGS },
    colorManagement: { ...DEFAULT_COLOR_MANAGEMENT_SETTINGS },
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
