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
import { reportEngineError } from '@core/engine/uiEdits';
import { activeInsertTarget } from '@layout/Scene/activeInsertTarget';
import { applyTransitionItem, type ApplyTransitionResult } from '@core/library/transitionLibrary';
import { useSelectionStore } from '@stores/selectionStore';
import { engine } from '@core/engine/engineInstance';
import { offDocument } from '@core/engine/offDocument';
import { assistantKeyframeCommands } from '@core/engine/assistantKeys';
import { getTransitionItem } from '@core/library/transitionLibrary';
import { buildTransitionPanels, type BuiltTransitionPanels } from '@core/library/transitionFragment';
import { previewChoreography } from '@core/library/insertPreview';
import { insertFragment } from '@/engine-client/insertFragment';
import { uiKindOf } from '@core/mirror/layerKinds';
import { getTime as getPlayheadTime } from '@stores/playbackClockStore';
import { documentMirror } from '@stores/documentMirror';

/**
 * Apply a transition item at the playhead. Solid mode is ONE undo entry
 * (`pasteLayers` of the panels, which end up selected). Resolves to what was
 * applied, or null when nothing could be (a refusal is toasted).
 */
export async function applyTransitionEdit(transId: string, label: string): Promise<ApplyTransitionResult | null> {
  const comp = activeInsertTarget()?.comp;
  const item = getTransitionItem(transId);
  if (!comp || !item) return null;
  // Layer mode: the recipe keys the selected content layers' own tracks. (Not
  // `addTransition`: these recipes are keyframe choreography on any layer,
  // not a cut transition between two bars.)
  if (!item.solidOnly && layerTargets().length > 0) {
    const keyed = await layerTransitionEdit(transId, label);
    if (keyed) return keyed;
  }
  // Solid mode: the panels laid into a fragment, ONE pasteLayers entry, selected.
  const t0 = getPlayheadTime();
  let made: BuiltTransitionPanels | null = null;
  const ids = await insertFragment(label, (b, f) => {
    made = buildTransitionPanels(b, f, transId, t0);
    return made?.panels ?? null;
  }, { comp });
  const r = made as BuiltTransitionPanels | null;
  if (!ids || ids.length === 0 || !r) return null;
  for (const id of ids) transitionPanels.add(id);
  // Rest half-covered (solidRestTime): the midpoint hides the comp, the end shows nothing.
  previewChoreography({ from: t0, to: t0 + r.duration, restAt: t0 + r.restAfter });
  // Insert order (the paste returns the front-most panel first).
  return { mode: 'solid', nodeIds: [...ids].reverse() };
}

/**
 * The panels this session's solid-mode transitions inserted. A panel left
 * selected by the previous apply is scenery for a cut, not content — the next
 * apply inserts its own panel instead of keying onto it
 * (transitionLibrary.ts TRANSITION_PANEL_PROP). B4-gap: the API does not
 * report the stored `__transitionPanel` mark, so a panel from an earlier
 * session reads as content.
 */
const transitionPanels = new Set<string>();

/** The selected content layers a layer-mode transition keys (no cameras / lights / audio, no panels). */
function layerTargets(): string[] {
  const m = documentMirror();
  return useSelectionStore.getState().ids.filter((id) => {
    const l = m.layer(id);
    if (!l || transitionPanels.has(id)) return false;
    const k = uiKindOf(l);
    return k !== 'camera' && k !== 'light' && k !== 'audio';
  });
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
