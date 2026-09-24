/**
 * inspectorEdits — the Inspector's command builders over the engine API (B3,
 * docs/B3_PATTERNS.md). Everything here COMPOSES commands from what a panel
 * holds today (node ids + track names, comp-time seconds) and reads the
 * document MIRROR (B4) only to decide what to send — the other members of a
 * vector at the playhead, whether a property is keyed.
 * Sending is the caller's: `edit(label, cmds)` for a click / a typed value,
 * `useGesture().send(cmds)` inside a drag.
 *
 *   trackWrites            member tracks of one layer → ONE whole-value write
 *                          per API property, in API units (Position is one vec2,
 *                          Scale is percent). Several members of the same
 *                          property in one write — Linked Scale, an anchor preset
 *                          — must go through here: two `memberWrite`s of one
 *                          property in one command would each re-read the other
 *                          member and the second would undo the first.
 *   valueCommands          per-layer values for one or more tracks → set /
 *                          auto-keyframe commands (the inspector's field write)
 *   stopwatchCommands      the (group) stopwatch across the selection
 *   keyToggleCommands      the (group) navigator diamond across the selection
 *   moveKeysCommands       the mini-lane retime (keys at one time → another)
 *   keysAtCommands         delete / ease the keys at one time
 *   expressionCommands     set/link an expression where the API addresses it
 *
 * Why not `@core/engine/propertyCommands.valueCommands` + `memberWrite`:
 * `memberWrite` builds the value from STORED member numbers, but the API takes
 * AE units — transform scale is stored as a multiplier and addressed in
 * percent (props.ts `apiUnitFactor`), so a Scale write through it lands 100×
 * too small, and the other member is read in the wrong unit too. Reported as
 * an engine gap; this module converts at the seam until propRefs does.
 */

import type {
  Command,
  EngineClient,
  Easing,
  KeyframeInsert,
  KeyframePatch,
  LayerSwitchesPatch,
  PropRef,
  PropertyWrite,
} from '@motion/engine-api';
import { parentOptionsFor } from '@core/scene/parenting';
import type { TrackMatte } from '@core/effects/matte';
import { isDistributeMode, planAlign, type AlignMode } from '@core/scene/alignNodes';
import { getTime } from '@stores/playbackClockStore';
import {
  clearTrackTangents,
  EASY_EASE_BEZIER,
  EASY_EASE_IN_BEZIER,
  EASY_EASE_OUT_BEZIER,
  smoothTrackTangents,
} from '@motion/animation';
import { compTime, propRefForTrack, valueOfNumbers, type TrackRef } from '@core/engine/propRefs';
import { apiUnitFactor } from '@core/engine/props';
import { engine } from '@core/engine/engineInstance';
import { isLayer } from '@core/engine/doc';
import { trackMatteCommand } from '@core/engine/trackWrites';
import { KEYFRAME_EPS, readTrack } from '@core/mirror/selection';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { edit } from '@core/engine/uiEdits';
import type { Keyframe as TsKeyframe } from '@motion/animation';

const refKey = (r: PropRef): string => `${r.layer}\u0000${r.path}`;

/**
 * Resolve a track, or null when the engine does not address it: the node is
 * not a LAYER (a composition root, a node outside any composition) or its
 * catalog has no such property.
 */
export function trackRef(nodeId: string, track: string): TrackRef | null {
  if (!isLayer(nodeId)) return null;
  try {
    return propRefForTrack(nodeId, track);
  } catch {
    return null;
  }
}

/** True when every (layer, track) pair is addressable through the API. */
export function allAddressable(nodeIds: ReadonlyArray<string>, tracks: ReadonlyArray<string>): boolean {
  return nodeIds.every((id) => tracks.every((t) => trackRef(id, t) !== null));
}

/**
 * Member tracks of ONE layer (stored units) → one write per API property, at
 * comp time `seconds`. Members not given keep their value at that time.
 * Tracks the engine does not address are skipped.
 */
export function trackWrites(
  nodeId: string,
  values: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  seconds: number,
): PropertyWrite[] {
  return resolvedWrites(nodeId, values, seconds).map((x) => x.write);
}

