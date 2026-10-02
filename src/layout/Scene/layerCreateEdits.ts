/**
 * Layer ▸ Create verbs through the engine API (B3z, docs/B3_PATTERNS.md §6,
 * ENGINE_API.md §15.9 "off-document builders"): Create Shapes from Text and
 * Create Nulls From Path Points. The Layers panel's row menu and the Layer
 * menu commands call these, so there is one implementation.
 *
 * Shapes from Text is the engine's `convertLayer` (its fonts, its text
 * layout). Nulls From Path Points is a client macro: the path's vertices are
 * sampled at the playhead, the nulls are BUILT off-document and sent as ONE
 * `pasteLayers` — one undo entry, engine-minted ids, the result selected.
 */

import { createNullsFromPath } from '@core/scene/nullsFromPaths';
import { compOfLayer, isLayer } from '@core/mirror/docFacts';
import { insertBuiltLayers } from '@core/engine/offDocument';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { engineOwnsDocumentNow } from '@core/engine/engineOwnership';
import { documentMirror } from '@stores/documentMirror';
import { values } from '@core/engine/propRefs';
import { useSelectionStore } from '@stores/selectionStore';

/**
 * Where a text conversion's outlines came from: the font's own Béziers
 * ('outlines'), or a trace of the painted text ('traced') when the face cannot
 * be read or the layout needs the painter. The engine says which in the made
 * layer's name.
 */
export type ShapesFromTextSource = 'outlines' | 'traced';

/**
 * `convertLayer` in the engine that owns the document (the C++ engine: the
 * font's own Béziers on its fonts, or a trace of the painted text) — ONE
 * entry, the made layers selected. `null` when the engine does not convert
 * (a harness without the engine process, a --no-gpu / headless C++ engine:
 * `unsupported`) — there is no page conversion to fall back to; `[]` when the
 * engine refused for another reason (reported).
 */
export async function convertLayerViaEngine(
  label: string,
  layer: string,
  conversion: 'shapesFromText' | 'masksFromText',
): Promise<{ layers: string[]; source?: ShapesFromTextSource } | null> {
  if (!engineOwnsDocumentNow()) return null;
  const res = await edit(label, { type: 'convertLayer', layer, conversion }, { quiet: true });
  if (!res.ok) {
    if (res.error.code === 'unsupported') return null;
    reportEngineError(label, res.error);
    return { layers: [] };
  }
  const layers = (res.value[0] as { layers?: string[] } | undefined)?.layers ?? [];
  if (layers.length > 0) useSelectionStore.getState().set([layers[0]!]);
  // The engine names its outline layer "<name> Outlines (outlines|traced)".
  const name = layers.length > 0 ? documentMirror().layer(layers[0]!)?.name ?? '' : '';
  return { layers, source: /\(traced\)$/.test(name) ? 'traced' : 'outlines' };
}

/**
 * AE's Layer ▸ Create ▸ Create Shapes from Text: the glyph outlines as a path
 * layer beside the text, and the text hidden (AE keeps it) — the engine's
 * `convertLayer`, one entry, the shape selected. Resolves to the new layer's id
 * and which source produced the outlines, or null when the text could not be
 * outlined (or the engine refused, toasted).
 */
export async function shapesFromTextEdit(
  nodeId: string,
  seconds: number,
): Promise<{ id: string; source: ShapesFromTextSource } | null> {
  const comp = isLayer(nodeId) ? compOfLayer(nodeId) : null;
  if (!comp) return null;
  if (documentMirror().layer(nodeId)?.kind !== 'text') return null;
  // The engine outlines with the font's own Béziers at the playhead (one entry: the outline layer + the text hidden).
  void seconds;
  const viaEngine = await convertLayerViaEngine('Create Shapes from Text', nodeId, 'shapesFromText');
  return viaEngine && viaEngine.layers.length > 0 ? { id: viaEngine.layers[0]!, source: viaEngine.source ?? 'outlines' } : null;
}

/**
 * Create Nulls From Path Points: a null at every vertex of the shape's outline
 * at the playhead, parented to (nested in) the shape — `createNullsFromPath`,
 * built off-document and sent as ONE `pasteLayers` INTO the shape. The nulls
 * are selected. Resolves to their ids (`[]` when the layer has no path points,
 * or the engine refused — toasted).
 *
 * `pointsFollowNulls` (the live direction) also binds each vertex to its null:
 * `layer/pointBindings` on the shape, `[{index, nullId}]` with the ids the
 * paste minted — the paste and the binding in ONE engine gesture, one entry.
 */
export async function nullsFromPathEdit(shapeId: string, seconds: number, opts: { pointsFollowNulls?: boolean } = {}): Promise<string[]> {
  const comp = isLayer(shapeId) ? compOfLayer(shapeId) : null;
  if (!comp) return [];
  if (!opts.pointsFollowNulls) {
    const ids = await insertBuiltLayers('Create Nulls From Path Points', comp, () => createNullsFromPath(shapeId, seconds));
    return ids ?? [];
  }
  const label = 'Create Nulls From Path Points (Points Follow Nulls)';
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return [];
  }
  const ids = await insertBuiltLayers(label, comp, () => createNullsFromPath(shapeId, seconds));
  let ok = !!ids && ids.length > 0;
  if (ok) {
    // `createNullsFromPath` selects its nulls in VERTEX order; the insert
    // selects the new ids in that order.
    const bindings = useSelectionStore.getState().ids.map((nullId, index) => ({ index, nullId }));
    const res = await edit(label, {
      type: 'setProperty', prop: { layer: shapeId, path: 'layer/pointBindings' }, value: values.json(bindings),
    });
    ok = res.ok;
  }
  const ended = await client.endGesture(opened.value.gesture, ok);
  if (!ended.ok) reportEngineError(label, ended.error);
  return ok && ended.ok ? ids! : [];
}
