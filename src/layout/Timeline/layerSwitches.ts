/**
 * The timeline's Collapse / Quality / Frame Blending switches, and Select
 * Label Group.
 *
 * The first three follow `@core/scene/layerFlags`' rules (availability,
 * labels), which is where every AE layer switch is defined. They used to be the only three that wrote
 * through their own helpers rather than through App's `onTrackToggleFlag`,
 * which is exactly why the Layers panel could not offer them: there was no one
 * place that knew what the switch column IS. The reading and availability rules
 * below moved with them; what stays here is the timeline's own vocabulary
 * (`CollapseSwitchKind`) and Select Label Group, which is not a switch.
 *
 * ── One sunburst, two meanings ─────────────────────────────────────────────
 * AE draws a single switch in this column and gives it one meaning per layer
 * type: on a placed composition it is Collapse Transformations, on a vector
 * layer (text, shapes, SVG) it is Continuous Rasterization. The inspector's
 * PrecompControl already models it exactly so; this reads and writes the same
 * props, so the two surfaces cannot disagree. Layers where neither means
 * anything (bitmaps, solids, nulls) get no switch.
 *
 * ── Quality ────────────────────────────────────────────────────────────────
 * Best → Draft → Wireframe → Best, AE's cycle. Draft is honoured end to end
 * (`RenderLayer.quality` → nearest-neighbour sampling, see `layerQuality.ts`).
 * Wireframe is viewport-only: the interactive hosts pass
 * `SnapshotComp.wireframeLayers`, which hides the layer's pixels, and the
 * overlay painter strokes its oriented box. Output paths never pass the flag,
 * so export renders a wireframe layer as Best.
 *
 * Every write is one undo step: a `setLayerSwitches` through the engine API
 * (B3), labelled as the legacy `toggleLayerFlags` labelled it. Every read —
 * which switches a layer has, where they stand — is the document MIRROR's
 * (B4: `LayerInfo.switches`, `@core/mirror/layerSwitchFacts`), read at call time.
 */

import type { LayerQuality, LayerSwitchesPatch } from '@motion/engine-api';
import { nextQuality } from '@core/effects/layerQuality';
import {
  frameBlendOn,
  mirrorCollapseSwitchKind,
  mirrorLayersWithLabel,
  mirrorSwitchAvailable,
  type MirrorSwitch,
} from '@core/mirror/layerSwitchFacts';
import { documentMirror } from '@stores/documentMirror';
import { edit } from '@core/engine/uiEdits';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';

const QUALITY_LABEL: Readonly<Record<LayerQuality, string>> = {
  best: 'Quality: Best',
  draft: 'Quality: Draft',
  wireframe: 'Quality: Wireframe',
};

/** The switch's name, as `layerFlags.LAYER_FLAGS` labels it (refusals and undo labels). */
const SWITCH_LABEL: Readonly<Record<MirrorSwitch, string>> = {
  collapse: 'Collapse Transformations',
  quality: 'Quality',
  frameBlend: 'Frame Blending',
};

/**
 * One timeline switch on one layer through the engine (the three below).
 * Unavailable → the same one-line refusal `toggleLayerFlags` showed.
 */
function setSwitch(nodeId: string, flag: MirrorSwitch, next: boolean | LayerQuality): void {
  const m = documentMirror();
  if (!m.layer(nodeId)) return;
  const name = SWITCH_LABEL[flag];
  if (!mirrorSwitchAvailable(m, nodeId, flag)) {
    useUIStore.getState().notify({ level: 'warning', message: `${name} isn't available for that layer`, durationMs: 2600 });
    return;
  }
  const patch: LayerSwitchesPatch =
    flag === 'quality' ? { quality: next as LayerQuality }
      : flag === 'frameBlend' ? { frameBlend: next ? 'frameMix' : 'off' }
        : { collapse: next as boolean };
  const label = typeof next === 'string' ? QUALITY_LABEL[next] : `${next ? 'Enable' : 'Disable'} ${name}`;
  void edit(label, { type: 'setLayerSwitches', layers: [nodeId], patch });
}

export type CollapseSwitchKind = 'collapse' | 'raster';

/** What the sunburst means on this layer, or null when it means nothing. */
export function collapseSwitchKind(nodeId: string): CollapseSwitchKind | null {
  return mirrorCollapseSwitchKind(documentMirror(), nodeId);
}

export function readCollapseSwitch(nodeId: string): boolean {
  return documentMirror().layer(nodeId)?.switches.collapse === true;
}

export function toggleCollapseSwitch(nodeId: string): void {
  const layer = documentMirror().layer(nodeId);
  if (!layer) return;
  setSwitch(nodeId, 'collapse', !layer.switches.collapse);
}

/** Layers with pixels to sample: everything but the chrome-only kinds. */
export function qualitySwitchAvailable(nodeId: string): boolean {
  return mirrorSwitchAvailable(documentMirror(), nodeId, 'quality');
}

/** The layer's Quality switch position. */
export function readQualitySwitch(nodeId: string): LayerQuality {
  return documentMirror().layer(nodeId)?.switches.quality ?? 'best';
}

/** Advance the Quality switch one position: Best → Draft → Wireframe → Best. */
export function toggleQualitySwitch(nodeId: string): LayerQuality | null {
  const layer = documentMirror().layer(nodeId);
  if (!layer) return null;
  const next = nextQuality(layer.switches.quality);
  setSwitch(nodeId, 'quality', next);
  return next;
}

/** Frame blending only means something on a layer with source frames. */
export function frameBlendSwitchAvailable(nodeId: string): boolean {
  return mirrorSwitchAvailable(documentMirror(), nodeId, 'frameBlend');
}

export function readFrameBlendSwitch(nodeId: string): boolean {
  return frameBlendOn(documentMirror().layer(nodeId));
}

/** Off → Frame Mix; any mode → Off (AE's switch cycles the same way). */
export function toggleFrameBlendSwitch(nodeId: string): void {
  const layer = documentMirror().layer(nodeId);
  if (!layer) return;
  setSwitch(nodeId, 'frameBlend', !frameBlendOn(layer));
}

/** AE's label menu "Select Label Group": every layer carrying this label. */
export function selectLabelGroup(nodeId: string): string[] {
  const ids = mirrorLayersWithLabel(documentMirror(), nodeId);
  if (ids.length > 0) useSelectionStore.getState().set(ids);
  return ids;
}
