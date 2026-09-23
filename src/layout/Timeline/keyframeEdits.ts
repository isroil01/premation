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
 * ── What the API cannot address yet (legacy path, whole action) ───────
 * The API keys a PROPERTY: Scale is one vec2 with one key per time, a colour
 * one value. The timeline draws some grouped properties as separate member
 * rows (Scale X / Scale Y, colour channels) and lets a key on one member move
 * alone. When a member's sibling has a key at the same time, a command on the
 * property would move (or delete, or re-ease) the sibling too — so that action
 * keeps the legacy writer (`resolveKeyIds` answers null). Merged Position rows
 * and separated Position dimensions address exactly what the API addresses.
 */

import type { Command, CubicBezier, Easing, Keyframe, KeyframePatch, PropRef, SpatialInterp } from '@motion/engine-api';
import {
  defaultAnimation,
  expandKeyframeProp,
  POSITION_PSEUDO_PROP,
  type BezierHandles,
  type EasingKind,
} from '@motion/animation';
import { keyframeToCompTime } from '@core/timeline/TimelineController';
import { applyEasingToKeyframes, presetCurve, type EasingPreset } from '@core/animation/keyframeAssistants';
import { applyEasingKindToKeyframes, EASING_KIND_LABEL } from '@core/animation/easingVocabulary';
import { clipboardEntries, pasteKeyframes as legacyPasteKeyframes } from '@core/animation/keyframeClipboard';
import { apiUnitFactor } from '@core/engine/props';
import { MASK_ANIM_PROP } from '@core/timeline/propertyTree';
import { readNodeMask, readNodeMaskAnim } from '@core/effects/mask';
import { fallbackKeyId, maskKeyId } from '@core/engine/props';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { engine } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { bumpScene } from '@stores/sceneStore';
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

/** The API property a selection key lives on, or null when the API cannot address it alone. */
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
  if (k.prop !== POSITION_PSEUDO_PROP && r.members.length > 1) {
    // A lone member row of a grouped property: only safe when no sibling
    // member has a key at this time (see the file header).
    const siblingKeyed = r.members.some((m) => m !== member && hasKeyAt(k.nodeId, m, k.t));
    if (siblingKeyed) return null;
  }
  let expected: string | null = null;
  if (r.members.length === 0) {
    const dk = defaultAnimation.getDataTrack(k.nodeId, member)?.keyframes.find((x) => Math.abs(x.t - k.t) < 1e-9);
    if (dk) expected = dk.id ?? fallbackKeyId(k.nodeId, member, dk.t);
  } else {
    for (const m of r.members) {
      const sk = defaultAnimation.getTrackKeyframes(k.nodeId, m)?.find((x) => Math.abs(x.t - k.t) < 1e-9);
      if (sk) { expected = sk.id ?? fallbackKeyId(k.nodeId, m, sk.t); break; }
    }
  }
  return expected ? { ref: r.ref, member, expected } : null;
}

/**
 * Selection ids → engine keyframe ids, in input order. Null when ANY of them
 * cannot be addressed (the caller keeps the legacy writer for the whole action,
 * so a user action is still one undo entry). Unparseable ids are dropped.
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
 * cannot swallow each other). `legacy` runs instead when the API cannot
 * address one of them.
 */
