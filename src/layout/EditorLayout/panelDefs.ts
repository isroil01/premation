/**
 * The canonical panel registry — id, title, icon, region, weight.
 *
 * This lives in its own module because TWO renderers need it and only one used
 * to have it. `registerPanel` is called from `EditorShellInner`, but a
 * popped-out panel renders `PopoutRoute`, never `EditorShell` — so in a pop-out
 * window the layout store's `panels` map is empty. That is why a detached Scene
 * panel titled itself `scene` (the raw id), showed no icon, and could not tell
 * that it was already popped out.
 *
 * Titles here are also what the dock tab strip labels itself with, so they must
 * read as user-facing names, not ids.
 */

import type { IconName } from '@components/Icon';
import type { RegionId } from '@stores/layoutStore';
import { isPanelAvailable } from '@core/config/panelAvailability';

export interface PanelDef {
  id: string;
  title: string;
  icon: IconName;
  region: RegionId;
  weight: number;
  closable: boolean;
  /** Registered, then closed on a fresh session — opened via menu/shortcut. */
  onDemand?: boolean;
  /**
   * The rail label, when `title` is too long for the rail's one short line.
   * The tooltip and header still say `title`; this only spares the rail an
   * ellipsis that would cut "Effect Controls" to "Effect C…".
   */
  shortTitle?: string;
}

/**
 * Icons are deliberately all distinct GLYPHS, not just distinct names: several
 * icon names alias the same Phosphor component (`ai`, `sparkles` and `brain`
 * are all `Sparkle`; `sliders-h` is the settings glyph), and with icon-only
 * tabs two panels sharing a glyph are genuinely indistinguishable.
 */
/**
 * Removed as DUPLICATES (2026-07-25), not as features:
 *  - `flow` (left sidebar) was a second full cubic-bezier easing editor for the
 *    same keyframes as `motion`. It wrote through `easeClipboardStore` instead of
 *    the animation engine and only re-read its handles when `easing === 'bezier'`,
 *    so it displayed a stale curve after any preset applied elsewhere. Its one
 *    unique action (Copy/Paste Ease) now lives in `motion`.
 *  - `motiontools` (right inspector) was a shortcut board for six properties
 *    other panels own — 3D toggle, time remap, trim paths, precompose, anchor,
 *    label colour — and two of its writes were WRONG: the label colour assigned
 *    `node.color` directly instead of `setNodeLabelColor` (so it never
 *    serialized), and time remap keyframed at comp time instead of converting
 *    through `compToKeyframeTime`, which lands on the wrong frame for a trimmed
 *    or stretched layer. Its trim in/out already existed in three other places
 *    including Alt+[ / Alt+].
 */
/**
 * FEWER PERMANENT PANELS (2026-09-15). Array order is rail order.
 *
 * This file used to argue, panel by panel, that Transcript, Plugins, Swatches,
 * Scopes, Source and Audio must be permanent because "an on-demand panel is a
 * panel nobody finds". The sum of those arguments was a left rail of 7
 * unlabelled icons and a right rail of 14, which a user could only read by
 * hovering every one — and four of them duplicated another surface (Layers vs
 * the timeline's layer list, Effect Controls vs Effects, Graph vs the
 * timeline's Graph Editor, Info & Audio vs Audio). Discoverability by sheer
 * presence stopped working once everything was present.
 *
 * So the permanent set is now what nearly every session uses — Project,
 * Library and AI on the left, Properties and Audio on the right — and the
 * discoverability those arguments wanted comes from three places instead:
 * rails that print each panel's NAME, a "+" at the foot of each rail listing
 * that side's closed panels, and Window ▸ Panels. Specialised workspaces
 * (Animation, Color, Color & VFX) open the panels their job needs.
 *
 * Ids never change — saved workspaces and persisted layouts hold them — and
 * `layoutStore`'s LAYOUT_SCHEMA_VERSION drops an older persisted tab order once
 * so these defaults actually reach existing users.
 */
