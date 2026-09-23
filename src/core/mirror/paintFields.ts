/**
 * A layer's PAINT (fill paint, fill stack, stroke stack, gradient stops) read
 * from the document MIRROR (B4) — what the Inspector's Fill & Stroke rows show.
 * The mirror twins of `getNodeFill` / `getNodeFills` / `getNodeStrokes` /
 * `getNodeStrokeAt` (paint/fill.ts, paint/stroke.ts). Pure: they take a mirror
 * reader and never touch the engine.
 *
 *   mirrorFill(m, layer)            the primary fill paint (`layer/fillPaint`, else the solid `layer/fill` colour)
 *   mirrorFills(m, layer)           the whole fill stack (`layer/fills`, else [primary])
 *   mirrorStrokes(m, layer)         the stroke stack (`layer/strokes`: normalised, disabled entries included)
 *   mirrorStrokeAt(m, layer, i)     one entry of it
 *   mirrorFillStopsAt(m, layer, t)  the fill's colour stops at comp time `t` (flicks) — the keyframed `layer/fillStops`
 *   paintPropertyMeta(m, layer, t)  `mirrorPropertyMeta` plus the stroke-stack units (taper Length Units, wave Units)
 */

import type { Value } from '@motion/engine-api';
import type { ColorStop, FillPaint } from '@core/paint/fill';
import type { Stroke } from '@core/paint/stroke';
import { resolvePropertyMeta, type PropertyMeta } from '@core/inspector/propertyMeta';
import { mirrorMetaFacts } from './metaFacts';
import { fieldValue, jsonField, type MirrorFieldRead } from './layerFields';

type PaintRead = Pick<MirrorFieldRead, 'property'>;

const PAINT_TYPES = new Set(['solid', 'linear', 'radial']);

function isFillPaint(v: unknown): v is FillPaint {
  return !!v && typeof v === 'object' && PAINT_TYPES.has((v as { type?: unknown }).type as string);
}

const hex2 = (n: number): string => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0');

/** A 0..1 colour as `#rrggbb` (`#rrggbbaa` when not opaque). */
export function channelsToHex(c: { r: number; g: number; b: number; a: number }): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a < 1 ? hex2(c.a) : ''}`;
}

/** The hex of a `color` Value, undefined for any other kind. */
export function colorValueHex(v: Value | undefined): string | undefined {
  return v?.kind === 'color' ? channelsToHex(v.value) : undefined;
}

/**
 * The layer's PRIMARY fill paint (`getNodeFill`): the paint object
 * (`layer/fillPaint`), else — a layer whose fill is a plain colour — a solid
 * paint of `layer/fill`. A text layer's `layer/fill` is its Character colour,
 * not a paint, so it has none (as `readNodeFill` reads it).
 */
export function mirrorFill(m: PaintRead & Pick<MirrorFieldRead, 'layer'>, layer: string): FillPaint | undefined {
  const paint = jsonField<unknown>(m, layer, 'layer/fillPaint');
  if (isFillPaint(paint)) return paint;
  if (m.layer(layer)?.kind === 'text') return undefined;
  const hex = colorValueHex(m.property(layer, 'layer/fill')?.value);
  return hex ? { type: 'solid', color: hex } : undefined;
}

const stackCache = new WeakMap<object, FillPaint[]>();

/** The layer's fill STACK (`getNodeFills`): `layer/fills` when it holds any paint, else the primary as a one-entry stack. */
export function mirrorFills(m: PaintRead & Pick<MirrorFieldRead, 'layer'>, layer: string): FillPaint[] {
  const raw = jsonField<unknown>(m, layer, 'layer/fills');
  if (Array.isArray(raw)) {
    let valid = stackCache.get(raw);
    if (!valid) {
      valid = raw.filter(isFillPaint);
      stackCache.set(raw, valid);
    }
    if (valid.length > 0) return valid;
  }
  const single = mirrorFill(m, layer);
  return single ? [single] : [];
}

const NO_STROKES: Stroke[] = [];

/** The stroke STACK (`getNodeStrokes`): normalised by the engine, disabled entries included. */
export function mirrorStrokes(m: PaintRead, layer: string): Stroke[] {
  const raw = jsonField<unknown>(m, layer, 'layer/strokes');
  return Array.isArray(raw) ? (raw as Stroke[]) : NO_STROKES;
}

/** Stroke `index` of the stack (`getNodeStrokeAt`), or undefined. */
export function mirrorStrokeAt(m: PaintRead, layer: string, index: number): Stroke | undefined {
  return mirrorStrokes(m, layer)[index];
}

/** The API path of the primary fill's colour stops (AE Gradient Fill ▸ Colors; keyed on `fill.stops`). */
export const FILL_STOPS_PATH = 'layer/fillStops';

/**
 * The fill's colour stops as a `gradient` Value turns them into (offset order,
 * hex colours; ids are positional — a keyed stop list has no stop ids).
 */
export function gradientValueStops(v: Value | undefined): ColorStop[] | undefined {
  if (v?.kind !== 'gradient') return undefined;
  return v.value.stops.map((s, i) => ({ id: `anim_${i}`, offset: s.offset, color: channelsToHex(s.color) }));
}

/** The layer's width / height fields (`layer/width`, `layer/height`), when it has them. */
export function mirrorLayerSize(m: PaintRead, layer: string): { width: number; height: number } | undefined {
  const w = fieldValue(m, layer, 'layer/width');
  const h = fieldValue(m, layer, 'layer/height');
  return typeof w === 'number' && typeof h === 'number' ? { width: w, height: h } : undefined;
}

/**
 * Property metadata for a paint track on a mirror layer: `mirrorPropertyMeta`'s
 * facts plus the stroke stack, so a taper length in Pixels reads px (not %) and
 * a wavelength in Cycles reads a count — the units the registry takes from the
 * layer (propertyMeta.ts `withStrokeUnits`).
 */
export function paintPropertyMeta(m: MirrorFieldRead, layer: string, track: string): PropertyMeta {
  const info = m.layer(layer);
  const facts = mirrorMetaFacts(info, info ? m.tree(layer) : undefined);
  if (!facts) return resolvePropertyMeta(track);
  return resolvePropertyMeta(track, { ...facts, strokeAt: (i) => mirrorStrokeAt(m, layer, i) });
}
