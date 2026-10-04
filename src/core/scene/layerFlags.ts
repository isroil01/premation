/**
 * layerFlags — the AE switch column as ONE set of verbs.
 *
 * The eight switches AE puts beside a layer (shy, collapse/rasterize, quality,
 * fx, frame blend, motion blur, adjustment, guide, preserve transparency, 3D)
 * each write somewhere different: some are node props, some are effect-stack
 * state, two need a second gate turned on with them, and one — `shy` — is view
 * state with no render meaning at all. That knowledge was written out inline in
 * `App.tsx`'s `onTrackToggleFlag`, which is where the TIMELINE happens to
 * render its switches. Anything else that wanted the same switch had to copy
 * it, and two things already had: `CompositingSection` and `SelectionHeader`
 * each re-derive the motion-blur / adjustment pair.
 *
 * So the verbs live here, beside the scene graph they write, and the panels
 * render buttons over them. A switch the Scene tree offers and the timeline
 * offers are then the same switch — not two that agree today.
 *
 * Three questions per flag, and each has one answer here:
 *   • `readLayerFlag`      — is it on for this node?
 *   • `layerFlagAvailable` — can this KIND carry it at all? (3D on a camera
 *     cannot, frame blending on a shape cannot — AE greys those out rather
 *     than lighting an icon that changes no pixel)
 *   • `toggleLayerFlag`    — flip it, with the feedback the flag needs.
 *
 * `toggleLayerFlag` does NOT open a history entry: it is a builder for
 * off-document callers (an importer). The panels send engine commands — the
 * anchored multi-layer toggle is layout/Scene/layerSwitchEdits.ts
 * `toggleLayerFlagsEdit`, one entry for the whole set.
 */

import { readNodeKind } from './sceneDerive';
import {   supportsContinuousRaster } from './continuousRaster';
import {  readNodeQuality,  type LayerQuality } from '@core/effects/layerQuality';
import type { SceneNode } from '@core/types';

/** Every switch this module speaks. */
export type LayerFlag =
  | 'shy'
  | 'collapse'
  | 'quality'
  | 'fxEnabled'
  | 'frameBlend'
  | 'motionBlur'
  | 'adjustment'
  | 'guide'
  | 'preserveTransparency'
  | 'threeD';

/** How a row draws one switch for one layer. */
export interface LayerFlagFace {
  label: string;
  title: string;
  icon?: string;
  glyph?: string;
}

export interface LayerFlagDef {
  id: LayerFlag;
  /** Accessible name and menu label. */
  label: string;
  /** Icon when the flag is ON; `glyph` instead for the ones AE draws as text. */
  icon?: string;
  glyph?: string;
  /** Long-form tooltip, shown on the switch. */
  title: string;
  /**
   * Not an on/off flag but a cycle through more than two positions — Quality
   * is Best → Draft → Wireframe → Best. `readLayerFlag` still answers "is it
   * off its default", which is what a lit switch means; `describe` says which
   * position it is actually in.
   */
  cycles?: boolean;
  /**
   * What this switch is called ON THIS LAYER, when that is not fixed. Two of
   * them are not: AE's sunburst is Collapse Transformations on a placed comp
   * and Continuous Rasterize on a vector layer, and Quality names its current
   * position. Absent means the static fields above apply to every layer.
   */
  describe?: (node: SceneNode) => LayerFlagFace;
}

/** The three positions of the Quality switch, as AE draws them. */
export const QUALITY_FACE: Readonly<Record<LayerQuality, LayerFlagFace>> = {
  best: { label: 'Quality: Best', title: 'Quality: Best — click for Draft', glyph: '/' },
  draft: { label: 'Quality: Draft', title: 'Quality: Draft — click for Wireframe', glyph: '\\' },
  wireframe: {
    label: 'Quality: Wireframe',
    title: 'Quality: Wireframe (viewport only — exports as Best) — click for Best',
    glyph: '□',
  },
};

/** The sunburst's two names: Collapse Transformations on a placed comp, Continuous Rasterize on a vector layer. */
export const COLLAPSE_FACE: Readonly<Record<'collapse' | 'raster', LayerFlagFace>> = {
  collapse: { label: 'Collapse Transformations', title: 'Collapse Transformations', icon: 'star' },
  raster: { label: 'Continuous Rasterize', title: 'Continuous Rasterize', icon: 'star' },
};

/** What AE's single sunburst means on this layer, or null when it means nothing. */
export function collapseSwitchKind(node: SceneNode | undefined): 'collapse' | 'raster' | null {
  if (!node) return null;
  if (readNodeKind(node) === 'comp') return 'collapse';
  if (supportsContinuousRaster(node)) return 'raster';
  return null;
}

/**
 * The switches, in AE's column order. The Scene panel renders a SUBSET of this
 * (the user picks which, see `sceneViewStore`); the timeline renders all of it.
 * One list, so the two panels cannot end up offering different switches.
 */
export const LAYER_FLAGS: readonly LayerFlagDef[] = [
  { id: 'shy', label: 'Shy', icon: 'shy', title: 'Shy — hidden while "Hide Shy Layers" is on' },
  {
    id: 'collapse',
    label: 'Collapse Transformations',
    icon: 'star',
    title: 'Collapse Transformations / Continuous Rasterize',
    // ONE switch, one meaning per layer type — see `collapseSwitchKind`. It is
    // the reason this def needs `describe`: calling it "Collapse
    // Transformations" on a text layer would name something that layer cannot do.
    describe: (node) => COLLAPSE_FACE[collapseSwitchKind(node) === 'collapse' ? 'collapse' : 'raster'],
  },
  {
    id: 'quality',
    label: 'Quality',
    glyph: '/',
    title: 'Quality: Best / Draft / Wireframe',
    cycles: true,
    describe: (node) => QUALITY_FACE[readNodeQuality(node)],
  },
  { id: 'fxEnabled', label: 'Effects', glyph: 'fx', title: 'Toggle Effects (fx)' },
  { id: 'frameBlend', label: 'Frame Blending', icon: 'video', title: 'Frame Blending' },
  { id: 'motionBlur', label: 'Motion Blur', icon: 'motion-blur', title: 'Toggle Motion Blur' },
  { id: 'adjustment', label: 'Adjustment Layer', icon: 'adjustment', title: 'Toggle Adjustment Layer' },
  { id: 'guide', label: 'Guide Layer', icon: 'frame', title: 'Guide layer — visible while editing, omitted from export' },
  {
    id: 'preserveTransparency',
    label: 'Preserve Underlying Transparency',
    glyph: 'T',
    title: 'Preserve Underlying Transparency — visible only where layers beneath are opaque',
  },
  { id: 'threeD', label: '3D Layer', icon: '3d', title: 'Toggle 3D Layer' },
];

const FLAG_BY_ID = new Map(LAYER_FLAGS.map((f) => [f.id, f]));

export function layerFlagDef(flag: LayerFlag): LayerFlagDef {
  const def = FLAG_BY_ID.get(flag);
  /* istanbul ignore next — the type makes this unreachable from TypeScript. */
  if (!def) throw new Error(`unknown layer flag: ${flag}`);
  return def;
}

/** How this switch should be drawn and named for this layer. */
export function describeLayerFlag(node: SceneNode, flag: LayerFlag): LayerFlagFace {
  const def = layerFlagDef(flag);
  if (def.describe) return def.describe(node);
  return { label: def.label, title: def.title, icon: def.icon, glyph: def.glyph };
}
