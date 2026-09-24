/**
 * The Paint tool's and Paint panel's document edits as engine commands (B3):
 * each is ONE `edit` = one undo entry; a typed error is toasted and changes
 * nothing. The stroke rules live in @core/paint/paintCommit (`planPaintDrag`);
 * the commands in handlers/strokes.ts (ENGINE_API.md §4.7).
 */

import { secondsToFlicks, type CommandResult, type EngineResult } from '@motion/engine-api';
import { getNodePaint } from '@core/paint/paintStrokes';
import { planPaintDrag, type PaintCommitResult, type PaintDrag } from '@core/paint/paintCommit';
import { edit } from './uiEdits';

/** A finished Paint / Clone Stamp / Eraser drag. `reason` is set when the drag was refused before sending. */
export async function commitPaintDrag(d: PaintDrag): Promise<PaintCommitResult> {
  const plan = planPaintDrag(d);
  if (!plan.ok) return plan;
  const res = await edit(plan.label, plan.commands);
  // A typed error was already toasted by `edit`.
  if (!res.ok) return { ok: false, reason: '' };
  const added = (res.value[0] as { stroke?: string } | undefined)?.stroke;
  return { ok: true, strokeId: plan.strokeId ?? added ?? '' };
}

/** The stroke's video switch. */
export function setPaintStrokeVisible(layer: string, stroke: string, visible: boolean): Promise<EngineResult<CommandResult[]>> {
  return edit(visible ? 'Show Paint Stroke' : 'Hide Paint Stroke', {
    type: 'updatePaintStroke', layer, stroke, patch: JSON.stringify({ visible: visible ? null : false }),
  });
}

/** The Path stopwatch; `seconds` is the playhead (comp time). */
export function setPaintPathAnimated(layer: string, stroke: string, animated: boolean, seconds: number): Promise<EngineResult<CommandResult[]>> {
  return edit(animated ? 'Enable Path Animation' : 'Disable Path Animation', {
    type: 'setPaintPathAnimated', layer, stroke, animated, time: secondsToFlicks(seconds),
  });
}

export function deletePaintStroke(layer: string, stroke: string): Promise<EngineResult<CommandResult[]>> {
  return edit('Delete Paint Stroke', { type: 'removePaintStrokes', layer, strokes: [stroke] });
}

/** Tool Options ▸ Undo last stroke: delete the layer's most recent stroke (no strokes: nothing happens). */
export async function removeLastPaintStroke(layer: string): Promise<void> {
  const last = getNodePaint(layer)?.strokes.at(-1);
  if (!last) return;
  await edit('Remove Last Stroke', { type: 'removePaintStrokes', layer, strokes: [last.id] });
}

export function setPaintOnTransparent(layer: string, on: boolean): Promise<EngineResult<CommandResult[]>> {
  return edit('Paint on Transparent', { type: 'setPaintOnTransparent', layers: [layer], on });
}
