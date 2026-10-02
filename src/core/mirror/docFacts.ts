/**
 * Document addressing over the MIRROR — the twins of `core/engine/doc.ts`'s
 * `isLayer`, `compOfLayer`, `layerIdsOfComp`, … for code outside the
 * TypeScript engine (docs/TS_ENGINE_REMOVAL.md block 3: the page replica goes,
 * so the UI answers these from the engine's own document).
 *
 * Same answers, read from what the owner reported: `MirrorComp.layers` is a
 * composition's whole stack top-first, a parent before its children, never
 * through a precomp barrier — exactly `layerIdsOfComp`'s walk — and
 * `LayerInfo.parent` is the API parent (absent at the top of a composition),
 * exactly `apiParentOf`.
 *
 * No React here (src/core).
 */

import { documentMirror } from '@stores/documentMirror';

/** Composition item ids, in document order. */
export function compItemIds(): string[] {
  return [...documentMirror().compIds];
}

export function isCompItem(id: string): boolean {
  return documentMirror().comp(id) !== undefined;
}

/** The composition a layer belongs to, or null when `id` is not a layer. */
export function compOfLayer(id: string): string | null {
  return documentMirror().layer(id)?.comp ?? null;
}

export function isLayer(id: string): boolean {
  return documentMirror().layer(id) !== undefined;
}

/** A composition's layers, top of the stack first, a parent before its children. */
export function layerIdsOfComp(compId: string): string[] {
  return [...(documentMirror().comp(compId)?.layers ?? [])];
}

/** The API parent of a layer (null at the top of its composition). */
export function apiParentOf(id: string): string | null {
  return documentMirror().layer(id)?.parent ?? null;
}

/**
 * A layer and every layer nested under it (parent first) in its composition's
 * stack order — what a subtree delete sends as one `deleteLayers`. Null when
 * `id` is not a layer.
 */
export function layerSubtree(id: string): string[] | null {
  const m = documentMirror();
  const layer = m.layer(id);
  if (!layer) return null;
  const stack = m.comp(layer.comp)?.layers ?? [id];
  const inside = new Set([id]);
  const out = [id];
  for (const lid of stack) {
    if (lid === id) continue;
    const p = m.layer(lid)?.parent;
    // The stack lists a parent before its children, so one pass collects the subtree.
    if (p && inside.has(p)) {
      inside.add(lid);
      out.push(lid);
    }
  }
  return out;
}

/** Layers anywhere in the document that show `itemId`. */
export function layersUsingItem(itemId: string): string[] {
  const m = documentMirror();
  return m.layerIds().filter((id) => m.layer(id)?.source === itemId);
}
