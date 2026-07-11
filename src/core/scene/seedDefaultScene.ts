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

import type { SceneNode, Transform } from '../types';
import defaultSceneGraph from './DefaultSceneGraph';

/** Scene node "kind" — mirrored into the tree for icon selection. */
export type SceneKind = 'group' | 'shape' | 'text' | 'image' | 'video';

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

  const nodes: SceneNode[] = [
    {
      id: 'comp_root',
      name: 'Composition',
      parent: null,
      children: ['shape_circle', 'shape_rect', 'text_hello', 'img_logo', 'vid_bg'],
      transform: transform(0, 0),
      visible: true,
      locked: false,
      components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
    },
    {
      id: 'shape_circle',
      name: 'Circle',
      parent: 'comp_root',
      children: [],
      transform: transform(120, 80),
      visible: true,
      locked: false,
      components: [
        { id: 'shape_circle_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 120, y: 80, rotation: 0 } },
        { id: 'shape_circle_s', type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
      ],
    },
    {
      id: 'shape_rect',
      name: 'Rectangle',
      parent: 'comp_root',
      children: [],
      transform: transform(260, 140),
      visible: true,
      locked: false,
      components: [
        { id: 'shape_rect_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 260, y: 140, rotation: 15 } },
        { id: 'shape_rect_s', type: 'Style', props: { opacity: 80, fill: '#28c7d7' } },
      ],
    },
    {
      id: 'text_hello',
      name: 'Hello',
      parent: 'comp_root',
      children: [],
      transform: transform(80, 220),
      visible: true,
      locked: false,
      components: [
        { id: 'text_hello_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 80, y: 220, rotation: 0 } },
        { id: 'text_hello_c', type: 'Text', props: { content: 'Hello', fontSize: 48, opacity: 100 } },
      ],
    },
    {
      id: 'img_logo',
      name: 'logo.png',
      parent: 'comp_root',
      children: [],
      transform: transform(320, 60),
      visible: true,
      locked: false,
      components: [
        { id: 'img_logo_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'image', x: 320, y: 60, rotation: 0 } },
        { id: 'img_logo_s', type: 'Style', props: { opacity: 100 } },
      ],
    },
    {
      id: 'vid_bg',
      name: 'background.mp4',
      parent: 'comp_root',
      children: [],
      transform: transform(0, 0),
      visible: true,
      locked: false,
      components: [
        { id: 'vid_bg_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'video', x: 0, y: 0, rotation: 0 } },
        { id: 'vid_bg_s', type: 'Style', props: { opacity: 60 } },
      ],
    },
  ];

  for (const n of nodes) defaultSceneGraph.addNode(n);
  seeded = true;
}

export default seedDefaultScene;
