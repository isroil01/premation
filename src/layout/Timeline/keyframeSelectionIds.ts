/**
 * The keyframe SELECTION's id format — one adapter for the whole timeline area.
 *
 * The timeline, the graph editor and `useKeyframeSelectionStore` name a key by
 * its POSITION (`nodeId::prop::t`, stored time). That id is editor state (what
 * is selected, which diamond is lit), shared with App.tsx and the
 * `src/core/animation` helpers that read the selection — it is not how the
 * document is written: every WRITE resolves these positions to the engine's
 * keyframe ids first (`keyframeEdits.resolveKeyIds`, the `getKeyframes` query).
 *
 * B3-legacy: the positional codec (ENGINE_API.md §15.3 deletes it). It lives
 * HERE so the timeline has one place that reads and writes the format, and one
 * place to change when the selection store moves to engine ids with B4's
 * mirror (the diamonds then carry the engine id they were drawn from).
 */

import { makeKeyframeId, parseKeyframeId } from '@motion/animation';

/** A keyframe as the selection names it (stored time `t`). */
export interface UiKey {
  id: string;
  nodeId: string;
  prop: string;
  t: number;
}

/** Encode a selection id. */
export function uiKeyId(nodeId: string, prop: string, t: number): string {
  return makeKeyframeId(nodeId, prop, t);
}

/** Decode a selection id (null for anything that is not one). */
export function parseUiKey(id: string): UiKey | null {
  const ref = parseKeyframeId(id);
  return ref ? { id, nodeId: ref.nodeId, prop: ref.prop, t: ref.t } : null;
}
