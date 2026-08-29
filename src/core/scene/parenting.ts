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
import { isPrecomp } from './precomp';
import { activeCompRootId } from './activeComp';
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

/**
 * The COMPOSITION a node lives in — the nearest enclosing composition, not the
 * document root.
 *
 * This is the distinction `compRootOf` does not make, and the reason the
 * "same composition only" rule below was vacuous for the commonest case.
 * `compRootOf` walks to the TOP-most ancestor, which is right when every
 * composition is its own scene root — and wrong for a PRECOMP, which is a group
 * living inside `comp_root`. Both a layer inside a precomp and a layer in the
 * outer comp resolve to `comp_root` under `compRootOf`, so the guard compared
 * two equal values and let the move through: the layer was physically relocated
 * out of the precomp and vanished from the comp being edited. Reported as
 * "parent the rectangle to a Null and the rectangle is missing".
 *
 * Walks from the node's PARENT: a precomp group is a layer OF its host comp, not
 * a layer of itself.
 */
export function enclosingCompRootOf(nodeId: string): string | null {
  const start = defaultSceneGraph.getNode(nodeId);
  if (!start) return null;
  let cur = start.parent ? defaultSceneGraph.getNode(start.parent) : null;
  const seen = new Set<string>([start.id]);
  while (cur) {
    // A precomp composites its subtree as one unit — its children are layers of
    // IT, not of whatever contains it. That boundary is the composition.
    if (isPrecomp(cur) || !cur.parent) return cur.id;
    if (seen.has(cur.id)) break; // dangling/cyclic parent must not hang the walk
    seen.add(cur.id);
    cur = defaultSceneGraph.getNode(cur.parent);
  }
  return start.parent ?? null;
}

/** Whether `childId` may be parented to `newParentId` (null = its own comp root). */
export function canReparent(childId: string, newParentId: string | null): boolean {
  if (childId === COMP_ROOT) return false; // the root is never re-parented
  // "None" means this layer's OWN composition root, which is always legal.
  if (newParentId === null) return true;
  if (newParentId === childId) return false; // no self-parent
  if (!defaultSceneGraph.getNode(newParentId)) return false;
  if (isDescendant(childId, newParentId)) return false; // no loops
  const home = enclosingCompRootOf(childId);
  // Parenting TO the composition root is the same thing as "None".
  if (newParentId === home || newParentId === COMP_ROOT) return newParentId === home;
  // Same composition only. Enforced HERE and not just in the dropdown, because
  // the AI tools and any future scripting path call `reparentNode` directly —
  // a rule that lives only in the UI is a rule that gets bypassed.
  //
  // `enclosingCompRootOf`, NOT `compRootOf`: see the note there for why the
  // document root is the wrong unit and what it let through.
  return home !== null && home === enclosingCompRootOf(newParentId);
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
  // Un-parenting returns the layer to ITS OWN composition root. Defaulting to
  // `COMP_ROOT` yanked a layer inside a precomp out to the top composition —
  // the same disappearance as parenting across comps, reached by the dropdown's
  // most-used entry.
  const target = newParentId ?? enclosingCompRootOf(childId) ?? COMP_ROOT;

  defaultSceneGraph.setParent(childId, target, { preserveWorld: options.preserveWorld ?? true });

  // The layer has MOVED IN THE TREE, and a collapsed destination hides it
  // outright — parenting to a fresh Null (never expanded, because it had no
  // children to expand) dropped the layer out of the Scene panel while it went
  // on rendering. Panels listen for this to open the branch they just moved it
  // into. Emitted for every route in and out of here, so the tree, the AI tools
  // and the plugin host cannot each forget it separately.
  getEventBus().emit('LayerReparented', { nodeId: childId, parentId: target });
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
  const root = enclosingCompRootOf(childId);
  if (!root) return out;
  // Walks CHILDREN, so the composition root is never offered as a parent — it
  // is what "None" already means.
  const walk = (n: SceneNode): void => {
    for (const c of defaultSceneGraph.getChildren(n.id)) {
      if (c.id !== childId && !isDescendant(childId, c.id)) {
        out.push({ id: c.id, name: c.name ?? c.id });
      }
      // Do not descend THROUGH a precomp: its children are layers of ANOTHER
      // composition, and offering one is offering to relocate this layer into
      // it. The precomp itself stays offerable (pushed just above) — it is an
      // ordinary layer of this composition.
      if (!isPrecomp(c)) walk(c);
    }
  };
  const rootNode = defaultSceneGraph.getNode(root);
  if (rootNode) walk(rootNode);
  return out;
}

let seq = 0;

/** Insert a null-object controller: an invisible layer with a transform that
 *  drives its children. Handy as a rig control shared by several layers. */
export function insertNull(): void {
  // The composition the user is EDITING, like every other insert
  // (`activeComp.ts` exists because hardcoding the first root was already this
  // bug once). Hardcoding COMP_ROOT here put the Null in the outer comp while
  // the user was inside a precomp — invisible where they made it, and a trap
  // for the parenting dropdown, which then relocated whatever was parented to
  // it out of the comp being edited.
  const rootId = activeCompRootId();
  const id = `null_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const node: SceneNode = {
    id,
    name: 'Null',
    parent: rootId,
    children: [],
    transform: { position: { x: 160, y: 120 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'null', x: 160, y: 120, rotation: 0 } },
    ],
  };
  defaultSceneGraph.addChild(rootId, node);
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
