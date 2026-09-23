/**
 * Paint writes over the engine API (G1, B3z): a layer's primary fill paint
 * (`layer/fillPaint`), its fill stack (`layer/fills`), its stroke stack
 * (`layer/strokes`) and a text layer's gradient stroke paint
 * (`text/strokePaint`) are json fields — the panel computes the next paint (a
 * type switch, a colour, a stop, a composite mode) and sends it whole, ONE undo
 * entry per action (docs/B3_PATTERNS.md §6). The primary fill's colour stops
 * are also `layer/fillStops` (a gradient Value, keyframeable).
 */

import type { Command, Value } from '@motion/engine-api';
import type { ColorStop, FillPaint } from '@core/paint/fill';
import { defaultStroke, getNodeStrokes, normalizeStroke, type Stroke } from '@core/paint/stroke';
import { parseColorChannels } from '@core/effects/effects';
import { isLayer } from '@core/engine/doc';
import { compTime } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { fieldCommands } from '@layout/Text/textEdits';

/** The layer's primary fill := `paint` (undefined = no fill; with a stack, its first entry). */
export function fillPaintCommands(nodeId: string, paint: FillPaint | undefined): Command[] {
  return fieldCommands(nodeId, 'layer/fillPaint', paint ?? null);
}

export function setFillPaintEdit(label: string, nodeId: string, paint: FillPaint | undefined): Promise<unknown> {
  return edit(label, fillPaintCommands(nodeId, paint));
}

/** The layer's whole fill stack (the primary is its first entry). */
export function setFillsEdit(label: string, nodeId: string, fills: ReadonlyArray<FillPaint>): Promise<unknown> {
  return edit(label, fieldCommands(nodeId, 'layer/fills', [...fills]));
}

/** A text layer's stroke paint (undefined = the solid Stroke Color). */
export function textStrokePaintCommands(nodeId: string, paint: FillPaint | undefined): Command[] {
  return fieldCommands(nodeId, 'text/strokePaint', paint ?? null);
}

export function setTextStrokePaintEdit(label: string, nodeId: string, paint: FillPaint | undefined): Promise<unknown> {
  return edit(label, textStrokePaintCommands(nodeId, paint));
}

/** The whole stroke stack (`layer/strokes`); the engine normalises each entry. */
export function strokesCommands(nodeId: string, strokes: ReadonlyArray<Stroke>): Command[] {
  return isLayer(nodeId) ? fieldCommands(nodeId, 'layer/strokes', [...strokes]) : [];
}

/**
 * The whole stack with stroke `index` patched, as the `layer/strokes` write
 * (`updateNodeStrokeAt`'s rule: index 0 is created from the default when the
 * layer has none; a higher index that does not exist writes nothing).
 */
export function strokePatchCommands(nodeId: string, index: number, patch: Partial<Stroke>): Command[] {
  if (!isLayer(nodeId)) return [];
  const stack = getNodeStrokes(nodeId);
  if (index > 0 && !stack[index]) return [];
  const next = stack.length > 0 ? [...stack] : [defaultStroke()];
  next[index] = normalizeStroke({ ...(next[index] ?? defaultStroke()), ...patch });
  return strokesCommands(nodeId, next);
}

/** A stroke patch as ONE undo entry. */
export function strokeEdit(label: string, nodeId: string, index: number, patch: Partial<Stroke>): Promise<unknown> {
  return edit(label, strokePatchCommands(nodeId, index, patch));
}

/** Colour stops as the API's `gradient` Value (offset order; `kind` is informational). */
export function stopsValue(stops: ReadonlyArray<Pick<ColorStop, 'offset' | 'color'>>, kind: 'linear' | 'radial' = 'linear'): Value {
  return {
    kind: 'gradient',
    value: {
      kind,
      stops: stops.map((s) => {
        const [r, g, b, a] = parseColorChannels(s.color);
        return { offset: s.offset, color: { r, g, b, a } };
      }),
      alphaStops: [],
    },
  };
}

/** Gradient Fill ▸ Colors at the playhead (`layer/fillStops`: a key when keyframed, else the paint's stops). */
export function fillStopsCommands(nodeId: string, stops: ReadonlyArray<Pick<ColorStop, 'offset' | 'color'>>, seconds: number): Command[] {
  if (!isLayer(nodeId)) return [];
  return [{ type: 'setProperty', prop: { layer: nodeId, path: 'layer/fillStops' }, value: stopsValue(stops), time: compTime(seconds) }];
}

/** The Colors stopwatch (`setAnimated`). */
export function fillStopsStopwatch(nodeId: string, animated: boolean, seconds: number): Command[] {
  if (!isLayer(nodeId)) return [];
  return [{ type: 'setAnimated', prop: { layer: nodeId, path: 'layer/fillStops' }, animated, time: compTime(seconds) }];
}
