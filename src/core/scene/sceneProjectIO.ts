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
import { SCENE_KIND_PROP } from './seedDefaultScene';

/** The default composition root every new/empty project needs — layers parent to
 *  it and the Scene panel shows it as "Composition 1". Without this a restored
 *  empty scene has no root, so inserting a layer silently fails. */
function defaultComposition(): SceneNode {
  return {
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  };
}

function clearGraph(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

export const sceneProjectIO: ProjectDocumentIO<ProjectFile> = {
  createEmpty: () => ({ version: '1.0.0', nodes: [defaultComposition()] }),

  capture: () => {
    const nodes: SceneNode[] = [];
    defaultSceneGraph.traverse((n) => {
      // Convert live AppNodeView into a POJO for serializability
      nodes.push({
        id: n.id,
        name: n.name,
        children: [...n.children],
        parent: n.parent,
        transform: JSON.parse(JSON.stringify(n.transform)),
        components: JSON.parse(JSON.stringify(n.components)),
        visible: n.visible,
        locked: n.locked,
        solo: n.solo,
        ...(n.color !== undefined ? { color: n.color } : {}),
      });
    });
    return { version: '1.0.0', nodes };
  },

  restore: (file: ProjectFile) => {
    clearGraph();
    const nodes = file.nodes ?? [];
    // Migrate legacy positional string mattes: if a node has fx.props.matte as a string,
    // convert to { mode: oldStr, sourceId: prevNode.id } so explicit source resolution works.
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const fx = node.components?.find((c) => c.type === 'fx');
      if (fx && typeof fx.props?.matte === 'string' && fx.props.matte !== 'none') {
        const prevNode = i > 0 ? nodes[i - 1] : undefined;
        if (prevNode) {
          fx.props.matte = { mode: fx.props.matte, sourceId: prevNode.id };
        }
      }
    }
    for (const node of nodes) defaultSceneGraph.addNode(node);
  },
};