function resolvedWrites(
  nodeId: string,
  values: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  seconds: number,
): Array<{ write: PropertyWrite; r: TrackRef }> {
  const given = values instanceof Map ? values as ReadonlyMap<string, number> : new Map(Object.entries(values));
  const byProp = new Map<string, TrackRef>();
  for (const track of given.keys()) {
    const r = trackRef(nodeId, track);
    if (r && !byProp.has(r.ref.path)) byProp.set(r.ref.path, r);
  }
  const time = compTime(seconds);
  const mirror = documentMirror();
  const out: Array<{ write: PropertyWrite; r: TrackRef }> = [];
  for (const r of byProp.values()) {
    // The members not given keep their value at the playhead — read from the
    // mirror in API units (a static property's value, else the value at
    // `time`), the property's default where the mirror has none.
    const current = numbersOfValue(mirror.valueAt(nodeId, r.ref.path, time));
    const fallback = numbersOfValue(mirror.property(nodeId, r.ref.path)?.defaultValue);
    const nums = r.members.map((m, i) => {
      const v = given.get(m);
      if (v !== undefined && Number.isFinite(v)) return v * apiUnitFactor(m);
      return current[i] ?? fallback[i] ?? 0;
    });
    out.push({ write: { prop: r.ref, value: valueOfNumbers(r.valueType, nums), time }, r });
  }
  return out;
}

export interface ValueOptions {
  /** The playhead, comp seconds. */
  seconds: number;
  /** Auto-keyframe preference: an unanimated property gets a key too. */
  autoKeyframe?: boolean;
}

/**
 * Per-layer values → commands. Each entry may carry several tracks (Linked
 * Scale writes W and H together). Animated properties get a key at the
 * playhead (setProperty with time = AE setValueAtTime); under auto-keyframe an
 * unanimated one gets its first key; the rest a static write.
 */
export function valueCommands(
  entries: ReadonlyArray<{ nodeId: string; values: Readonly<Record<string, number>> }>,
  opts: ValueOptions,
): Command[] {
  const sets: PropertyWrite[] = [];
  const keys: KeyframeInsert[] = [];
  for (const e of entries) {
    const finite = Object.fromEntries(Object.entries(e.values).filter(([, v]) => Number.isFinite(v)));
    if (Object.keys(finite).length === 0) continue;
    for (const { write: w, r } of resolvedWrites(e.nodeId, finite, opts.seconds)) {
      const animated = isRefAnimated(e.nodeId, r);
      if (!animated && opts.autoKeyframe && r.animatable) {
        keys.push({ prop: w.prop, time: w.time!, value: w.value, spatialIn: [], spatialOut: [] });
      } else {
        sets.push(w);
      }
    }
  }
  const out: Command[] = [];
  if (sets.length > 0) out.push({ type: 'setProperties', writes: sets });
  if (keys.length > 0) out.push({ type: 'addKeyframes', keys });
  return out;
}

/**
 * A numeric preset bag (Transform presets) onto every layer that has each
 * property, as ONE undo entry. Skew / Skew Axis / Fill Opacity at their
 * defaults are addressed through the engine's LATENT bindings (B3z,
 * latentPropSpecs.ts); a property no layer can take is skipped and reported.
 */
export function applyPresetValues(
  nodeIds: ReadonlyArray<string>,
  bag: Readonly<Record<string, number | string | boolean>>,
  opts: ValueOptions,
  label: string,
): void {
  const entries: Array<{ nodeId: string; values: Record<string, number> }> = [];
  const skipped = new Set<string>();
  const mirror = documentMirror();
  for (const nodeId of nodeIds) {
    const values: Record<string, number> = {};
    for (const [prop, v] of Object.entries(bag)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (readTrack(mirror, nodeId, prop, opts.seconds) === undefined) continue;
      if (trackRef(nodeId, prop)) values[prop] = v;
      else skipped.add(prop);
    }
    if (Object.keys(values).length > 0) entries.push({ nodeId, values });
  }
  if (entries.length > 0) void edit(label, valueCommands(entries, opts));
  if (skipped.size > 0) console.warn(`[applyPresetValues] not addressed by the engine on some layers: ${[...skipped].join(', ')}`);
}

/** One track, one value per layer (the common field write). */
export function scalarValueCommands(
  track: string,
  writes: ReadonlyArray<{ nodeId: string; value: number }>,
  opts: ValueOptions,
): Command[] {
  return valueCommands(writes.map((w) => ({ nodeId: w.nodeId, values: { [track]: w.value } })), opts);
}

