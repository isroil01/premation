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
 * B3-legacy: the positional codec (ENGINE_API.md §15.3 deletes it).
 *
 * B4 (the mirror) draws the diamonds from the mirror's keyframes (comp-time
 * flicks + ENGINE ids) and still names them positionally here. The move of the
 * selection itself to engine ids was NOT done in B4, for two reasons:
 *   - the timeline still draws some vector properties as MEMBER rows (Scale X /
 *     Scale Y, colour channels), each with the property's keys: an engine id is
 *     per PROPERTY, so two diamonds (one per member row) would share one id and
 *     "select this diamond" could no longer tell them apart;
 *   - the selection is read by ~10 modules outside the timeline
 *     (`src/core/animation` clipboard / assistants / easing vocabulary,
 *     `core/commands/clipboard`, `core/inspector/propertyMenu`, the ease
 *     clipboard store, App's copy/paste) that all decode the position.
 * `storedKeyIndex` / `storedKeyOf` below are the one place that turns a mirror
 * keyframe back into the position; they go when the selection moves to engine ids.
 */

import { makeKeyframeId, parseKeyframeId, defaultAnimation } from '@motion/animation';
import { flicksToSeconds, type Keyframe } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeMaskAnim } from '@core/effects/mask';

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

/** The TS engine's positional fallback key id (`@layer|track|t`, engine props.ts `fallbackKeyId`). */
const FALLBACK_KEY_ID = /^@(.+)\|(.+)\|(-?[0-9.eE+-]+)$/;

/** The whole-mask keyframe row's synthetic track (core/timeline/propertyTree `MASK_ANIM_PROP`). */
const MASK_ANIM_TRACK = '__mask:path';

/** Where a mirror keyframe sits in the TS engine's storage: its track and STORED time. */
export interface StoredKey {
  track: string;
  t: number;
}

/**
 * Engine keyframe id → stored position, for every key of one layer.
 *
 * Exact, never a comp→layer time conversion (that one frame-quantizes): a key
 * the engine addresses positionally carries its track and stored time in its
 * id (`storedKeyOf`); every other one is found by its id on the TS engine's own
 * tracks, here. Built once per track rebuild, not per key.
 */
export function storedKeyIndex(layer: string): ReadonlyMap<string, StoredKey> {
  const out = new Map<string, StoredKey>();
  // B4-gap: stored keyframe position — selection ids are positional (see the header) and the API carries only comp time + the engine id.
  for (const tr of defaultAnimation.tracksFor(layer)) {
    for (const k of tr.keyframes) if (k.id && !out.has(k.id)) out.set(k.id, { track: tr.prop, t: k.t });
  }
  // B4-gap: stored keyframe position — as above.
  for (const dt of defaultAnimation.dataTracksFor(layer)) {
    for (const k of dt.keyframes) if (k.id && !out.has(k.id)) out.set(k.id, { track: dt.prop, t: k.t });
  }
  // B4-gap: stored keyframe position — as above (mask-shape snapshots, engine props.ts `maskKeyId`).
  const node = defaultSceneGraph.getNode(layer);
  // B4-gap: stored keyframe position — as above.
  for (const k of node ? readNodeMaskAnim(node) : []) {
    const id = (k as { id?: string }).id;
    if (!id) continue;
    for (const p of k.mask.paths) out.set(`${id}@${p.id}`, { track: MASK_ANIM_TRACK, t: k.t });
  }
  return out;
}

/**
 * The stored position of one mirror keyframe. `track` names the row it draws
 * on, used as is when the key is not a TS-engine key (the C++ engine owns the
 * document, and its layer axis is the comp axis).
 */
export function storedKeyOf(index: ReadonlyMap<string, StoredKey>, key: Keyframe, track: string): StoredKey {
  const hit = index.get(key.id);
  if (hit) return hit;
  const fb = FALLBACK_KEY_ID.exec(key.id);
  if (fb) {
    const t = Number(fb[3]);
    if (Number.isFinite(t)) return { track: fb[2]!.startsWith('mask:') ? MASK_ANIM_TRACK : fb[2]!, t };
  }
  return { track, t: flicksToSeconds(key.time) };
}
