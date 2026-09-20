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
 * `toggleLayerFlag` does NOT open a history entry: its callers are already
 * inside one (the timeline's handler bumps, the Scene panel wraps the whole
 * multi-layer toggle in a single `runDocumentEdit` so five layers is one undo).
 * `toggleLayerFlags` is that wrapper.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { readNodeKind } from './sceneDerive';
import { canBe3D, is3DEnabled, set3DEnabled } from './threeD';
import { isGuideLayer, toggleGuideLayer } from './guideLayer';
import { readNodeFxEnabled, setNodeFxEnabled } from '@core/effects/effects';
import { readNodeMotionBlur, setNodeMotionBlur } from '@core/effects/motionBlur';
import { readNodeAdjustment, setNodeAdjustment } from '@core/effects/adjustment';
import {
  readNodePreserveTransparency,
  setNodePreserveTransparency,
} from '@core/effects/preserveTransparency';
import {
  disableLayerMotionBlur,
  enableLayerMotionBlurWithFeedback,
  notifyGuideLayerChange,
  setAdjustmentWithFeedback,
} from '@core/effects/layerSwitchFeedback';
import { isPrecomp, setCompCollapse } from './precomp';
import { readCompCollapse } from './compInstance';
import { readContinuousRaster, setContinuousRaster, supportsContinuousRaster } from './continuousRaster';
import { getNodeLayerTime, updateNodeLayerTime } from './layerTime';
import { nextQuality, readNodeQuality, setNodeQuality, type LayerQuality } from '@core/effects/layerQuality';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { bumpScene } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
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
const QUALITY_FACE: Readonly<Record<LayerQuality, LayerFlagFace>> = {
  best: { label: 'Quality: Best', title: 'Quality: Best — click for Draft', glyph: '/' },
  draft: { label: 'Quality: Draft', title: 'Quality: Draft — click for Wireframe', glyph: '\\' },
  wireframe: {
    label: 'Quality: Wireframe',
    title: 'Quality: Wireframe (viewport only — exports as Best) — click for Best',
    glyph: '□',
  },
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
    describe: (node) => collapseSwitchKind(node) === 'collapse'
      ? { label: 'Collapse Transformations', title: 'Collapse Transformations', icon: 'star' }
      : { label: 'Continuous Rasterize', title: 'Continuous Rasterize', icon: 'star' },
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

/** Is the flag set on this node? */
export function readLayerFlag(node: SceneNode, flag: LayerFlag): boolean {
  switch (flag) {
    case 'threeD': return is3DEnabled(node);
    case 'guide': return isGuideLayer(node.id);
    case 'motionBlur': return readNodeMotionBlur(node) === true;
    case 'adjustment': return readNodeAdjustment(node) === true;
    case 'preserveTransparency': return readNodePreserveTransparency(node) === true;
    // fx is ON unless explicitly turned off — an empty stack still reads as
    // "effects enabled", which is what the timeline's `!== false` says too.
    case 'fxEnabled': return readNodeFxEnabled(node) !== false;
    // View state, stored on the node because that is where the timeline put it.
    case 'shy': return (node as { shy?: boolean }).shy === true;
    case 'collapse': {
      const kind = collapseSwitchKind(node);
      if (kind === 'collapse') return readCompCollapse(node);
      if (kind === 'raster') return readContinuousRaster(node);
      return false;
    }
    case 'frameBlend': return getNodeLayerTime(node.id).frameBlend !== 'none';
    // A cycling switch is "on" when it is off its default, which is what a lit
    // switch means to a reader scanning the column. `describe` says which of the
    // three positions it is actually in.
    case 'quality': return readNodeQuality(node) !== 'best';
  }
}

/** How this switch should be drawn and named for this layer. */
export function describeLayerFlag(node: SceneNode, flag: LayerFlag): LayerFlagFace {
  const def = layerFlagDef(flag);
  if (def.describe) return def.describe(node);
  return { label: def.label, title: def.title, icon: def.icon, glyph: def.glyph };
}

/**
 * Can this node carry the flag at all?
 *
 * Honest gating, the same rule the timeline's disabled dark-box buttons follow:
 * a switch that cannot change a pixel is refused rather than lit. Only 3D has a
 * kind restriction strong enough to hide the control (`canBe3D` covers groups,
 * nulls, cameras, lights, solids, particles and audio); the rest apply to any
 * layer, and a composition ROOT carries none of them — it is the document, not
 * a layer in it.
 */
export function layerFlagAvailable(node: SceneNode, flag: LayerFlag): boolean {
  if (node.parent === null) return false;
  switch (flag) {
    case 'threeD': return canBe3D(node);
    // The sunburst means nothing on a bitmap, a solid or a null.
    case 'collapse': return collapseSwitchKind(node) !== null;
    // Frame blending needs source frames to blend between.
    case 'frameBlend': return readNodeKind(node) === 'video' || isPrecomp(node);
    // Quality needs pixels to sample, so the chrome-only kinds have none.
    case 'quality':
      return !['null', 'camera', 'light', 'audio', 'group'].includes(readNodeKind(node)) || isPrecomp(node);
    default: return true;
  }
}

/**
 * Flip one flag on one node. No history entry and no `bumpScene` — see the
 * header; `toggleLayerFlags` is the undoable wrapper the panels call.
 *
 * Returns false when the flag was refused (3D on a kind that cannot project),
 * so a caller toggling a selection can report how many it skipped.
 */
export function toggleLayerFlag(
  nodeId: string,
  flag: LayerFlag,
  next?: boolean | LayerQuality,
): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;

  // Quality is the one switch whose "next" is not a boolean: it advances
  // Best → Draft → Wireframe → Best, and a multi-layer toggle passes the
  // anchor's new POSITION so the whole set lands on the same one.
  if (flag === 'quality') {
    if (!layerFlagAvailable(node, 'quality')) return false;
    const q = typeof next === 'string' ? next : nextQuality(readNodeQuality(node));
    setNodeQuality(nodeId, q);
    return true;
  }

  const on = typeof next === 'boolean' ? next : !readLayerFlag(node, flag);

  switch (flag) {
    case 'collapse': {
      const kind = collapseSwitchKind(node);
      if (!kind) return false;
      if (kind === 'collapse') setCompCollapse(nodeId, on);
      else setContinuousRaster(nodeId, on);
      return true;
    }

    case 'frameBlend':
      if (!layerFlagAvailable(node, 'frameBlend')) return false;
      updateNodeLayerTime(nodeId, { frameBlend: on ? 'mix' : 'none' });
      return true;

    case 'preserveTransparency':
      setNodePreserveTransparency(nodeId, on);
      return true;

    case 'guide':
      if (isGuideLayer(nodeId) !== on) toggleGuideLayer(nodeId);
      // Says what a guide layer IS, because nothing on screen changes when you
      // arm one — it stays visible in the viewer and vanishes only on export.
      notifyGuideLayerChange(on);
      return true;

    case 'threeD': {
      if (!canBe3D(node)) return false;
      set3DEnabled(nodeId, on);
      if (on) {
        notifyCameraTipIfMissing((message, level) =>
          useUIStore.getState().notify({ level, message, durationMs: 3200 }),
        );
      }
      return true;
    }

    case 'motionBlur':
      if (on) enableLayerMotionBlurWithFeedback(nodeId, setNodeMotionBlur);
      else disableLayerMotionBlur(nodeId, setNodeMotionBlur);
      return true;

    case 'adjustment':
      setAdjustmentWithFeedback(nodeId, on, setNodeAdjustment);
      return true;

    case 'fxEnabled':
      setNodeFxEnabled(nodeId, on);
      return true;

    case 'shy':
      // Timeline-only state with no render meaning, so it is written straight
      // onto the node rather than into a component the renderer reads.
      (node as { shy?: boolean }).shy = on;
      return true;
  }
}