/** Unique API properties behind (layers × tracks). */
export function uniqueRefs(nodeIds: ReadonlyArray<string>, tracks: ReadonlyArray<string>): Array<{ nodeId: string; r: TrackRef }> {
  const seen = new Set<string>();
  const out: Array<{ nodeId: string; r: TrackRef }> = [];
  for (const id of nodeIds) {
    for (const t of tracks) {
      const r = trackRef(id, t);
      if (!r) continue;
      const k = refKey(r.ref);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ nodeId: id, r });
    }
  }
  return out;
}

/** Whether the property behind `r` is keyed (the mirror's key list: one per API property). */
function isRefAnimated(nodeId: string, r: TrackRef): boolean {
  return documentMirror().keyframes(nodeId, r.ref.path).length > 0;
}

/**
 * The stopwatch over the selection for one or several tracks (a pair row's
 * group stopwatch): any property animated → all off, else all on (AE).
 */
export function stopwatchCommands(nodeIds: ReadonlyArray<string>, tracks: ReadonlyArray<string>, seconds: number): Command[] {
  const refs = uniqueRefs(nodeIds, tracks).filter((x) => x.r.animatable);
  if (refs.length === 0) return [];
  const anyAnimated = refs.some((x) => isRefAnimated(x.nodeId, x.r));
  const time = compTime(seconds);
  return refs
    .filter((x) => isRefAnimated(x.nodeId, x.r) === anyAnimated)
    .map((x) => ({ type: 'setAnimated', prop: x.r.ref, animated: !anyAnimated, time }) as Command);
}

/** Engine keyframe ids of `refs` at comp time `seconds` (± KEYFRAME_EPS). */
export async function keyIdsAt(refs: ReadonlyArray<PropRef>, seconds: number, client: EngineClient = engine()): Promise<string[]> {
  if (refs.length === 0) return [];
  const time = compTime(seconds);
  const eps = compTime(KEYFRAME_EPS);
  const res = await client.query({ type: 'getKeyframes', props: [...refs], range: { start: time - eps, duration: 2 * eps } });
  if (!res.ok) return [];
  return res.value.sets.flatMap((s) => s.keyframes.filter((k) => Math.abs(k.time - time) <= eps).map((k) => k.id));
}

/**
 * The navigator diamond over the selection for one or several tracks: keys at
 * the playhead → delete them; none → add one (holding the evaluated value) on
 * every animated property.
 */
export async function keyToggleCommands(
  nodeIds: ReadonlyArray<string>,
  tracks: ReadonlyArray<string>,
  seconds: number,
): Promise<Command[]> {
  const animated = uniqueRefs(nodeIds, tracks).filter((x) => isRefAnimated(x.nodeId, x.r)).map((x) => x.r.ref);
  if (animated.length === 0) return [];
  const at = await keyIdsAt(animated, seconds);
  if (at.length > 0) return [{ type: 'deleteKeyframes', ids: at }];
  const time = compTime(seconds);
  return [{ type: 'addKeyframes', keys: animated.map((prop) => ({ prop, time, spatialIn: [], spatialOut: [] })) }];
}

/** Keys of these tracks at `fromSeconds` → `toSeconds` (the mini lane's drag). */
export async function moveKeysCommands(
  nodeId: string,
  tracks: ReadonlyArray<string>,
  fromSeconds: number,
  toSeconds: number,
): Promise<Command[]> {
  const refs = uniqueRefs([nodeId], tracks).map((x) => x.r.ref);
  const ids = await keyIdsAt(refs, fromSeconds);
  const delta = compTime(toSeconds) - compTime(fromSeconds);
  if (ids.length === 0 || delta === 0) return [];
  return [{ type: 'moveKeyframes', ids, delta }];
}

/** Delete the keys of these tracks at `seconds`. */
export async function deleteKeysAtCommands(nodeId: string, tracks: ReadonlyArray<string>, seconds: number): Promise<Command[]> {
  const ids = await keyIdsAt(uniqueRefs([nodeId], tracks).map((x) => x.r.ref), seconds);
  return ids.length > 0 ? [{ type: 'deleteKeyframes', ids }] : [];
}

export type EasePreset = 'Linear' | 'Ease' | 'EaseIn' | 'EaseOut' | 'Hold';

