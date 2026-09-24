/**
 * A composition's layer TREE over the document mirror (B4) — the mirror twins
 * of the scene graph's `getChildOrder` and `compNavigation.isDescendantOf`.
 * Pure: they take a mirror reader and never touch the engine.
 *
 * The mirror lists a composition's whole stack in `MirrorComp.layers` (depth
 * first, front-most first, a parent before its children, never through a
 * precomp barrier — `layerIdsOfComp`), and each layer names its `parent`
 * (undefined at the top of its comp). A group's `children` repeat its members.
 * A legacy nested precomp GROUP is both a layer of the outer comp and a
 * composition of its own (its members are that comp's layers).
 */

import type { LayerInfo } from '@motion/engine-api';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorTreeRead {
  layer(id: string): LayerInfo | undefined;
  comp(id: string): { readonly layers: readonly string[] } | undefined;
}

/**
 * The children of `parent` — a composition id or a layer id — BACK to FRONT,
 * the order the scene graph's `getChildOrder` gives. Empty when it has none.
 */
export function childOrderOf(m: MirrorTreeRead, parent: string): string[] {
  const comp = m.comp(parent);
  if (comp) return comp.layers.filter((id) => !m.layer(id)?.parent).reverse();
  const layer = m.layer(parent);
  if (!layer) return [];
  if (layer.kind === 'group') return [...layer.children].reverse();
  const host = m.comp(layer.comp);
  return host ? host.layers.filter((id) => m.layer(id)?.parent === parent).reverse() : [];
}

/**
 * Whether `ancestorId` is above `nodeId` — its parent chain, through the
 * composition it is a layer of (and on, when that composition is itself a
 * nested precomp layer). The twin of `compNavigation.isDescendantOf`.
 */
export function isMirrorDescendantOf(m: MirrorTreeRead, nodeId: string, ancestorId: string): boolean {
  let cur = m.layer(nodeId);
  for (let guard = 0; cur && guard < 256; guard++) {
    const up = cur.parent ?? cur.comp;
    if (!up) return false;
    if (up === ancestorId) return true;
    cur = m.layer(up);
  }
  return false;
}

/**
 * Whether a layer sits inside a GROUP (at any depth, within its composition) —
 * a group's members are not independent clips: the timeline gives them no bar
 * of their own (`syncFromScene` does not descend into groups).
 */
export function isInsideGroup(m: MirrorTreeRead, layerId: string): boolean {
  let parent = m.layer(layerId)?.parent;
  for (let guard = 0; parent && guard < 256; guard++) {
    const p = m.layer(parent);
    if (!p) return false;
    if (p.kind === 'group') return true;
    parent = p.parent;
  }
  return false;
}
