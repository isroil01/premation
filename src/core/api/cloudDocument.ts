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
import { useProjectStore, type CompositionSettings, type SerializedWorkspaceTabs } from '@stores/projectStore';
import { withoutTimelineView } from '@core/project/editorView';
import { useMotionBlurStore, type MotionBlurSettings } from '@stores/motionBlurStore';
import { useGuidesStore, type GuidesSettings } from '@stores/guidesStore';
import { useColorManagementStore, type ColorManagementSettings } from '@stores/colorManagementStore';
import { useSwatchStore, type ProjectSwatch } from '@stores/swatchStore';
import { useMaterialStore, type NamedMaterial } from '@stores/materialStore';
import { useTransitionStore } from '@stores/transitionStore';
import type { TransitionRecord } from '@core/timeline/transitionModel';
import type { ProjectFile } from '@core/types';
import type { SerializedTimeline } from '@motion/timeline';
import { migrateDocument } from '@core/project/migrations';
import { rebindAssetSrcs } from '@core/scene/assetRebind';
import {
  useAssetStore,
  captureProjectItems,
  applyProjectItems,
  legacyProjectItems,
  type ProjectItemsDocument,
} from '@stores/assetStore';
import { captureDocumentExtras, restoreDocumentExtras, type DocumentExtras } from '@core/project/documentExtras';

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
  /** Project working space, display transform, intermediate bit depth. */
  colorManagement?: ColorManagementSettings;
  /**
   * The project's named colour swatches, in the user's order.
   *
   * Authored state, so it belongs to the file rather than the machine: a
   * palette kept in preferences would be the previous project's palette the
   * moment a second file opened. Optional, so every document written before
   * swatches existed reads back unchanged — absent means "keep", and
   * `projectDocumentIO.createEmpty` states an empty palette explicitly so File ▸
   * New Project does not inherit the last one's.
   */
  swatches?: ProjectSwatch[];
  /**
   * The project's named 3D materials, in the user's order.
   *
   * Authored state on exactly the same terms as `swatches`: a library that
   * followed the app rather than the file would be the previous project's
   * library the moment a second file opened. Only USER materials are written —
   * the built-in six come from the style-preset registry at runtime, and
   * freezing them into every document would mean each file carried a snapshot
   * of a registry that has already changed twice.
   */
  materials?: NamedMaterial[];
  /**
   * Per-cut transitions, keyed by composition id.
   *
   * Authored state that is NOT recoverable from what it produces: the overlap
   * and the opacity ramps a cross dissolve leaves behind are indistinguishable
   * from a hand-built overlap and a hand-drawn fade, so a document that carried
   * only the result would reopen with four transitions that could no longer be
   * selected, lengthened or removed. Each record also carries the exact state
   * the cut held BEFORE it was applied, which is what makes removal after a
   * reload possible at all.
   *
   * Optional, so every document written before transitions existed reads back
   * unchanged — absent means "keep", exactly as `swatches` and `timelines` do,
   * and `projectDocumentIO.createEmpty` states an empty map explicitly so File ▸
   * New Project does not inherit the last one's.
   */
  transitions?: Record<string, TransitionRecord[]>;
  /**
   * LEGACY plugin blocks (the JavaScript plugin system is gone — G2, not
   * ported): the plugins a document's custom layers depended on, and
   * plugin-owned per-document storage. Carried through a load → save
   * unchanged, never read.
   */
  plugins?: unknown[];
  pluginStorage?: Record<string, Record<string, string>>;
  /**
   * LEGACY (read, never written since B4): open composition tabs (which
   * precomps are open, which is active, playhead per tab). Editor state — it
   * now lives beside the file (core/project/editorView.ts). A document that
   * still carries it restores it once, so an existing project opens where it
   * was left; an absent key means "keep".
   */
  openTabs?: SerializedWorkspaceTabs;
  /** Legacy: single active comp. Read on restore, no longer written. */
  comp?: CompositionSettings;
  /**
   * Folders + per-footage organisation (folder, interpretation, label, tags,
   * comment). Was localStorage-only (ENGINE_API.md §2.5 #12). Absent = the
   * document predates items: restore migrates them from the frozen copy of
   * that cache (`legacyProjectItems`). Every save path carries it — the bundle
   * in `project.json` (bundleCodec), everything else as this field.
   */
  projectItems?: ProjectItemsDocument;
  /** Engine-API project settings (bit depth, time display, …) when not default. */
  projectSettings?: DocumentExtras['projectSettings'];
  /** The render queue as saved with the project (AE), when not empty. */
  renderQueue?: DocumentExtras['renderQueue'];
}

/** Snapshot every authored subsystem into one self-contained document. */
export function captureDocument(): EditorDocument {
  const ws = useProjectStore.getState();
  // B4: no editor state in the document — open tabs, the playhead and each
  // timeline's zoom/scroll are kept per project file on this machine instead
  // (core/project/editorView.ts). Documents written before still carry them
  // and restore still reads them (the migration); the next save drops them.
  const timelines: Record<string, SerializedTimeline> = {};
  for (const [id, t] of Object.entries(getTimelineController().capture())) timelines[id] = withoutTimelineView(t);
  return {
    version: '1.1.0',
    scene: sceneProjectIO.capture(),
    animation: defaultAnimation.snapshot(),
    comps: structuredClone(ws.comps),
    timelines,
    motionBlur: useMotionBlurStore.getState().settings(),
    guides: useGuidesStore.getState().settings(),
    colorManagement: useColorManagementStore.getState().settings(),
    swatches: useSwatchStore.getState().list(),
    materials: useMaterialStore.getState().list(),
    transitions: useTransitionStore.getState().capture(),
    // The legacy plugin blocks, exactly as the document that was opened had them.
    ...(restoredPluginBlocks.plugins ? { plugins: restoredPluginBlocks.plugins } : {}),
    ...(restoredPluginBlocks.pluginStorage ? { pluginStorage: restoredPluginBlocks.pluginStorage } : {}),
    // Always present, even empty: its ABSENCE marks a document written before
    // items existed, which restore migrates from the pre-document cache.
    projectItems: captureProjectItems(),
    // Absent when default, same rule as `pluginStorage` above.
    ...captureDocumentExtras(),
  };
}

