/**
 * Adjustment layers (Prompt 5 — GPU compositing, feature 4).
 *
 * An adjustment layer doesn't draw its own content — instead its effect stack
 * (the CSS filter buildSnapshot already compiles) applies to the composite of
 * everything beneath it within the composition. The flag lives on the layer's
 * `fx` component alongside its effects.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

export function readNodeAdjustment(node: SceneNode): boolean {
  const fx = node.components.find((c) => c.type === 'fx');
  return fx?.props.isAdjustment === true;
}

export function getNodeAdjustment(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeAdjustment(node) : false;
}

export function setNodeAdjustment(nodeId: string, on: boolean): void {
  defaultSceneGraph.setAdjustment(nodeId, on ? true : undefined);
  getEventBus().emit('AnimationChanged', { nodeId });
}
