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
import { useMotionBlurStore, type MotionBlurSettings } from '@stores/motionBlurStore';
import { useGuidesStore, type GuidesSettings } from '@stores/guidesStore';
import { useColorManagementStore, type ColorManagementSettings } from '@stores/colorManagementStore';
import { useSwatchStore, type ProjectSwatch } from '@stores/swatchStore';
import { useMaterialStore, type NamedMaterial } from '@stores/materialStore';
import { useTransitionStore, type TransitionRecord } from '@core/timeline/transitionStore';
import type { ProjectFile } from '@core/types';
import type { SerializedTimeline } from '@motion/timeline';
import { migrateDocument } from '@core/project/migrations';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { usePluginStore } from '@stores/pluginStore';
import { collectPluginReferences, type DocumentPluginReference } from '@core/plugins/customLayers';
import { migratePluginBindings } from '@core/plugins/bindingMigration';
import { captureProjectStorage, restoreProjectStorage } from '@core/plugins/pluginStorage';
import { rebindAssetSrcs } from '@core/scene/assetRebind';
import { useAssetStore } from '@stores/assetStore';
import type { SceneNode } from '@core/types';

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
   * The plugins this document's custom layers depend on.
   *
   * New in Track B, and the reason it exists is the invariant it replaces:
   * documents never used to reference plugins at all. Now one can, so a
   * document has to be able to SAY which — otherwise the editor can tell a user
   * "this layer needs a plugin" and not which plugin, and an id alone is not
   * enough to explain a missing dependency or to fetch it.
   *
   * Derived from the document's CONTENTS at capture time, never from what
   * happens to be installed. A project saved on a machine that is missing the
   * plugin must still list it — that machine is exactly the one whose user
   * needs to be told.
   *
   * Optional, so every document written before this reads back unchanged and
   * needs no migration: absent and empty both mean "no custom layers".
   */
  plugins?: DocumentPluginReference[];
  /**
   * Plugin-owned state that belongs to this DOCUMENT.
   *
   * Plugin id → key → serialised value. Written by `storage.set('project', …)`,
   * bounded at 256 KB per plugin, and carried wherever the file goes — which is
   * the point: "which layer is this plugin's spine bone" is useless without the
   * layers it names.
   *
   * Retained for a plugin that is NOT installed. Opening a project on a machine
   * that lacks the plugin and saving it must not destroy state that machine
   * cannot see; garbage collection is an explicit user action, never a side
   * effect of opening a file.
   *
   * Optional, so every document written before this reads back byte-identical.
   */
  pluginStorage?: Record<string, Record<string, string>>;
  /**
   * Open composition tabs (which precomps are open, which is active, playhead
   * per tab). Optional: an absent key means "keep" on restore, same as
   * `timelines`. New Project drops them via `resetProjectWorkspace`.
   */
  openTabs?: SerializedWorkspaceTabs;
  /** Legacy: single active comp. Read on restore, no longer written. */
  comp?: CompositionSettings;
}

/** Snapshot every authored subsystem into one self-contained document. */
export function captureDocument(): EditorDocument {
  const ws = useProjectStore.getState();
  const openTabs: SerializedWorkspaceTabs = {
    tabOrder: [...ws.tabOrder],
    activeTabId: ws.activeTabId,
    tabs: Object.fromEntries(
      Object.values(ws.tabs).map((t) => [
        t.id,
        {
          id: t.id,
          compositionId: t.compositionId,
          breadcrumbPath: [...t.breadcrumbPath],
          title: t.title,
          time: t.time,
          frame: t.frame,
        },
      ]),
    ),
  };
  return {
    version: '1.1.0',
    scene: sceneProjectIO.capture(),
    animation: defaultAnimation.snapshot(),
    comps: structuredClone(ws.comps),
    timelines: getTimelineController().capture(),
    motionBlur: useMotionBlurStore.getState().settings(),
    guides: useGuidesStore.getState().settings(),
    colorManagement: useColorManagementStore.getState().settings(),
    swatches: useSwatchStore.getState().list(),
    materials: useMaterialStore.getState().list(),
    transitions: useTransitionStore.getState().capture(),
    openTabs,
    ...(pluginReferences().length > 0 ? { plugins: pluginReferences() } : {}),
    // Absent when empty, so a document with no plugin state reads back
    // byte-identical — the same rule `plugins` follows above.
    ...(captureProjectStorage() ? { pluginStorage: captureProjectStorage() } : {}),
  };
}

