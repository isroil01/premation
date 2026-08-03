/**
 * Cloud document capture/restore.
 *
 * The editor's on-disk file format (ProjectFile) is scene-only. The backend
 * stores a richer, self-contained EditorDocument (scene + animation + comps +
 * timelines + render settings) so the AI and render services have everything
 * they need. These helpers bridge the two: capture the full document from the
 * live engines, and restore every subsystem from one.
 *
 * Anything a user can author that is NOT captured here is silently lost on
 * reload. Add new authored state to both halves, and to the round-trip test in
 * `cloudDocument.test.ts`.
 */

import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore, type CompositionSettings } from '@stores/projectStore';
import { useMotionBlurStore, type MotionBlurSettings } from '@stores/motionBlurStore';
import { useGuidesStore, type GuidesSettings } from '@stores/guidesStore';
import type { ProjectFile } from '@core/types';
import type { SerializedTimeline } from '@motion/timeline';
import { migrateDocument } from '@core/project/migrations';

export interface EditorDocument {
  version: string;
  scene: ProjectFile;
  animation: AnimSnapshot;
  /** Every composition's settings, keyed by id — not just the active tab's. */
  comps?: Record<string, CompositionSettings>;
  /** Every composition's time domain, keyed by composition id. */
  timelines?: Record<string, SerializedTimeline>;
  /** Render-affecting; must round-trip or exports change after a reload. */
  motionBlur?: MotionBlurSettings;
  guides?: GuidesSettings;
  /** Legacy: single active comp. Read on restore, no longer written. */
  comp?: CompositionSettings;
}

/** Snapshot every authored subsystem into one self-contained document. */
export function captureDocument(): EditorDocument {
  return {
    version: '1.1.0',
    scene: sceneProjectIO.capture(),
    animation: defaultAnimation.snapshot(),
    comps: structuredClone(useProjectStore.getState().comps),
    timelines: getTimelineController().capture(),
    motionBlur: useMotionBlurStore.getState().settings(),
    guides: useGuidesStore.getState().settings(),
  };
}

/**
 * Restore all subsystems from a full document. Tolerant of partial documents.
 *
 * This is the ONE place a foreign document becomes live state — the bundle path
 * (BundleRepository → decodeBundle), local version history (VersionStore), the
 * cloud API and legacy single-file reads all arrive here. That is why the
 * version migration runs at the top: it covers every entry point with one call,
 * and it throws BEFORE the first subsystem restore, so a document this build
 * cannot understand fails whole rather than half-populating the scene graph.
 */
export function restoreDocument(doc: EditorDocument): void {
  if (!doc) return;

  // Throws DocumentVersionError for a newer-than-us document or an uncovered
  // version gap. Deliberately not caught here — the caller must surface it, as
  // silently opening an empty project is indistinguishable from losing the work.
  const migrated = migrateDocument(doc);
  doc = migrated;

  // Scene first: the timeline reconciles its clips against the node tree, and
  // comps must exist before the timeline reads their frame rate.
  if (doc.scene) sceneProjectIO.restore(doc.scene);
  if (doc.animation) defaultAnimation.restore(doc.animation);

  if (doc.comps) {
    useProjectStore.getState().actions.replaceComps(doc.comps);
  } else if (doc.comp) {
    // v1.0.0 documents carried only the active comp. updateComp upserts, so
    // this applies whether or not the seeded default already claims the id.
    useProjectStore.getState().actions.updateComp(doc.comp.id, doc.comp);
  }

  if (doc.timelines) getTimelineController().restore(doc.timelines);
  if (doc.motionBlur) useMotionBlurStore.getState().restore(doc.motionBlur);
  if (doc.guides) useGuidesStore.getState().restore(doc.guides);
}
