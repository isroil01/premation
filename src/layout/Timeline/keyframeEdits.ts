/**
 * The timeline's keyframe edits through the engine API (B3,
 * docs/B3_PATTERNS.md §4): move, delete, ease, velocity, nudge, paste.
 *
 * ── Ids ──────────────────────────────────────────────────────────────
 * The keyframe SELECTION names a key by its ENGINE id (plus a member index for
 * a member row's diamond) — the adapter is `core/mirror/keySelection.ts`. A
 * selection id is resolved through the document mirror to the key and its
 * property, and every edit is verified against the engine's own answer (the
 * `getKeyframes` query) before a command carries the id.
 *
 * The member-level editors (graph editor handles, typed fields, the velocity
 * dialog) still address one MEMBER track's key by its stored time
 * (`MemberKeyAt`), because their curve math works on the stored axis.
 *
 * ── One key per time (ENGINE_API.md §3.3) ────────────────────────────
 * After Effects' model: a vector or colour property (Scale, Anchor Point, a
 * colour) has ONE keyframe per time for all its dimensions. The timeline still
 * draws some grouped properties as member rows (Scale X / Scale Y, colour
 * channels); a diamond on such a row IS the property's key at that time, so
 * moving, deleting or easing it acts on the whole key, as in AE. What AE lets a
 * user shape per dimension — the temporal ease (a handle on Scale X's curve in
 * the graph editor) — goes through `KeyframePatch.dim` (`memberKeyPatches`).
 * A legacy document whose member tracks disagree (a lone Scale X key) reads as
 * whole keys; the engine fills the missing members on the first edit.
 *
 * ── Reads (B4) ───────────────────────────────────────────────────────
 * What these builders compose a command from — which key an id names, its
 * comp time, the other members' numbers of a whole-key value — is read from
 * the document MIRROR at call time (`documentMirror()`), never from the TS
 * engine's tracks. Only the member-level editors' stored times go through
 * `storedTimeOf` (keySelection.ts: the one B4-gap).
 */

import { secondsToFlicks, type Command, type CubicBezier, type Easing, type Keyframe, type KeyframePatch, type PropRef, type SpatialInterp, type Value } from '@motion/engine-api';
import type { BezierHandles, EasingKind } from '@motion/animation';
import { presetCurve, type EasingPreset } from '@core/animation/keyframeAssistants';
import { EASING_KIND_LABEL } from '@core/animation/easingVocabulary';
import { clipboardEntries } from '@core/animation/keyframeClipboard';
import { apiUnitFactor } from '@core/engine/props';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { edit, type GestureSession } from '@core/engine/uiEdits';
import { compTime, propRefForTrack, valueOfNumbers } from '@core/engine/propRefs';
import { memberKeyIndexAt, memberKeyOf, memberKeysOf, type MemberKey, type StoredTimeOf } from '@core/mirror/memberKeys';
import { resolveSelectionKey, storedTimeOf } from '@core/mirror/keySelection';
import { numbersOfValue, type TrackRef as MirrorTrackRef } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { isDataProperty } from './buildPropertyRows';

/** One MEMBER track's key by its stored time — the member-level editors' address (`id` is the caller's own key). */
export interface MemberKeyAt {
  id: string;
  nodeId: string;
  /** A member track (`x`, `scaleX`, `opacity`). */
  prop: string;
  /** Stored time (seconds). */
  t: number;
}

interface Target {
  ref: PropRef;
  /** The member track the key was read through. */
  member: string;
  /** The property, as the document mirror describes it. */
  prop: MirrorTrackRef;
  /** The key, seen from `member` (B4: read from the document mirror). */
  key: MemberKey;
  /** The engine's id of this key (the mirror's keyframe id). */
  expected: string;
}

/** Per-layer stored-time readers for one batch of lookups (one `storedKeyIndex` per layer, not per key). */
function storedTimes(): (layer: string) => StoredTimeOf {
  const cache = new Map<string, StoredTimeOf>();
  return (layer) => {
    let f = cache.get(layer);
    if (!f) {
      f = storedTimeOf(layer);
      cache.set(layer, f);
    }
    return f;
  };
}

