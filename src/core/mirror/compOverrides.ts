/**
 * A placed composition's per-instance OVERRIDES (Essential Properties) read
 * from the document MIRROR (B4) — what the Inspector's Essential Properties
 * rows show. The mirror twins of `compInstanceOverrides`' `readCompOverrides`
 * and the section's inherited-value read. Pure: they take a mirror reader and
 * never touch the engine.
 *
 *   mirrorCompOverrides(m, instance)           the instance's overrides (`layer/compOverrides`), validated per property
 *   overrideSourceLayers(m, comp)              every layer of the referenced comp, walked back to front, parents first
 *   inheritedOverrideValue(m, source, prop, t) the value a source layer's property has WITHOUT an override
 *
 *   mirrorEssentialProps(m, comp)              the Essential Properties a comp PUBLISHES (`CompSettings.essentialProps`)
 *   mirrorCompositionRootOf(m, layer)          the outermost composition a layer sits in (`compositionRootOf`)
 *   mirrorEssentialPropsOf(m, layer)           the layer's own promoted properties (`pinnedProps.essentialPropsOf`)
 */

import { flicksToSeconds, secondsToFlicks, type LayerInfo, type Value } from '@motion/engine-api';
import {
  OVERRIDE_PROP_KINDS,
  isOverridableProp,
  isValidOverrideValue,
  overrideKey,
  parseOverrideKey,
  type OverridableProp,
  type OverrideValue,
} from '@core/scene/compInstanceOverrides';
import { jsonField, type MirrorFieldRead } from './layerFields';
import { childOrderOf, type MirrorTreeRead } from './layerTree';
import { readTrack, type MirrorRead } from './selection';
import { trackRefIn } from './trackIndex';

/** The API path of an instance's override record (json, fx.__compOverrides). */
export const COMP_OVERRIDES_PATH = 'layer/compOverrides';

const NO_OVERRIDES: ReadonlyMap<string, OverrideValue> = new Map();
const cache = new WeakMap<object, ReadonlyMap<string, OverrideValue>>();

/**
 * Every override stored on the instance layer (the twin of `readCompOverrides`):
 * keys `<origLayerId>/<prop>`, each validated for its property's kind (a
 * string under `x` would reach the renderer as NaN). Same map while the record
 * is unchanged.
 */
export function mirrorCompOverrides(m: Pick<MirrorFieldRead, 'property'>, instance: string): ReadonlyMap<string, OverrideValue> {
  const bag = jsonField<Record<string, unknown>>(m, instance, COMP_OVERRIDES_PATH);
  if (!bag || typeof bag !== 'object') return NO_OVERRIDES;
  const hit = cache.get(bag);
  if (hit) return hit;
  const out = new Map<string, OverrideValue>();
  for (const [k, v] of Object.entries(bag)) {
    const parsed = parseOverrideKey(k);
    if (parsed && isValidOverrideValue(parsed.prop, v)) out.set(k, v);
  }
  cache.set(bag, out);
  return out;
}

/**
 * Every layer under `root` (a composition id, or a layer), depth first in the
 * scene graph's child order (back to front), each before its children — the
 * walk the section used over `getChildren`.
 */
export function overrideSourceLayers(m: MirrorTreeRead, root: string): LayerInfo[] {
  const out: LayerInfo[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    for (const child of childOrderOf(m, id)) {
      if (seen.has(child)) continue;
      seen.add(child);
      const layer = m.layer(child);
      if (!layer) continue;
      out.push(layer);
      visit(child);
    }
  };
  visit(root);
  return out;
}

/** The layer's comp seconds for a time on its keyframe (layer-time) axis: the start time plus the stretched offset. */
export function layerToCompSeconds(layer: Pick<LayerInfo, 'timing'>, layerSeconds: number): number {
  const stretch = layer.timing.stretch > 0 ? layer.timing.stretch : 1;
  return flicksToSeconds(layer.timing.startTime) + layerSeconds * stretch;
}

const hex2 = (v: number): string => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');

