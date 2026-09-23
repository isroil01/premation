/**
 * Reads of a layer's static FIELDS and of a composition's layer list over the
 * document MIRROR (B4) — what the Inspector's per-kind sections (camera, light,
 * material, audio, cloner, physics…) show. Pure: they take a `MirrorFieldRead`
 * (the app passes the document mirror) and never touch the engine.
 *
 *   fieldValue(m, layer, path)       plain JS value of a static field (json parsed)
 *   jsonField<T>(m, layer, path)     a json field (`layer/cloner`, `audio/gate`…) or undefined when null/absent
 *   compLayersDeep(m, comp)          every layer of a comp, groups' children included, top of the stack first
 */

import type { LayerInfo, PropertyInfo } from '@motion/engine-api';
import type { MirrorTreeLike } from './trackIndex';
import { plainValue } from './trackIndex';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorFieldRead {
  layer(id: string): LayerInfo | undefined;
  property(layer: string, path: string): PropertyInfo | undefined;
  comp(id: string): { readonly layers: readonly string[] } | undefined;
  tree(id: string): MirrorTreeLike | undefined;
}

/** The plain value of a static field (`light/lightType`, `layer/sequenceLoop`, json parsed), undefined when the layer has no such property. */
export function fieldValue(m: Pick<MirrorFieldRead, 'property'>, layer: string, path: string): unknown {
  return plainValue(m.property(layer, path)?.value);
}

const jsonCache = new WeakMap<object, unknown>();

/**
 * A json field's parsed value — cached per mirror `Value` record, so the same
 * record always yields the same object (identity stays the change test).
 * `undefined` when the layer has no such property or it holds `null`.
 */
export function jsonField<T>(m: Pick<MirrorFieldRead, 'property'>, layer: string, path: string): T | undefined {
  const v = m.property(layer, path)?.value;
  if (!v || v.kind !== 'json') return undefined;
  if (jsonCache.has(v)) return (jsonCache.get(v) ?? undefined) as T | undefined;
  const parsed = plainValue(v) ?? null;
  jsonCache.set(v, parsed);
  return (parsed ?? undefined) as T | undefined;
}

/** Every layer of composition `comp`, depth first, top of the stack first (group children follow their group). */
export function compLayersDeep(m: Pick<MirrorFieldRead, 'comp' | 'layer'>, comp: string | undefined): LayerInfo[] {
  const out: LayerInfo[] = [];
  const top = comp ? m.comp(comp)?.layers : undefined;
  if (!top) return out;
  const seen = new Set<string>();
  const walk = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const l = m.layer(id);
      if (!l) continue;
      out.push(l);
      if (l.children.length > 0) walk(l.children);
    }
  };
  walk(top);
  return out;
}