/** A selection id → the key and property it names, from the document MIRROR (B4). Null when the key is gone. */
function selectionTarget(id: string): Target | null {
  const m = documentMirror();
  const r = resolveSelectionKey(m, id);
  if (!r || !r.ref || !m.layer(r.sel.layer)) return null;
  return { ref: { layer: r.sel.layer, path: r.path }, member: r.lookup, prop: r.ref, key: memberKeyOf(r.ref, r.key), expected: r.key.id };
}

/**
 * A member track's key at a STORED time, from the document MIRROR — matched on
 * stored time, never on comp time: two keys a trimmed clip clamps onto the
 * same comp instant must not resolve to one id.
 */
function memberTarget(k: MemberKeyAt, storedT: StoredTimeOf): Target | null {
  const m = documentMirror();
  if (!m.layer(k.nodeId)) return null;
  const hit = memberKeysOf(m, k.nodeId, k.prop, storedT);
  if (!hit) return null;
  const index = memberKeyIndexAt(hit.keys, k.t);
  if (index < 0) return null;
  const key = hit.keys[index]!;
  return { ref: { layer: k.nodeId, path: hit.ref.path }, member: k.prop, prop: hit.ref, key, expected: key.key.id };
}

/** Targets (null when any is gone), verified against the engine's own keys; keyed by the caller's ids. */
async function verifyTargets(found: ReadonlyArray<{ id: string; tgt: Target | null }>): Promise<Map<string, Target> | null> {
  const out = new Map<string, Target>();
  if (found.length === 0) return out;
  const keys: Array<{ id: string; tgt: Target }> = [];
  for (const x of found) {
    if (!x.tgt) return null;
    keys.push({ id: x.id, tgt: x.tgt });
  }
  const byPath = new Map<string, PropRef>();
  for (const x of keys) byPath.set(`${x.tgt.ref.layer}|${x.tgt.ref.path}`, x.tgt.ref);
  // The engine's own answer for these properties: every expected id must be one
  // of the keys it reports (a key it does not know is not addressed blindly).
  const res = await engine().query({ type: 'getKeyframes', props: [...byPath.values()] });
  if (!res.ok) return null;
  const known = new Set<string>();
  for (const set of res.value.sets) for (const kf of set.keyframes) known.add(`${set.prop.layer}|${set.prop.path}|${kf.id}`);
  for (const x of keys) {
    if (!known.has(`${x.tgt.ref.layer}|${x.tgt.ref.path}|${x.tgt.expected}`)) return null;
    out.set(x.id, x.tgt);
  }
  return out;
}

/** Selection ids → their targets (null when any is gone). */
function resolveSelection(uiIds: Iterable<string>): Promise<Map<string, Target> | null> {
  const found: Array<{ id: string; tgt: Target | null }> = [];
  for (const id of uiIds) found.push({ id, tgt: selectionTarget(id) });
  return verifyTargets(found);
}

function idsOf(targets: ReadonlyMap<string, Target>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, t] of targets) out.set(id, t.expected);
  return out;
}

/**
 * Selection ids → engine keyframe ids, in input order. Null when ANY of them no
 * longer names a key (a stale selection: the caller does nothing).
 */
export async function resolveKeyIds(uiIds: Iterable<string>): Promise<Map<string, string> | null> {
  const targets = await resolveSelection(uiIds);
  return targets ? idsOf(targets) : null;
}

/** Member keys at stored times → engine keyframe ids (keyed by their `id`). Null when any is gone. */
export async function resolveKeys(keys: ReadonlyArray<MemberKeyAt>): Promise<Map<string, string> | null> {
  const stored = storedTimes();
  const targets = await verifyTargets(keys.map((k) => ({ id: k.id, tgt: memberTarget(k, stored(k.nodeId)) })));
  return targets ? idsOf(targets) : null;
}

// ── Move / delete ────────────────────────────────────────────────────

/**
 * Move keys to comp times (the timeline's drag release: every dragged key in
 * ONE undo entry). Keys moving by the same amount travel as one
 * `moveKeyframes` (the engine retimes them together, so keys trading places
 * cannot swallow each other).
 */
