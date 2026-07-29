/**
 * Seed the default scene graph with a small starter composition.
 *
 * This is temporary demo content that stands in for a real project load.
 * It exists so the Scene panel and the Inspector have live data to drive:
 * selecting a node shows its real, editable component props (routed through
 * the PropertyRegistry editors) instead of an empty "No node data" state.
 *
 * When a real Project engine lands, it will replace this by loading nodes
 * from a ProjectFile — the UI (ScenePanel / NodeInspector) won't change.
 */

import type { Transform } from '../types';
import defaultSceneGraph from './DefaultSceneGraph';

/** Scene node "kind" — mirrored into the tree for icon selection. */
export type SceneKind = 'group' | 'null' | 'shape' | 'text' | 'image' | 'video' | 'svg' | 'audio' | 'camera' | 'light' | 'adjustment' | 'particle' | 'comp';

/** Stored on each node so the UI can pick an icon without guessing. */
export const SCENE_KIND_PROP = '__kind';

function transform(x: number, y: number): Transform {
  return { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } };
}

let seeded = false;

/** Populate the default scene graph once. Safe to call repeatedly. */
export function seedDefaultScene(): void {
  if (seeded || defaultSceneGraph.size > 0) {
    seeded = true;
    return;
  }

  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: transform(0, 0),
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  });

  seeded = true;
}

export default seedDefaultScene;
