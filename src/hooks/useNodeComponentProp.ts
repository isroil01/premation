import { useEffect, useState, useCallback } from 'react';
import { getEventBus } from '@core/events/EventBus';
import type { AppEventPayloads } from '@core/events/EventTypes';
import type SceneGraph from '@core/scene/SceneGraph';
import type { ID } from '@core/types';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';

export function useNodeComponentProp(
  sceneGraph: SceneGraph,
  nodeId: ID | undefined,
  componentId: ID | undefined,
  propName: string,
): [unknown, (v: unknown) => void] {
  const read = useCallback(() => {
    if (!nodeId || !componentId) return undefined;
    const node = sceneGraph.getNode(nodeId);
    if (!node) return undefined;
    const comp = node.components.find((c) => c.id === componentId);
    if (!comp) return undefined;
    return comp.props ? (comp.props as Record<string, unknown>)[propName] : undefined;
  }, [sceneGraph, nodeId, componentId, propName]);

  const [value, setValue] = useState<unknown>(read);

  useEffect(() => {
    setValue(read());
    const handler = (payload: AppEventPayloads['NodeUpdated']) => {
      if (payload.nodeId !== nodeId) return;
      if (payload.componentId !== componentId) return;
      if (payload.propName !== propName) return;
      setValue(payload.value);
    };
    const onSceneChanged = () => {
      setValue(read());
    };
    const sub1 = getEventBus().on('NodeUpdated', handler);
    const sub2 = getEventBus().on('SceneGraphChanged', onSceneChanged);
    return () => {
      sub1.dispose();
      sub2.dispose();
    };
  }, [nodeId, componentId, propName, read]);

  const setProp = useCallback((v: unknown) => {
    if (!nodeId || !componentId) return;
    if (updateNodeComponentProp(sceneGraph, nodeId, componentId, propName, v)) {
      setValue(v);
    }
  }, [sceneGraph, nodeId, componentId, propName]);

  return [value, setProp];
}

export default useNodeComponentProp;
