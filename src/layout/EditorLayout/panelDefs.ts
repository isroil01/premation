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
  { id: 'ai',          title: 'AI',        icon: 'ai',          region: 'leftSidebar', weight: 4,   closable: false },
  { id: 'project',     title: 'Project',   icon: 'folder-open', region: 'leftSidebar', weight: 3,   closable: true, onDemand: true },
  // ── Right inspector ──────────────────────────────────────────────
  { id: 'properties',  title: 'Transform', icon: 'move',        region: 'rightInspector', weight: 5,   closable: false },
  { id: 'style',       title: 'Style',     icon: 'brush',       region: 'rightInspector', weight: 4,   closable: false },
  { id: 'rig',         title: 'Rigging',   icon: 'bone',        region: 'rightInspector', weight: 3.5, closable: false },
  { id: 'effects',     title: 'Effects',   icon: 'zap',         region: 'rightInspector', weight: 3,   closable: false },
  // The graph editor + EXPRESSION editor. Its renderer has always existed in
  // getAllPanelRenderers, but it was never registered and nothing called
  // openPanel('motion') — so the entire expressions feature had no way in.
  { id: 'motion',      title: 'Graph',     icon: 'graph-value', region: 'rightInspector', weight: 1.4, closable: false },
  { id: 'presets',     title: 'Presets',   icon: 'keyframe',    region: 'rightInspector', weight: 1,   closable: false },
  { id: 'misc',        title: 'Settings',  icon: 'settings',    region: 'rightInspector', weight: 0,   closable: false },
  { id: 'history',     title: 'History',   icon: 'history',     region: 'rightInspector', weight: 0.8, closable: true, onDemand: true },
  { id: 'renderQueue', title: 'Render',    icon: 'queue',       region: 'rightInspector', weight: 0.7, closable: true, onDemand: true },
  // Review comments anchored to a layer + time. The panel, its ReviewBar and
  // commentsStore formed a closed island referenced by nothing — a built feature
  // with no way in. On-demand so it does not crowd the rail by default.
  { id: 'comments',    title: 'Comments',  icon: 'marker',      region: 'rightInspector', weight: 0.6, closable: true, onDemand: true },
];

export function panelDef(id: string): PanelDef | undefined {
  return PANEL_DEFS.find((p) => p.id === id);
}
