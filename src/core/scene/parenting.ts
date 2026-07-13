/**
 * Layer parenting (Prompt E3). Reparent a layer under another, compensating its
 * local transform so it does NOT move on screen, and reject parenting loops.
 * Null objects are invisible controller layers usable as parents.
 *
 * Composition maths live in [[worldTransform]]; this module owns the graph-level
 * operations + the eligibility/cycle rules the UI drives.
 */

import { Matrix } from '@motion/scene';
import defaultSceneGraph from './DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import type { SceneNode } from '@core/types';
import {
  worldMatrixOf,
  localUnderParent,
  type LocalTransform,
  type LocalOf,
  type ParentOf,
} from './worldTransform';

/** The composition root — the implicit "no parent" (comp-space) container. */
const COMP_ROOT = 'comp_root';

/** Read a node's base (non-animated) local transform from its components. */
export function baseLocal(node: SceneNode): LocalTransform {
  let scaleX = 1;
  let scaleY = 1;
  let scale: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.scaleX === 'number') scaleX = p.scaleX;
    if (typeof p.scaleY === 'number') scaleY = p.scaleY;
    if (typeof p.scale === 'number') scale = p.scale;
  }
  return {
    x: node.transform.position.x,
    y: node.transform.position.y,
    rotation: node.transform.rotation,
    scaleX: scale ?? scaleX,
    scaleY: scale ?? scaleY,
  };
}

const localOf: LocalOf = (id) => {
  const n = defaultSceneGraph.getNode(id);
  return n ? baseLocal(n) : null;
};
const parentOf: ParentOf = (id) => defaultSceneGraph.getNode(id)?.parent ?? null;

/** True when `nodeId` is a (deep) descendant of `ancestorId`. */
function isDescendant(ancestorId: string, nodeId: string): boolean {
  let p = defaultSceneGraph.getNode(nodeId)?.parent ?? null;
  while (p) {
    if (p === ancestorId) return true;
    p = defaultSceneGraph.getNode(p)?.parent ?? null;
  }
  return false;
}

/** Whether `childId` may be parented to `newParentId` (null = comp root). */
export function canReparent(childId: string, newParentId: string | null): boolean {
  if (childId === COMP_ROOT) return false; // the root is never re-parented
  if (newParentId === null || newParentId === COMP_ROOT) return true;
  if (newParentId === childId) return false; // no self-parent
  if (!defaultSceneGraph.getNode(newParentId)) return false;
  return !isDescendant(childId, newParentId); // no loops
}

/**
 * Reparent `childId` under `newParentId` (null → comp root) WITHOUT moving it on
 * screen: the child adopts the local transform that reproduces its current world
 * pose under the new parent. Returns false if the move would create a cycle.
 */
export function reparentNode(childId: string, newParentId: string | null): boolean {
  if (!canReparent(childId, newParentId)) return false;
  const target = newParentId ?? COMP_ROOT;

  // World pose BEFORE relinking (old parent chain).
  const childWorld = worldMatrixOf(childId, localOf, parentOf, new Map());
  defaultSceneGraph.setParent(childId, target);
  // New parent's world (fresh cache; the child is now excluded upstream).
  const parentWorld = worldMatrixOf(target, localOf, parentOf, new Map());
  const compensated = localUnderParent(childWorld, Matrix.clone(parentWorld));
  defaultSceneGraph.setLocalTransform(childId, compensated);

  getEventBus().emit('AnimationChanged', { nodeId: childId });
  bumpScene();
  return true;
}

/** The current parent id of a node (comp root when it's a direct child of it). */
export function parentOfNode(childId: string): string | null {
  const p = defaultSceneGraph.getNode(childId)?.parent ?? null;
  return p === COMP_ROOT ? null : p;
}

/** Layers eligible as a parent for `childId` (excludes self, descendants, root). */
export function eligibleParents(childId: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const walk = (n: SceneNode): void => {
    if (n.id !== COMP_ROOT && n.id !== childId && !isDescendant(childId, n.id)) {
      out.push({ id: n.id, name: n.name ?? n.id });
    }
    for (const c of defaultSceneGraph.getChildren(n.id)) walk(c);
  };
  for (const r of defaultSceneGraph.getRoots()) walk(r);
  return out;
}

let seq = 0;

/** Insert a null-object controller: an invisible layer with a transform that
 *  drives its children. Handy as a rig control shared by several layers. */
export function insertNull(): void {
  const id = `null_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const node: SceneNode = {
    id,
    name: 'Null',
    parent: COMP_ROOT,
    children: [],
    transform: { position: { x: 160, y: 120 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'null', x: 160, y: 120, rotation: 0 } },
    ],
  };
  defaultSceneGraph.addChild(COMP_ROOT, node);
  useSelectionStore.getState().set([id]);
  bumpScene();
}

/**
 * Move `nodeId` to a new absolute index within its sibling list.
 * This implements AE-style layer-order drag in the timeline header.
 * `toIndex` is 0-based within the siblings; clamped to [0, siblingCount].
 * Returns false when the node doesn't exist or no move is needed.
 */
export function reorderNode(nodeId: string, toIndex: number): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const parentId: string = (node as any).parent ?? 'comp_root';
  // Access the engine node for the parent to mutate childIds directly
  const parentEngNode = (defaultSceneGraph as any).engine?.(parentId);
  if (!parentEngNode) return false;
  const kids: string[] = Array.isArray(parentEngNode.custom.childIds)
    ? (parentEngNode.custom.childIds as string[])
    : [];
  const fromIndex = kids.indexOf(nodeId);
  if (fromIndex === -1) return false;
  // Splice out then insert at new position
  kids.splice(fromIndex, 1);
  const dest = Math.max(0, Math.min(kids.length, fromIndex < toIndex ? toIndex - 1 : toIndex));
  kids.splice(dest, 0, nodeId);
  parentEngNode.custom.childIds = kids;
  getEventBus().emit('AnimationChanged', { nodeId });
  return true;
}
