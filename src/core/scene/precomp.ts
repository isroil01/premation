/**
 * Precomps (Prompt 10) — nested compositions. A group flagged as a precomp has
 * its whole subtree rendered to an offscreen texture, which is then composited
 * as ONE layer: the group's opacity, blend mode, effects and mask apply to the
 * nested animation as a unit (overlapping semi-transparent children composite
 * correctly inside, then the whole thing composites with the comp). This is the
 * structural foundation for building complex, reusable motion-graphics blocks.
 *
 * Cycle-safe by construction: a precomp is a subtree of the scene tree, so it
 * can never contain itself.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

/** True when the group composites its subtree as a single unit. */
export function isPrecomp(node: SceneNode): boolean {
  const fx = node.components.find((c) => c.type === 'fx');
  return (fx?.props as Record<string, unknown> | undefined)?.precomp === true;
}

/** Read alias used by the renderer. */
export function readNodePrecomp(node: SceneNode): boolean {
  return isPrecomp(node);
}

/** Turn precomp compositing on/off for a group. */
export function setPrecomp(nodeId: string, on: boolean): void {
  defaultSceneGraph.setPrecomp(nodeId, on || undefined);
  bumpScene();
}

/**
 * The nearest ancestor of `node` that is a precomp group (or null). Used by the
 * renderer to route a layer into its enclosing precomp's texture. Handles
 * nesting — returns the *closest* precomp so inner precomps nest inside outer.
 */
export function nearestPrecompRoot(
  node: SceneNode,
  nodeById: ReadonlyMap<string, SceneNode>,
): SceneNode | null {
  let parentId = node.parent;
  while (parentId) {
    const parent = nodeById.get(parentId);
    if (!parent) break;
    if (isPrecomp(parent)) return parent;
    parentId = parent.parent;
  }
  return null;
}
