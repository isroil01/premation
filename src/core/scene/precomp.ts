/**
 * Precomps — nested compositions. A group flagged as a precomp has
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
import { readCompCollapse, COMP_COLLAPSE_PROP } from '@core/scene/compInstance';

/** True when the group composites its subtree as a single unit. */
export function isPrecomp(node: SceneNode): boolean {
  const fx = node.components.find((c) => c.type === 'fx');
  return (fx?.props as Record<string, unknown> | undefined)?.precomp === true;
}

/**
 * True when the node is a compositing BARRIER — its subtree renders to a texture
 * and composites as one unit.
 *
 * A precomp with Collapse Transformations on is not: its layers are spliced into
 * the host and meet the host's camera and depth sort directly. That is the whole
 * feature, so the routing question ("does this layer go into a texture?") has to
 * ask this rather than `isPrecomp`.
 *
 * `isPrecomp` itself is deliberately unchanged: a collapsed comp is still a
 * precomp for the purposes of the time-remap chain, which is about timing, not
 * compositing.
 */
export function compositesAsUnit(node: SceneNode): boolean {
  return isPrecomp(node) && !readCompCollapse(node);
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

/** Turn Collapse Transformations on/off for a placed composition. */
export function setCompCollapse(nodeId: string, on: boolean): void {
  // `undefined` rather than `false` so an untouched instance stores nothing —
  // the file stays free of every default, which is how the rest of the fx flags
  // are written.
  defaultSceneGraph.setFxKey(nodeId, COMP_COLLAPSE_PROP, on || undefined);
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
    // `compositesAsUnit`, not `isPrecomp`: a COLLAPSED comp is transparent to
    // routing, so its layers keep walking outward and land in the host's own
    // list — where the host's camera and 3D sort can reach them.
    if (compositesAsUnit(parent)) return parent;
    parentId = parent.parent;
  }
  return null;
}

/**
 * The full chain of precomp-group ancestors of `node`, OUTERMOST first and
 * EXCLUDING `node` itself. For nested precomps A ▸ B ▸ C (A outermost) a leaf
 * inside C yields [A, B, C]; the group node C itself yields [A, B] (its own
 * remap is applied via its `sourceTime`, so it must not appear in its own
 * children's inheritance twice). Used to fold every ancestor's time-remap in
 * order so inner content composes ALL outer remaps, not just the nearest one.
 */
export function precompAncestorChain(
  node: SceneNode,
  nodeById: ReadonlyMap<string, SceneNode>,
): SceneNode[] {
  const chain: SceneNode[] = [];
  let parentId = node.parent;
  while (parentId) {
    const parent = nodeById.get(parentId);
    if (!parent) break;
    if (isPrecomp(parent)) chain.push(parent);
    parentId = parent.parent;
  }
  chain.reverse(); // outermost first
  return chain;
}
