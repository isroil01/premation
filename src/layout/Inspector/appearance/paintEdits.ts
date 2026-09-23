/**
 * Paint writes over the engine API (G1): a layer's primary fill paint
 * (`layer/fillPaint`), its fill stack (`layer/fills`) and a text layer's
 * gradient stroke paint (`text/strokePaint`) are json fields — the panel
 * computes the next paint (a type switch, a colour, a stop, a composite mode)
 * and sends it whole, ONE undo entry per action (docs/B3_PATTERNS.md §6).
 */

import type { FillPaint } from '@core/paint/fill';
import { edit } from '@core/engine/uiEdits';
import { fieldCommands } from '@layout/Text/textEdits';

/** The layer's primary fill := `paint` (undefined = no fill; with a stack, its first entry). */
export function setFillPaintEdit(label: string, nodeId: string, paint: FillPaint | undefined): Promise<unknown> {
  return edit(label, fieldCommands(nodeId, 'layer/fillPaint', paint ?? null));
}

/** The layer's whole fill stack (the primary is its first entry). */
export function setFillsEdit(label: string, nodeId: string, fills: ReadonlyArray<FillPaint>): Promise<unknown> {
  return edit(label, fieldCommands(nodeId, 'layer/fills', [...fills]));
}

/** A text layer's stroke paint (undefined = the solid Stroke Color). */
export function setTextStrokePaintEdit(label: string, nodeId: string, paint: FillPaint | undefined): Promise<unknown> {
  return edit(label, fieldCommands(nodeId, 'text/strokePaint', paint ?? null));
}
