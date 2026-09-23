/**
 * The timeline's keyframe edits through the engine API (B3,
 * docs/B3_PATTERNS.md §4): move, delete, ease, velocity, nudge, paste.
 *
 * ── Ids ──────────────────────────────────────────────────────────────
 * The timeline, the graph editor and the keyframe selection store still name a
 * key by its POSITION (`nodeId::prop::t`, stored time) — that id is editor
 * state shared with App.tsx and `src/core/animation`, and it changes format
 * when the selection store moves to engine ids (B4, with the mirror). What
 * changes here is the WRITE: every edit resolves those positions to the
 * ENGINE's keyframe ids with the `getKeyframes` query (never `makeKeyframeId`)
 * and sends commands that carry them. The codec itself is
 * `keyframeSelectionIds.ts`.
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
 */

import type { Command, CubicBezier, Easing, Keyframe, KeyframePatch, PropRef, SpatialInterp, Value } from '@motion/engine-api';
import {
  defaultAnimation,
  expandKeyframeProp,
  sampleTrack,
  type BezierHandles,
  type EasingKind,
} from '@motion/animation';
import { keyframeToCompTime } from '@core/timeline/TimelineController';
import { presetCurve, type EasingPreset } from '@core/animation/keyframeAssistants';
import { EASING_KIND_LABEL } from '@core/animation/easingVocabulary';
import { clipboardEntries } from '@core/animation/keyframeClipboard';
import { apiUnitFactor } from '@core/engine/props';
import { MASK_ANIM_PROP } from '@core/timeline/propertyTree';
import { readNodeMask, readNodeMaskAnim } from '@core/effects/mask';
import { fallbackKeyId, maskKeyId } from '@core/engine/props';
import { readStaticPropertyValue } from '@core/inspector/propertyValue';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { edit, type GestureSession } from '@core/engine/uiEdits';
import { compTime, paths, propRefForTrack, valueOfNumbers } from '@core/engine/propRefs';
import { parseUiKey, uiKeyId, type UiKey } from './keyframeSelectionIds';

export { parseUiKey, uiKeyId, type UiKey };

interface Target {
  ref: PropRef;
  /** The member track the stored time is on (comp-time conversion). */
  member: string;
  /**
   * The id the engine gives this key: the stored key's own id, else the
   * engine's positional fallback for its LEAD member (props.readKeys' rule).
   * Matched on STORED time, never on comp time — two keys a trimmed clip
   * clamps onto the same comp instant must not resolve to one id.
   */
  expected: string;
}

function hasKeyAt(nodeId: string, member: string, t: number): boolean {
  if (defaultAnimation.getTrackKeyframes(nodeId, member)?.some((k) => Math.abs(k.t - t) < 1e-9)) return true;
  return defaultAnimation.getDataTrack(nodeId, member)?.keyframes.some((k) => Math.abs(k.t - t) < 1e-9) ?? false;
}

/** The API property a selection key lives on, or null when there is no such key any more. */
function targetOf(k: UiKey): Target | null {
  if (!defaultSceneGraph.getNode(k.nodeId)) return null;
  if (k.prop === MASK_ANIM_PROP) {
    // Whole-mask snapshots: any mask's Path addresses the snapshot entry.
    const node = defaultSceneGraph.getNode(k.nodeId)!;
    const first = readNodeMask(node)?.paths[0];
    const mk = readNodeMaskAnim(node).find((x) => Math.abs(x.t - k.t) < 1e-9);
    if (!first || !mk) return null;
    return { ref: { layer: k.nodeId, path: paths.mask(first.id, 'path') }, member: MASK_ANIM_PROP, expected: maskKeyId(k.nodeId, mk, first.id) };
  }
  const members = expandKeyframeProp(k.prop);
  const member = members.find((m) => hasKeyAt(k.nodeId, m, k.t)) ?? members[0]!;
  const r = propRefForTrack(k.nodeId, member);
  if (!r) return null;
  let expected: string | null = null;
  if (r.members.length === 0) {
    const dk = defaultAnimation.getDataTrack(k.nodeId, member)?.keyframes.find((x) => Math.abs(x.t - k.t) < 1e-9);
    if (dk) expected = dk.id ?? fallbackKeyId(k.nodeId, member, dk.t);
  } else {
    // The property's key at this time is its LEAD member's (the first keyed).
    for (const m of r.members) {
      const sk = defaultAnimation.getTrackKeyframes(k.nodeId, m)?.find((x) => Math.abs(x.t - k.t) < 1e-9);
      if (sk) { expected = sk.id ?? fallbackKeyId(k.nodeId, m, sk.t); break; }
    }
  }
  return expected ? { ref: r.ref, member, expected } : null;
}

