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
 * Like Rename / Hide / Solo, this is a direct scene mutation + bumpScene —
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

/** Curated medium, eye-relaxing pastel/matte label palette. */
export const LABEL_COLORS: ReadonlyArray<LabelColor> = [
  { id: 'slate',      label: 'Slate Blue',     color: '#5282b8' },
  { id: 'teal',       label: 'Sage Teal',      color: '#4ea885' },
  { id: 'coral',      label: 'Warm Coral',     color: '#d0705a' },
  { id: 'lavender',   label: 'Soft Lavender',  color: '#8b75c8' },
  { id: 'steel',      label: 'Steel Blue',     color: '#5692a8' },
  { id: 'amber',      label: 'Muted Amber',    color: '#b87e4c' },
  { id: 'olive',      label: 'Soft Olive',     color: '#7b9c6a' },
  { id: 'magenta',    label: 'Muted Magenta',  color: '#a86b96' },
  { id: 'aqua',       label: 'Dusty Aqua',     color: '#4b9e99' },
  { id: 'terracotta', label: 'Terracotta',     color: '#a2775f' },
  { id: 'royal',      label: 'Soft Royal',     color: '#587db8' },
  { id: 'coolgray',   label: 'Cool Slate',     color: '#7d8ca3' },
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
export function matchLabelColor(
  nodes: ReadonlyArray<SceneNode>,
  color: string | undefined,
): string[] {
  return nodes.filter((n) => readNodeLabelColor(n) === color).map((n) => n.id);
}

/**
 * Ids of every node carrying the same label colour as `nodeId`, in scene order.
 *
 * Backs "Select All with This Label". `undefined` is a real match, not a gap in
 * the query — sweeping up the UNLABELLED layers is exactly as useful as
 * sweeping up the red ones, and is how you find what you forgot to tag.
 *
 * Returns [] when the node is gone rather than throwing: a context menu is
 * built from a snapshot and the scene can move underneath it.
 */
export function nodesWithLabelColor(nodeId: string): string[] {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return [];
  const all: SceneNode[] = [];
  defaultSceneGraph.traverse((n) => all.push(n));
  return matchLabelColor(all, readNodeLabelColor(node));
}

export function setNodeLabelColor(nodeIds: string | ReadonlyArray<string>, color: string | undefined): void {
  const ids = typeof nodeIds === 'string' ? [nodeIds] : nodeIds;
  let changed = false;
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    if (!node) continue;
    node.color = color;
    changed = true;
  }
  if (changed) {
    bumpScene();
  }
}
