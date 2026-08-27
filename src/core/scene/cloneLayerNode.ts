/**
 * Clone one layer's scene node, for operations that turn a single layer into
 * two INDEPENDENT layers — split above all.
 *
 * Why this exists at all: the timeline models a clip bar as a `Layer` whose
 * `sourceId` points at a scene node, and `Timeline.splitLayer` used to hand the
 * new right-hand bar the SAME `sourceId` as the left. Two bars, one node. The
 * consequences were not subtle:
 *
 *   • Selection is addressed by node id, so there was no way to select "the
 *     right half" — clicking either bar selected the same layer.
 *   • Delete removes a NODE, and the reconciler then drops every clip backed by
 *     it, so deleting after a split deleted both halves.
 *   • Any property edit hit both halves, since they were literally one object.
 *
 * After Effects' split makes two real layers. This gives us the missing half of
 * that: a node clone the right-hand bar can own.
 *
 * Deliberately NOT `duplicateSelectedLayers`: that one is the Edit ▸ Duplicate
 * command and bakes in its own semantics — a "+20/+20" nudge so the copy is
 * visible, a " copy" name suffix, and it drives the selection. A split copy
 * must sit at exactly the same place with exactly the same name; it is the same
 * layer, later in time.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { copyNodeAnimation } from '@core/animation/cloneNodeAnimation';
import { defaultAnimation } from '@motion/animation';

/** Mint an id for a split half. Stable shape, so it reads in a debugger. */
export function mintSplitNodeId(sourceId: string): string {
  return `${sourceId}_split_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Deep-clone `sourceId`'s node as `newId`, inserted directly above the original
 * in its parent's child list, carrying the original's animation.
 *
 * Returns false when the source is missing or is a root (nothing addressable to
 * clone). Children are NOT cloned: a split divides one layer in time, it does
 * not fork its parented subtree — the same rule After Effects follows.
 */
export function cloneLayerNode(sourceId: string, newId: string): boolean {
  const original = defaultSceneGraph.getNode(sourceId);
  if (!original || original.parent === null || original.parent === undefined) return false;
  if (defaultSceneGraph.getNode(newId)) return false;

  const components = original.components.map((c) => ({
    ...c,
    id: `${newId}_${c.type}`,
    // Deep-clone props: a shallow spread shares nested arrays (pathOps, gradient
    // stops, mask paths) with the original, so editing one half of a split
    // would silently edit the other — the very bug this clone exists to end.
    props: structuredClone(c.props),
  }));

  const clone = {
    id: newId,
    name: original.name,
    parent: null as string | null,
    children: [] as string[],
    transform: {
      position: { ...original.transform.position },
      rotation: original.transform.rotation,
      scale: { ...original.transform.scale },
    },
    visible: original.visible,
    locked: original.locked === true,
    components,
  };

  defaultSceneGraph.addChild(
    original.parent,
    clone as unknown as Parameters<typeof defaultSceneGraph.addChild>[1],
  );
  placeAfter(original.parent, sourceId, newId);
  // Keyframes, data tracks (Source Text, puppet pins, mask shapes) and
  // expressions. Both halves keep the WHOLE animation, as in AE — the clip
  // bounds decide what is visible, not the keyframe list.
  copyNodeAnimation(sourceId, newId);
  return true;
}

/** Undo a {@link cloneLayerNode}: drop the clone and the animation it carried. */
export function removeLayerNodeClone(newId: string): void {
  if (!defaultSceneGraph.getNode(newId)) return;
  defaultAnimation.clearNode(newId);
  defaultSceneGraph.removeNode(newId);
}

/**
 * Move `movingId` to sit directly after `anchorId` among their siblings.
 *
 * `addChild` appends, which for a split would drop the right-hand half at the
 * BOTTOM of the layer stack — visually behind everything, nowhere near the
 * layer it came from. Child order is the layer stack, so this is a z-order fix
 * as much as a tidiness one.
 *
 * Reaches through to `custom.childIds` the same way `parenting.ts` does; the
 * facade has no ordered insert.
 */
function placeAfter(parentId: string, anchorId: string, movingId: string): void {
  const graph = defaultSceneGraph as unknown as {
    engine?: (id: string) => { custom: Record<string, unknown> } | undefined;
  };
  const parent = graph.engine?.(parentId);
  if (!parent) return;
  const kids = Array.isArray(parent.custom.childIds) ? [...(parent.custom.childIds as string[])] : [];
  const from = kids.indexOf(movingId);
  if (from !== -1) kids.splice(from, 1);
  const anchor = kids.indexOf(anchorId);
  kids.splice(anchor === -1 ? kids.length : anchor + 1, 0, movingId);
  parent.custom.childIds = kids;
}
