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
  type PropRef,
  type SpatialInterp as ApiSpatialInterp,
  type Value,
} from '@motion/engine-api';
import { AnimationEngine, defaultAnimation, type Keyframe } from '@motion/animation';
import { keyframeToCompTime } from '@core/timeline/TimelineController';
import type { MaskMode, MaskPath, MaskPoint } from '@core/effects/mask';
import { engine } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { compTime, paths, propRefForTrack, valueOfNumbers, values } from '@core/engine/propRefs';
import { maskPointsToPath } from '@core/workspace/toolEdits';
import type { ColorStop, FillPaint } from '@core/paint/fill';
import { fillPaintCommands, fillStopsCommands, strokePatchCommands, textStrokePaintCommands } from '@layout/Inspector/appearance/paintEdits';
import { trackRef, valueCommands } from '@layout/Inspector/inspectorEdits';
import { fieldCommands } from '@layout/Text/textEdits';

// ── Numeric props through the viewport's "dual path" ─────────────────
//
// The builders live in core (`@core/workspace/toolEdits`) so the workspace
// ports, camera navigation and the device handles build the same commands.

export { trackValueCommands, maskPointsToPath } from '@core/workspace/toolEdits';
export type { NodeTrackValues, TrackValueOptions } from '@core/workspace/toolEdits';

// ── Masks (the Layer panel's mask tools) ─────────────────────────────

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
  opts: { seconds: number; label: string; rename?: string; runs?: ReadonlyArray<unknown> },
): Promise<boolean> {
  const cmds: Command[] = [];
  if (opts.rename !== undefined) cmds.push({ type: 'renameLayer', layer: nodeId, name: opts.rename });
  cmds.push({
    type: 'setProperty',
    prop: { layer: nodeId, path: paths.sourceText() },
    value: values.string(text),
    time: compTime(opts.seconds),
  });
  // Styled text: the runs re-indexed to the new text, after it (G1 `text/styleRuns`
  // — a static Source Text write drops the runs that indexed the old text).
  if (opts.runs) cmds.push({ type: 'setProperty', prop: { layer: nodeId, path: paths.textProp('styleRuns') }, value: values.json(opts.runs) });
  const res = await edit(opts.label, cmds);
  return res.ok;
}

// ── Gradient gizmo (GradientHandleOverlay) ───────────────────────────
//
// The on-canvas gradient editor writes exactly where the Fill & Stroke rows
// write (Inspector/appearance/paintEdits.ts, AnimatablePaintRow): the paint is
// a json field sent whole, the primary fill's keyed stop list is
// `layer/fillStops`, and the geometry scalars (`fillAngle`…, `strokeAngle`…,
// a shape stroke's `gradientStartX`…) are catalog properties — a key at the
// playhead where live or under Auto-Keyframe, the static paint otherwise.

/** Which paint a gradient gizmo write lands on. */
export interface GradientPaintTarget {
  nodeId: string;
  /**
   * `fill`: slot `fillIndex` of the fill stack (0 = the primary fill);
   * `stroke`: a text layer's `strokePaint`; `shapeStroke`: stroke
   * `strokeIndex` of the stroke stack.
   */
  channel: 'fill' | 'stroke' | 'shapeStroke';
  fillIndex: number;
  strokeIndex: number;
  /** The fill stack as stored — a slot above 0 is written as the whole stack. */
  fills: ReadonlyArray<FillPaint>;
}

/** The target's paint := `paint`, whole (a static write — no keyframes). */
export function gradientPaintCommands(t: GradientPaintTarget, paint: FillPaint): Command[] {
  if (t.channel === 'shapeStroke') return strokePatchCommands(t.nodeId, t.strokeIndex, { paint });
  if (t.channel === 'stroke') return textStrokePaintCommands(t.nodeId, paint);
  if (t.fillIndex === 0) return fillPaintCommands(t.nodeId, paint);
  const next = [...t.fills];
  next[t.fillIndex] = paint;
  return fieldCommands(t.nodeId, 'layer/fills', next);
}

/**
 * A new colour-stop list. `keyed` (the primary fill's `fill.stops` is
 * animated): a Colors key at the playhead — the renderer reads the track, so a
 * static write would change nothing on screen. Otherwise the paint with its
 * stops replaced, in the order given (storage order keeps stop ids stable).
 */
export function gradientStopsCommands(
  t: GradientPaintTarget,
  paint: Exclude<FillPaint, { type: 'solid' }>,
  stops: ReadonlyArray<ColorStop>,
  opts: { keyed: boolean; seconds: number },
): Command[] {
  if (opts.keyed && t.channel === 'fill' && t.fillIndex === 0) return fillStopsCommands(t.nodeId, stops, opts.seconds);
  return gradientPaintCommands(t, { ...paint, stops: [...stops] });
}

/**
 * A gradient geometry drag (`AnimatablePaintRow`'s rule, per property): each
 * `{ track, value }` whose track is live — or every one while Auto-Keyframe is
 * on — keys at the playhead; if any is left over, `staticCommands()` (the
 * caller's whole-paint / whole-stack write of the dragged fields) goes too.
 * The geometry tracks bind to the PRIMARY fill, so a stack slot above 0 is
 * always static. A track the engine does not address is written statically.
 * Absolute values: safe to send per move inside a gesture.
 */
export function gradientGeometryCommands(
  t: GradientPaintTarget,
  writes: ReadonlyArray<{ track: string; value: number }>,
  staticCommands: () => Command[],
  opts: { seconds: number; autoKeyframe: boolean },
): Command[] {
  const tracked = t.channel !== 'fill' || t.fillIndex === 0;
  const keyed: Record<string, number> = {};
  let anyStatic = false;
  for (const w of writes) {
    const live = tracked && (opts.autoKeyframe || defaultAnimation.isAnimated(t.nodeId, w.track));
    if (live && trackRef(t.nodeId, w.track)) keyed[w.track] = w.value;
    else anyStatic = true;
  }
  const out: Command[] = anyStatic ? [...staticCommands()] : [];
  if (Object.keys(keyed).length > 0) out.push(...valueCommands([{ nodeId: t.nodeId, values: keyed }], opts));
  return out;
}
