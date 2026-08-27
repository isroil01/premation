/**
 * Deleting a layer, in one place.
 *
 * There were two answers to "delete this layer" and they did different things:
 *
 *   • The Scene tree and the Del key called `deleteSelectedLayers`, which
 *     removes the SCENE NODE. The layer goes, and stays gone.
 *   • The timeline's clip context menu called `Timeline.removeLayer`, which
 *     removes the CLIP BAR and nothing else. The scene node survived, so the
 *     row stayed in the timeline with no bar on it — and the moment anything
 *     triggered `syncFromScene`, the reconciler saw a node with no clip and
 *     seeded it a fresh full-length bar. The layer came back.
 *
 * Reported as: "none of them completely delete the layer — if you delete from
 * the left sidebar it deletes, but from the timeline row it does not."
 *
 * So there is one primitive now, and both routes call it.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import type { SceneNode } from '@core/types';

/**
 * Remove a layer and everything that belongs to it: its descendants, and the
 * animation of the whole subtree.
 *
 * Animation is cleared SUBTREE-FIRST, because `removeNode` takes the
 * descendants with it and their ids are unreachable afterwards. Without that,
 * every deleted layer left orphan tracks riding every autosave forever — and a
 * future layer that happened to mint the same id would inherit a stranger's
 * keyframes.
 *
 * Returns false when the node does not exist, is locked, or is a root (a
 * composition root is not a layer and must not be deletable as one).
 */
export function deleteLayerNode(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || node.locked || node.parent === null || node.parent === undefined) return false;

  const stack: SceneNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    defaultAnimation.clearNode(n.id);
    for (const childId of n.children) {
      const child = defaultSceneGraph.getNode(childId);
      if (child) stack.push(child);
    }
  }
  defaultSceneGraph.removeNode(nodeId);
  return true;
}
