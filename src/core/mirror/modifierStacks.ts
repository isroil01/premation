/**
 * A layer's MODIFIER STACKS and the numeric properties a stack can drive, over
 * the document MIRROR (B4) — the twins of `readModifierStacks(node)` and the
 * Modifiers section's `numericProps(nodeId)`. Pure: they take a mirror reader
 * and never touch the engine.
 *
 * The record is the json field `layer/modifiers` (`{ <track>: { modifiers,
 * previous } }`, Transform.__modifiers). It is normalised by the SAME reader
 * the document uses (`readModifierStacks` reads only the Transform's
 * `__modifiers`), handed the mirror's record as that one prop — so a garbled
 * or older stored stack reads here exactly as the renderer reads it.
 */

import type { LayerInfo } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import { MODIFIERS_PROP, readModifierStacks, type ModifierStack } from '@core/animation/modifierStack';
import { jsonField, type MirrorFieldRead } from './layerFields';
import { mirrorPropertyMeta } from './metaFacts';
import { membersOf, type MirrorTreeLike } from './trackIndex';

export const MODIFIERS_PATH = 'layer/modifiers';

const NONE: Readonly<Record<string, ModifierStack>> = Object.freeze({});
const cache = new WeakMap<object, Record<string, ModifierStack>>();

/** Every stack on the layer, keyed by track (the twin of `readModifierStacks`). Same object per mirror record. */
export function mirrorModifierStacks(m: Pick<MirrorFieldRead, 'property'>, layer: string): Readonly<Record<string, ModifierStack>> {
  const raw = jsonField<unknown>(m, layer, MODIFIERS_PATH);
  if (!raw || typeof raw !== 'object') return NONE;
  let out = cache.get(raw);
  if (!out) {
    out = readModifierStacks({ components: [{ id: 'mirror:Transform', type: 'Transform', props: { [MODIFIERS_PROP]: raw } }] } as unknown as SceneNode);
    cache.set(raw, out);
  }
  return out;
}

/** The stack on one track, or null (the twin of `readModifierStack`). */
export function mirrorModifierStack(m: Pick<MirrorFieldRead, 'property'>, layer: string, track: string): ModifierStack | null {
  return mirrorModifierStacks(m, layer)[track] ?? null;
}

/** Property value types a numeric modifier chain can sensibly drive (ModifierStackSection). */
const NUMERIC_TYPES: ReadonlySet<string> = new Set(['number', 'percent', 'angle', 'multiplier']);

export interface NumericTrackOption {
  /** The member track (`x`, `opacity`, `effect.fx_1.radius`). */
  path: string;
  label: string;
}

const numericCache = new WeakMap<object, WeakMap<object, NumericTrackOption[]>>();

/**
 * Every animatable NUMERIC member track of the layer, in tree order (the twin
 * of the Modifiers / Audio Driver sections' `numericProps`): a vector's members
 * are listed as `<Property> · <Member>`.
 */
export function mirrorNumericTracks(layer: LayerInfo | undefined, tree: MirrorTreeLike | undefined): NumericTrackOption[] {
  if (!layer || !tree) return [];
  let byTree = numericCache.get(layer);
  if (!byTree) {
    byTree = new WeakMap();
    numericCache.set(layer, byTree);
  }
  const hit = byTree.get(tree);
  if (hit) return hit;
  const out: NumericTrackOption[] = [];
  const seen = new Set<string>();
  for (const info of tree.nodes.values()) {
    if (info.kind !== 'property' || !info.animatable || info.valueType === 'color') continue;
    const members = membersOf(info);
    for (const path of members) {
      if (seen.has(path)) continue;
      const meta = mirrorPropertyMeta(path, layer, tree);
      if (!NUMERIC_TYPES.has(meta.type)) continue;
      seen.add(path);
      const own = meta.label;
      out.push({ path, label: members.length > 1 && own !== info.name ? `${info.name} · ${own}` : info.name });
    }
  }
  byTree.set(tree, out);
  return out;
}
