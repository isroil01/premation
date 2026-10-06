/**
 * The Paint tool's and Paint panel's document edits as engine commands (B3):
 * each is ONE `edit` = one undo entry; a typed error is toasted and changes
 * nothing. The stroke rules live in @core/paint/paintCommit (`planPaintDrag`);
 * the commands in handlers/strokes.ts (ENGINE_API.md §4.7).
 */

import { flicksToSeconds, secondsToFlicks, type CommandResult, type EngineResult } from '@motion/engine-api';
import { planPaintDrag, type PaintCommitResult, type PaintDrag, type PaintDragContext } from '@core/paint/paintCommit';
import { mirrorPaintStrokes, type MirrorPaintStroke } from '@core/mirror/paintStrokes';
import { settingsFps } from '@core/mirror/compFacts';
import { documentMirror } from '@stores/documentMirror';
import { engine } from './engineInstance';
import { edit } from './uiEdits';

/** The layer's paint strokes from the document mirror, its property tree fetched first when it is not loaded yet. */
async function strokesOf(layer: string): Promise<MirrorPaintStroke[]> {
  const m = documentMirror();
  if (!m.tree(layer)) await m.whenIdle();
  return mirrorPaintStrokes(m, layer);
}

/** What `planPaintDrag` reads of the document: the layer's strokes (mirror), its keyframe-axis time and its comp's rate (engine). */
async function dragContext(d: PaintDrag): Promise<PaintDragContext> {
  const m = documentMirror();
  const info = m.layer(d.nodeId);
  const fps = settingsFps(info ? m.comp(info.comp)?.settings : undefined);
  const mapped = await engine().query({ type: 'mapLayerTime', layer: d.nodeId, time: secondsToFlicks(d.compTime), outward: false, keyframeAxis: true });
  const layerT = mapped.ok && mapped.value.time !== undefined ? flicksToSeconds(mapped.value.time) : d.compTime;
  return { layerT, fps, existing: await strokesOf(d.nodeId) };
}

/** A finished Paint / Clone Stamp / Eraser drag. `reason` is set when the drag was refused before sending. */
export async function commitPaintDrag(d: PaintDrag): Promise<PaintCommitResult> {
  const plan = planPaintDrag(d, await dragContext(d));
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

/** Move a stroke: its own Transform ▸ Position, in the layer's pixels. One undo step. */
export function movePaintStroke(layer: string, stroke: string, x: number, y: number): Promise<EngineResult<CommandResult[]>> {
  return edit('Move Paint Stroke', [
    { type: 'setProperty', prop: { layer, path: `paint/${stroke}/positionX` }, value: { kind: 'scalar', value: x } },
    { type: 'setProperty', prop: { layer, path: `paint/${stroke}/positionY` }, value: { kind: 'scalar', value: y } },
  ]);
}

/** Tool Options ▸ Undo last stroke: delete the layer's most recent stroke (no strokes: nothing happens). */
export async function removeLastPaintStroke(layer: string): Promise<void> {
  const last = (await strokesOf(layer)).at(-1);
  if (!last) return;
  await edit('Remove Last Stroke', { type: 'removePaintStrokes', layer, strokes: [last.id] });
}

export function setPaintOnTransparent(layer: string, on: boolean): Promise<EngineResult<CommandResult[]>> {
  return edit('Paint on Transparent', { type: 'setPaintOnTransparent', layers: [layer], on });
}
