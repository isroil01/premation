/**
 * Layer parenting (Prompt E3). Reparent a layer under another, compensating its
 * local transform so it does NOT move on screen, and reject parenting loops.
 * Null objects are invisible controller layers usable as parents.
 *
 * Composition maths live in [[worldTransform]]; this module owns the graph-level
 * operations + the eligibility/cycle rules the UI drives.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import type { SceneNode } from '@core/types';
import {
  type LocalTransform,
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
  if (isDescendant(childId, newParentId)) return false; // no loops
  // Same composition only. Enforced HERE and not just in the dropdown, because
  // the AI tools and any future scripting path call `reparentNode` directly —
  // a rule that lives only in the UI is a rule that gets bypassed.
  return compRootOf(childId) === compRootOf(newParentId);
}

/**
 * Reparent `childId` under `newParentId` (null → comp root). By default this
 * does NOT move the layer on screen: the child adopts the local transform that
 * reproduces its current world pose under the new parent (`preserveWorld: true`).
 * Pass `{ preserveWorld: false }` to keep the child's LOCAL transform as-is —
 * importers (e.g. Lottie) use this because their locals are already
 * parent-relative. Returns false if the move would create a cycle.
 */
export function reparentNode(
  childId: string,
  newParentId: string | null,
  options: { preserveWorld?: boolean } = {},
): boolean {
  if (!canReparent(childId, newParentId)) return false;
  const target = newParentId ?? COMP_ROOT;

  defaultSceneGraph.setParent(childId, target, { preserveWorld: options.preserveWorld ?? true });

  getEventBus().emit('AnimationChanged', { nodeId: childId });
  bumpScene();
  return true;
}

/** The current parent id of a node (comp root when it's a direct child of it). */
export function parentOfNode(childId: string): string | null {
  const p = defaultSceneGraph.getNode(childId)?.parent ?? null;
  return p === COMP_ROOT ? null : p;
}

/**
 * The composition a node belongs to: its top-most ancestor.
 *
 * Not the hardcoded `comp_root` — that is only the FIRST composition, and in a
 * multi-composition project every other one has a different root id.
 */
export function compRootOf(nodeId: string): string | null {
  let cur = defaultSceneGraph.getNode(nodeId);
  if (!cur) return null;
  const seen = new Set<string>([cur.id]);
  while (cur.parent) {
    const p = defaultSceneGraph.getNode(cur.parent);
    // A cycle or a dangling parent id must not hang the walk.
    if (!p || seen.has(p.id)) break;
    seen.add(p.id);
    cur = p;
  }
  return cur.id;
}

/**
 * Layers eligible as a parent for `childId` — excludes self, descendants, the
 * composition root, and anything in a DIFFERENT composition.
 *
 * After Effects has no cross-composition parenting, and here it was worse than
 * merely unsupported: `parent` IS the tree structure in this graph, so picking a
 * parent from another composition physically relocated the layer into that
 * composition. It vanished from the comp you were editing and started rendering
 * in one you weren't looking at. The dropdown offered every layer in the project
 * with nothing to distinguish them, so the only cue was the layer disappearing.
 */
export function eligibleParents(childId: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const root = compRootOf(childId);
  if (!root) return out;
  const walk = (n: SceneNode): void => {
    if (n.id !== root && n.id !== COMP_ROOT && n.id !== childId && !isDescendant(childId, n.id)) {
      out.push({ id: n.id, name: n.name ?? n.id });
    }
    for (const c of defaultSceneGraph.getChildren(n.id)) walk(c);
  };
  const rootNode = defaultSceneGraph.getNode(root);
  if (rootNode) walk(rootNode);
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

/**
 * Drag-to-reorder drop: move `dragId` to sit directly before/after `targetId`
 * among the target's siblings, reparenting into the target's parent first if
 * the drag came from a different branch (transform-compensated). Drives the
 * Scene tree's drag handle.
 */
export function moveNodeAdjacent(
  dragId: string,
  targetId: string,
  pos: 'before' | 'after',
): boolean {
  if (dragId === targetId) return false;
  if (!defaultSceneGraph.getNode(dragId) || !defaultSceneGraph.getNode(targetId)) return false;
  const targetParent = parentOfNode(targetId); // null → comp root
  // Reparent into the target's branch first (no-op if already siblings).
  if (parentOfNode(dragId) !== targetParent) {
    if (!reparentNode(dragId, targetParent)) return false;
  }
  const parentId = targetParent ?? COMP_ROOT;
  const parentEng = (defaultSceneGraph as any).engine?.(parentId);
  if (!parentEng) return false;
  const kids: string[] = Array.isArray(parentEng.custom.childIds)
    ? (parentEng.custom.childIds as string[])
    : [];
  const from = kids.indexOf(dragId);
  if (from !== -1) kids.splice(from, 1);
  let idx = kids.indexOf(targetId);
  if (idx === -1) idx = kids.length;
  if (pos === 'after') idx += 1;
  kids.splice(idx, 0, dragId);
  parentEng.custom.childIds = kids;
  getEventBus().emit('AnimationChanged', { nodeId: dragId });
  bumpScene();
  return true;
}

export function moveNodeInStack(nodeId: string, action: 'front' | 'back' | 'forward' | 'backward'): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const parentId = node.parent ?? 'comp_root';
  const parentEngNode = (defaultSceneGraph as any).engine?.(parentId);
  if (!parentEngNode) return false;
  const kids: string[] = Array.isArray(parentEngNode.custom.childIds)
    ? [...parentEngNode.custom.childIds]
    : [];
  const fromIndex = kids.indexOf(nodeId);
  if (fromIndex === -1) return false;

  kids.splice(fromIndex, 1);

  if (action === 'front') {
    kids.push(nodeId);
  } else if (action === 'back') {
    kids.unshift(nodeId);
  } else if (action === 'forward') {
    const dest = Math.min(kids.length, fromIndex + 1);
    kids.splice(dest, 0, nodeId);
  } else if (action === 'backward') {
    const dest = Math.max(0, fromIndex - 1);
    kids.splice(dest, 0, nodeId);
  }

  parentEngNode.custom.childIds = kids;
  getEventBus().emit('AnimationChanged', { nodeId });
  bumpScene();
  return true;
}
