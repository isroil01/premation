/**
 * The Library's Transitions through the engine API (B3z, ENGINE_API.md §15.9
 * off-document builders).
 *
 * A transition item applies in one of two modes (`applyTransitionItem`):
 *   solid  comp-covering panel(s) choreographed over the cut — NEW layers
 *          (their keys, masks and blur effect included), so the builder runs
 *          off-document and the panels land as ONE `pasteLayers`;
 *   layer  the in/out rig keyed onto the selected layers' own tracks.
 *
 * The mode is the builder's own decision (it keys the selection when it can),
 * so the off-document run is tried first: a build that changed existing layers
 * is layer mode, and that mode keeps the legacy writer.
 */

import type { Command } from '@motion/engine-api';
import { buildLayerFragment, OffDocumentError, type BuiltLayers } from '@core/engine/offDocument';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { activeInsertTarget } from '@layout/Scene/activeInsertTarget';
import { applyTransitionItem, type ApplyTransitionResult } from '@core/library/transitionLibrary';
import { useSelectionStore } from '@stores/selectionStore';

/**
 * Apply a transition item at the playhead. Solid mode is ONE undo entry
 * (`pasteLayers` of the panels, which end up selected). Resolves to what was
 * applied, or null when nothing could be (a refusal is toasted).
 */
export async function applyTransitionEdit(transId: string, label: string): Promise<ApplyTransitionResult | null> {
  const comp = activeInsertTarget()?.comp;
  if (!comp) return null;
  let made: ApplyTransitionResult | null = null;
  let built: BuiltLayers | null;
  try {
    built = buildLayerFragment(comp, () => { made = applyTransitionItem(transId); });
  } catch (err) {
    if (!(err instanceof OffDocumentError)) {
      reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
      return null;
    }
    // B3-legacy: engine gap — per-member keys: layer mode keys the selected layers' member tracks
    // (x / y / scaleX / scaleY at the recipe's own times), adds a Blur effect and the motion-blur
    // switch; the API keys a vector property as one value.
    return applyTransitionItem(transId);
  }
  const r = made as ApplyTransitionResult | null;
  if (!built || !r) return null;
  const paste = {
    type: 'pasteLayers', comp, fragment: built.fragment, index: built.index, ...(built.parent ? { parent: built.parent } : {}),
  } as Command;
  const res = await edit(label, paste);
  if (!res.ok) return null;
  const ids = (res.value[0] as { layers?: string[] } | undefined)?.layers ?? [];
  const map = new Map(built.scratchIds.map((s, i) => [s, ids[i]]));
  const panels = (built.selected.length > 0 ? built.selected : built.tops)
    .map((s) => map.get(s))
    .filter((x): x is string => !!x);
  if (panels.length > 0) useSelectionStore.getState().set(panels);
  return { mode: 'solid', nodeIds: panels };
}
