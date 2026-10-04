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

import {  type AnimSnapshot } from '@motion/animation';
import {  type CompositionSettings, type SerializedWorkspaceTabs } from '@stores/projectStore';
import {  type MotionBlurSettings } from '@stores/motionBlurStore';
import {  type GuidesSettings } from '@stores/guidesStore';
import {  type ColorManagementSettings } from '@stores/colorManagementStore';
import {  type ProjectSwatch } from '@stores/swatchStore';
import {  type NamedMaterial } from '@stores/materialStore';
import type { TransitionRecord } from '@core/timeline/transitionModel';
import type { ProjectFile } from '@core/types';
import type { SerializedTimeline } from '@motion/timeline';
import {
  
  
  
  
  type ProjectItemsDocument,
} from '@stores/assetStore';
import {   type DocumentExtras } from '@core/project/documentExtras';

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
