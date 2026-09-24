/**
 * Edit ▸ Cut / Copy / Paste through the engine API (B3z, docs/B3_PATTERNS.md §6).
 *
 *   Copy   a Direct Selection path → the path clipboard (`copyPathFromSelection`);
 *          selected keyframes → the keyframe clipboard the timeline's Ctrl+C
 *          fills (`copyKeyframes`); otherwise the selected layers → a
 *          `copyLayers` fragment, captured NOW (a later edit or delete of the
 *          originals does not change what pastes).
 *   Cut    Copy, then delete what was copied (keyframes: `deleteKeyframes`;
 *          layers: the Delete command's `deleteLayers`).
 *   Paste  the path onto the selected path; else the copied keyframes at the
 *          playhead on every selected layer (`pasteKeyframes`); else the copied
 *          layers as ONE `pasteLayers` at the top of the active composition,
 *          each copy named "<name> copy" and nudged +20 px when its Position is
 *          static (what the legacy clipboard did); else SVG markup on the OS
 *          clipboard, built off-document and sent as one `pasteLayers`.
 *
 * Each paste is ONE undo entry. The legacy module (`core/commands/clipboard`)
 * kept its own snapshot of nodes and tracks and wrote them with the graph.
 */

import type { Command, DocumentFragment, Value } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { reportEngineError } from '@core/engine/uiEdits';
import { insertBuiltLayers } from '@core/engine/offDocument';
import { apiParentOf, graph as docGraph, isLayer } from '@core/engine/doc';
import { catalogFor, isAnimated, readStatic } from '@core/engine/props';
import { copyKeyframes } from '@core/animation/keyframeClipboard';
import { readOsClipboardSvg } from '@core/commands/clipboard';
import { copyPathFromSelection, pastePathEdit } from '@core/workspace/pathCommands';
import { activeInsertTarget } from '@layout/Scene/activeInsertTarget';
import { insertSvgDocument } from '@core/scene/sceneInsert';
import { deleteKeyframesUi, pasteKeyframesAt } from '@layout/Timeline/keyframeEdits';
import { deleteSelectedLayersEdit } from '@layout/Workspace/layerMenuEdits';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { getTime } from '@stores/playbackClockStore';

export type CopyKind = 'path' | 'keyframes' | 'layers' | null;
export type PasteResult = 'keyframes' | 'layers' | 'svg' | 'path' | null;

/** The legacy paste's placement nudge for a pasted copy (px). */
const PASTE_OFFSET = 20;

interface HeldLayers {
  fragment: Promise<DocumentFragment | null>;
  /** The copied top-level layers' names, in fragment order. */
  names: string[];
}

/** What Copy put on the app clipboard last (keyframes live in the keyframe clipboard). */
let held: { kind: 'keyframes' } | ({ kind: 'layers' } & HeldLayers) | null = null;

/** The selected layers without those whose ancestor is also selected (the fragment carries descendants). */
function topLayers(ids: readonly string[]): string[] {
  const picked = new Set(ids.filter((id) => isLayer(id)));
  return [...picked].filter((id) => {
    for (let p = apiParentOf(id); p; p = apiParentOf(p)) if (picked.has(p)) return false;
    return true;
  });
}

/**
 * Edit ▸ Copy. Resolves to what was copied — the layer fragment is captured by
 * the time it resolves (a Cut awaits it before deleting the originals).
 */
export async function copyEdit(): Promise<CopyKind> {
  // A Direct Selection vertex selection copies the PATH, not the layer (AE);
  // otherwise this drops a stale path clipboard so it cannot shadow the paste.
  if (copyPathFromSelection()) return 'path';
  const kf = useKeyframeSelectionStore.getState().ids;
  if (kf.size > 0) {
    copyKeyframes(kf);
    held = { kind: 'keyframes' };
    return 'keyframes';
  }
  const layers = topLayers(useSelectionStore.getState().ids);
  if (layers.length === 0) return null;
  const fragment = engine()
    .query({ type: 'copyLayers', layers })
    .then((res) => {
      if (res.ok) return { version: res.value.version, data: res.value.data };
      reportEngineError('Copy', res.error);
      return null;
    });
  // The copy's names, read now: the originals may be renamed or deleted before the paste.
  const names = layers.map((id) => docGraph.getNode(id)?.name ?? '');
  held = { kind: 'layers', fragment, names };
  return (await fragment) ? 'layers' : null;
}

