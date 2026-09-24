/**
 * Parenting pickers over the document MIRROR (B4) — the mirror twins of
 * `@core/scene/parenting`'s `parentOfNode`, `eligibleParents` and
 * `canBeParentOf`. Pure: they take a mirror reader and never touch the engine.
 *
 * The rules are the scene graph's: a parent is a layer of the SAME
 * composition (never one behind a precomp barrier — those belong to another
 * composition, and the mirror's `MirrorComp.layers` never lists them), never
 * the layer itself and never one of its own descendants. "None" (the
 * composition) is what `parent === undefined` means in the API.
 */

import type { LayerInfo } from '@motion/engine-api';
import { isMirrorDescendantOf, type MirrorTreeRead } from './layerTree';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export type MirrorParentRead = MirrorTreeRead;

export interface ParentOption {
  id: string;
  name: string;
}

/** The layer's parent, or null at the top of its composition (the twin of `parentOfNode`). */
export function mirrorParentOf(m: Pick<MirrorParentRead, 'layer'>, childId: string): string | null {
  return m.layer(childId)?.parent ?? null;
}

/** Whether `targetId` may become `childId`'s parent (the twin of `canBeParentOf`). */
export function mirrorCanBeParentOf(m: MirrorParentRead, childId: string, targetId: string): boolean {
  if (targetId === childId) return false;
  const child = m.layer(childId);
  const target = m.layer(targetId);
  if (!child || !target || target.comp !== child.comp) return false;
  return !isMirrorDescendantOf(m, targetId, childId);
}

/**
 * Every layer eligible as `childId`'s parent (the twin of `eligibleParents`):
 * the layers of its composition, depth first, top of the stack first — minus
 * itself and its descendants.
 */
export function mirrorEligibleParents(m: MirrorParentRead, childId: string): ParentOption[] {
  const child = m.layer(childId);
  const comp = child ? m.comp(child.comp) : undefined;
  if (!child || !comp) return [];
  const out: ParentOption[] = [];
  for (const id of comp.layers) {
    if (id === childId) continue;
    const l: LayerInfo | undefined = m.layer(id);
    if (!l || isMirrorDescendantOf(m, id, childId)) continue;
    out.push({ id, name: l.name || id });
  }
  return out;
}
