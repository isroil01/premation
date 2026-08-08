/**
 * Preserve Underlying Transparency — AE's per-layer "T" switch.
 *
 * The layer is visible ONLY where what is already composited beneath it is
 * opaque. A logo set over a shaped backdrop clips itself to that shape without
 * a track matte, a duplicate, or a mask that has to be kept in sync.
 *
 * ## It is NOT a blend mode, and modelling it as one would be a mistake
 *
 * The obvious cheap implementation is to append it to `LayerBlendMode` and give
 * it an `advancedBlendId`. That is wrong: in AE this is an independent switch
 * that composes WITH the blend mode, and folding it into the mode enum makes
 * "Multiply **and** Preserve Transparency" unrepresentable — a state users
 * actually want, and one they currently express with two layers. So it is its
 * own boolean on the `fx` component, sibling to `blendMode`, and rides the same
 * History / autosave / export capture for free.
 *
 * ## What it does to the composite, derived rather than guessed
 *
 * The BLEND_COMBINE shader already computes the Porter-Duff `source-over` line
 *
 *     co = as·(1−ad)·cs + as·ad·B + (1−as)·ad·cb
 *     ao = as + ad − as·ad
 *
 * where `B` is the blended colour. Preserve Underlying Transparency is
 * `source-atop`: the source only exists inside the backdrop's coverage, and it
 * cannot ADD coverage. That is
 *
 *     co = ad·( as·B + (1−as)·cb )
 *     ao = ad
 *
 * Checked at the three points that matter, on paper, before any code:
 *
 *   ad = 1 (opaque backdrop)     → co = as·B + (1−as)·cb, ao = 1  — unchanged
 *   ad = 0 (nothing beneath)     → co = 0, ao = 0                 — invisible
 *   ad = 0.5, as = 1, B = cs     → co = 0.5·cs, ao = 0.5          — shows at 50%
 *
 * The third is the one that rules out the tempting shortcut of scaling `as` by
 * `ad` and leaving the standard line alone: that yields ao = 0.75, i.e. the
 * layer ADDS opacity where it is supposed to be clipped by it.
 *
 * ## Why it forces the backdrop-sampling path
 *
 * `ad` is the accumulated alpha beneath the layer, which only the BLEND_COMBINE
 * route has. So a layer with this switch on is routed exactly like an advanced
 * blend — including when its blend mode is Normal, which is the common case.
 * `bChan` falls through to `return cs` for mode 0, so Normal composites
 * correctly through the combine without a special case.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

/** Read the switch off a node. Absent / non-boolean = off. */
export function readNodePreserveTransparency(node: SceneNode): boolean {
  const fx = node.components.find((c) => c.type === 'fx');
  return fx?.props.preserveTransparency === true;
}

export function getNodePreserveTransparency(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodePreserveTransparency(node) : false;
}

export function setNodePreserveTransparency(nodeId: string, on: boolean): void {
  // Stored as `undefined` when off rather than `false`, so an untouched project
  // does not grow a field and a round-trip stays byte-identical.
  defaultSceneGraph.setFxKey(nodeId, 'preserveTransparency', on ? true : undefined);
  // Compositing changed → the same refresh signal a blend-mode edit sends.
  getEventBus().emit('AnimationChanged', { nodeId });
}
