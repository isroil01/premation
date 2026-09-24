/**
 * A composition's layers as the viewport walks them (B4) — the mirror twins of
 * `sceneDerive.flattenComposition` and the "does this comp hold 3D content"
 * scans the 3D chrome gates on. Pure: they take a mirror reader and never
 * touch the engine.
 *
 * `MirrorComp.layers` lists a composition's whole stack top-first, a parent
 * before its children, never through a precomp barrier; a legacy nested
 * precomp GROUP is both a layer of the outer comp and a composition of its own
 * (its members are that comp's layers). The scene graph's walk descends into
 * such a group, so these do too.
 */

import type { LayerInfo } from '@motion/engine-api';
import { uiKindOf } from './layerKinds';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorCompLayersRead {
  layer(id: string): LayerInfo | undefined;
  comp(id: string): { readonly layers: readonly string[] } | undefined;
  layerIds(): readonly string[];
}

const MAX_NESTING = 64;

/**
 * Every layer of `compId`, in `flattenComposition`'s order: depth first, a
 * parent before its children, siblings BACK to FRONT (paint order), descending
 * into legacy nested precomp groups. The composition root itself is not listed
 * (it is not a layer). With no such composition, every layer of the document
 * (`flattenScene`'s fallback) in the mirror's order.
 */
export function flattenCompLayers(m: MirrorCompLayersRead, compId: string | undefined): string[] {
  if (!compId || !m.comp(compId)) return [...m.layerIds()];
  const out: string[] = [];
  const walkComp = (id: string, depth: number): void => {
    const comp = m.comp(id);
    if (!comp || depth > MAX_NESTING) return;
    // Children per parent, front-first as the stack lists them.
    const kids = new Map<string, string[]>();
    const roots: string[] = [];
    for (const lid of comp.layers) {
      const p = m.layer(lid)?.parent;
      if (p) {
        let list = kids.get(p);
        if (!list) kids.set(p, (list = []));
        list.push(lid);
      } else {
        roots.push(lid);
      }
    }
    const visit = (lid: string): void => {
      out.push(lid);
      // A legacy nested precomp group: its members are its own composition's layers.
      if (m.comp(lid)) walkComp(lid, depth + 1);
      const list = kids.get(lid);
      if (list) for (let i = list.length - 1; i >= 0; i--) visit(list[i] as string);
    };
    for (let i = roots.length - 1; i >= 0; i--) visit(roots[i] as string);
  };
  walkComp(compId, 0);
  return out;
}

/**
 * Whether `compId` shows 3D content: a 3D-switched layer that is not a light
 * (`threeD.is3DEnabled`), or — with `camerasCount` — any camera. The walk the
 * axis widget, the 3D reference geometry and the focus plane gate on.
 */
export function compHas3DContent(m: MirrorCompLayersRead, compId: string | undefined, camerasCount: boolean): boolean {
  for (const id of flattenCompLayers(m, compId)) {
    const layer = m.layer(id);
    const k = uiKindOf(layer);
    if (k === 'camera') {
      if (camerasCount) return true;
      continue;
    }
    if (k !== 'light' && layer?.switches.threeD === true) return true;
  }
  return false;
}
