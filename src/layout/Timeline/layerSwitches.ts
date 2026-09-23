/**
 * The timeline's Collapse / Quality / Frame Blending switches, and Select
 * Label Group.
 *
 * The first three are now thin wrappers over `@core/scene/layerFlags`, which is
 * where every AE layer switch lives. They used to be the only three that wrote
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
 * (B3), labelled as the legacy `toggleLayerFlags` labelled it.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { LayerSwitchesPatch } from '@motion/engine-api';
import {
  collapseSwitchKind as collapseKindOf,
  layerFlagAvailable,
  layerFlagDef,
  readLayerFlag,
  type LayerFlag,
} from '@core/scene/layerFlags';
import { nextQuality, readNodeQuality, type LayerQuality } from '@core/effects/layerQuality';
import { nodesWithLabelColor } from '@core/scene/labelColor';
import { edit } from '@core/engine/uiEdits';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';

const QUALITY_LABEL: Readonly<Record<LayerQuality, string>> = {
  best: 'Quality: Best',
  draft: 'Quality: Draft',
  wireframe: 'Quality: Wireframe',
};

/**
 * One timeline switch on one layer through the engine (the three below).
 * Unavailable → the same one-line refusal `toggleLayerFlags` showed.
 */
function setSwitch(nodeId: string, flag: 'collapse' | 'quality' | 'frameBlend', next: boolean | LayerQuality): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const def = layerFlagDef(flag as LayerFlag);
  if (!layerFlagAvailable(node, flag)) {
    useUIStore.getState().notify({ level: 'warning', message: `${def.label} isn't available for that layer`, durationMs: 2600 });
    return;
  }
  const patch: LayerSwitchesPatch =
    flag === 'quality' ? { quality: next as LayerQuality }
      : flag === 'frameBlend' ? { frameBlend: next ? 'frameMix' : 'off' }
        : { collapse: next as boolean };
  const label = typeof next === 'string' ? QUALITY_LABEL[next] : `${next ? 'Enable' : 'Disable'} ${def.label}`;
  void edit(label, { type: 'setLayerSwitches', layers: [nodeId], patch });
}

export type CollapseSwitchKind = 'collapse' | 'raster';

/** What the sunburst means on this layer, or null when it means nothing. */
export const collapseSwitchKind = collapseKindOf;

export function readCollapseSwitch(node: SceneNode): boolean {
  return readLayerFlag(node, 'collapse');
}

export function toggleCollapseSwitch(nodeId: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  setSwitch(nodeId, 'collapse', !readLayerFlag(node, 'collapse'));
}

/** Layers with pixels to sample: everything but the chrome-only kinds. */
export function qualitySwitchAvailable(node: SceneNode | undefined): boolean {
  return !!node && layerFlagAvailable(node, 'quality');
}

/** Advance the Quality switch one position: Best → Draft → Wireframe → Best. */
export function toggleQualitySwitch(nodeId: string): LayerQuality | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const next = nextQuality(readNodeQuality(node));
  setSwitch(nodeId, 'quality', next);
  return next;
}

/** Frame blending only means something on a layer with source frames. */
export function frameBlendSwitchAvailable(node: SceneNode | undefined): boolean {
  return !!node && layerFlagAvailable(node, 'frameBlend');
}

export function readFrameBlendSwitch(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && readLayerFlag(node, 'frameBlend');
}

/** Off → Frame Mix; any mode → Off (AE's switch cycles the same way). */
export function toggleFrameBlendSwitch(nodeId: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  setSwitch(nodeId, 'frameBlend', !readLayerFlag(node, 'frameBlend'));
}

/** AE's label menu "Select Label Group": every layer carrying this label. */
export function selectLabelGroup(nodeId: string): string[] {
  const ids = nodesWithLabelColor(nodeId);
  if (ids.length > 0) useSelectionStore.getState().set(ids);
  return ids;
}
