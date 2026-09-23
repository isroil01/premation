/**
 * The viewport's document edits through the engine API (B3,
 * docs/B3_PATTERNS.md): the value writes its gizmos and handles make, masks
 * drawn in the Layer panel, motion-path vertices and tangents, and the text
 * tool's commit. Layer-level menu actions live in `layerMenuEdits.ts`.
 *
 * Two shapes, as everywhere in B3:
 *
 *   • a click / menu item / release → `edit(label, commands)`: one entry;
 *   • a drag → the caller's `GestureSession` / `useGesture`, sending the
 *     commands built here for the CURRENT pointer position — every builder
 *     below returns ABSOLUTE values (start state + drag), never a delta.
 *
 * Deciding "is this animated", sampling the members a write does not change,
 * reading key tangents to compute new ones: display reads, direct until B4's
 * mirror. The writes are commands.
 */

import {
  secondsToFlicks,
  type Command,
  type KeyframeInsert,
  type KeyframePatch,
  type PropertyWrite,
  type PropRef,
  type SpatialInterp as ApiSpatialInterp,
  type Value,
} from '@motion/engine-api';
import { AnimationEngine, defaultAnimation, type Keyframe } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { keyframeToCompTime } from '@core/timeline/TimelineController';
import type { MaskMode, MaskPath, MaskPoint } from '@core/effects/mask';
import { apiUnitFactor } from '@core/engine/props';
import { isLayer } from '@core/engine/doc';
import { engine } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import {
  compTime,
  memberWrite,
  numbersOfValue,
  paths,
  propRefForTrack,
  valueOfNumbers,
  values,
} from '@core/engine/propRefs';

// ── Numeric props through the viewport's "dual path" ─────────────────

/** One layer's new values, by today's track names (`x`, `rotationX`, `effect.fx_1.tl_x`, `focusDistance`). */
export interface NodeTrackValues {
  nodeId: string;
  values: Readonly<Record<string, number>>;
}

export interface TrackValueOptions {
  /** Comp seconds of the write (the playhead). */
  seconds: number;
  /** The Auto-Keyframe preference: an unanimated property takes a key too. */
  autoKeyframe?: boolean;
}

/**
 * The viewport's write rule (ports' `applyGizmo3DTransforms` /
 * `applyNodePropsKeyframed`, `writeEffectParams`) as commands: an animated
 * property — and every property while Auto-Keyframe is on — gets a key at the
 * playhead; the rest a static value. Member tracks of one property (`x`/`y`/`z`
 * of Position, `scaleX`/`scaleY`) become ONE whole-value write; the members a
 * write does not name keep the value they have at that time. Values are STORED
 * units (scale as a multiplier) and converted to API units here.
 *
 * Locked and vanished layers are skipped (the legacy writers skipped them; the
 * engine would refuse the whole batch). Returns null when the API cannot
 * address the write — a node that is not a layer of a composition, or a track
 * with no API property on its layer — and the caller keeps its legacy writer
 * for that edit.
 */
export function trackValueCommands(items: ReadonlyArray<NodeTrackValues>, opts: TrackValueOptions): Command[] | null {
  const sets: PropertyWrite[] = [];
  const keys: KeyframeInsert[] = [];
  const time = compTime(opts.seconds);
  for (const item of items) {
    const node = defaultSceneGraph.getNode(item.nodeId);
    if (!node || node.locked) continue;
    if (!isLayer(item.nodeId)) return null;
    const groups = new Map<string, { prop: PropRef; valueType: Parameters<typeof valueOfNumbers>[0]; nums: number[]; animated: boolean }>();
    for (const [track, v] of Object.entries(item.values)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const r = propRefForTrack(item.nodeId, track);
      if (!r) return null;
      let g = groups.get(r.ref.path);
      if (!g) {
        const base = memberWrite(item.nodeId, track, v, opts.seconds);
        if (!base) return null;
        g = {
          prop: r.ref,
          valueType: r.valueType,
          nums: numbersOfValue(base.value),
          animated: r.members.some((m) => defaultAnimation.isAnimated(item.nodeId, m)),
        };
        groups.set(r.ref.path, g);
      }
      g.nums[r.member] = v * apiUnitFactor(track);
    }
    for (const g of groups.values()) {
      const value = valueOfNumbers(g.valueType, g.nums);
      if (!g.animated && opts.autoKeyframe) keys.push({ prop: g.prop, time, value, spatialIn: [], spatialOut: [] });
      else sets.push({ prop: g.prop, value, time });
    }
  }
  const out: Command[] = [];
  if (sets.length > 0) out.push({ type: 'setProperties', writes: sets });
  if (keys.length > 0) out.push({ type: 'addKeyframes', keys });
  return out;
}