export async function moveKeyframesTo(moves: ReadonlyArray<{ id: string; time: number }>): Promise<void> {
  if (moves.length === 0) return;
  const targets = await resolveSelection(moves.map((m) => m.id));
  if (!targets) return;
  const byDelta = new Map<number, string[]>();
  for (const m of moves) {
    const tgt = targets.get(m.id);
    if (!tgt) continue;
    const eid = tgt.expected;
    // The key's comp time as the engine reports it (the mirror's keyframe).
    const from = tgt.key.key.time;
    const delta = compTime(Math.max(0, m.time)) - from;
    if (delta === 0) continue;
    const list = byDelta.get(delta) ?? [];
    if (!list.includes(eid)) list.push(eid);
    byDelta.set(delta, list);
  }
  const cmds: Command[] = [...byDelta].map(([delta, list]) => ({ type: 'moveKeyframes', ids: list, delta }));
  if (cmds.length === 0) return;
  await edit(moves.length === 1 ? 'Move keyframe' : 'Move keyframes', cmds);
}

/** Delete keys (one undo entry). */
export async function deleteKeyframesUi(uiIds: ReadonlyArray<string>, label?: string): Promise<void> {
  if (uiIds.length === 0) return;
  const ids = await resolveKeyIds(uiIds);
  if (!ids) return;
  const list = [...new Set(ids.values())];
  if (list.length === 0) return;
  await edit(label ?? (uiIds.length === 1 ? 'Delete keyframe' : 'Delete keyframes'), { type: 'deleteKeyframes', ids: list });
}

// ── Easing ───────────────────────────────────────────────────────────

const MASK_PATH = /^masks\/[^/]+\/path$/;

/**
 * Scalar tracks spell hold as 'step'; data tracks as 'hold' (the legacy
 * writers' split). A data track is a property with no member tracks (Source
 * Text, a paint path, gradient stops, a puppet pin); the whole-mask snapshot
 * row is not one (its keys live beside the mask, not on a data track).
 */
function holdFor(tgt: Target): Easing {
  if (MASK_PATH.test(tgt.ref.path)) return 'step';
  return isDataProperty(tgt.prop.info) || tgt.prop.members.length === 0 ? 'hold' : 'step';
}

function toCubic(b: BezierHandles | readonly number[]): CubicBezier {
  return { x1: b[0]!, y1: b[1]!, x2: b[2]!, y2: b[3]! };
}

/**
 * Set (easing, handles) on keys — Easy Ease, the ease library, F9, the graph
 * panel's curve grid, a pasted ease. `curve.bezier` absent = the preset has no
 * handles. The whole key is eased (every dimension), as in AE.
 */
export async function easeKeyframes(
  uiIds: ReadonlyArray<string>,
  curve: { easing: EasingKind; bezier?: BezierHandles },
  label: string,
): Promise<void> {
  if (uiIds.length === 0) return;
  const targets = await resolveSelection(uiIds);
  if (!targets) return;
  const patches: KeyframePatch[] = [];
  const seen = new Set<string>();
  for (const id of uiIds) {
    const tgt = targets.get(id);
    const eid = tgt?.expected;
    if (!tgt || !eid || seen.has(eid)) continue;
    seen.add(eid);
    const easing: Easing = curve.easing === 'hold' ? holdFor(tgt) : curve.easing as Easing;
    patches.push({
      id: eid,
      easing,
      ...(curve.bezier ? { bezier: toCubic(curve.bezier) } : {}),
      spatialIn: [],
      spatialOut: [],
    });
  }
  if (patches.length === 0) return;
  await edit(label, { type: 'updateKeyframes', patches });
}

/** A preset (Easy Ease, Hold, an ease-library curve) on keys — F9, the pills, the graph grid. */
export function easePresetOnKeys(uiIds: ReadonlyArray<string>, preset: EasingPreset): Promise<void> {
  return easeKeyframes(uiIds, presetCurve(preset), `Set keyframe easing: ${preset}`);
}

/**
 * An interpolation KIND on keys (the graph editor's kind buttons). Like the
 * legacy `setEasing`, switching to a bezier kind seeds default handles on a key
 * that has none (and a fresh bezier key is continuous).
 */
