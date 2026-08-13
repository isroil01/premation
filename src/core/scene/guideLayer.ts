/**
 * Guide layers — visible while you work, absent from anything you deliver.
 *
 * AE's guide layer: reference material that belongs in the composition but not
 * in the output. Colour charts, safe-area overlays, a temp track to line
 * animation up against, a screenshot of the design you are matching.
 *
 * ## Where the flag lives, and why that is the whole design
 *
 * On the layer's `fx` component, as `guide: true`, through
 * `SceneGraph.setFx` — the same route as layer quality, corner pin and the
 * paint stack. That is not incidental: `setFx` is the graph's own mutator, so
 * undo/redo, autosave and project serialization pick the flag up with no extra
 * code, and a document written before guide layers existed simply has no key
 * and reads as `false`.
 *
 * Only `true` is stored. The default costs nothing on disk, and absence and
 * `false` cannot then disagree.
 *
 * ## Where the EXCLUSION lives
 *
 * Not here. `buildSnapshot` decides layer visibility in exactly one place, and
 * that is where a guide layer is dropped — see `SnapshotComp.forExport`. This
 * module owns the flag; the renderer owns what the flag means. Splitting it
 * the other way (a `shouldRender()` helper consulted by every caller) is the
 * §2·0 shape: several readers of one rule, agreeing only by attention.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

/** True when this layer is a guide — visible in the comp, never rendered out. */
export function readIsGuideLayer(node: SceneNode): boolean {
  const fx = node.components.find((c) => c.type === 'fx');
  return fx?.props.guide === true;
}

export function isGuideLayer(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readIsGuideLayer(node) : false;
}

export function setGuideLayer(nodeId: string, guide: boolean): void {
  // Only the non-default is stored, matching `setLayerQuality`.
  defaultSceneGraph.setGuideLayer(nodeId, guide ? true : undefined);
  getEventBus().emit('AnimationChanged', { nodeId });
}

export function toggleGuideLayer(nodeId: string): void {
  setGuideLayer(nodeId, !isGuideLayer(nodeId));
}
