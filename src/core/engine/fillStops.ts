/**
 * `layer/fillStops` (B3z, ENGINE_API.md §15.9) — AE's Gradient Fill ▸ Colors:
 * the primary fill's colour stops as ONE keyframeable property of the API's
 * `gradient` Value.
 *
 *   present      while the primary fill (`fx.fill`) is linear / radial, or the
 *                `fill.stops` data track exists (keys outlive a type switch)
 *   static       the paint's colour stops (sorted by offset); a write replaces
 *                them, keeping the i-th stored stop's id for the i-th written
 *                stop and minting `gs<i>` for the rest (never colliding)
 *   keys         the `fill.stops` data track (kind `gradientStops`, values
 *                `[{pos, color: hex}]` — what buildSnapshot samples)
 *   stopwatch    `setAnimated` (on: one key holding the static stops; off: the
 *                stops at that time become the static paint)
 *
 * Only `gradient` Values are accepted (the old unclaimed data-track path
 * `layer/fill.stops` took nothing usable). `kind` of a written value is
 * ignored — the paint type is `layer/fillPaint`'s; `alphaStops` are read as
 * empty and ignored on write: opacity stops stay static paint json
 * (`layer/fillPaint.opacityStops`), not keyframeable.
 *
 * The C++ engine ports this file (native/engine/src/core/strokes.cpp).
 */

import type { Gradient, Value } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import { defaultAnimation } from '@motion/animation';
import { parseColorChannels, channelsToColor } from '@core/effects/effects';
import { fail } from './errors';
import type { PropBinding } from './props';

export const FILL_STOPS_TRACK = 'fill.stops';

interface StoredStop { id?: unknown; offset?: unknown; color?: unknown }

function primaryFill(node: SceneNode): Record<string, unknown> | undefined {
  const fx = node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
  const f = fx?.fill;
  return f && typeof f === 'object' && !Array.isArray(f) ? f as Record<string, unknown> : undefined;
}

function gradientKind(node: SceneNode): 'linear' | 'radial' | undefined {
  const t = primaryFill(node)?.type;
  return t === 'linear' || t === 'radial' ? t : undefined;
}

export function fillStopsBinding(node: SceneNode, layerId: string): PropBinding | undefined {
  if (!gradientKind(node) && !defaultAnimation.getDataTrack(layerId, FILL_STOPS_TRACK)) return undefined;
  return {
    path: 'layer/fillStops', name: 'Colors', matchName: 'ADBE Vector Grad Colors', valueType: 'gradient', members: [],
    dataTrack: FILL_STOPS_TRACK, special: 'fillStops', animatable: true, unit: '',
  };
}

const colorOf = (hex: unknown): { r: number; g: number; b: number; a: number } => {
  const [r, g, b, a] = parseColorChannels(typeof hex === 'string' ? hex : '#000000');
  return { r, g, b, a };
};

function gradientValue(kind: 'linear' | 'radial', stops: ReadonlyArray<{ offset: number; color: unknown }>): Value {
  const g: Gradient = { kind, stops: stops.map((s) => ({ offset: s.offset, color: colorOf(s.color) })), alphaStops: [] };
  return { kind: 'gradient', value: g };
}

/** The paint's stops, sorted by offset (fill.ts `sortedStops`: stable for equal offsets). */
function storedStops(node: SceneNode): StoredStop[] {
  const raw = primaryFill(node)?.stops;
  const list = Array.isArray(raw) ? (raw as StoredStop[]).filter((s) => !!s && typeof s === 'object') : [];
  return list
    .map((s, i) => ({ s, i }))
    .sort((x, y) => (Number(x.s.offset) - Number(y.s.offset)) || (x.i - y.i))
    .map((x) => x.s);
}

export function readFillStopsStatic(node: SceneNode): Value {
  return gradientValue(gradientKind(node) ?? 'linear', storedStops(node).map((s) => ({
    offset: typeof s.offset === 'number' ? s.offset : 0, color: s.color,
  })));
}

/** The written stops (type-checked), in value order. */
function writtenStops(b: PropBinding, value: Value): Array<{ offset: number; color: string }> {
  if (value.kind !== 'gradient') fail('typeMismatch', `'${b.path}' takes a gradient, got ${value.kind}`, { path: b.path, detail: JSON.stringify({ expected: 'gradient' }) });
  return value.value.stops.map((s) => {
    const c = s.color;
    if (![s.offset, c.r, c.g, c.b, c.a].every(Number.isFinite)) fail('invalidArgument', `'${b.path}': stops must be finite`, { path: b.path });
    return { offset: Math.max(0, Math.min(1, s.offset)), color: channelsToColor(c.r, c.g, c.b, c.a) };
  });
}

/** The primary fill's stops := `value` (setPrimaryFill writes the paint back). */
export function writeFillStopsStatic(
  layerId: string,
  node: SceneNode,
  b: PropBinding,
  value: Value,
  setPrimaryFill: (layerId: string, node: SceneNode, paint: unknown) => void,
): void {
  const next = writtenStops(b, value);
  const paint = primaryFill(node);
  if (!gradientKind(node) || !paint) fail('invalidArgument', `layer '${layerId}' has no gradient fill`, { layer: layerId, path: b.path });
  const old = storedStops(node);
  const ids = new Set(old.map((s) => s.id).filter((x): x is string => typeof x === 'string'));
  const stops = next.map((s, i) => {
    let id = typeof old[i]?.id === 'string' ? old[i]!.id as string : undefined;
    if (id === undefined) {
      let n = i;
      while (ids.has(`gs${n}`)) n += 1;
      id = `gs${n}`;
      ids.add(id);
    }
    return { id, offset: s.offset, color: s.color };
  });
  setPrimaryFill(layerId, node, { ...paint, stops });
}

/** A data-key value (`[{pos, color}]`) → the API gradient. */
export function fillStopsKeyToApi(node: SceneNode, v: unknown): Value {
  const list = Array.isArray(v) ? v as Array<{ pos?: unknown; color?: unknown }> : [];
  return gradientValue(gradientKind(node) ?? 'linear', list.map((s) => ({ offset: typeof s.pos === 'number' ? s.pos : 0, color: s.color })));
}

/** The API gradient → a data-key value, sorted by position. */
export function apiToFillStopsKey(b: PropBinding, value: Value): Array<{ pos: number; color: string }> {
  return writtenStops(b, value)
    .map((s, i) => ({ s, i }))
    .sort((x, y) => (x.s.offset - y.s.offset) || (x.i - y.i))
    .map(({ s }) => ({ pos: s.offset, color: s.color }));
}
