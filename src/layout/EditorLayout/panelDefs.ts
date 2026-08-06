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
import { pluginPanelDef } from '@layout/Plugins/pluginPanelDefs';

export interface PanelDef {
  id: string;
  title: string;
  icon: IconName;
  region: RegionId;
  weight: number;
  closable: boolean;
  /** Registered, then closed on a fresh session — opened via menu/shortcut. */
  onDemand?: boolean;
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
export const PANEL_DEFS: readonly PanelDef[] = [
  // ── Left sidebar ─────────────────────────────────────────────────
  { id: 'scene',       title: 'Scene',     icon: 'layers',      region: 'leftSidebar', weight: 10,  closable: false },
  { id: 'assets',      title: 'Assets',    icon: 'image',       region: 'leftSidebar', weight: 8,   closable: false },
  { id: 'library',     title: 'Library',   icon: 'component',   region: 'leftSidebar', weight: 6,   closable: false },
  // Server edition only — see PANEL_AVAILABILITY. The local (OSS) edition does
  // not ship the assistant, so the panel is absent from the registry rather than
  // rendered empty: a tab that opens onto "not available in this edition" is a
  // worse answer than no tab. `getAllPanelRenderers` drops the renderer too.
  { id: 'ai',          title: 'AI',        icon: 'ai',          region: 'leftSidebar', weight: 4,   closable: false },
  { id: 'project',     title: 'Project',   icon: 'folder-open', region: 'leftSidebar', weight: 3,   closable: true, onDemand: true },
  // The marketplace. Distinct from the `plugins` panel in the right inspector,
  // which HOSTS the interfaces plugins provide — this one is where you find,
  // install and manage them. Two different jobs that were easy to conflate
  // under one name, so only this one is titled "Plugins".
  //
  // PERMANENT and NOT closable, like Scene and Assets. It shipped `onDemand`
  // first, which meant it did not exist until the user went to the menu bar and
  // asked for it — so finding a plugin required already knowing the panel was
  // there to be summoned. A marketplace nobody can see is not discoverable by
  // definition, and that is the one job it has.
  { id: 'marketplace', title: 'Plugins',   icon: 'plugin',      region: 'leftSidebar', weight: 5,   closable: false },
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
  { id: 'properties',  title: 'Properties', icon: 'sliders-h',  region: 'rightInspector', weight: 5,   closable: false },
  { id: 'rig',         title: 'Rigging',   icon: 'bone',        region: 'rightInspector', weight: 3.5, closable: false },
  // `magic-wand`, not `zap`: Lightning is the app's speed/quick-action glyph and
  // it was already carrying the Presets tab's meaning here. A tab icon that
  // names a different tab's job is worse than a generic one.
  { id: 'effects',     title: 'Effects',   icon: 'magic-wand',  region: 'rightInspector', weight: 3,   closable: false },
  // The graph editor + EXPRESSION editor. Its renderer has always existed in
  // getAllPanelRenderers, but it was never registered and nothing called
  // openPanel('motion') — so the entire expressions feature had no way in.
  { id: 'motion',      title: 'Graph',     icon: 'graph-value', region: 'rightInspector', weight: 1.4, closable: false },
  // Was `keyframe` — the same diamond the timeline draws on every animated
  // property, so the tab read as "keyframes" rather than "motion presets".
  { id: 'presets',     title: 'Presets',   icon: 'zap',         region: 'rightInspector', weight: 1,   closable: false },
  { id: 'history',     title: 'History',   icon: 'history',     region: 'rightInspector', weight: 0.8, closable: true, onDemand: true },
  // `closable: true` like every other on-demand panel. It was the one exception,
  // so PanelHeader drew no ✕ and the only way to dismiss it was F6 or the Window
  // menu — for a panel that opens on demand and is empty most of the time.
  { id: 'renderQueue', title: 'Render',    icon: 'queue',       region: 'rightInspector', weight: 0.7, closable: true, onDemand: true },
  // Third-party plugin UI — the SHARED host, for panels that did not ask for a
  // tab of their own (`placement: "shared"`, the default) or asked and found the
  // rail full. Panels that did get their own tab are registered dynamically from
  // `layout/Plugins/pluginPanelDefs.ts` and are not in this list.
  //
  // On demand because it is empty until a plugin with a panel is installed — it
  // opens itself when one calls `motion.ui.openPanel()`, when the user picks it
  // from the Plugins menu, or from the manager's Open button. Docked (not a
  // modal) because a plugin panel is for use WHILE dragging on the canvas, which
  // is the one thing a modal forbids.
  //
  // `closable: false`, like every plugin surface. It used to draw an ✕, which
  // offered to dismiss a container the user never opened and could only get back
  // from a menu — while the control that actually means "I do not want this",
  // the one that also stops the worker, is the toggle on the plugin's row in the
  // Plugins panel. The host still removes this panel on its own when the last
  // plugin panel goes away; what is gone is the button that pretended the user
  // was managing plugins by tidying their dock.
  { id: 'plugins',     title: 'Plugin Panels', icon: 'layout',  region: 'rightInspector', weight: 0.6, closable: false, onDemand: true },
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
  // Plugin panels that own a tab are not in the static list — they come and go
  // with what is installed. Resolving them here is what gives them a title, a
  // glyph and `closable: false` in the dock tab strip and in a pop-out window,
  // both of which look a panel up by id and neither of which knows about
  // plugins. `pluginPanelDefs` is imported for its VALUE, so this module must
  // only ever be imported by it as a TYPE — otherwise the cycle is real.
  const fromPlugin = pluginPanelDef(id);
  if (fromPlugin) return fromPlugin;
  return PANEL_DEFS.find((p) => p.id === id);
}
