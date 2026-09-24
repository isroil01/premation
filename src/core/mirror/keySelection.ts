/**
 * The keyframe SELECTION's ids — the one adapter every surface goes through
 * (the timeline, the graph editor, `useKeyframeSelectionStore`, App's
 * diamond menu, the ease clipboard, `src/core/animation`'s clipboard and
 * easing helpers, the inspector's property menu).
 *
 * A selected diamond is named by the ENGINE's keyframe id (ENGINE_API.md §3.3:
 * stable, minted by the engine, carried on `Keyframe.id` in the mirror) plus
 * the layer it is on:
 *
 *   `<layer>::<engineKeyId>`            the whole key (a scalar row, the merged
 *                                       Position row, a data row, the Mask Shape
 *                                       row, a collapsed layer's summary diamond)
 *   `<layer>::<engineKeyId>#<member>`   one MEMBER row's diamond of a vector /
 *                                       colour property (Scale X = member 0 of
 *                                       `transform/scale`): the API keeps one key
 *                                       per time for the whole property, so two
 *                                       member rows would otherwise share one id
 *                                       and "select this diamond" could not tell
 *                                       them apart.
 *
 * The id does not change when the key moves (the positional `nodeId::prop::t`
 * codec it replaces did, and every move had to rewrite the selection). Layer
 * ids never contain `::`; engine key ids never end in `#<digits>`.
 *
 * Decoding goes through the document MIRROR (B4): `resolveSelectionKey` finds
 * the key by its id among the layer's keyframes and names the member tracks
 * the diamond stands for. What only the TypeScript engine's storage knows —
 * a key's STORED time on the layer's keyframe axis, which the pre-API core
 * helpers (`keyframeClipboard`, `keyframeAssistants`, `easingVocabulary`,
 * `core/commands/clipboard`) and the graph editor's curve math still work in —
 * is `storedTimeOf` / `selectionStoredRefs` below (B4-gap: the API carries only
 * comp time + the engine id).
 */

import { POSITION_PSEUDO_PROP, SOURCE_TEXT_PROP, defaultAnimation } from '@motion/animation';
import { flicksToSeconds, secondsToFlicks, type Keyframe, type PropertyInfo } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeMaskAnim } from '@core/effects/mask';
import { memberTrackRef, type MemberKeyRead, type StoredTimeOf } from './memberKeys';
import { membersOf, type TrackRef } from './trackIndex';

// ── The id ───────────────────────────────────────────────────────────

/** A decoded selection id. */
export interface SelectionKeyRef {
  id: string;
  layer: string;
  /** The engine's keyframe id. */
  keyId: string;
  /** The member row's index in the property's members; absent for the whole key. */
  member?: number;
}

const SEP = '::';
const MEMBER = /#(\d+)$/;

/** Encode a selection id. */
export function selectionKeyId(layer: string, keyId: string, member?: number): string {
  return member === undefined ? `${layer}${SEP}${keyId}` : `${layer}${SEP}${keyId}#${member}`;
}

/** Decode a selection id (null for anything that is not one). */
export function parseSelectionKey(id: string): SelectionKeyRef | null {
  const at = id.indexOf(SEP);
  if (at <= 0) return null;
  const layer = id.slice(0, at);
  let keyId = id.slice(at + SEP.length);
  let member: number | undefined;
  const m = MEMBER.exec(keyId);
  if (m) {
    member = Number(m[1]);
    keyId = keyId.slice(0, m.index);
  }
  if (!keyId || keyId.includes(SEP)) return null;
  return member === undefined ? { id, layer, keyId } : { id, layer, keyId, member };
}

/** The layer a selection id is on, or null. */
export function selectionLayerOf(id: string): string | null {
  return parseSelectionKey(id)?.layer ?? null;
}

// ── Rows ─────────────────────────────────────────────────────────────

/** The whole-mask keyframe row's synthetic track (core/timeline/propertyTree `MASK_ANIM_PROP`). */
export const MASK_ANIM_TRACK = '__mask:path';
/** The TS engine's gradient-stops data track (engine fillStops.ts `FILL_STOPS_TRACK`). */
const FILL_STOPS_TRACK = 'fill.stops';
const MASK_PATH = /^masks\/[^/]+\/path$/;

/**
 * The timeline track names a mirror property stands for: its member tracks, or
 * — for a data property (Source Text, a mask path, gradient stops) — the one
 * data track the TS engine keeps its keys on.
 */
