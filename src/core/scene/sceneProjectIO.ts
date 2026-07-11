/**
 * sceneProjectIO — bridges the ProjectManager to the scene graph document.
 *
 * Pure with respect to the UI: it only reads/writes the scene graph. The UI
 * refreshes by listening for ProjectLoaded/ProjectUnloaded on the EventBus and
 * bumping its own revision — this module never imports a store.
 */

import type { ProjectDocumentIO } from '@core/project/ProjectManager';
import type { ProjectFile, SceneNode } from '@core/types';
import defaultSceneGraph from './DefaultSceneGraph';

function clearGraph(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

export const sceneProjectIO: ProjectDocumentIO = {
  createEmpty: () => ({ version: '1.0.0', nodes: [] }),

  capture: () => {
    const nodes: SceneNode[] = [];
    defaultSceneGraph.traverse((n) => nodes.push(n));
    return { version: '1.0.0', nodes };
  },

  restore: (file: ProjectFile) => {
    clearGraph();
    for (const node of file.nodes ?? []) defaultSceneGraph.addNode(node);
  },
};
