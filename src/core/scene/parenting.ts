/**
 * Layer parenting (Prompt E3). Reparent a layer under another, compensating its
 * local transform so it does NOT move on screen, and reject parenting loops.
 * Null objects are invisible controller layers usable as parents.
 *
 * Composition maths live in [[worldTransform]]; this module owns the graph-level
 * operations + the eligibility/cycle rules the UI drives.
 */

import type { SceneNode } from '@core/types';
import {
  type LocalTransform,
} from './worldTransform';

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
    // Per-axis first, matching `readGeometry` and the renderer — see the same
    // note in `SceneGraph.getLocalTransform`.
    scaleX: scaleX ?? scale ?? 1,
    scaleY: scaleY ?? scale ?? 1,
  };
}

/** How a parenting gesture treats the child's transform. */
export interface ReparentOptions {
  /** false = keep the LOCAL values (importer path; the Alt legacy gesture). */
  preserveWorld?: boolean;
  /**
   * AE's "Parent & Link" with Shift: the child JUMPS onto the parent — its
   * position becomes the parent's anchor point.
   */
  jump?: boolean;
  /** Composition seconds the jump measures an animated Position at (default: the playhead). */
  time?: number;
}

/**
 * Turn the modifier keys held during a parenting gesture into the option
 * `reparentNode` takes.
 *
 * PLAIN: AE's default — the child keeps its world pose (compensated).
 *
 * SHIFT: AE's Parent & Link jump — the child snaps onto the parent, its
 * position set to the parent's anchor point (see `jumpToParent`). This is how
 * AE users attach a prop to a hand or a label to a null in one gesture.
 *
 * ALT (Option): the older "keep values" variant — link without compensating,
 * so the layer's typed values are reinterpreted in the parent's space. Kept as
 * an alias because rigs are built with it; Shift wins when both are held.
 *
 * Lives here, next to the thing it configures, because four surfaces parent
 * (the inspector's picker, the compositing panel's, the timeline's Parent &
 * Link column, and the pick-whip on each of them) and a modifier implemented
 * four times is a modifier that means four things.
 */
export function parentOptionsFor(
  modifiers: { altKey?: boolean; shiftKey?: boolean } | undefined,
): ReparentOptions | undefined {
  if (modifiers?.shiftKey === true) return { jump: true };
  return modifiers?.altKey === true ? { preserveWorld: false } : undefined;
}

/** The arrange verbs, in the stacking direction each one moves. */
export type StackAction = 'front' | 'back' | 'forward' | 'backward';

/**
 * Reorder ONE sibling list. Pure: takes the current child order and the ids
 * being moved, returns the new order. Exported for the tests that pin the
 * multi-selection rules without standing a scene graph up.
 *
 * `kids` is back-to-front (index 0 = back-most), so "forward" moves an id
 * toward the END of the array.
 *
 * A multi-selection moves as a BLOCK and keeps its internal order. Doing it one
 * layer at a time — which is what every call site used to do, by looping
 * `moveNodeInStack` over the selection — is wrong in two ways that cancel out
 * into nonsense: Bring Forward over two adjacent layers moved the lower one up
 * past the upper one and then the upper one back down past it, for a net no-op;
 * and Send to Back moved each in turn to index 0, so the selection came out
 * REVERSED.
 */
export function reorderSiblings(
  kids: ReadonlyArray<string>,
  ids: ReadonlyArray<string>,
  action: StackAction,
): string[] {
  const sel = new Set(ids.filter((id) => kids.includes(id)));
  if (sel.size === 0) return [...kids];
  const next = [...kids];

  if (action === 'front' || action === 'back') {
    // Relative order is the array's own, not the selection's: the caller hands
    // us a selection in click order, and Bring to Front must not re-stack the
    // layers among themselves.
    const moved = next.filter((id) => sel.has(id));
    const rest = next.filter((id) => !sel.has(id));
    return action === 'front' ? [...rest, ...moved] : [...moved, ...rest];
  }

  // One step. Walking from the destination end means a run of selected layers
  // shuffles as a unit and stops as a unit when it reaches the top (or bottom):
  // a selected layer only swaps with an UNSELECTED neighbour, so members never
  // leapfrog each other and the block cannot pass through itself.
  if (action === 'forward') {
    for (let i = next.length - 2; i >= 0; i--) {
      if (sel.has(next[i]!) && !sel.has(next[i + 1]!)) {
        [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
      }
    }
  } else {
    for (let i = 1; i < next.length; i++) {
      if (sel.has(next[i]!) && !sel.has(next[i - 1]!)) {
        [next[i], next[i - 1]] = [next[i - 1]!, next[i]!];
      }
    }
  }
  return next;
}
