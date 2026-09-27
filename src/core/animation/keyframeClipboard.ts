/**
 * keyframeClipboard — in-memory copy/paste for keyframes (AE-style), in API
 * form (B4, ENGINE_API.md §15.12).
 *
 * Copy: the engine's `copyKeyframes` answers the WHOLE keys the selection
 *       names (every dimension, as AE copies a key) — value, temporal easing
 *       and per-dimension ease, spatial tangents, spatial mode, continuous /
 *       roving — grouped per property at their composition times.
 * Paste: `pasteKeyframes` per (target layer, property of the same path): the
 *        earliest copied key lands at the playhead, spacing kept (composition
 *        time). One undo entry; a target without the property is skipped.
 *
 * The clipboard is module state (survives re-renders, resets on page unload).
 * It never reads the document itself: copies are the engine's answers, the
 * mirror only names which key sits under the playhead.
 */

import type { Command, KeyframeSet } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { parseSelectionKey, selectionIdAt } from '@core/mirror/keySelection';
import { trackRefIn } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';

let clipboard: KeyframeSet[] = [];

/** True when the clipboard holds at least one keyframe. */
export function hasClipboard(): boolean {
  return clipboard.some((s) => s.keyframes.length > 0);
}

/** What Copy captured (read-only): API key sets, composition times. */
export function clipboardSets(): readonly KeyframeSet[] {
  return clipboard;
}

/** Test helper — wipe the module clipboard between cases. */
export function clearClipboard(): void {
  clipboard = [];
}

/**
 * Copy by ENGINE keyframe id. Resolves true when something was copied (an
 * empty answer leaves the clipboard as it was).
 */
export async function copyKeyframeIds(keyIds: ReadonlyArray<string>): Promise<boolean> {
  const ids = [...new Set(keyIds)];
  if (ids.length === 0) return false;
  const res = await engine().query({ type: 'copyKeyframes', keys: ids });
  if (!res.ok) return false;
  const sets = res.value.sets.filter((s) => s.keyframes.length > 0);
  if (sets.length === 0) return false;
  clipboard = sets;
  return true;
}

/**
 * Copy the selected keyframes (keyframe SELECTION ids, core/mirror/keySelection.ts:
 * `<layer>::<engineKeyId>[#member]`) — a member row's diamond copies its whole key.
 */
export function copyKeyframes(ids: ReadonlySet<string>): Promise<boolean> {
  return copyKeyframeIds([...ids].flatMap((id) => {
    const ref = parseSelectionKey(id);
    return ref ? [ref.keyId] : [];
  }));
}

/**
 * Copy the key of track `prop` under comp time `seconds` — the property menu's
 * Copy Keyframe, which holds a property and the playhead rather than a
 * timeline selection. Resolves false when no key sits there.
 */
export function copyKeyframeAt(nodeId: string, prop: string, seconds: number): Promise<boolean> {
  const m = documentMirror();
  const ref = trackRefIn(m.tree(nodeId), prop);
  const at = ref ? selectionIdAt(m, nodeId, ref.path, compTime(seconds)) : null;
  const key = at ? parseSelectionKey(at) : null;
  return key ? copyKeyframeIds([key.keyId]) : Promise.resolve(false);
}

/**
 * Paste onto each target layer at comp time `atCompTime` (seconds): one
 * `pasteKeyframes` per (layer, property); the earliest copied key of the whole
 * clipboard lands at `atCompTime`, every set keeps its offset from it. ONE
 * undo entry. A target without a property of the copied path is skipped for it.
 */
export async function pasteKeyframes(targetNodeIds: readonly string[], atCompTime: number): Promise<void> {
  const sets = clipboard.filter((s) => s.keyframes.length > 0);
  if (sets.length === 0 || targetNodeIds.length === 0) return;
  const m = documentMirror();
  const minTime = Math.min(...sets.flatMap((s) => s.keyframes.map((k) => k.time)));
  const at = compTime(atCompTime);
  const cmds: Command[] = [];
  for (const layer of targetNodeIds) {
    if (!m.layer(layer)) continue;
    if (!m.tree(layer)) await m.whenIdle();
    for (const s of sets) {
      const info = m.property(layer, s.prop.path);
      if (!info?.animatable) continue;
      const first = Math.min(...s.keyframes.map((k) => k.time));
      cmds.push({ type: 'pasteKeyframes', prop: { layer, path: s.prop.path }, time: at + (first - minTime), keys: s.keyframes.map((k) => ({ ...k, id: '' })) });
    }
  }
  if (cmds.length === 0) return;
  await edit('Paste keyframes', cmds);
}
