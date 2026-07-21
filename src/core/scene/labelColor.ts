/**
 * Per-layer label colors (AE-style).
 *
 * The color is stored as `node.color` on the scene-graph node view, which the
 * SceneGraph backs by the engine node's `custom.labelColor` — so it survives
 * the view cache, is captured/restored by sceneProjectIO, and every reader of
 * `node.color` (Scene rows, timeline track headers, clip bars) picks it up on
 * the next scene revision. Clearing (undefined) falls back to the layer kind's
 * default category color (KIND_COLOR / KIND_FILL in sceneDerive).
 *
 * Like Rename / Hide / Solo, this is a direct scene mutation + bumpScene() —
 * intentionally not routed through the undo stack (same policy as those ops).
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

export interface LabelColor {
  id: string;
  label: string;
  color: string;
}

/** The classic AE label palette (fixed swatches, hex — Canvas-safe). */
export const LABEL_COLORS: ReadonlyArray<LabelColor> = [
  { id: 'red',      label: 'Red',      color: '#d5493d' },
  { id: 'orange',   label: 'Orange',   color: '#e08a3a' },
  { id: 'yellow',   label: 'Yellow',   color: '#e6c74c' },
  { id: 'green',    label: 'Green',    color: '#4faf4e' },
  { id: 'seafoam',  label: 'Sea Foam', color: '#79b39a' },
  { id: 'aqua',     label: 'Aqua',     color: '#3fc1c9' },
  { id: 'blue',     label: 'Blue',     color: '#4a7fe0' },
  { id: 'lavender', label: 'Lavender', color: '#a08fd1' },
  { id: 'purple',   label: 'Purple',   color: '#8a63d2' },
  { id: 'pink',     label: 'Pink',     color: '#ef86b5' },
  { id: 'peach',    label: 'Peach',    color: '#eb9a71' },
  { id: 'brown',    label: 'Brown',    color: '#996f4d' },
  { id: 'gray',     label: 'Gray',     color: '#9e9e9e' },
];

/** Pure read — the node's explicit label color, or undefined for kind default. */
export function readNodeLabelColor(node: SceneNode): string | undefined {
  return node.color;
}

/** Read a node's label color from the default scene graph by id. */
export function getNodeLabelColor(nodeId: string): string | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeLabelColor(node) : undefined;
}

/**
 * Set (or clear, with undefined) the label color on one or more nodes and
 * bump the scene revision so every projection (Scene tree, timeline tracks,
 * clip bars) re-derives.
 */
export function setNodeLabelColor(nodeIds: string | ReadonlyArray<string>, color: string | undefined): void {
  const ids = typeof nodeIds === 'string' ? [nodeIds] : nodeIds;
  let changed = false;
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    if (!node) continue;
    node.color = color;
    changed = true;
  }
  if (changed) bumpScene();
}