export async function easeKindOnKeys(uiIds: ReadonlyArray<string>, kind: EasingKind): Promise<void> {
  if (uiIds.length === 0) return;
  const label = `Set keyframe easing: ${EASING_KIND_LABEL[kind]}`;
  const targets = await resolveSelection(uiIds);
  if (!targets) return;
  const patches: KeyframePatch[] = [];
  const seen = new Set<string>();
  for (const id of uiIds) {
    const tgt = targets.get(id);
    const eid = tgt?.expected;
    if (!tgt || !eid || seen.has(eid)) continue;
    seen.add(eid);
    // The key as its row's member sees it — numeric keys only (a data key has
    // no curve handles to seed), as the legacy `setEasing` read it.
    const lead = numbersOfValue(tgt.key.key.value).length > 0 ? tgt.key : undefined;
    const patch: KeyframePatch = { id: eid, easing: kind as Easing, spatialIn: [], spatialOut: [] };
    if (lead && !lead.bezier) {
      if (kind === 'bezier') patch.bezier = { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
      else if (kind === 'autoBezier' || kind === 'continuousBezier') patch.bezier = { x1: 0.333, y1: 0, x2: 0.667, y2: 1 };
    }
    // A fresh bezier key is continuous. The API states continuity as a boolean
    // (no "never set"), so "fresh" is a key that is not continuous yet.
    if (lead && kind === 'bezier' && !lead.continuous) patch.continuous = true;
    patches.push(patch);
  }
  if (patches.length === 0) return;
  await edit(label, { type: 'updateKeyframes', patches });
}

/** Rove Across Time on keys (the diamond menu, the graph editor): the engine re-times the run. */
export async function setRovingOnKeys(uiIds: ReadonlyArray<string>, roving: boolean): Promise<void> {
  const ids = await resolveKeyIds(uiIds);
  if (!ids || ids.size === 0) return;
  const patches: KeyframePatch[] = [...new Set(ids.values())].map((id) => ({ id, roving, spatialIn: [], spatialOut: [] }));
  await edit(roving ? 'Enable roving keyframe' : 'Disable roving keyframe', { type: 'updateKeyframes', patches });
}

// ── Member-level editors (graph editor, velocity dialog) ─────────────

/**
 * One write to ONE member track's key at stored time `t`: temporal fields for
 * that dimension (`KeyframePatch.dim` on a vector — AE's per-dimension ease),
 * and/or the member's new value in STORED units (sent as the whole key's value,
 * the other members keeping theirs).
 */
export interface MemberKeyWrite {
  t: number;
  easing?: Easing;
  bezier?: CubicBezier;
  continuous?: boolean;
  value?: number;
}

/**
 * The whole property's numbers at stored time `t`, API units — read from the
 * document MIRROR (B4): its key there, else its value (static, or the curve at
 * `t` read as comp time: the one caller without a key at `t` is a paste onto
 * another layer, whose keys land on the comp axis).
 */
function apiNumbersAt(nodeId: string, path: string, t: number, storedT: StoredTimeOf = storedTimeOf(nodeId)): number[] {
  const m = documentMirror();
  const k = m.keyframes(nodeId, path).find((x) => storedT(x) === t);
  return numbersOfValue(k ? k.value : m.valueAt(nodeId, path, secondsToFlicks(t)));
}

/** One member's API number from its stored number (colours are not scaled). */
function toApi(valueType: Parameters<typeof valueOfNumbers>[0], member: string, n: number): number {
  return valueType === 'color' ? n : n * apiUnitFactor(member);
}

/**
 * The patches for member-level writes on `member`'s keys (the graph editor's
 * handles, typed fields and diamond values; the velocity dialog). Null when a
 * key is gone or the track is not a property of the layer.
 */
export async function memberKeyPatches(
  nodeId: string,
  member: string,
  writes: ReadonlyArray<MemberKeyWrite>,
): Promise<KeyframePatch[] | null> {
  const r = propRefForTrack(nodeId, member);
  if (!r) return null;
  const keys = writes.map((w, i): MemberKeyAt => ({ id: String(i), nodeId, prop: member, t: w.t }));
  const ids = await resolveKeys(keys);
  if (!ids) return null;
  const out: KeyframePatch[] = [];
  for (const [i, w] of writes.entries()) {
    const eid = ids.get(String(i));
    if (!eid) return null;
    out.push({ id: eid, ...memberPatchFields(nodeId, member, w), spatialIn: [], spatialOut: [] });
  }
  return out;
}

/**
 * A member write's patch fields, without the id — for a gesture that resolved
 * its ids up front (the graph editor's drags). `dim` when the member is one
 * dimension of a vector; a value is the whole key's.
 */
export function memberPatchFields(nodeId: string, member: string, w: MemberKeyWrite): Omit<KeyframePatch, 'id' | 'spatialIn' | 'spatialOut'> {
  const r = propRefForTrack(nodeId, member);
  const grouped = !!r && r.members.length > 1;
  const temporal = w.easing !== undefined || w.bezier !== undefined || w.continuous !== undefined;
  const patch: Omit<KeyframePatch, 'id' | 'spatialIn' | 'spatialOut'> = {
    ...(w.easing !== undefined ? { easing: w.easing } : {}),
    ...(w.bezier ? { bezier: w.bezier } : {}),
    ...(w.continuous !== undefined ? { continuous: w.continuous } : {}),
    ...(grouped && temporal ? { dim: r!.member } : {}),
  };
  if (w.value !== undefined && r) {
    const members = r.members.length > 0 ? r.members : [member];
    const idx = Math.max(0, members.indexOf(member));
    const api = apiNumbersAt(nodeId, r.ref.path, w.t);
    const nums = members.map((_m, i) => api[i] ?? 0);
    nums[idx] = toApi(r.valueType, members[idx]!, w.value);
    patch.value = valueOfNumbers(r.valueType, nums);
  }
  return patch;
}

/** A member's whole key at drag start: every member's number, for absolute value writes. */
export interface MemberKeyStart {
  members: readonly string[];
  /** This member's index in `members`. */
  index: number;
  valueType: Parameters<typeof valueOfNumbers>[0];
  /** Every member's number, API units (the mirror's key). */
  api: number[];
}

/** Snapshot the whole key a member row's key belongs to (stored time `t`), from the document mirror. Null when not a property. */
export function memberKeyStart(nodeId: string, member: string, t: number): MemberKeyStart | null {
  const r = propRefForTrack(nodeId, member);
  if (!r) return null;
  const members = r.members.length > 0 ? r.members : [member];
  const api = apiNumbersAt(nodeId, r.ref.path, t);
  return { members, index: Math.max(0, members.indexOf(member)), valueType: r.valueType, api: members.map((_m, i) => api[i] ?? 0) };
}

/** `start` with some members replaced (STORED units) → the API Value of the whole key. */
export function memberKeyValue(start: MemberKeyStart, replace: ReadonlyMap<number, number>): Value {
  const nums = start.api.map((n, i) => {
    const r = replace.get(i);
    return r === undefined ? n : toApi(start.valueType, start.members[i]!, r);
  });
  return valueOfNumbers(start.valueType, nums);
}

/**
 * Where the key with engine id `eid` sits now on `member`'s property (stored
 * time), or null — the graph editor's focused key follows a key a gesture
 * moved (the diamond drag, roving) through this. Read from the document
 * mirror (B4).
 */
export function keyTimeById(nodeId: string, member: string, eid: string): number | null {
  const hit = memberKeysOf(documentMirror(), nodeId, member, storedTimeOf(nodeId));
  return hit?.keys.find((k) => k.key.id === eid)?.t ?? null;
}

/**
 * `resolveKeys` for a gesture that MOVES keys: a key the engine still names
 * by its positional fallback (a key a pre-API writer made) would lose that
 * name at the first move, so the gesture's first message stamps them (an
 * unchanged label) and the ids are read again.
 */
export async function resolveKeysForGesture(gesture: GestureSession, uiKeys: ReadonlyArray<MemberKeyAt>): Promise<Map<string, string> | null> {
  const ids = await resolveKeys(uiKeys);
  if (!ids) return null;
  const positional = [...new Set([...ids.values()].filter((id) => id.startsWith('@')))];
  if (positional.length === 0) return ids;
  gesture.send({ type: 'updateKeyframes', patches: positional.map((id) => ({ id, spatialIn: [], spatialOut: [] })) });
  await engineIdle();
  return resolveKeys(uiKeys);
}

/** Whether the member-level editors can write this track through the API. */
export function memberAddressable(nodeId: string, member: string): boolean {
  return !!propRefForTrack(nodeId, member);
}

export { toCubic };

// ── Paste ────────────────────────────────────────────────────────────

/**
 * Ctrl+V: the copied keys onto every target layer, the earliest copied key at
 * the playhead (`atCompTime`, comp seconds), spacing kept — one undo entry.
 * One `pasteKeyframes` per (layer, property). The clipboard holds MEMBER keys;
 * Copy takes every member of a copied key (`copyKeyframes` — a whole key, as
 * AE copies it), so a property's keys are whole at each copied time; a member
 * missing from an older clipboard takes the target's own value there.
 */
export async function pasteKeyframesAt(targetNodeIds: readonly string[], atCompTime: number): Promise<void> {
  const entries = clipboardEntries();
  if (entries.length === 0 || targetNodeIds.length === 0) return;
  const minT = Math.min(...entries.map((e) => e.t));
  const cmds: Command[] = [];
  for (const nodeId of targetNodeIds) {
    // property path → time → member → entry
    const groups = new Map<string, { ref: PropRef; members: readonly string[]; vt: Parameters<typeof valueOfNumbers>[0]; byT: Map<number, Map<string, typeof entries[number]>> }>();
    for (const e of entries) {
      const r = propRefForTrack(nodeId, e.prop);
      if (!r) continue; // the target has no such property: skipped, as before
      const g = groups.get(r.ref.path) ?? { ref: r.ref, members: r.members, vt: r.valueType, byT: new Map() };
      const at = g.byT.get(e.t) ?? new Map();
      at.set(e.prop, e);
      g.byT.set(e.t, at);
      groups.set(r.ref.path, g);
    }
    const storedT = storedTimeOf(nodeId);
    for (const g of groups.values()) {
      const keys: Keyframe[] = [];
      for (const [t, byMember] of [...g.byT].sort((a, b) => a[0] - b[0])) {
        const lead = g.members.map((m) => byMember.get(m)).find((e) => e !== undefined)!;
        // A member the clipboard lacks takes the target's own number (API units, from the mirror).
        const own = byMember.size < g.members.length ? apiNumbersAt(nodeId, g.ref.path, t, storedT) : [];
        const nums = g.members.map((m, i) => {
          const e = byMember.get(m);
          return e ? toApi(g.vt, m, e.value) : own[i] ?? 0;
        });
        const anySpatial = g.members.some((m) => byMember.get(m)?.si !== undefined || byMember.get(m)?.so !== undefined);
        const dims = g.members.map((m) => {
          const e = byMember.get(m) ?? lead;
          return { easing: (e.easing ?? 'linear') as Easing, ...(e.bezier ? { bezier: toCubic(e.bezier) } : {}), continuous: e.continuous === true };
        });
        const uniform = dims.every((d) => JSON.stringify(d) === JSON.stringify(dims[0]));
        keys.push({
          id: '',
          time: compTime(t),
          value: valueOfNumbers(g.vt, nums),
          easing: (lead.easing ?? 'linear') as Easing,
          ...(lead.bezier ? { bezier: toCubic(lead.bezier) } : {}),
          continuous: lead.continuous === true,
          roving: lead.roving === true,
          spatialInterp: (lead.spatialInterp ?? 'legacy') as SpatialInterp,
          spatialIn: anySpatial ? g.members.map((m) => byMember.get(m)?.si ?? 0) : [],
          spatialOut: anySpatial ? g.members.map((m) => byMember.get(m)?.so ?? 0) : [],
          label: 0,
          dims: uniform || g.members.length < 2 ? [] : dims,
        });
      }
      if (keys.length === 0) continue;
      // The earliest key of THIS property lands where the earliest copied key
      // of the whole clipboard would put it — spacing kept across properties.
      const first = Math.min(...[...g.byT.keys()]);
      cmds.push({ type: 'pasteKeyframes', prop: g.ref, time: compTime(atCompTime + (first - minT)), keys });
    }
  }
  if (cmds.length === 0) return;
  await edit('Paste keyframes', cmds);
}
