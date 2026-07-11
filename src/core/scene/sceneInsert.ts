/**
 * sceneInsert — shared "add a primitive to the composition" action, so the
 * insert controls can live anywhere (top tool bar, command palette, …) without
 * each call site re-implementing the node factory.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP, type SceneKind } from './seedDefaultScene';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';

let seq = 0;

/** Build a fresh scene node of `kind` with sensible default components. */
function makeNode(kind: SceneKind, name: string): SceneNode {
  const id = `${kind}_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const transform = { position: { x: 160, y: 120 }, rotation: 0, scale: { x: 1, y: 1 } };
  const components: SceneNode['components'] =
    kind === 'text'
      ? [
          { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 160, y: 120, rotation: 0 } },
          { id: `${id}_c`, type: 'Text', props: { content: 'Text', fontSize: 32, opacity: 100 } },
        ]
      : kind === 'group'
        ? [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: kind } }]
        : [
            { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 160, y: 120, rotation: 0 } },
            { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
          ];
  return { id, name, parent: null, children: [], transform, visible: true, locked: false, components };
}

/** Insert a primitive at the composition root, select it, and refresh the UI. */
export function insertPrimitive(kind: SceneKind, name: string): void {
  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
  const node = makeNode(kind, name);
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}