/** Edit ▸ Cut: Copy, then delete the originals (a path is only copied). */
export async function cutEdit(): Promise<CopyKind> {
  const kfIds = [...useKeyframeSelectionStore.getState().ids];
  const kind = await copyEdit();
  if (kind === 'keyframes') {
    await deleteKeyframesUi(kfIds, 'Cut keyframes');
    useKeyframeSelectionStore.getState().set(new Set());
  } else if (kind === 'layers') {
    await deleteSelectedLayersEdit();
  }
  return kind;
}

/** A static Position +PASTE_OFFSET on both axes (null when animated or not addressable). */
function nudgeCommands(layer: string): Command[] {
  const cat = catalogFor(layer);
  const whole = cat.byPath.get('transform/position');
  const out: Command[] = [];
  const bump = (path: string, v: Value): void => { out.push({ type: 'setProperty', prop: { layer, path }, value: v }); };
  if (whole) {
    if (isAnimated(layer, whole)) return [];
    const v = readStatic(layer, whole);
    if (v.kind === 'vec2') bump(whole.path, { kind: 'vec2', value: { x: v.value.x + PASTE_OFFSET, y: v.value.y + PASTE_OFFSET } });
    else if (v.kind === 'vec3') bump(whole.path, { kind: 'vec3', value: { ...v.value, x: v.value.x + PASTE_OFFSET, y: v.value.y + PASTE_OFFSET } });
    return out;
  }
  // Separated dimensions: each static one moves.
  for (const dim of ['x', 'y']) {
    const b = cat.byPath.get(`transform/position/${dim}`);
    if (!b || isAnimated(layer, b)) continue;
    const v = readStatic(layer, b);
    if (v.kind === 'scalar') bump(b.path, { kind: 'scalar', value: v.value + PASTE_OFFSET });
  }
  return out;
}

/**
 * The copied layers into the active composition (into the open group when the
 * tab is a group), at the top of the stack — ONE entry named "Paste". The paste
 * returns the new ids, so the renames and nudges run in the same engine
 * gesture. Resolves to the new top-level ids.
 */
async function pasteLayersEdit(h: HeldLayers): Promise<string[] | null> {
  const fragment = await h.fragment;
  if (!fragment) return null;
  const target = activeInsertTarget();
  if (!target) return null;
  const label = 'Paste';
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  let ok = true;
  let tops: string[] = [];
  const res = await client.execute({ type: 'pasteLayers', comp: target.comp, fragment, index: 0, ...(target.parent ? { parent: target.parent } : {}) });
  if (!res.ok) {
    reportEngineError(label, res.error);
    ok = false;
  } else {
    const ids = (res.value as { layers?: string[] }).layers ?? [];
    const made = new Set(ids);
    tops = ids.filter((id) => !made.has(apiParentOf(id) ?? ''));
    const follow: Command[] = [];
    tops.forEach((id, i) => {
      const name = h.names[i];
      if (name) follow.push({ type: 'renameLayer', layer: id, name: `${name} copy` });
      follow.push(...nudgeCommands(id));
    });
    if (follow.length > 0) {
      const r = await client.batch(label, follow);
      if (!r.ok) {
        reportEngineError(label, r.error);
        ok = false;
      }
    }
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  if (!ok) return null;
  if (tops.length > 0) useSelectionStore.getState().set(tops);
  return tops;
}

/**
 * Edit ▸ Paste — the path, the keyframes or the layers Copy took (in that
 * order), else SVG markup from the OS clipboard (AE 26.3). Resolves to what
 * was pasted, or null when there was nothing to paste.
 */
export async function pasteEdit(): Promise<PasteResult> {
  // A path paste (Direct Selection vertices copied): one engine edit onto the target outlines.
  if (pastePathEdit()) return 'path';
  if (held?.kind === 'keyframes') {
    const targets = useSelectionStore.getState().ids.filter((id) => isLayer(id));
    if (targets.length === 0) return null;
    await pasteKeyframesAt(targets, getTime());
    return 'keyframes';
  }
  if (held?.kind === 'layers') {
    const ids = await pasteLayersEdit(held);
    return ids && ids.length > 0 ? 'layers' : null;
  }
  // Checked LAST, only once the app's own clipboard is empty, and built by the
  // importer a dropped .svg file takes, so both land identically.
  const svg = await readOsClipboardSvg();
  if (!svg) return null;
  const comp = activeInsertTarget()?.comp;
  if (!comp) return null;
  const ids = await insertBuiltLayers('Paste SVG', comp, () => insertSvgDocument(svg, 'Pasted SVG'));
  return ids && ids.length > 0 ? 'svg' : null;
}

/** Forget what Copy took (tests). */
export function clearHeldClipboard(): void {
  held = null;
}