/** A keyframe-interpolation preset as an `updateKeyframes` patch (scalar tracks spell hold `step`). */
export function easePatch(id: string, preset: EasePreset): KeyframePatch {
  const bez = (b: readonly number[]): KeyframePatch['bezier'] => ({ x1: b[0]!, y1: b[1]!, x2: b[2]!, y2: b[3]! });
  const base = { id, spatialIn: [], spatialOut: [] };
  switch (preset) {
    case 'Linear': return { ...base, easing: 'linear' as Easing, clearBezier: true };
    case 'Hold': return { ...base, easing: 'step' as Easing, clearBezier: true };
    case 'Ease': return { ...base, easing: 'bezier' as Easing, bezier: bez(EASY_EASE_BEZIER) };
    case 'EaseIn': return { ...base, easing: 'bezier' as Easing, bezier: bez(EASY_EASE_IN_BEZIER) };
    case 'EaseOut': return { ...base, easing: 'bezier' as Easing, bezier: bez(EASY_EASE_OUT_BEZIER) };
    default: return { ...base, easing: 'linear' as Easing, clearBezier: true };
  }
}

/** Ease the keys of these tracks at `seconds`. */
export async function easeKeysAtCommands(
  nodeId: string,
  tracks: ReadonlyArray<string>,
  seconds: number,
  preset: EasePreset,
): Promise<Command[]> {
  const ids = await keyIdsAt(uniqueRefs([nodeId], tracks).map((x) => x.r.ref), seconds);
  return ids.length > 0 ? [{ type: 'updateKeyframes', patches: ids.map((id) => easePatch(id, preset)) }] : [];
}

// ── Layer-level edits shared by several inspector sections ─────────────

/**
 * Parent a layer (the Parent dropdown / pick-whip). PLAIN = AE's default, the
 * layer keeps its world pose; ALT = keep values (no compensation); SHIFT =
 * Parent & Link JUMP (`setParent{jump, time}`, B3z): the child lands on the
 * parent's anchor at the active tab's playhead, an animated position re-based
 * rigidly.
 */
export function parentLayer(nodeId: string, parentId: string | null, modifiers?: { altKey?: boolean; shiftKey?: boolean }): void {
  const opts = parentOptionsFor(modifiers);
  const jump = opts?.jump === true && parentId !== null;
  void edit(parentId ? 'Parent' : 'Unparent', {
    type: 'setParent',
    layers: [nodeId],
    ...(parentId ? { parent: parentId } : {}),
    keepWorldTransform: opts?.preserveWorld ?? true,
    ...(jump ? { jump: true, time: compTime(getTime()) } : {}),
  });
}

/**
 * Set a layer's track matte. The API addresses a matte BY REFERENCE (AE 2023);
 * a matte with no explicit source is AE's classic positional "Layer Above"
 * matte (`setTrackMatte` without `matte.layer`).
 */
export function setLayerMatte(nodeId: string, matte: TrackMatte | undefined): void {
  void edit('Track Matte', trackMatteCommand(nodeId, matte));
}

/** Blending mode on these layers, one entry. */
export function setLayersBlend(nodeIds: readonly string[], mode: string): void {
  const layers = nodeIds.filter((id) => isLayer(id));
  if (layers.length === 0) return;
  // One command per layer: `setBlendMode` takes ONE composition's layers.
  void edit('Blending Mode', layers.map((id) => ({ type: 'setBlendMode', layers: [id], mode }) as Command));
}

/** A layer switch on these layers (`setLayerSwitches`), one entry. */
export function setLayersSwitch(nodeIds: readonly string[], patch: LayerSwitchesPatch, label: string): Promise<unknown> {
  const layers = nodeIds.filter((id) => isLayer(id));
  if (layers.length === 0) return Promise.resolve();
  return edit(label, layers.map((id) => ({ type: 'setLayerSwitches', layers: [id], patch }) as Command));
}

/**
 * Align / distribute the selection — a client macro: `planAlign` measures the
 * boxes (world space, at the playhead) and returns each moved layer's new
 * parent-space Position; they go out as ONE `setProperties` (keyed at the
 * playhead where Position is animated, as the canvas does).
 */