export function timelineTracksOf(info: PropertyInfo): readonly string[] {
  if (info.path === 'text/sourceText') return [SOURCE_TEXT_PROP];
  if (info.path === 'layer/fillStops') return [FILL_STOPS_TRACK];
  if (MASK_PATH.test(info.path)) return [MASK_ANIM_TRACK];
  const members = membersOf(info);
  return members.length > 0 ? members : [info.matchName];
}

/** Whether a property's member rows each get their own diamond (a vector / colour drawn as member rows). */
function hasMemberRows(tracks: readonly string[]): boolean {
  return tracks.length > 1;
}

/**
 * The selection id of the diamond a member TRACK row draws for an engine key
 * (the graph editor's curves, the timeline's member rows): with the member
 * index when the property has several members, else the whole key.
 */
export function trackSelectionId(m: Pick<MemberKeyRead, 'tree'>, layer: string, track: string, keyId: string): string {
  const ref = memberTrackRef(m.tree(layer), track);
  return selectionKeyId(layer, keyId, ref && hasMemberRows(ref.members) ? ref.member : undefined);
}

// ── Resolving through the mirror ─────────────────────────────────────

/** What the resolver reads: a `DocumentMirror` is one. */
export interface SelectionRead extends MemberKeyRead {
  layerKeyframes(layer: string): ReadonlyMap<string, readonly Keyframe[]>;
}

interface KeyAt {
  path: string;
  index: number;
}

const byIdCache = new WeakMap<ReadonlyMap<string, readonly Keyframe[]>, Map<string, KeyAt>>();

/** Where an engine key id sits among a layer's keyframes (indexed once per keyframe-map identity). */
export function findKeyById(m: Pick<SelectionRead, 'layerKeyframes'>, layer: string, keyId: string): { path: string; index: number; key: Keyframe; keys: readonly Keyframe[] } | null {
  const all = m.layerKeyframes(layer);
  let idx = byIdCache.get(all);
  if (!idx) {
    idx = new Map();
    for (const [path, list] of all) list.forEach((k, index) => { if (!idx!.has(k.id)) idx!.set(k.id, { path, index }); });
    byIdCache.set(all, idx);
  }
  const at = idx.get(keyId);
  if (!at) return null;
  const keys = all.get(at.path) ?? [];
  const key = keys[at.index];
  return key ? { path: at.path, index: at.index, key, keys } : null;
}

/** A selection id resolved against the mirror. */
export interface ResolvedSelectionKey {
  sel: SelectionKeyRef;
  /** The API property the key is on. */
  path: string;
  info: PropertyInfo | undefined;
  key: Keyframe;
  /** Every key of the property (time order) and the key's index in it. */
  keys: readonly Keyframe[];
  index: number;
  /** The timeline tracks the diamond stands for: the member row's one, or every member of the whole key. */
  tracks: string[];
  /** The row the diamond is drawn on, as the timeline names rows (`scaleX`, `Position`, `__mask:path`, `opacity`). */
  rowProp: string;
  /** The track to read the key through (`memberTrackRef`): the member row's track, else the lead track, else the path. */
  lookup: string;
  /** The property as `lookup` sees it (null when the layer's tree is not loaded or has no such property). */
  ref: TrackRef | null;
}

/** Resolve a selection id (or its decoded form) against the mirror. Null when the key is gone. */
export function resolveSelectionKey(m: SelectionRead, id: string | SelectionKeyRef): ResolvedSelectionKey | null {
  const sel = typeof id === 'string' ? parseSelectionKey(id) : id;
  if (!sel) return null;
  const hit = findKeyById(m, sel.layer, sel.keyId);
  if (!hit) return null;
  const tree = m.tree(sel.layer);
  const info = tree?.nodes.get(hit.path);
  const all = info ? [...timelineTracksOf(info)] : [hit.path];
  const memberTrack = sel.member !== undefined ? all[sel.member] : undefined;
  const tracks = memberTrack !== undefined ? [memberTrack] : all;
  const isMask = MASK_PATH.test(hit.path);
  const rowProp = memberTrack
    ?? (isMask ? MASK_ANIM_TRACK : all[0] === 'x' && all[1] === 'y' ? POSITION_PSEUDO_PROP : all[0] ?? hit.path);
  const lead = isMask ? hit.path : memberTrack ?? all[0] ?? hit.path;
  const byLead = memberTrackRef(tree, lead);
  const ref = byLead && byLead.path === hit.path ? byLead : memberTrackRef(tree, hit.path);
  return {
    sel,
    path: hit.path,
    info,
    key: hit.key,
    keys: hit.keys,
    index: hit.index,
    tracks,
    rowProp,
    lookup: ref === byLead ? lead : hit.path,
    ref,
  };
}