// ── Masks (the Layer panel's mask tools) ─────────────────────────────

/** A mask outline as the API's BezierPath (tangents relative to their vertex). */
export function maskPointsToPath(points: ReadonlyArray<MaskPoint>, closed: boolean): Value {
  const vertices: number[] = [];
  const inTangents: number[] = [];
  const outTangents: number[] = [];
  for (const p of points) {
    vertices.push(p.x, p.y);
    inTangents.push(p.inX - p.x, p.inY - p.y);
    outTangents.push(p.outX - p.x, p.outY - p.y);
  }
  return { kind: 'path', value: { vertices, inTangents, outTangents, closed, featherPoints: [] } };
}

/**
 * Add a drawn mask (rectangle / ellipse / pen) — one entry, "New Mask".
 * Returns the engine's id for it (the UI selects it), or null on a refusal.
 */
export async function addMaskEdit(nodeId: string, mask: MaskPath): Promise<string | null> {
  const res = await edit('New Mask', {
    type: 'addMask',
    layer: nodeId,
    path: (maskPointsToPath(mask.points, mask.closed) as Extract<Value, { kind: 'path' }>).value,
    mode: mask.mode,
    inverted: mask.inverted === true,
    ...(mask.name ? { name: mask.name } : {}),
  });
  if (!res.ok) return null;
  const group = (res.value[0] as { groups?: string[] } | undefined)?.groups?.[0];
  return group ? group.split('/')[1] ?? null : null;
}

/**
 * Reshape a mask: its points at the comp time `seconds` — on an animated mask
 * that is a key at that moment (AE), on a static one the shape itself.
 */
export function maskPathCommand(nodeId: string, maskId: string, points: ReadonlyArray<MaskPoint>, closed: boolean, seconds: number): Command {
  return {
    type: 'setProperty',
    prop: { layer: nodeId, path: paths.mask(maskId, 'path') },
    value: maskPointsToPath(points, closed),
    time: compTime(seconds),
  };
}

/** Mode / Inverted of one mask — one entry. */
export async function setMaskFlagsEdit(nodeId: string, maskId: string, label: string, patch: { mode?: MaskMode; inverted?: boolean }): Promise<void> {
  const cmds: Command[] = [];
  if (patch.mode !== undefined) cmds.push({ type: 'setProperty', prop: { layer: nodeId, path: paths.mask(maskId, 'mode') }, value: values.choice(patch.mode) });
  if (patch.inverted !== undefined) cmds.push({ type: 'setProperty', prop: { layer: nodeId, path: paths.mask(maskId, 'inverted') }, value: values.bool(patch.inverted) });
  await edit(label, cmds);
}

/** Delete one mask (with its keys) — one entry, "Delete Mask". */
export async function deleteMaskEdit(nodeId: string, maskId: string): Promise<void> {
  await edit('Delete Mask', { type: 'removePropertyGroups', groups: [{ layer: nodeId, path: paths.maskGroup(maskId) }] });
}

// ── Position keyframes (motion path) ─────────────────────────────────

