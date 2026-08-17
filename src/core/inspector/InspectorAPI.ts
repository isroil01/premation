import { getEventBus } from '@core/events/EventBus';
import type { ID } from '@core/types';
import { SceneGraph } from '@core';

export function updateNodeComponentProp(
  sceneGraph: SceneGraph,
  nodeId: ID,
  componentId: ID,
  propName: string,
  value: unknown,
): void {
  // Data lives in the engine's typed components; route the write there. The
  // loose `components[].props` shape is a computed view, so writing it would be
  // dropped — `writeProp` maps the flat key onto the typed component.
  if (!sceneGraph.writeProp(nodeId, componentId, propName, value)) return;
  // Emit node updated event
  getEventBus().emit('NodeUpdated', { nodeId, componentId, propName, value });
}

export default updateNodeComponentProp;