/**
 * The legacy plugin blocks of the document last restored (see `plugins` /
 * `pluginStorage` on EditorDocument): written back unchanged by capture,
 * cleared on every restore so a document never inherits the previous one's.
 */
let restoredPluginBlocks: Pick<EditorDocument, 'plugins' | 'pluginStorage'> = {};

/** Footage ids the document's layers point at (`assetId`, audio `__assetId`). */
function referencedAssetIdsOf(doc: EditorDocument): Set<string> {
  const ids = new Set<string>();
  for (const node of doc.scene?.nodes ?? []) {
    for (const c of node.components ?? []) {
      const props = (c.props ?? {}) as Record<string, unknown>;
      for (const key of ['assetId', '__assetId']) {
        const v = props[key];
        if (typeof v === 'string' && v) ids.add(v);
      }
    }
  }
  return ids;
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
/** F2: depth of `restoreDocument` calls in progress (engineDocumentStores.ts ignores the store writes they make). */
let restoreDepth = 0;

/**
 * True while `restoreDocument` is writing the page stores. With the engine as
 * owner a restore is the page REPLICA catching up, never a user edit — the
 * store→engine write-through (src/stores/engineDocumentStores.ts) skips it.
 */
export function isRestoringDocument(): boolean {
  return restoreDepth > 0;
}

export function restoreDocument(doc: EditorDocument): void {
  if (!doc) return;
  restoreDepth += 1;
  try {
    restoreDocumentNow(doc);
  } finally {
    restoreDepth -= 1;
  }
}

function restoreDocumentNow(doc: EditorDocument): void {

  // Throws DocumentVersionError for a newer-than-us document or an uncovered
  // version gap. Deliberately not caught here — the caller must surface it, as
  // silently opening an empty project is indistinguishable from losing the work.
  const migrated = migrateDocument(doc);
  doc = migrated;

  // The legacy plugin blocks ride through unchanged (assigned unconditionally).
  // Empty scopes are dropped, as the C++ engine's docio does (is_scope_store).
  const storage = Object.fromEntries(Object.entries(doc.pluginStorage ?? {}).filter(
    ([, scope]) => scope && typeof scope === 'object' && Object.keys(scope).length > 0,
  ));
  restoredPluginBlocks = {
    ...(Array.isArray(doc.plugins) && doc.plugins.length > 0 ? { plugins: doc.plugins } : {}),
    ...(Object.keys(storage).length > 0 ? { pluginStorage: storage } : {}),
  };

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

  // Timelines are stated whole too: a document that carries none (a project
  // created from settings on the dashboard, an old export) gets fresh ones
  // seeded from its comps' own rate and duration on first access — never the
  // previous project's.
  if (doc.timelines) getTimelineController().restore(doc.timelines);
  else if (doc.comps || doc.comp) getTimelineController().reset();
  if (doc.openTabs) useProjectStore.getState().actions.hydrateWorkspaceTabs(doc.openTabs);
  if (doc.motionBlur) useMotionBlurStore.getState().restore(doc.motionBlur);
  if (doc.guides) useGuidesStore.getState().restore(doc.guides);
  if (doc.colorManagement) useColorManagementStore.getState().restore(doc.colorManagement);
  if (doc.swatches) useSwatchStore.getState().restore(doc.swatches);
  if (doc.materials) useMaterialStore.getState().restore(doc.materials);
  // Present-but-empty is meaningful ("this project has no transitions"), so the
  // guard is on the KEY, not on the map's size — a document that states an
  // empty map must clear the previous project's records rather than keep them.
  if (doc.transitions) useTransitionStore.getState().restore(doc.transitions);

  // The document's media srcs are object URLs from whichever session WROTE it
  // — dead on arrival by definition. Repoint them at the live library by
  // assetId (see assetRebind.ts). Assets may still be hydrating at boot; the
  // asset store runs the same rebind when hydration lands, so whichever
  // finishes second completes the repair.
  rebindAssetSrcs(useAssetStore.getState().assets);

  // Project items and engine-API extras: stated whole by the document (absent
  // = none / default), so a project never inherits the previous one's.
  //
  // A document with no `projectItems` predates them (or came through a path
  // that used to drop them): its organisation lived in this machine's
  // localStorage, so it is migrated from the frozen copy of that cache here —
  // the next save writes it into the document, and from then on the cache is
  // never consulted for this project again (`legacyProjectItems`).
  applyProjectItems(doc.projectItems ?? legacyProjectItems(referencedAssetIdsOf(doc)));
  restoreDocumentExtras({
    ...(doc.projectSettings ? { projectSettings: doc.projectSettings } : {}),
    ...(doc.renderQueue ? { renderQueue: doc.renderQueue } : {}),
  });

  // A cloud open never emits ProjectLoaded, so the missing-font watcher would
  // not run; ask directly, deferred like the watcher so web fonts can register.
  // Dynamic import keeps core/api free of a static dependency on the UI layer.
  setTimeout(() => {
    void import('@layout/Text/missingFontsWatcher').then((m) => m.checkMissingFonts()).catch(() => {});
  }, 400);
}