function textOf(v: Value | undefined): string | undefined {
  if (v?.kind === 'textDocument') return v.value.text;
  if (v?.kind === 'string') return v.value;
  return undefined;
}

/**
 * What `prop` of source layer `source` is WITHOUT an override, at comp
 * seconds `t` of the source's own composition (undefined when the layer has
 * no such property — the caller shows its fallback):
 *   number  the track's value (animated or static), stored units
 *   color   `#rrggbb` of the colour property (the `<prop>_r/_g/_b` channels)
 *   text    the Source Text's string (static — a string has no track)
 */
export function inheritedOverrideValue(
  m: MirrorRead & Pick<MirrorFieldRead, 'property'>,
  source: string,
  prop: OverridableProp,
  t: number,
): OverrideValue | undefined {
  const kind = OVERRIDE_PROP_KINDS[prop];
  if (kind === 'number') return readTrack(m, source, prop, t);
  if (kind === 'text') return textOf(m.property(source, 'text/sourceText')?.value);
  const ref = trackRefIn(m.tree(source), `${prop}_r`);
  if (!ref) return undefined;
  const info = ref.info;
  const v = info.animated ? m.valueAt(source, ref.path, secondsToFlicks(t)) : info.value;
  if (v?.kind !== 'color') return undefined;
  return `#${hex2(v.value.r)}${hex2(v.value.g)}${hex2(v.value.b)}`;
}

// ── Published Essential Properties (B4: `CompSettings.essentialProps`) ─────

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorEssentialRead {
  layer(id: string): LayerInfo | undefined;
  comp(id: string): { readonly settings: { readonly essentialProps?: readonly string[] } } | undefined;
}

const NO_KEYS: ReadonlySet<string> = new Set();
const keyCache = new WeakMap<readonly string[], ReadonlySet<string>>();

/**
 * Every property published on this composition (the twin of `readEssentialProps`):
 * `<origLayerId>/<prop>` keys whose property can be overridden. Empty when none.
 */
export function mirrorEssentialProps(m: MirrorEssentialRead, compId: string | null | undefined): ReadonlySet<string> {
  const raw = compId ? m.comp(compId)?.settings.essentialProps : undefined;
  if (!raw || raw.length === 0) return NO_KEYS;
  const hit = keyCache.get(raw);
  if (hit) return hit;
  const out = new Set<string>();
  for (const k of raw) {
    const parsed = parseOverrideKey(k);
    if (parsed && isOverridableProp(parsed.prop)) out.add(k);
  }
  keyCache.set(raw, out);
  return out;
}

/**
 * The OUTERMOST composition `id` sits in — through a legacy nested precomp group,
 * which is both a layer and a composition — the twin of `compositionRootOf`
 * (the scene graph's root). A composition id is its own root; null when unknown.
 */
export function mirrorCompositionRootOf(m: MirrorEssentialRead, id: string): string | null {
  let layer = m.layer(id);
  if (!layer) return m.comp(id) ? id : null;
  for (let guard = 0; guard < 64; guard++) {
    const host = m.layer(layer.comp);
    if (!host) return layer.comp || null;
    layer = host;
  }
  return null;
}

/** The properties of `layerId` promoted on its composition (the twin of `pinnedProps.essentialPropsOf`). */
export function mirrorEssentialPropsOf(m: MirrorEssentialRead, layerId: string): string[] {
  const root = mirrorCompositionRootOf(m, layerId);
  if (!root || root === layerId) return [];
  const out: string[] = [];
  for (const key of mirrorEssentialProps(m, root)) {
    const parsed = parseOverrideKey(key);
    if (parsed && parsed.origNodeId === layerId) out.push(parsed.prop);
  }
  return out;
}

/** Whether `prop` of `layerId` is published on composition `root` (`isEssentialProp`). */
export function mirrorIsEssentialProp(m: MirrorEssentialRead, root: string, layerId: string, prop: string): boolean {
  return mirrorEssentialProps(m, root).has(overrideKey(layerId, prop));
}