/**
 * Flip a flag across several layers as ONE undo step, anchored on `anchorId`.
 *
 * Anchored the way every other multi-layer switch in this app is: the state the
 * clicked row is in decides the direction for the whole set, so a mixed
 * selection resolves to "make them all match this one" rather than "invert each
 * of them" — which is what the label on the button already promised.
 *
 * Reports refusals once rather than per layer: selecting twelve layers and
 * hitting 3D when four are cameras should say so in one line.
 */
export function toggleLayerFlags(
  ids: ReadonlyArray<string>,
  flag: LayerFlag,
  anchorId?: string,
): void {
  const targets = ids.filter((id) => {
    const n = defaultSceneGraph.getNode(id);
    return !!n && layerFlagAvailable(n, flag);
  });
  const refused = ids.length - targets.length;
  if (targets.length === 0) {
    if (refused > 0) notifyRefused(flag, refused);
    return;
  }

  const anchor = defaultSceneGraph.getNode(
    anchorId && targets.includes(anchorId) ? anchorId : targets[0]!,
  );
  if (!anchor) return;

  const def = layerFlagDef(flag);
  // A cycling switch has no "on"/"off" to name: the anchor advances one
  // position and the rest of the set lands on the SAME one, so twelve layers
  // end up at Draft together rather than each one position further round.
  const next: boolean | LayerQuality = def.cycles
    ? nextQuality(readNodeQuality(anchor))
    : !readLayerFlag(anchor, flag);

  // Named after the position it is moving TO, not the one it is leaving —
  // `describeLayerFlag` reads the CURRENT state, which is the wrong end of the
  // edit for an undo label.
  const verb = typeof next === 'string'
    ? QUALITY_FACE[next].label
    : `${next ? 'Enable' : 'Disable'} ${def.label}`;
  const label = targets.length === 1 ? verb : `${verb} (${targets.length} layers)`;

  runDocumentEdit(label, () => {
    for (const id of targets) toggleLayerFlag(id, flag, next);
    bumpScene();
  });

  if (refused > 0) notifyRefused(flag, refused);
}

function notifyRefused(flag: LayerFlag, count: number): void {
  const def = layerFlagDef(flag);
  useUIStore.getState().notify({
    level: 'warning',
    message: count === 1
      ? `${def.label} isn't available for that layer`
      : `${def.label} isn't available for ${count} of the selected layers`,
    durationMs: 2600,
  });
}

/** Kind of the node, for callers that want to explain a refusal. */
export function layerFlagRefusalReason(node: SceneNode, flag: LayerFlag): string | null {
  if (layerFlagAvailable(node, flag)) return null;
  if (node.parent === null) return 'A composition has no layer switches';
  return `${layerFlagDef(flag).label} isn't available for ${readNodeKind(node)} layers`;
}