/**
 * The selection id of the key at comp time `time` (flicks) on the property
 * `path` of `layer`, keeping `member` — how a selection follows a key whose
 * engine id changed under an edit (a key a pre-API writer left with a
 * positional fallback id is stamped with a stable one by its first API edit).
 */
export function selectionIdAt(m: Pick<SelectionRead, 'layerKeyframes'>, layer: string, path: string, time: number, member?: number): string | null {
  // The nearest key within half a 24 fps frame: the engine quantizes a moved key to the clip's frames.
  const tolerance = secondsToFlicks(1 / 48);
  let best: Keyframe | undefined;
  for (const k of m.layerKeyframes(layer).get(path) ?? []) {
    const d = Math.abs(k.time - time);
    if (d <= tolerance && (!best || d < Math.abs(best.time - time))) best = k;
  }
  return best ? selectionKeyId(layer, best.id, member) : null;
}

// ── Stored positions (the TS engine's keyframe axis) ─────────────────

/** Where a mirror keyframe sits in the TS engine's storage: its track and STORED time. */
export interface StoredKey {
  track: string;
  t: number;
}

/** The TS engine's positional fallback key id (`@layer|track|t`, engine props.ts `fallbackKeyId`). */
const FALLBACK_KEY_ID = /^@(.+)\|(.+)\|(-?[0-9.eE+-]+)$/;

/**
 * Engine keyframe id → stored position, for every key of one layer.
 *
 * Exact, never a comp→layer time conversion (that one frame-quantizes): a key
 * the engine addresses positionally carries its track and stored time in its
 * id (`storedKeyOf`); every other one is found by its id on the TS engine's own
 * tracks, here. Built once per call, not per key.
 */
export function storedKeyIndex(layer: string): ReadonlyMap<string, StoredKey> {
  const out = new Map<string, StoredKey>();
  // B4-gap: stored keyframe position — the API carries only comp time + the engine id.
  for (const tr of defaultAnimation.tracksFor(layer)) {
    for (const k of tr.keyframes) if (k.id && !out.has(k.id)) out.set(k.id, { track: tr.prop, t: k.t });
  }
  for (const dt of defaultAnimation.dataTracksFor(layer)) {
    for (const k of dt.keyframes) if (k.id && !out.has(k.id)) out.set(k.id, { track: dt.prop, t: k.t });
  }
  // Mask-shape snapshots (engine props.ts `maskKeyId`).
  const node = defaultSceneGraph.getNode(layer);
  for (const k of node ? readNodeMaskAnim(node) : []) {
    const id = (k as { id?: string }).id;
    if (!id) continue;
    for (const p of k.mask.paths) out.set(`${id}@${p.id}`, { track: MASK_ANIM_TRACK, t: k.t });
  }
  return out;
}

/**
 * The stored position of one mirror keyframe. `track` is used as is when the
 * key is not a TS-engine key (the C++ engine owns the document, and its layer
 * axis is the comp axis).
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

/** The stored time of any mirror keyframe of one layer (`storedKeyOf` over one `storedKeyIndex`). */
export function storedTimeOf(layer: string, index: ReadonlyMap<string, StoredKey> = storedKeyIndex(layer)): StoredTimeOf {
  return (key) => storedKeyOf(index, key, '').t;
}

/** A key by its stored position — what the pre-API core helpers address (`nodeId`, track, stored `t`). */
export interface StoredKeyRef {
  nodeId: string;
  prop: string;
  t: number;
}

/**
 * Selection ids → the stored positions of the tracks each diamond stands for
 * (a member row: its track; a whole key: every member; the Mask Shape row: the
 * mask snapshot track). For the core helpers that still read and write the TS
 * engine's tracks. Ids that no longer name a key are dropped.
 */
export function selectionStoredRefs(m: SelectionRead, ids: Iterable<string>): StoredKeyRef[] {
  const stored = new Map<string, StoredTimeOf>();
  const out: StoredKeyRef[] = [];
  for (const id of ids) {
    const r = resolveSelectionKey(m, id);
    if (!r) continue;
    let st = stored.get(r.sel.layer);
    if (!st) {
      st = storedTimeOf(r.sel.layer);
      stored.set(r.sel.layer, st);
    }
    const t = st(r.key);
    for (const prop of r.tracks) out.push({ nodeId: r.sel.layer, prop, t });
  }
  return out;
}
