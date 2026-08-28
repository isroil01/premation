import { getEventBus } from '@core/events/EventBus';
import { bumpSceneRevision } from '@stores/sceneStore';
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
  // ...and advance the scene REVISION, which is what every reader that is not
  // subscribed to this one prop rebuilds from.
  //
  // `NodeUpdated` reaches exactly the fields bound to (nodeId, componentId,
  // propName) — the inspector's own rows, and nothing else. Views that read the
  // scene during render are woken by the revision instead, so a write that only
  // emitted `NodeUpdated` left the timeline's expanded property rows frozen at
  // whatever they last drew: scrubbing Position in the timeline moved the layer
  // in the viewport and updated the inspector, while the number under the
  // pointer never changed. The viewport-drag path (`ports.moveNodes`) has
  // always bumped; this makes the two writers agree.
  //
  // Revision only, NOT `SceneGraphChanged`: nothing structural happened here —
  // see `bumpRevision` for why announcing one would both cost a full-scene
  // walk and split this single edit into two undo steps.
  bumpSceneRevision();
}

export default updateNodeComponentProp;
