/**
 * inspectorEdits — the Inspector's command builders over the engine API (B3,
 * docs/B3_PATTERNS.md). Everything here COMPOSES commands from what a panel
 * holds today (node ids + track names, comp-time seconds) and reads the live
 * document only to decide what to send (display reads stay direct until B4).
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
  MatteMode as ApiMatteMode,
  PropRef,
  PropertyWrite,
} from '@motion/engine-api';
import { parentOptionsFor, reparentNode } from '@core/scene/parenting';
import { setNodeMatte, type TrackMatte } from '@core/effects/matte';
import { isDistributeMode, planAlign, type AlignMode } from '@core/scene/alignNodes';
import { getTime } from '@stores/playbackClockStore';
import {
  clearTrackTangents,
  defaultAnimation,
  EASY_EASE_BEZIER,
  EASY_EASE_IN_BEZIER,
  EASY_EASE_OUT_BEZIER,
  smoothTrackTangents,
} from '@motion/animation';
import { compTime, propRefForTrack, valueOfNumbers, type TrackRef } from '@core/engine/propRefs';
import { apiUnitFactor } from '@core/engine/props';
import { engine } from '@core/engine/engineInstance';
import { isLayer } from '@core/engine/doc';
import { applyPropertyBag, KEYFRAME_EPS, readPropertyValue } from '@core/inspector/multiSelection';
import { edit } from '@core/engine/uiEdits';
import { staticOrDefaultValue } from '@core/inspector/propertyValue';

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
  const out: Array<{ write: PropertyWrite; r: TrackRef }> = [];
  for (const r of byProp.values()) {
    const nums = r.members.map((m) => {
      const v = given.get(m);
      const stored = v !== undefined && Number.isFinite(v)
        ? v
        : readPropertyValue(nodeId, m, seconds) ?? staticOrDefaultValue(nodeId, m);
      return stored * apiUnitFactor(m);
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
      const animated = r.members.some((m) => defaultAnimation.isAnimated(e.nodeId, m));
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
 * property, as ONE undo entry. Properties the engine does not address on a
 * layer fall back to the pre-API bag writer (a second entry, as before).
 */
export function applyPresetValues(
  nodeIds: ReadonlyArray<string>,
  bag: Readonly<Record<string, number | string | boolean>>,
  opts: ValueOptions,
  label: string,
): void {
  const entries: Array<{ nodeId: string; values: Record<string, number> }> = [];
  const rest: Record<string, number> = {};
  const restIds = new Set<string>();
  for (const nodeId of nodeIds) {
    const values: Record<string, number> = {};
    for (const [prop, v] of Object.entries(bag)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (readPropertyValue(nodeId, prop, opts.seconds) === undefined) continue;
      if (trackRef(nodeId, prop)) values[prop] = v;
      else { rest[prop] = v; restIds.add(nodeId); }
    }
    if (Object.keys(values).length > 0) entries.push({ nodeId, values });
  }
  if (entries.length > 0) void edit(label, valueCommands(entries, opts));
  if (restIds.size > 0) {
    // B3-legacy: engine gap — preset props the catalog does not list on this layer (skew / skewAxis / fillOpacity while at default).
    applyPropertyBag([...restIds], rest, { compTime: opts.seconds, autoKeyframe: opts.autoKeyframe, label });
  }
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

const isRefAnimated = (nodeId: string, r: TrackRef): boolean => r.members.some((m) => defaultAnimation.isAnimated(nodeId, m));

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
 * layer keeps its world pose; ALT = keep values (no compensation). SHIFT's
 * Parent & Link JUMP (the child lands on the parent's anchor) is not a mode
 * of the API's `setParent`, so it keeps the legacy writer.
 */
export function parentLayer(nodeId: string, parentId: string | null, modifiers?: { altKey?: boolean; shiftKey?: boolean }): void {
  const opts = parentOptionsFor(modifiers);
  if (opts?.jump && parentId !== null) {
    // B3-legacy: engine gap — `setParent` has no Parent & Link JUMP mode (Shift): relink + land on the parent's anchor, rebasing animated position.
    reparentNode(nodeId, parentId, opts);
    return;
  }
  void edit(parentId ? 'Parent' : 'Unparent', {
    type: 'setParent',
    layers: [nodeId],
    ...(parentId ? { parent: parentId } : {}),
    keepWorldTransform: opts?.preserveWorld ?? true,
  });
}

/** The API's matte mode for a stored matte. */
function apiMatteMode(m: TrackMatte): ApiMatteMode {
  const base = m.mode === 'luma' ? 'luma' : 'alpha';
  return (m.inverted ? `${base}Inverted` : base) as ApiMatteMode;
}

/**
 * Set a layer's track matte. The API addresses a matte BY REFERENCE (AE 2023);
 * a matte with no explicit source ("Layer Above", AE's positional rule) is not
 * expressible, so that one case keeps the legacy writer.
 */
export function setLayerMatte(nodeId: string, matte: TrackMatte | undefined): void {
  if (!matte) {
    void edit('Track Matte', { type: 'setTrackMatte', layer: nodeId, matte: { mode: 'none' } });
    return;
  }
  if (matte.sourceId) {
    void edit('Track Matte', { type: 'setTrackMatte', layer: nodeId, matte: { layer: matte.sourceId, mode: apiMatteMode(matte) } });
    return;
  }
  // B3-legacy: engine gap — `setTrackMatte` needs a source layer; the positional "Layer Above" matte (no sourceId) has no API form.
  setNodeMatte(nodeId, matte);
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
  const tracks = r.members.map((m) => defaultAnimation.getTrackKeyframes(nodeId, m) ?? []);
  const x = tracks[0] ?? [];
  if (apiKeys.length === 0 || apiKeys.length !== x.length) return [];
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
 * `setExpression` for (layer, track) pairs — only where the track IS the whole
 * API property (one member). An expression on ONE member of a vector (X of
 * Position) is not addressable: the API's expressions are per property and
 * `setExpression` would put the source on every member. Returns null when any
 * pair is not addressable, so the caller keeps its legacy path for it.
 */
export function expressionCommands(
  pairs: ReadonlyArray<{ nodeId: string; track: string; source: string }>,
  enabled = true,
): Command[] | null {
  const out: Command[] = [];
  for (const p of pairs) {
    const r = trackRef(p.nodeId, p.track);
    if (!r || r.members.length !== 1 || r.members[0] !== p.track) return null;
    out.push({ type: 'setExpression', prop: r.ref, source: p.source, enabled });
  }
  return out;
}
