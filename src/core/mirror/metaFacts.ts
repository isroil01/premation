/**
 * Property metadata (labels, units, ranges, display scale) for a layer the
 * UI knows only through the document MIRROR (B4). The registry
 * (`resolvePropertyMeta`) takes "facts" about the layer instead of reading the
 * scene graph; these are built from a `LayerInfo` and its mirror property tree.
 * Pure: no engine, no store.
 */

import type { LayerInfo } from '@motion/engine-api';
import { resolvePropertyMeta, type MetaNodeFacts, type PropertyMeta } from '@core/inspector/propertyMeta';
import { uiKindOf } from './layerKinds';
import type { MirrorTreeLike } from './trackIndex';

const cache = new WeakMap<object, WeakMap<object, MetaNodeFacts>>();

/** Facts about one layer for the metadata registry, from mirror records (cached per record pair). */
export function mirrorMetaFacts(layer: LayerInfo | undefined, tree: MirrorTreeLike | undefined): MetaNodeFacts | undefined {
  if (!layer) return undefined;
  const key = tree ?? EMPTY_TREE;
  let byTree = cache.get(layer);
  if (!byTree) {
    byTree = new WeakMap();
    cache.set(layer, byTree);
  }
  const hit = byTree.get(key);
  if (hit) return hit;
  const node = (path: string) => tree?.nodes.get(path);
  const facts: MetaNodeFacts = {
    kind: uiKindOf(layer) ?? undefined,
    effectType: (id) => node(`effects/${id}`)?.matchName,
    pathOpType: (id) => node(`contents/${id}`)?.matchName.replace(/^pathop:/, ''),
    maskName: (id) => {
      const m = node(`masks/${id}`);
      return m?.name;
    },
    paintStrokeName: (id) => {
      const n = node(`paint/${id}`)?.name;
      return n && n !== id ? n : undefined;
    },
    animators: () => {
      const list = node('text/animators')?.children ?? [];
      return list.map((p) => {
        const a = node(p);
        const sels = node(`${p}/selectors`)?.children ?? [];
        return {
          ...(a?.name ? { name: a.name } : {}),
          selectors: sels.map((s) => ({ kind: (node(s)?.name ?? 'range').replace(/ selector$/, '') })),
        };
      });
    },
  };
  byTree.set(key, facts);
  return facts;
}

const EMPTY_TREE = {};

/** The registry's metadata for a track on a mirror layer. */
export function mirrorPropertyMeta(track: string, layer: LayerInfo | undefined, tree: MirrorTreeLike | undefined): PropertyMeta {
  return resolvePropertyMeta(track, mirrorMetaFacts(layer, tree));
}