export const PANEL_DEFS: readonly PanelDef[] = [
  // ── Left sidebar ─────────────────────────────────────────────────
  // The Layers panel: hosts document compositions and the layer hierarchy tree.
  { id: 'scene',       title: 'Layers',    icon: 'layers',      region: 'leftSidebar', weight: 10,  closable: true },
  /**
   * The Assets panel: imported files, media browser, and asset management.
   * Dedicated to imported assets (images, video, audio).
   */
  { id: 'assets',      title: 'Assets',    icon: 'folder',      region: 'leftSidebar', weight: 8,   closable: false },
  { id: 'library',     title: 'Library',   icon: 'component',   region: 'leftSidebar', weight: 6,   closable: false },
  // Both editions — see PANEL_AVAILABILITY / `aiEnabled()`. Local runs BYOK;
  // server runs through the hosted gateway.
  { id: 'ai',          title: 'AI',        icon: 'ai',          region: 'leftSidebar', weight: 4,   closable: false },
  // AE's Effect Controls: the applied-effect stack for the selected layer. On
  // demand like AE's own — F3, Window ▸ Effect Controls, and every "edit this
  // effect" route (`revealEffectControls`, the Properties panel) open it.
  // `stopwatch` is the glyph AE uses on every animatable parameter in it.
  { id: 'effectControls', title: 'Effect Controls', shortTitle: 'Controls', icon: 'stopwatch', region: 'leftSidebar', weight: 9, closable: true, onDemand: true },
  /**
   * Text-based editing: the composition's spoken words, as chips you can seek
   * to, select in runs and DELETE — which cuts that time out of every layer and
   * closes the gap. Window ▸ Transcript and the Transcribe commands open it.
   *
   * `mic` because it is the only unclaimed glyph that names SPEECH. `type` is
   * the Text tab's, `audio` and `waves` name a waveform rather than words, and
   * `voice` aliases the same Phosphor component as `mic`.
   */
  { id: 'transcript',  title: 'Transcript', icon: 'mic',        region: 'leftSidebar', weight: 7,   closable: true, onDemand: true },
  // ── Right inspector ──────────────────────────────────────────────
  /**
   * Merged 2026-08-03: `style` (Style) and `misc` (Settings) folded into this
   * one panel. All three were an accordion of property sections for the
   * selected layer, so the split only ever made the user guess which tab owned
   * the property they wanted — and each carried its own search box that could
   * not see the other two. It is titled "Properties" rather than "Transform"
   * now, because transform is one section of it, not the whole thing.
   *
   * The panels below stay separate deliberately: they are editors and modes
   * (a curve graph, an effect stack, a rig, a render queue) rather than
   * properties of the current selection.
   */
  { id: 'properties',  title: 'Properties', icon: 'sliders-h',  region: 'rightInspector', weight: 5,    closable: false },
  { id: 'effects',     title: 'Effects',   icon: 'magic-wand',  region: 'rightInspector', weight: 4.8,  closable: true },
  { id: 'presets',     title: 'Presets',   icon: 'zap',         region: 'rightInspector', weight: 4.7,  closable: true },
  /**
   * Native SDK plugins: what the engine found in the plugins folder (loaded,
   * or failed with why) and the button that opens that folder. Where the old
   * Plugins (marketplace) tab lived; the JS plugin system and its registry
   * were removed in 0.9 and native plugins are installed by copying them in.
   * `plugins` was once the id of the JS plugin-panel host; a persisted layout
   * that still lists it now shows this panel, which is the right successor.
   */
  { id: 'plugins',     title: 'Plugins',   icon: 'plugin',      region: 'rightInspector', weight: 4.6,  closable: true },
  /**
   * AE's Audio panel (Ctrl+4): the master meter, the selected layer's level and
   * pan faders, and — since 2026-09-15 — the pointer / composition readout that
   * used to be a separate "Info & Audio" tab beside it (`InfoReadout`). Two
   * tabs that both drew a master meter was one too many.
   */
  { id: 'audio',       title: 'Audio',     icon: 'audio',       region: 'rightInspector', weight: 4.48, closable: false },
  // ── Right inspector, on demand (Window ▸ Panels, the rail's "+") ─────
  // Each of these is a specialist surface; the workspaces that need one open
  // it (Color → Scopes, Animation → Graph + Rigging).
  { id: 'character',   title: 'Text',      icon: 'type',        region: 'rightInspector', weight: 4.4,  closable: true, onDemand: true },
  { id: 'align',       title: 'Align',     icon: 'align-center', region: 'rightInspector', weight: 4.3, closable: true, onDemand: true },
  // The project palette. The swatches are document state and the colour picker
  // offers them wherever a colour is edited, so the panel is the bulk editor.
  { id: 'swatches',    title: 'Swatches',  icon: 'palette',     region: 'rightInspector', weight: 4.25, closable: true, onDemand: true },
  // The pointer / composition readout plus a simple master meter — the same
  // readout Audio now carries at its top, kept for layouts that want it alone.
  { id: 'info',        title: 'Info',      icon: 'info',        region: 'rightInspector', weight: 4.2,  closable: true, onDemand: true },
  // Video scopes: waveform, RGB parade, vectorscope, histogram. The Color
  // workspaces lead with it. `waves` is the one unclaimed glyph that reads as a
  // signal trace; `graph-value` / `graph-speed` are the Graph panel's.
  { id: 'scopes',      title: 'Scopes',    icon: 'waves',       region: 'rightInspector', weight: 4.15, closable: true, onDemand: true },
  { id: 'preview',     title: 'Preview',   icon: 'play',        region: 'rightInspector', weight: 4.1,  closable: true, onDemand: true },
  /**
   * The SOURCE viewer — one clip, before it is in the edit, with in/out points
   * and the four verbs that put the marked range into a comp. Every route that
   * hands it a clip (the Project panel's context menu, the footage dialog's
   * "Open in Source Monitor") goes through `openSourceMonitor`, which opens the
   * panel first — so on demand costs those routes nothing.
   *
   * `tv` because a monitor is what this is: `video` and `image` name media
   * KINDS, and `play` is the Preview panel's.
   */
  { id: 'sourceMonitor', title: 'Source',  icon: 'tv',          region: 'rightInspector', weight: 4.05, closable: true, onDemand: true },
  { id: 'tracker',     title: 'Tracker',   icon: 'crosshair',   region: 'rightInspector', weight: 4.0,  closable: true, onDemand: true },
  { id: 'rig',         title: 'Rigging',   icon: 'bone',        region: 'rightInspector', weight: 3.5,  closable: true, onDemand: true },
  // The graph + EXPRESSION editor. On demand beside the timeline's own Graph
  // Editor (Shift+G); the Animation and Motion Design workspaces open it.
  { id: 'motion',      title: 'Graph',     icon: 'graph-value', region: 'rightInspector', weight: 1.4,  closable: true, onDemand: true },
  { id: 'history',     title: 'History',   icon: 'history',     region: 'rightInspector', weight: 0.8,  closable: true, onDemand: true },
  // AE's Paint (Ctrl+8) and Brushes (Ctrl+9). On demand like AE's own: the
  // compact Tool Options bar covers everyday painting, and both commands plus
  // the Window menu open them (`layout/Paint/paintCommands.ts`).
  { id: 'paint',       title: 'Paint',     icon: 'brush',       region: 'rightInspector', weight: 0.78, closable: true, onDemand: true },
  { id: 'brushes',     title: 'Brushes',   icon: 'circle',      region: 'rightInspector', weight: 0.76, closable: true, onDemand: true },
  // `closable: true` like every other on-demand panel. It was the one exception,
  // so PanelHeader drew no ✕ and the only way to dismiss it was F6 or the Window
  // menu — for a panel that opens on demand and is empty most of the time.
  { id: 'renderQueue', title: 'Render',    icon: 'queue',       region: 'rightInspector', weight: 0.7, closable: true, onDemand: true },
  // The Export dialog's form, DOCKED — so a render can be queued while the
  // timeline is still the thing on screen. Same form component and the same
  // shared choices as the top-bar dialog (`exportFormStore`); the dialog stays
  // for the button. On demand (Window ▸ Export, `window.exportPanel`) because
  // the toolbar button is the discoverable route and a permanent tab would
  // duplicate it in the rail.
  { id: 'export',      title: 'Export',    icon: 'export',      region: 'rightInspector', weight: 0.65, closable: true, onDemand: true },
  // NOTE: there is deliberately no 'comments' panel. Review comments, the
  // approval flow and shareable review links were removed outright — not gated,
  // not hidden behind a plan. Collaboration is not what this app is for, and a
  // half-present feature is worse than an absent one.
];

/**
 * The panels this build actually has.
 *
 * Everything that REGISTERS or OFFERS a panel must read this rather than
 * `PANEL_DEFS` — registration, the Window menu, the workspace presets. Call it
 * at use time; caching the result in a module constant reintroduces exactly the
 * boot-order bug the `available` predicate exists to avoid.
 */
export function availablePanelDefs(): readonly PanelDef[] {
  return PANEL_DEFS.filter((p) => isPanelAvailable(p.id));
}

/**
 * Look up a panel by id, INCLUDING ones this edition does not offer.
 *
 * Deliberately unfiltered. This resolves the title and icon of a panel that is
 * already open — including in a pop-out window, which never runs the
 * registration effect — so a persisted layout from a server-edition build that
 * still lists `ai` renders a correctly-labelled panel instead of a raw id. The
 * gate belongs at the point of registration and offering, not at the point of
 * naming something already on screen.
 */
export function panelDef(id: string): PanelDef | undefined {
  return PANEL_DEFS.find((p) => p.id === id);
}
