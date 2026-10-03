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
  type Command,
  type Value,
} from '@motion/engine-api';
import type { AnimationEngine } from '@motion/animation';
import { POSITION_TRACKS, positionTracksFrom, scratchPositionEngine, type PositionTracks } from '@core/mirror/positionTracks';
import { fetchMemberTracks } from '@stores/memberTracks';
import type { MaskMode, MaskPath, MaskPoint } from '@core/effects/mask';
import { edit } from '@core/engine/uiEdits';
import { compTime, paths, values } from '@core/engine/propRefs';
import { maskPointsToPath } from '@core/workspace/toolEdits';
import type { ColorStop, FillPaint } from '@core/paint/fill';
import { fillPaintCommands, fillStopsCommands, strokePatchCommands, textStrokePaintCommands } from '@layout/Inspector/appearance/paintEdits';
import { trackRef, valueCommands } from '@layout/Inspector/inspectorEdits';
import { fieldCommands } from '@layout/Text/textEdits';
import { documentMirror } from '@stores/documentMirror';
import { isTrackAnimated } from '@core/mirror/selection';

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

export type { PositionTracks };

/**
 * The layer's Position member tracks as the engine stores them NOW
 * (`getMemberKeyframes` — B4: never the TypeScript engine's live tracks).
 */
export async function capturePositionTracks(nodeId: string): Promise<PositionTracks> {
  return positionTracksFrom(await fetchMemberTracks(nodeId, POSITION_TRACKS));
}

/**
 * A Position edit expressed with today's pure motion-path logic, as commands.
 *
 * `mutate` runs the legacy helper (`setPathTangent`, `setSpatialInterpolation`,
 * `smoothMotionPath`, …) on a SCRATCH animation engine seeded with the layer's
 * Position tracks as `start` had them; every member track it changed is sent
 * whole as ONE `setMemberKeyframes` (value, tangents, continuity, spatial mode
 * as the helper left them — no key ids or time mapping involved). A client
 * macro (ENGINE_API.md §1 rule 7): the arithmetic is the helper's, unchanged,
 * and the write is one command.
 *
 * Built from the START state every time, so inside a drag each message is
 * absolute (start + pointer) and dropping intermediates loses nothing.
 */
export function positionKeyPatchCommands(
  nodeId: string,
  start: PositionTracks,
  mutate: (scratch: AnimationEngine) => void,
): Command[] {
  const scratch = scratchPositionEngine(nodeId, start);
  mutate(scratch);
  const tracks: Array<{ member: string; keyframes: string }> = [];
  for (const m of POSITION_TRACKS) {
    const after = scratch.getTrackKeyframes(nodeId, m) ?? [];
    const before = start[m] ?? [];
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    tracks.push({ member: m, keyframes: JSON.stringify(after) });
  }
  return tracks.length > 0 ? [{ type: 'setMemberKeyframes', layer: nodeId, tracks }] : [];
}

/** One-shot form (a menu item / button): build, send as one entry. */
export async function editPositionKeys(nodeId: string, label: string, mutate: (scratch: AnimationEngine) => void): Promise<void> {
  const cmds = positionKeyPatchCommands(nodeId, await capturePositionTracks(nodeId), mutate);
  if (cmds.length > 0) await edit(label, cmds);
}

/** The same Position edit over several layers (a selection), as ONE entry. */
export async function editPositionKeysOf(
  nodeIds: readonly string[],
  label: string,
  mutate: (nodeId: string, scratch: AnimationEngine) => void,
): Promise<void> {
  const cmds: Command[] = [];
  for (const id of nodeIds) {
    cmds.push(...positionKeyPatchCommands(id, await capturePositionTracks(id), (scratch) => mutate(id, scratch)));
  }
  if (cmds.length > 0) await edit(label, cmds);
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
    const live = tracked && (opts.autoKeyframe || isTrackAnimated(documentMirror(), t.nodeId, w.track));
    if (live && trackRef(t.nodeId, w.track)) keyed[w.track] = w.value;
    else anyStatic = true;
  }
  const out: Command[] = anyStatic ? [...staticCommands()] : [];
  if (Object.keys(keyed).length > 0) out.push(...valueCommands([{ nodeId: t.nodeId, values: keyed }], opts));
  return out;
}
