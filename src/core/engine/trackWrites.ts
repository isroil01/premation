/**
 * Track-name writes as engine commands — shared by the automation clients
 * (B5, docs/ENGINE_API.md §12): the AI tool facades (src/core/ai/toolContext.ts)
 * and the plugin host (src/core/plugins/hostApi.ts) both speak the legacy
 * TRACK names (`x`, `opacity`, `effect.<id>.<key>`) and both must land the
 * same command the UI sends, so they build them here, in one place.
 *
 * Every builder returns null when the API cannot say EXACTLY what the legacy
 * writer does; the caller then keeps its named legacy fallback.
 */

import { secondsToFlicks, type Command, type Easing, type MatteMode, type PropRef, type Value } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { effectDefFor, parseColorChannels } from '@core/effects/effects';
import { mirrorEffectHeaders } from '@core/mirror/effects';
import { useProjectStore } from '@stores/projectStore';
import type { TrackMatte } from '@core/effects/matte';
import {   propRefForTrack } from './propRefs';
import { apiUnitFactor } from './props';

const POSITION_DIMS = new Set(['x', 'y', 'z']);

/** Where a track's keys go on the API: its property, whether Position must be separated first, the member. */
export interface KeyTarget {
  ref: PropRef;
  separate: boolean;
  member: string;
}

/**
 * The ONE engine property a track name keys on its own: a single-member scalar
 * property, or one dimension of Position (which the engine separates first,
 * AE's Separate Dimensions — the storage is per-dimension either way).
 */
export function keyTargetFor(nodeId: string, track: string): KeyTarget | null {
  if (!documentMirror().layer(nodeId)) return null;
  const r = propRefForTrack(nodeId, track);
  if (!r || !r.animatable) return null;
  if (r.members.length === 1 && r.members[0] === track && r.valueType === 'scalar') {
    return { ref: r.ref, separate: false, member: track };
  }
  if (POSITION_DIMS.has(track) && r.ref.path === 'transform/position' && r.members.includes(track)) {
    return { ref: { layer: nodeId, path: `transform/position/${track}` }, separate: true, member: track };
  }
  return null;
}

/**
 * An EXISTING key of `track` is its own API key: always for a single-member
 * property; for a Position dimension only once dimensions are separated
 * (merged, the API key is the whole vector — patching it would touch the
 * other dimensions too).
 */
export function keyAddressable(nodeId: string, track: string, target: KeyTarget): boolean {
  return !target.separate || propRefForTrack(nodeId, track)?.ref.path === target.ref.path;
}

/** Position ▸ Separate Dimensions, the command a per-dimension key needs first. */
export function separateDimensionsCommand(nodeId: string): Command {
  return { type: 'setDimensionsSeparated', layer: nodeId, path: 'transform/position', separated: true } as Command;
}

/** '#rgb' / '#rrggbb' / '#rrggbbaa' → an API colour value, or null. */
export function apiColorOfHex(s: string): Value | null {
  if (!/^#?[0-9a-fA-F]{3,8}$/.test(s.trim())) return null;
  const [r, g, b, a] = parseColorChannels(s);
  return { kind: 'color', value: { r, g, b, a } };
}

/**
 * The engine command for an effect parameter write (`effects/<id>/<key>`), or
 * null when the API does not take it (an unknown binding or option). An
 * animated param takes a key at comp time `seconds` (AE setValue on a keyed
 * property); a static one ignores the time.
 */
export function effectParamCommand(
  nodeId: string,
  effectId: string,
  key: string,
  value: number | string | boolean,
  seconds: number,
): Command[] | null {
  // The effect's type from the mirror (the `effects/<id>` group's match name).
  const effect = mirrorEffectHeaders(documentMirror().tree(nodeId)).find((e) => e.id === effectId);
  if (!effect) return null;
  const ref: PropRef = { layer: nodeId, path: `effects/${effectId}/${key}` };
  const time = secondsToFlicks(seconds);
  // A dropdown given BY VALUE (the stored option value, as a number or its
  // string) or by label: the API takes the option's label (G1).
  const def = effectDefFor(effect.type)?.params.find((p) => p.key === key);
  if (def?.type === 'enum') {
    const opt = def.options?.find((o) => String(o.value) === String(value) || o.label === value);
    return opt ? [{ type: 'setProperty', prop: ref, value: { kind: 'choice', value: opt.label } } as Command] : null;
  }
  if (typeof value === 'number') {
    const member = `effect.${effectId}.${key}`;
    const r = propRefForTrack(nodeId, member);
    if (!r || r.members.length !== 1 || r.members[0] !== member) return null;
    return [{ type: 'setProperty', prop: r.ref, value: { kind: 'scalar', value: value * apiUnitFactor(member) }, time } as Command];
  }
  if (typeof value === 'boolean') {
    const r = propRefForTrack(nodeId, ref.path);
    if (!r || r.valueType !== 'bool') return null;
    return [{ type: 'setProperty', prop: ref, value: { kind: 'bool', value } } as Command];
  }
  const color = apiColorOfHex(value);
  if (!color) return null;
  const r = propRefForTrack(nodeId, `effect.${effectId}.${key}_r`) ?? propRefForTrack(nodeId, ref.path);
  if (!r || r.valueType !== 'color') return null;
  return [{ type: 'setProperty', prop: r.ref, value: color, time } as Command];
}

/** Easings the API takes by name (the rest keep their legacy writer). */
export const ENGINE_EASINGS: ReadonlySet<string> = new Set<Easing>([
  'linear', 'hold', 'bezier', 'ease', 'easeIn', 'easeOut', 'easeInOut', 'step', 'autoBezier', 'continuousBezier',
]);

/** The active composition's playhead, comp seconds — the time a write on an animated property keys at. */
export function activePlayheadSeconds(): number {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId ?? '']?.time ?? 0;
}

/**
 * A layer's track matte as `setTrackMatte`. The API addresses a matte BY
 * REFERENCE (AE 2023); a stored matte with no explicit source is AE's classic
 * positional "Layer Above" matte (no `matte.layer`). `undefined` = none.
 */
export function trackMatteCommand(layer: string, matte: TrackMatte | undefined): Command {
  if (!matte) return { type: 'setTrackMatte', layer, matte: { mode: 'none' } } as Command;
  const base = matte.mode === 'luma' ? 'luma' : 'alpha';
  const mode = (matte.inverted ? `${base}Inverted` : base) as MatteMode;
  return { type: 'setTrackMatte', layer, matte: { ...(matte.sourceId ? { layer: matte.sourceId } : {}), mode } } as Command;
}