const POSITION_TRACKS = ['x', 'y', 'z'] as const;

/** A layer's Position member tracks, deep-copied (the drag-start state). */
export type PositionTracks = Partial<Record<(typeof POSITION_TRACKS)[number], Keyframe[]>>;

export function capturePositionTracks(nodeId: string): PositionTracks {
  const out: PositionTracks = {};
  for (const m of POSITION_TRACKS) {
    const kfs = defaultAnimation.getTrackKeyframes(nodeId, m);
    if (kfs) out[m] = kfs.map((k) => ({ ...k }));
  }
  return out;
}

/**
 * The API keyframe ids of a layer's Position keys, by the property path and
 * the STORED key time they have today (`transform/position@0.5`). Ids come
 * from the engine (`getKeyframes`), never from positional codecs.
 */
export type PositionKeyIds = Map<string, string>;

const keyAddr = (path: string, t: number): string => `${path}@${t}`;

export async function resolvePositionKeyIds(nodeId: string, start: PositionTracks = capturePositionTracks(nodeId)): Promise<PositionKeyIds> {
  const ids: PositionKeyIds = new Map();
  const refs = new Map<string, PropRef>();
  for (const m of POSITION_TRACKS) {
    if (!start[m]) continue;
    const r = propRefForTrack(nodeId, m);
    if (r) refs.set(r.ref.path, r.ref);
  }
  if (refs.size === 0) return ids;
  const res = await engine().query({ type: 'getKeyframes', props: [...refs.values()] });
  if (!res.ok) return ids;
  // Half a millisecond: API key times are the stored times mapped to comp time
  // and rounded to flicks; a key a frame away is never that close.
  const tol = secondsToFlicks(0.0005);
  for (const set of res.value.sets) {
    const r = propRefForTrack(nodeId, set.prop.path);
    const member = r?.members[0] ?? 'x';
    for (const m of r?.members ?? [member]) {
      for (const k of start[m as keyof PositionTracks] ?? []) {
        const at = secondsToFlicks(keyframeToCompTime(nodeId, k.t, m));
        const hit = set.keyframes.find((x) => Math.abs(x.time - at) <= tol);
        if (hit && !ids.has(keyAddr(set.prop.path, k.t))) ids.set(keyAddr(set.prop.path, k.t), hit.id);
      }
    }
  }
  return ids;
}

const sameNum = (a: number | undefined, b: number | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && Math.abs(a - b) < 1e-9);

function keyChanged(a: Keyframe | undefined, b: Keyframe | undefined): boolean {
  if (!a || !b) return a !== b;
  return !sameNum(a.value, b.value) || !sameNum(a.si, b.si) || !sameNum(a.so, b.so)
    || a.continuous !== b.continuous || a.spatialInterp !== b.spatialInterp;
}

/**
 * A Position edit expressed with today's pure motion-path logic, as commands.
 *
 * `mutate` runs the legacy helper (`setPathTangent`, `setSpatialInterpolation`,
 * `smoothMotionPath`, …) on a SCRATCH animation engine seeded with the layer's
 * Position tracks as `start` had them; every key it changed becomes an
 * `updateKeyframes` patch (value, spatial tangents, continuity, spatial mode)
 * on the engine's key id. A client macro (ENGINE_API.md §1 rule 7): the
 * arithmetic is the helper's, unchanged, and the write is one command.
 *
 * Built from the START state every time, so inside a drag each message is
 * absolute (start + pointer) and dropping intermediates loses nothing.
 */