export async function moveKeyframesTo(
  moves: ReadonlyArray<{ id: string; time: number }>,
  legacy: () => void,
): Promise<void> {
  if (moves.length === 0) return;
  const ids = await resolveKeyIds(moves.map((m) => m.id));
  if (!ids) {
    legacy();
    return;
  }
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

/** Delete keys (one undo entry). `legacy` runs when the API cannot address one of them. */
export async function deleteKeyframesUi(uiIds: ReadonlyArray<string>, legacy: () => void): Promise<void> {
  if (uiIds.length === 0) return;
  const ids = await resolveKeyIds(uiIds);
  if (!ids) {
    legacy();
    return;
  }
  const list = [...new Set(ids.values())];
  if (list.length === 0) return;
  await edit(uiIds.length === 1 ? 'Delete keyframe' : 'Delete keyframes', { type: 'deleteKeyframes', ids: list });
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
 * panel's curve grid. `curve.bezier` absent = the preset has no handles.
 */
export async function easeKeyframes(
  uiIds: ReadonlyArray<string>,
  curve: { easing: EasingKind; bezier?: BezierHandles },
  label: string,
  legacy: () => void,
): Promise<void> {
  if (uiIds.length === 0) return;
  const ids = await resolveKeyIds(uiIds);
  if (!ids) {
    legacy();
    return;
  }
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
  return easeKeyframes(uiIds, presetCurve(preset), `Set keyframe easing: ${preset}`, () => {
    // B3-legacy: a key the API cannot address alone (file header).
    applyEasingToKeyframes(uiIds, preset);
    bumpScene();
  });
}

/**
 * An interpolation KIND on keys (the graph editor's kind buttons). Like the
 * legacy `setEasing`, switching to a bezier kind seeds default handles on a key
 * that has none (and a fresh bezier key is continuous).
 */
export async function easeKindOnKeys(uiIds: ReadonlyArray<string>, kind: EasingKind): Promise<void> {
  if (uiIds.length === 0) return;
  const label = `Set keyframe easing: ${EASING_KIND_LABEL[kind]}`;
  const legacy = (): void => {
    // B3-legacy: a key the API cannot address alone (file header).
    applyEasingKindToKeyframes(uiIds, kind);
    bumpScene();
  };
  const ids = await resolveKeyIds(uiIds);
  if (!ids) {
    legacy();
    return;
  }
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

/**
 * Patch the keys at stored times on ONE member track (graph editor, velocity
 * dialog, roving). Engine when the member IS the whole property (a scalar, a
 * separated Position dimension); otherwise null — a patch on a grouped
 * property would reach its sibling members, which these member-level editors
 * never touched.
 */
export async function memberKeyPatches(
  nodeId: string,
  member: string,
  writes: ReadonlyArray<{ t: number; patch: Omit<KeyframePatch, 'id' | 'spatialIn' | 'spatialOut'> }>,
): Promise<KeyframePatch[] | null> {
  const r = propRefForTrack(nodeId, member);
  if (!r || r.members.length !== 1) return null;
  const keys = writes.map((w, i): UiKey => ({ id: String(i), nodeId, prop: member, t: w.t }));
  const ids = await resolveKeys(keys);
  if (!ids) return null;
  const out: KeyframePatch[] = [];
  for (const [i, w] of writes.entries()) {
    const eid = ids.get(String(i));
    if (!eid) return null;
    out.push({ id: eid, ...w.patch, spatialIn: [], spatialOut: [] });
  }
  return out;
}

/** Whether the member-level editors can write this track through the API (see `memberKeyPatches`). */
export function memberAddressable(nodeId: string, member: string): boolean {
  const r = propRefForTrack(nodeId, member);
  return !!r && r.members.length === 1;
}

export { toCubic };

// ── Paste ────────────────────────────────────────────────────────────

/**
 * Ctrl+V: the copied keys onto every target layer, the earliest copied key at
 * the playhead (`atCompTime`, comp seconds), spacing kept — one undo entry.
 * One `pasteKeyframes` per (layer, property). The clipboard holds MEMBER keys
 * (x and y separately); a property is pasted through the API only when every
 * member of it was copied at each time, otherwise the whole paste keeps the
 * legacy writer (a lone copied member is a member-level write — see header).
 */
export async function pasteKeyframesAt(targetNodeIds: readonly string[], atCompTime: number): Promise<void> {
  const entries = clipboardEntries();
  if (entries.length === 0 || targetNodeIds.length === 0) return;
  const legacy = (): void => {
    // B3-legacy: engine gap — a lone copied member of a grouped property (see above).
    legacyPasteKeyframes(targetNodeIds, atCompTime);
  };
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
        if (g.members.some((m) => !byMember.has(m))) {
          legacy();
          return;
        }
        const lead = byMember.get(g.members[0]!)!;
        const nums = g.members.map((m) => byMember.get(m)!.value * apiUnitFactor(m));
        const anySpatial = g.members.some((m) => byMember.get(m)!.si !== undefined || byMember.get(m)!.so !== undefined);
        keys.push({
          id: '',
          time: compTime(t),
          value: valueOfNumbers(g.vt, nums),
          easing: (lead.easing ?? 'linear') as Easing,
          ...(lead.bezier ? { bezier: toCubic(lead.bezier) } : {}),
          continuous: lead.continuous === true,
          roving: lead.roving === true,
          spatialInterp: (lead.spatialInterp ?? 'legacy') as SpatialInterp,
          spatialIn: anySpatial ? g.members.map((m) => byMember.get(m)!.si ?? 0) : [],
          spatialOut: anySpatial ? g.members.map((m) => byMember.get(m)!.so ?? 0) : [],
          label: 0,
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