/**
 * What the document last restored said about its plugins.
 *
 * The dependency block is DERIVED from the node tree at capture time, which is
 * what keeps it honest — but version and publisher cannot be derived, they can
 * only be looked up in the installed set or remembered. Remembering is this
 * map. Without it, opening a project on a machine that lacks the plugin and
 * saving it back erased the version the document already carried.
 *
 * Module-level because capture and restore have no other channel between them,
 * and cleared on restore so a document never inherits the previous one's.
 */
let restoredPluginRefs = new Map<string, { version?: string; publisher?: string }>();

/**
 * Which plugins this document depends on, read off the node tree.
 *
 * Version and publisher come from the INSTALLED copy when there is one, else
 * from what the document itself recorded, and are absent only when neither
 * knows — which still leaves the id, which is what `premation://plugin/<id>`
 * needs.
 */
function pluginReferences(): DocumentPluginReference[] {
  const nodes: SceneNode[] = [];
  const walk = (id: string): void => {
    const node = defaultSceneGraph.getNode(id);
    if (!node) return;
    nodes.push(node);
    for (const child of defaultSceneGraph.getChildren(id)) walk(child.id);
  };
  for (const root of defaultSceneGraph.getRoots()) walk(root.id);

  const installed = new Map(
    usePluginStore.getState().plugins.map((p) => [
      p.manifest.id,
      { version: p.manifest.version, ...(p.manifest.author ? { author: p.manifest.author } : {}) },
    ]),
  );
  return collectPluginReferences(nodes, installed, restoredPluginRefs);
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

  // Remember what this document said before anything derives a new answer.
  // Assigned unconditionally, so opening a document with no plugin block clears
  // the previous one's rather than leaking its versions into an unrelated save.
  restoredPluginRefs = new Map(
    (doc.plugins ?? []).map((p) => [
      p.id,
      {
        ...(p.version ? { version: p.version } : {}),
        ...(p.publisher ? { publisher: p.publisher } : {}),
      },
    ]),
  );

  // Assigned unconditionally, including for a document that carries none: a
  // project opened after one that had plugin state must not inherit it.
  restoreProjectStorage(doc.pluginStorage);

  // Scene first: the timeline reconciles its clips against the node tree, and
  // comps must exist before the timeline reads their frame rate.
  if (doc.scene) sceneProjectIO.restore(doc.scene);
  if (doc.animation) defaultAnimation.restore(doc.animation);

  /*
    Repair plugin bindings that reference their parent by NAME.

    Documents written before the id form existed carry
    `layer('Hero depth', 'plugin.focal')`, resolved every frame — so renaming
    that layer silently breaks every child. Rewritten once, here, after both
    the scene and the animation are in place (the rewrite needs to resolve
    names against the restored tree).

    Runs on every load and is idempotent: after the first pass there is nothing
    left matching, so it costs one regex over plugin-authored expressions.
  */
  migratePluginBindings();

  if (doc.comps) {
    useProjectStore.getState().actions.replaceComps(doc.comps);
  } else if (doc.comp) {
    // v1.0.0 documents carried only the active comp. updateComp upserts, so
    // this applies whether or not the seeded default already claims the id.
    useProjectStore.getState().actions.updateComp(doc.comp.id, doc.comp);
  }

  if (doc.timelines) getTimelineController().restore(doc.timelines);
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
}
