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
 * is layer mode — `layerTransitionEdit`, one engine gesture: the Blur effect
 * the recipe keys is added for real first (its id is the engine's), then the
 * recipe runs off-document again and its keys land as setKeyframes, with the
 * motion-blur switch (core/engine/assistantKeys.ts).
 */

import type { Command } from '@motion/engine-api';
import { buildLayerFragment, OffDocumentError, type BuiltLayers } from '@core/engine/offDocument';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { activeInsertTarget } from '@layout/Scene/activeInsertTarget';
import { applyTransitionItem, type ApplyTransitionResult } from '@core/library/transitionLibrary';
import { useSelectionStore } from '@stores/selectionStore';
import { engine } from '@core/engine/engineInstance';
import { offDocument } from '@core/engine/offDocument';
import { assistantKeyframeCommands } from '@core/engine/assistantKeys';
import { getTransitionItem } from '@core/library/transitionLibrary';
import { documentMirror } from '@stores/documentMirror';

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
    // Layer mode: the recipe keys the selected layers' own tracks. (Not
    // `addTransition`: these recipes are keyframe choreography on any layer,
    // not a cut transition between two bars.)
    return layerTransitionEdit(transId, label);
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

/** A scratch node part whose `fx` stack holds a Blur effect. */
function hasBlurPart(part: unknown): boolean {
  const comps = (part as { components?: Array<{ type: string; props: Record<string, unknown> }> } | undefined)?.components ?? [];
  const list = comps.find((c) => c.type === 'fx')?.props.effects;
  return Array.isArray(list) && list.some((e) => (e as { type?: unknown }).type === 'blur');
}

/** Which layers carry a Blur effect (the mirror: an `effects/<id>` group whose match name is the type). */
function blurred(layers: readonly string[]): Set<string> {
  const m = documentMirror();
  return new Set(layers.filter((id) => {
    const t = m.tree(id);
    const kids = t?.nodes.get('effects')?.children ?? [];
    return kids.some((p) => t?.nodes.get(p)?.matchName === 'blur');
  }));
}

/**
 * A layer-mode transition as ONE undo entry (see the file header). Resolves to
 * what was keyed, or null when the recipe keyed nothing or the engine refused
 * (toasted).
 */
async function layerTransitionEdit(transId: string, label: string): Promise<ApplyTransitionResult | null> {
  const item = getTransitionItem(transId);
  const targets = useSelectionStore.getState().ids.filter((id) => documentMirror().hasLayer(id));
  if (!item || targets.length === 0) return null;
  const hadBlur = blurred(targets);
  let needBlur: string[];
  try {
    needBlur = offDocument(() => applyTransitionItem(transId), ({ after }) =>
      // The layers the recipe gave a Blur effect (their scratch node part's fx stack).
      targets.filter((id) => !hadBlur.has(id) && hasBlurPart(after.get(`node:${id}`))));
  } catch (err) {
    reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  let result: ApplyTransitionResult | null = null;
  let ok = true;
  try {
    if (needBlur.length > 0) {
      const res = await client.execute({ type: 'addEffect', layers: needBlur, effect: 'blur', params: [] });
      if (!res.ok) throw res.error;
    }
    const plan = assistantKeyframeCommands(targets, () => applyTransitionItem(transId), { allowNodeChanges: true });
    result = plan.value;
    const cmds: Command[] = [...plan.cmds];
    if (result && item.motionBlur) cmds.push({ type: 'setLayerSwitches', layers: result.nodeIds, patch: { motionBlur: true } });
    if (!result || cmds.length === 0) {
      ok = false;
    } else {
      const res = await client.batch(label, cmds);
      if (!res.ok) throw res.error;
    }
  } catch (err) {
    ok = false;
    result = null;
    const e = err as { code?: string; message?: string };
    reportEngineError(label, e.code ? err as never : { code: 'internal', message: err instanceof Error ? err.message : String(err) });
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  if (result) useSelectionStore.getState().set(result.nodeIds);
  return result;
}