/**
 * Selection ids → engine keyframe ids, in input order. Null when ANY of them no
 * longer names a key (a stale selection: the caller does nothing).
 * Unparseable ids are dropped.
 */
export async function resolveKeyIds(uiIds: Iterable<string>): Promise<Map<string, string> | null> {
  const keys: UiKey[] = [];
  for (const id of uiIds) {
    const k = parseUiKey(id);
    if (k) keys.push(k);
  }
  return resolveKeys(keys);
}

/** `resolveKeyIds` over already-decoded keys (keyed by their `id`). */
export async function resolveKeys(uiKeys: ReadonlyArray<UiKey>): Promise<Map<string, string> | null> {
  const keys: Array<{ k: UiKey; tgt: Target }> = [];
  for (const k of uiKeys) {
    const tgt = targetOf(k);
    if (!tgt) return null;
    keys.push({ k, tgt });
  }
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
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
    out.set(x.k.id, x.tgt.expected);
  }
  return out;
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
  const ids = await resolveKeyIds(moves.map((m) => m.id));
  if (!ids) return;
  const byDelta = new Map<number, string[]>();
  for (const m of moves) {
    const k = parseUiKey(m.id);
    const eid = ids.get(m.id);
    if (!k || !eid) continue;
    const member = expandKeyframeProp(k.prop).find((p) => hasKeyAt(k.nodeId, p, k.t)) ?? k.prop;
    const from = compTime(keyframeToCompTime(k.nodeId, k.t, member));
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

/** Scalar tracks spell hold as 'step'; data tracks as 'hold' (the legacy writers' split). */
function holdFor(k: UiKey): Easing {
  return expandKeyframeProp(k.prop).some((p) => defaultAnimation.getDataTrack(k.nodeId, p)) ? 'hold' : 'step';
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
  const ids = await resolveKeyIds(uiIds);
  if (!ids) return;
  const patches: KeyframePatch[] = [];
  const seen = new Set<string>();
  for (const id of uiIds) {
    const k = parseUiKey(id);
    const eid = ids.get(id);
    if (!k || !eid || seen.has(eid)) continue;
    seen.add(eid);
    const easing: Easing = curve.easing === 'hold' ? holdFor(k) : curve.easing as Easing;
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
  const ids = await resolveKeyIds(uiIds);
  if (!ids) return;
  const patches: KeyframePatch[] = [];
  const seen = new Set<string>();
  for (const id of uiIds) {
    const k = parseUiKey(id);
    const eid = ids.get(id);
    if (!k || !eid || seen.has(eid)) continue;
    seen.add(eid);
    const lead = expandKeyframeProp(k.prop)
      .map((p) => defaultAnimation.getTrackKeyframes(k.nodeId, p)?.find((x) => Math.abs(x.t - k.t) < 1e-6))
      .find((x) => x !== undefined);
    const patch: KeyframePatch = { id: eid, easing: kind as Easing, spatialIn: [], spatialOut: [] };
    if (lead && !lead.bezier) {
      if (kind === 'bezier') patch.bezier = { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
      else if (kind === 'autoBezier' || kind === 'continuousBezier') patch.bezier = { x1: 0.333, y1: 0, x2: 0.667, y2: 1 };
    }
    if (lead && kind === 'bezier' && lead.continuous === undefined) patch.continuous = true;
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

/** Every member's number at stored time `t` (its key, else its curve, else its static value), stored units. */
function memberNumbersAt(nodeId: string, members: readonly string[], t: number): number[] {
  return members.map((m) => {
    const kfs = defaultAnimation.getTrackKeyframes(nodeId, m);
    const k = kfs?.find((x) => x.t === t);
    if (k) return k.value;
    if (kfs && kfs.length > 0) return sampleTrack({ nodeId, prop: m, keyframes: kfs }, t) ?? 0;
    return readStaticPropertyValue(nodeId, m) ?? 0;
  });
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
  const keys = writes.map((w, i): UiKey => ({ id: String(i), nodeId, prop: member, t: w.t }));
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
    const nums = memberNumbersAt(nodeId, members, w.t);
    nums[Math.max(0, members.indexOf(member))] = w.value;
    patch.value = valueOfNumbers(r.valueType, nums.map((n, i) => (r.valueType === 'color' ? n : n * apiUnitFactor(members[i]))));
  }
  return patch;
}

/** A member's whole key at drag start: every member's number (stored units), for absolute value writes. */
export interface MemberKeyStart {
  members: readonly string[];
  /** This member's index in `members`. */
  index: number;
  valueType: Parameters<typeof valueOfNumbers>[0];
  nums: number[];
}

/** Snapshot the whole key a member row's key belongs to (stored time `t`). Null when not a property. */
export function memberKeyStart(nodeId: string, member: string, t: number): MemberKeyStart | null {
  const r = propRefForTrack(nodeId, member);
  if (!r) return null;
  const members = r.members.length > 0 ? r.members : [member];
  return { members, index: Math.max(0, members.indexOf(member)), valueType: r.valueType, nums: memberNumbersAt(nodeId, members, t) };
}

/** `start` with some members replaced (stored units) → the API Value of the whole key. */
export function memberKeyValue(start: MemberKeyStart, replace: ReadonlyMap<number, number>): Value {
  const nums = start.nums.map((n, i) => replace.get(i) ?? n);
  return valueOfNumbers(start.valueType, nums.map((n, i) => (start.valueType === 'color' ? n : n * apiUnitFactor(start.members[i]))));
}

/**
 * Where the key with engine id `eid` sits now on `member`'s property (stored
 * time), or null — the selection's positional ids are rewritten from this
 * after a gesture moved keys (the diamond drag, roving).
 */
export function keyTimeById(nodeId: string, member: string, eid: string): number | null {
  const members = propRefForTrack(nodeId, member)?.members ?? [member];
  for (const m of members.length > 0 ? members : [member]) {
    const k = defaultAnimation.getTrackKeyframes(nodeId, m)?.find((x) => x.id === eid);
    if (k) return k.t;
    const dk = defaultAnimation.getDataTrack(nodeId, m)?.keyframes.find((x) => x.id === eid);
    if (dk) return dk.t;
  }
  return null;
}

/**
 * `resolveKeys` for a gesture that MOVES keys: a key the engine still names
 * by its positional fallback (a key a pre-API writer made) would lose that
 * name at the first move, so the gesture's first message stamps them (an
 * unchanged label) and the ids are read again.
 */
export async function resolveKeysForGesture(gesture: GestureSession, uiKeys: ReadonlyArray<UiKey>): Promise<Map<string, string> | null> {
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
    for (const g of groups.values()) {
      const keys: Keyframe[] = [];
      for (const [t, byMember] of [...g.byT].sort((a, b) => a[0] - b[0])) {
        const lead = g.members.map((m) => byMember.get(m)).find((e) => e !== undefined)!;
        const own = memberNumbersAt(nodeId, g.members, t);
        const nums = g.members.map((m, i) => (byMember.get(m)?.value ?? own[i]!) * (g.vt === 'color' ? 1 : apiUnitFactor(m)));
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
