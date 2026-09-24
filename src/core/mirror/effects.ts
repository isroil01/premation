/**
 * A layer's EFFECT STACK read from its mirror property tree (B4) — the twin
 * of `getNodeEffects` (core/effects/effects.ts) for the Effects panels. Pure:
 * takes a mirror tree and never touches the engine.
 *
 *   mirrorEffectHeaders(tree)            id / type / enabled per applied effect, stack order
 *   mirrorEffectParam(tree, id, param)   one parameter's STATIC value in the stored form
 *                                        (numbers in stored units, colours `#rrggbb[aa]`,
 *                                        enums by value, curves as point lists)
 *   mirrorEffects(tree)                  the stack as `Effect` records (params, Compositing
 *                                        Options, label) — what the panels were written against
 *
 * The tree lists every applied effect as a group `effects/<id>` (matchName =
 * the effect type, `enabled` = its fx switch) — expression controls
 * (`effects/ctrl_<name>`) share the group and are not effects. Numeric and
 * colour parameters are properties keyed on `effect.<id>.<key>`; the others
 * (menus, checkboxes, layer / mask pickers, curves) are `effects/<id>/<key>`
 * fields; Compositing Options are `effects/<id>/compositing/{opacity,mask,label}`.
 */

import type { PropertyInfo } from '@motion/engine-api';
import {
  effectDefFor,
  effectPropPath,
  type Effect,
  type EffectParamDef,
  type EffectParamValue,
  type EffectType,
} from '@core/effects/effects';
import { plainValue, storedNumber, trackRefIn, type MirrorTreeLike } from './trackIndex';

/** Expression controls' group-id prefix (engine/controlSpecs.ts `CONTROL_PREFIX`). */
const CONTROL_PREFIX = 'ctrl_';

export interface MirrorEffectHeader {
  id: string;
  type: string;
  enabled: boolean;
}

const headerCache = new WeakMap<object, MirrorEffectHeader[]>();

/** The applied effects, in stack order (the `effects` group's children, controls excluded). */
export function mirrorEffectHeaders(tree: MirrorTreeLike | undefined): MirrorEffectHeader[] {
  if (!tree) return [];
  const hit = headerCache.get(tree);
  if (hit) return hit;
  const out: MirrorEffectHeader[] = [];
  for (const path of tree.nodes.get('effects')?.children ?? []) {
    const id = path.slice('effects/'.length);
    if (id.startsWith(CONTROL_PREFIX)) continue;
    const g = tree.nodes.get(path);
    if (!g) continue;
    out.push({ id, type: g.matchName, enabled: g.enabled !== false });
  }
  headerCache.set(tree, out);
  return out;
}

const hex2 = (n: number): string => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0');

function colorHex(info: PropertyInfo | undefined): string | undefined {
  const v = info?.value;
  if (v?.kind !== 'color') return undefined;
  const { r, g, b, a } = v.value;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a) : ''}`;
}

/**
 * One parameter's static value in the form the effect stores it, or undefined
 * when the layer's tree does not carry it (the caller falls back to the
 * definition's default, as `paramsOf` does).
 */
export function mirrorEffectParam(tree: MirrorTreeLike | undefined, effectId: string, param: EffectParamDef): EffectParamValue | undefined {
  if (!tree) return undefined;
  if (param.type === 'number') {
    const r = trackRefIn(tree, effectPropPath(effectId, param.key));
    if (!r) return undefined;
    if (r.info.valueType === 'choice') {
      const label = plainValue(r.info.value);
      return param.options?.find((o) => o.label === label)?.value;
    }
    return storedNumber(r, r.info.value);
  }
  if (param.type === 'color') {
    return colorHex(trackRefIn(tree, `${effectPropPath(effectId, param.key)}_r`)?.info);
  }
  const info = tree.nodes.get(`effects/${effectId}/${param.key}`);
  if (!info) return undefined;
  const v = plainValue(info.value);
  switch (param.type) {
    case 'checkbox': return v === true;
    case 'enum': return param.options?.find((o) => o.label === v)?.value;
    case 'layer':
    case 'maskPath':
      return typeof v === 'string' ? v : '';
    case 'curve': return Array.isArray(v) ? (v as EffectParamValue) : undefined;
    default: return undefined;
  }
}

/** Compositing Options: Effect Opacity (absent at 100), Effect Mask and the label colour ('' = none). */
export function mirrorEffectCompositing(tree: MirrorTreeLike | undefined, effectId: string): Pick<Effect, 'opacity' | 'maskId' | 'labelColor'> {
  const out: Pick<Effect, 'opacity' | 'maskId' | 'labelColor'> = {};
  if (!tree) return out;
  const op = plainValue(tree.nodes.get(`effects/${effectId}/compositing/opacity`)?.value);
  if (typeof op === 'number' && Number.isFinite(op) && op !== 100) out.opacity = op;
  const mask = plainValue(tree.nodes.get(`effects/${effectId}/compositing/mask`)?.value);
  if (typeof mask === 'string' && mask !== '') out.maskId = mask;
  const label = plainValue(tree.nodes.get(`effects/${effectId}/compositing/label`)?.value);
  if (typeof label === 'string' && label !== '') out.labelColor = label;
  return out;
}

const stackCache = new WeakMap<object, Effect[]>();

/**
 * The stack as `Effect` records: the header, every declared parameter the tree
 * carries (static values, stored form) and the Compositing Options. An effect
 * whose definition is not installed keeps its header alone. Same array per
 * tree record.
 */
export function mirrorEffects(tree: MirrorTreeLike | undefined): Effect[] {
  if (!tree) return [];
  const hit = stackCache.get(tree);
  if (hit) return hit;
  const out: Effect[] = mirrorEffectHeaders(tree).map((h) => {
    const def = effectDefFor(h.type);
    const params: Record<string, EffectParamValue> = {};
    for (const p of def?.params ?? []) {
      if (p.type === 'resolved') continue;
      const v = mirrorEffectParam(tree, h.id, p);
      if (v !== undefined) params[p.key] = v;
    }
    return {
      id: h.id,
      type: h.type as EffectType,
      ...(def ? { params } : {}),
      ...(h.enabled ? {} : { enabled: false }),
      ...mirrorEffectCompositing(tree, h.id),
    };
  });
  stackCache.set(tree, out);
  return out;
}

export interface MirrorMaskHeader {
  id: string;
  /** The mask's name as the tree names it (`Mask N` when it has none of its own). */
  name: string;
  /** Mode other than None — the mask also cuts the layer (the group's `enabled`). */
  cuts: boolean;
}

/** The layer's masks in stack order (`masks/<id>` groups) — what an Effect Mask / mask-path picker lists. */
export function mirrorMaskHeaders(tree: MirrorTreeLike | undefined): MirrorMaskHeader[] {
  if (!tree) return [];
  const out: MirrorMaskHeader[] = [];
  for (const path of tree.nodes.get('masks')?.children ?? []) {
    const g = tree.nodes.get(path);
    if (!g) continue;
    out.push({ id: path.slice('masks/'.length), name: g.name, cuts: g.enabled !== false });
  }
  return out;
}