export function alignLayers(
  ids: ReadonlyArray<string>,
  mode: AlignMode,
  alignTo: 'selection' | 'composition',
  compWidth: number,
  compHeight: number,
): void {
  const seconds = getTime();
  // B4-gap: world-space layer bounds and the parent-space inverse (planAlign's getBounds / toParentSpace evaluate the TS engine's transforms) — the API answers them as getLayerBounds / getLayerTransforms QUERIES; this synchronous macro still measures the scene graph.
  const writes = planAlign(ids.filter((id) => isLayer(id)), mode, alignTo, compWidth, compHeight)
    .flatMap((m) => trackWrites(m.id, { x: m.x, y: m.y }, seconds));
  if (writes.length > 0) void edit(isDistributeMode(mode) ? 'Distribute' : 'Align', { type: 'setProperties', writes });
}

/**
 * Smooth (auto-bezier through every key) or straighten (no spatial tangents)
 * a layer's merged Position path — a client macro (ENGINE_API.md §1 rule 7):
 * the tangents are computed here with the same pure functions the animation
 * engine uses (`smoothTrackTangents` / `clearTrackTangents` on X and Y) and
 * sent as ONE `updateKeyframes`. Key ids come from `getKeyframes`; the API's
 * keys and the stored X/Y keys are the same list in time order. Resolves to
 * false (nothing sent) when Position is separated or not keyed.
 */
export async function motionPathCommands(nodeId: string, mode: 'smooth' | 'straighten'): Promise<Command[]> {
  const r = trackRef(nodeId, 'x');
  if (!r || r.ref.path !== 'transform/position') return [];
  const res = await engine().query({ type: 'getKeyframes', props: [r.ref] });
  if (!res.ok) return [];
  const apiKeys = res.value.sets[0]?.keyframes ?? [];
  if (apiKeys.length === 0) return [];
  // Each member as the pure tangent functions take it — time, value, tangents
  // — from the API keys themselves (tangents are ratios of value to time, so
  // flicks serve as well as seconds).
  const tracks: TsKeyframe[][] = r.members.map((_, i) => apiKeys.map((k) => ({
    t: k.time,
    value: numbersOfValue(k.value)[i] ?? 0,
    ...(k.spatialIn.length > 0 ? { si: k.spatialIn[i] ?? 0 } : {}),
    ...(k.spatialOut.length > 0 ? { so: k.spatialOut[i] ?? 0 } : {}),
  }) as TsKeyframe));
  const shaped = mode === 'smooth'
    ? tracks.map((t, i) => (i < 2 ? smoothTrackTangents(t) : t))
    : tracks.map((t, i) => (i < 2 ? clearTrackTangents(t) : t));
  const patches: KeyframePatch[] = apiKeys.map((k, i) => {
    const si = shaped.map((t) => t[i]?.si);
    const so = shaped.map((t) => t[i]?.so);
    const none = si.every((v) => v === undefined) && so.every((v) => v === undefined);
    // `legacy` = no per-key spatial mode (the pure functions drop it: a baked tangent wins).
    return none
      ? { id: k.id, clearSpatial: true, spatialInterp: 'legacy', spatialIn: [], spatialOut: [] }
      : { id: k.id, spatialInterp: 'legacy', spatialIn: si.map((v) => v ?? 0), spatialOut: so.map((v) => v ?? 0) };
  });
  return [{ type: 'updateKeyframes', patches }];
}

/**
 * `setExpression` for (layer, track) pairs: the whole property when the track
 * IS it (one member); ONE member of an unseparated vector (X of Position) with
 * `member` — Premation's per-dimension expression, which is what the document
 * stores (an expression per member track). Returns null when any pair is not
 * addressable (the caller refuses the edit).
 */
export function expressionCommands(
  pairs: ReadonlyArray<{ nodeId: string; track: string; source: string }>,
  enabled = true,
): Command[] | null {
  const out: Command[] = [];
  for (const p of pairs) {
    const r = trackRef(p.nodeId, p.track);
    if (!r) return null;
    if (r.members.length === 1 && r.members[0] === p.track) {
      out.push({ type: 'setExpression', prop: r.ref, source: p.source, enabled });
      continue;
    }
    // One dimension of an UNSEPARATED vector (the X field of Position): the
    // API's per-dimension expression (`member`, ENGINE_API.md §4.6) — the
    // member track carries the source, as the document always stored it.
    const member = r.members.indexOf(p.track);
    if (member < 0) return null;
    out.push({ type: 'setExpression', prop: r.ref, source: p.source, enabled, member });
  }
  return out;
}
