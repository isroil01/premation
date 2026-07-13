/**
 * Auto-orient (Prompt E4) — a layer flagged auto-orient rotates to face its
 * direction of travel along the motion path. Stored as a boolean on the layer's
 * `fx` component; buildSnapshot reads it and overrides the layer rotation with
 * the velocity heading (see motionPath.autoOrientAngleDeg).
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

/** True when the layer auto-orients along its motion path. */
export function isAutoOriented(node: SceneNode): boolean {
  const fx = node.components.find((c) => c.type === 'fx');
  return (fx?.props as Record<string, unknown> | undefined)?.autoOrient === true;
}

/** Read a node's auto-orient flag by id (buildSnapshot convenience). */
export function readNodeAutoOrient(node: SceneNode): boolean {
  return isAutoOriented(node);
}

/** Turn auto-orient on/off for a layer. */
export function setAutoOriented(nodeId: string, on: boolean): void {
  defaultSceneGraph.setAutoOrient(nodeId, on || undefined);
  bumpScene();
}
