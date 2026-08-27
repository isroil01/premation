/**
 * Freeze a layer well enough to put it back.
 *
 * Deleting a layer from the timeline has to be undoable, and the app's own
 * snapshot history cannot do it alone: `sceneProjectIO.capture()` covers the
 * scene and the animation but NOT the clip geometry (see
 * `TimelineController.capture`, the only route the time domain has into a
 * document). So a delete that crossed both domains would undo the scene half
 * and leave the bar's trim, position and stretch behind.
 *
 * This captures the layer's own half — node, components, place in the stack,
 * animation — and `TimelineController` restores the geometry beside it.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { snapshotNodeAnimation, applyNodeAnimation, type NodeAnimationSnapshot } from '@core/animation/cloneNodeAnimation';
import type { SceneNode } from '@core/types';

export interface LayerSnapshot {
  nodeId: string;
  /** Deep copy of the node and its descendants, parent-first. */
  nodes: Array<{ node: SceneNode; parent: string; index: number }>;
  /** Animation per node id, so a restored subtree keeps its motion. */
  animation: Record<string, NodeAnimationSnapshot>;
  /**
   * The bar's geometry, which no scene snapshot carries.
   *
   * Left at zero by `captureLayerSnapshot` and filled in by the caller: this
   * module knows the scene, and only the timeline controller knows the clip.
   */
  clip: { start: number; end: number };
}

/**
 * Capture `nodeId` and everything under it.
 *
 * Parent-first ordering matters on restore: a child cannot be added under a
 * parent that is not back yet.
 */
export function captureLayerSnapshot(nodeId: string): LayerSnapshot {
  const nodes: LayerSnapshot['nodes'] = [];
  const animation: Record<string, NodeAnimationSnapshot> = {};

  const visit = (id: string): void => {
    const node = defaultSceneGraph.getNode(id);
    if (!node) return;
    const parent = (node.parent ?? 'comp_root') as string;
    const siblings = defaultSceneGraph.getChildren(parent).map((n) => n.id as string);
    nodes.push({ node: plainCopy(node), parent, index: Math.max(0, siblings.indexOf(id)) });
    animation[id] = snapshotNodeAnimation(id);
    for (const childId of node.children) visit(childId as string);
  };
  visit(nodeId);

  return { nodeId, nodes, animation, clip: { start: 0, end: 0 } };
}

/**
 * Put a captured layer back: nodes in their original places in the stack, then
 * their animation.
 *
 * The stack position is restored explicitly rather than by appending, because
 * child order IS the layer order — a layer that comes back at the bottom of the
 * stack has visibly not been un-deleted.
 */
export function restoreLayerSnapshot(snapshot: LayerSnapshot): void {
  for (const entry of snapshot.nodes) {
    if (defaultSceneGraph.getNode(entry.node.id)) continue;
    defaultSceneGraph.addChild(
      entry.parent,
      plainCopy(entry.node) as Parameters<typeof defaultSceneGraph.addChild>[1],
    );
    placeAt(entry.parent, entry.node.id as string, entry.index);
  }
  for (const [id, anim] of Object.entries(snapshot.animation)) {
    if (defaultSceneGraph.getNode(id)) applyNodeAnimation(id, anim);
  }
}

/**
 * A plain, structured-cloneable copy of a scene node.
 *
 * NOT `structuredClone(node)`: a live node is an engine wrapper carrying
 * callbacks (`onNodeChanged` among them), and structuredClone throws
 * DataCloneError on the first function it meets. That threw from inside a
 * context-menu handler, where React swallowed it — so Delete looked like it did
 * nothing at all, which is a worse failure than an error would have been.
 *
 * Ids are preserved exactly. This is an UNDO record, not a duplicate: the layer
 * has to come back as itself, with the same component ids its keyframes and
 * effect references point at.
 */
function plainCopy(node: SceneNode): SceneNode {
  return {
    id: node.id,
    name: node.name,
    parent: node.parent ?? null,
    children: [...node.children],
    transform: {
      position: { ...node.transform.position },
      rotation: node.transform.rotation,
      scale: { ...node.transform.scale },
    },
    visible: node.visible,
    locked: node.locked,
    components: node.components.map((c) => ({ ...c, props: structuredClone(c.props) })),
  } as SceneNode;
}

/**
 * Move `movingId` to `index` among its siblings.
 *
 * Reaches through to `custom.childIds` the same way `parenting.ts` and
 * `cloneLayerNode.ts` do — the facade has no ordered insert.
 */
function placeAt(parentId: string, movingId: string, index: number): void {
  const graph = defaultSceneGraph as unknown as {
    engine?: (id: string) => { custom: Record<string, unknown> } | undefined;
  };
  const parent = graph.engine?.(parentId);
  if (!parent) return;
  const kids = Array.isArray(parent.custom.childIds) ? [...(parent.custom.childIds as string[])] : [];
  const from = kids.indexOf(movingId);
  if (from !== -1) kids.splice(from, 1);
  kids.splice(Math.max(0, Math.min(kids.length, index)), 0, movingId);
  parent.custom.childIds = kids;
}