export function positionKeyPatchCommands(
  nodeId: string,
  start: PositionTracks,
  ids: PositionKeyIds,
  mutate: (scratch: AnimationEngine) => void,
): Command[] {
  const scratch = new AnimationEngine();
  for (const m of POSITION_TRACKS) {
    const kfs = start[m];
    if (kfs) scratch.setTrackKeyframes(nodeId, m, kfs.map((k) => ({ ...k })));
  }
  mutate(scratch);

  const patches: KeyframePatch[] = [];
  const inserts: KeyframeInsert[] = [];
  const done = new Set<string>();
  for (const m of POSITION_TRACKS) {
    const after = scratch.getTrackKeyframes(nodeId, m) ?? [];
    for (const k of after) {
      const before = start[m]?.find((x) => x.t === k.t);
      if (!keyChanged(before, k)) continue;
      const r = propRefForTrack(nodeId, m);
      if (!r) continue;
      const addr = keyAddr(r.ref.path, k.t);
      if (done.has(addr)) continue;
      done.add(addr);
      const member = (mm: string): Keyframe | undefined =>
        (scratch.getTrackKeyframes(nodeId, mm) ?? []).find((x) => x.t === k.t);
      const keysOf = r.members.map(member);
      const nums = keysOf.map((x, i) => x?.value ?? defaultAnimation.sample(nodeId, r.members[i]!, k.t) ?? 0);
      const value = valueOfNumbers(r.valueType, nums);
      const id = ids.get(addr);
      if (!id) {
        // A member that had no key at this time (legacy unaligned tracks): the
        // helper created one — add it with its value.
        inserts.push({ prop: r.ref, time: secondsToFlicks(keyframeToCompTime(nodeId, k.t, m)), value, spatialIn: [], spatialOut: [] });
        continue;
      }
      const si = keysOf.map((x) => x?.si);
      const so = keysOf.map((x) => x?.so);
      const anyIn = si.some((v) => v !== undefined);
      const anyOut = so.some((v) => v !== undefined);
      const patch: KeyframePatch = {
        id,
        value,
        spatialIn: anyIn ? si.map((v) => v ?? 0) : [],
        spatialOut: anyOut ? so.map((v) => v ?? 0) : [],
        // Dropping a tangent (a vertex made Linear) has no per-side form:
        // clear both, then re-send whichever side remains.
        ...(!anyIn || !anyOut ? { clearSpatial: true } : {}),
      };
      const lead = keysOf.find((x) => x !== undefined);
      if (lead?.continuous !== undefined) patch.continuous = lead.continuous;
      const beforeMode = start[m]?.find((x) => x.t === k.t)?.spatialInterp;
      if (lead && lead.spatialInterp !== beforeMode) {
        patch.spatialInterp = (lead.spatialInterp ?? 'legacy') as ApiSpatialInterp;
      }
      patches.push(patch);
    }
  }
  const out: Command[] = [];
  if (patches.length > 0) out.push({ type: 'updateKeyframes', patches });
  if (inserts.length > 0) out.push({ type: 'addKeyframes', keys: inserts });
  return out;
}

/** One-shot form (a menu item / button): resolve ids, build, send as one entry. */
export async function editPositionKeys(nodeId: string, label: string, mutate: (scratch: AnimationEngine) => void): Promise<void> {
  const start = capturePositionTracks(nodeId);
  const ids = await resolvePositionKeyIds(nodeId, start);
  await edit(label, positionKeyPatchCommands(nodeId, start, ids, mutate));
}

// ── Text tool ────────────────────────────────────────────────────────

/**
 * Source Text at the playhead (keyed when Source Text is animated, else the
 * static text), plus the layer's auto-name when it still follows its content.
 * One entry.
 */
export async function commitSourceTextEdit(
  nodeId: string,
  text: string,
  opts: { seconds: number; label: string; rename?: string },
): Promise<boolean> {
  const cmds: Command[] = [];
  if (opts.rename !== undefined) cmds.push({ type: 'renameLayer', layer: nodeId, name: opts.rename });
  cmds.push({
    type: 'setProperty',
    prop: { layer: nodeId, path: paths.sourceText() },
    value: values.string(text),
    time: compTime(opts.seconds),
  });
  const res = await edit(opts.label, cmds);
  return res.ok;
}
