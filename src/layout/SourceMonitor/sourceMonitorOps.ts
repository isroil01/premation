/**
 * The four verbs that take a marked SOURCE range out of the monitor and into
 * the edit.
 *
 * ── The one conversion that matters ─────────────────────────────────────
 * The monitor speaks SOURCE SECONDS; a clip bar is FRAMES of the target comp
 * (`Clip`: `start`, `duration`, `sourceIn`, end-exclusive). The conversion
 * happens HERE and nowhere else, because it needs both halves at once — the
 * range, and the fps of the comp the footage is landing in. A source monitor
 * that stored frames would be wrong the moment the same clip was inserted into
 * a 24fps and a 30fps comp.
 *
 * ── Why trim rather than "insert with a duration" ───────────────────────
 * `insertMedia` is the ONE routing every import takes (PAR, sequences, audio,
 * SVG, fitting) and it has no opinion about time — `syncFromScene` seeds the
 * new node a bar of `min(comp duration, source length)` starting at 0. So the
 * range is expressed the way the timeline already expresses every trim: the
 * end trimmed first, then the start (end first — moving the head first can
 * momentarily invert the bar and the clip math clamps it to one frame, which
 * is exactly how `clipWindow` once produced sliver bars), and finally the bar
 * placed. `trimStart` advances `sourceIn` by the same delta it moves `start`,
 * which is what makes the bar show the marked part of the file rather than
 * the first N seconds of it. The geometry is computed with the timeline's own
 * `Clip` math on a clone and sent as ONE absolute `setLayerTiming` (B3 — the
 * engine API; `layout/Timeline/timelineEdits.ts` is the reference).
 *
 * ── What "overwrite" honestly means here ────────────────────────────────
 * This app is not a single-track NLE: layers are scene nodes with a z-order,
 * and clips overlapping in time is the normal case, not a collision. So
 * overwrite does the bounded, reversible thing — it trims the clips the new
 * one lands on top of, and SPLITS a clip that spans the whole insert. A clip
 * that sits ENTIRELY inside the range is left alone and reported, because the
 * only way to "overwrite" it would be to delete the user's layer, and a button
 * that silently deletes layers is not a trim.
 *
 * The range, the overwrite trims and splits are ONE undo entry after the
 * insert's own (the insert router has no API form yet — see `insertFromSource`).
 */

import type { Command, LayerTimingPatch } from '@motion/engine-api';
import { Clip, type ClipData } from '@motion/timeline';
import { insertMedia } from '@core/scene/sceneInsert';
import { createCompositionFromFootage } from '@core/composition/compositionOps';
import { getTimelineController } from '@core/timeline/TimelineController';
import { framesToFlicks } from '@core/engine/time';
import { compTime } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { ImportedAsset } from '@stores/assetStore';

/** A span of the SOURCE file, in seconds. End-exclusive, like a clip. */
export interface SourceRange {
  inSec: number;
  outSec: number;
}

/** Where the trimmed clip lands on the comp's time axis. */
export type Placement =
  /** At the comp playhead — the assemble gesture. */
  | { at: 'playhead' }
  /** After everything already in the comp — "add to the end". */
  | { at: 'end' }
  /** An explicit comp time in seconds. */
  | { at: 'time'; seconds: number };

/**
 * Where the last clip in the active comp ends, in seconds (0 for an empty
 * comp). Read BEFORE the insert, so the new clip's own bar cannot be counted
 * as "the end" it is supposed to follow.
 */
export function compEndSeconds(): number {
  const controller = getTimelineController();
  const fps = controller.timeline.getFrameRate().fps || 30;
  let end = 0;
  for (const l of controller.layersOfComp()) end = Math.max(end, l.start + l.duration);
  return end / fps;
}

/** The absolute `setLayerTiming` patch that gives a layer the bar `to` (frames of its comp). */
function timingPatch(nodeId: string, to: ClipData, fps: number): LayerTimingPatch {
  return {
    layer: nodeId,
    startTime: framesToFlicks(to.start - to.sourceIn, fps),
    inPoint: framesToFlicks(to.start, fps),
    outPoint: framesToFlicks(to.start + to.duration, fps),
  };
}

/** A placed source window: the command that sets it and the bar it produces. */
export interface SourceRangeEdit {
  command: Command;
  /** The bar after the edit (frames of the layer's comp). */
  bar: ClipData;
  fps: number;
}

/**
 * The edit that gives `nodeId`'s clip the marked source window, placed at
 * `atSeconds` — computed with the timeline's clip math on a clone (end trim,
 * then start trim, then the placement: the legacy order and clamps).
 *
 * Null when the node has no bar (nothing was seeded, or the caller ran before
 * `syncFromScene`).
 */
export function sourceRangeEdit(nodeId: string, range: SourceRange, atSeconds: number): SourceRangeEdit | null {
  const controller = getTimelineController();
  const clip = controller.getLayersForNode(nodeId)[0];
  if (!clip) return null;
  const fps = controller.fpsForNode(nodeId) || 30;
  // The bar's own origin, not zero: `syncFromScene` seeds `start: 0`, but a
  // caller that placed the layer first would otherwise have its offset read as
  // part of the source window.
  const barStart = clip.start / fps;
  const trial = Clip.fromJSON(clip.clip.toJSON());
  // End BEFORE start — see the header.
  trial.trimEnd(Math.round((barStart + range.outSec) * fps));
  trial.trimStart(Math.round((barStart + range.inSec) * fps));
  const bar: ClipData = { ...trial.toJSON(), start: Math.max(0, Math.round(atSeconds * fps)) };
  return { command: { type: 'setLayerTiming', items: [timingPatch(nodeId, bar, fps)] }, bar, fps };
}

/**
 * The trims and splits for whatever the new clip lands on top of, in frames
 * of the active comp. See the header for what this deliberately does NOT do.
 * `covered` counts the clips left untouched because they sit entirely inside
 * the range.
 */
export function overwriteCommands(keepNodeId: string, startF: number, endF: number): { commands: Command[]; covered: number } {
  const controller = getTimelineController();
  const fps = controller.timeline.getFrameRate().fps || 30;
  const f = (frame: number): number => framesToFlicks(frame, fps);
  const commands: Command[] = [];
  const touched = new Set<string>();
  let covered = 0;
  for (const l of controller.layersOfComp()) {
    const nodeId = l.sourceId;
    if (!nodeId || nodeId === keepNodeId || touched.has(nodeId)) continue;
    const s = l.start;
    const e = l.start + l.duration;
    if (e <= startF || s >= endF) continue; // no overlap
    touched.add(nodeId);
    if (s < startF && e > endF) {
      // Spans the whole insert: cut a hole in it. The split keeps the LEFT
      // part on this layer (the right part is a new layer), then the left
      // part's tail is trimmed back to where the insert begins.
      commands.push({ type: 'splitLayers', layers: [nodeId], time: f(endF) });
      commands.push({ type: 'setLayerTiming', items: [{ layer: nodeId, outPoint: f(startF) }] });
    } else if (s < startF) {
      commands.push({ type: 'setLayerTiming', items: [{ layer: nodeId, outPoint: f(startF) }] });
    } else if (e > endF) {
      commands.push({ type: 'setLayerTiming', items: [{ layer: nodeId, inPoint: f(endF) }] });
    } else {
      covered++;
    }
  }
  return { commands, covered };
}

/**
 * Trim whatever lands under `[startSeconds, endSeconds)` (every layer but
 * `keepNodeId`) as one undo entry. Returns how many clips were left alone.
 */
export async function overwriteUnder(keepNodeId: string, startSeconds: number, endSeconds: number): Promise<number> {
  const fps = getTimelineController().timeline.getFrameRate().fps || 30;
  const { commands, covered } = overwriteCommands(keepNodeId, Math.round(startSeconds * fps), Math.round(endSeconds * fps));
  if (commands.length > 0) await edit('Overwrite', commands);
  return covered;
}

function reportCovered(covered: number): void {
  if (covered <= 0) return;
  useUIStore.getState().notify({
    level: 'info',
    message: `Overwrote the range. ${covered} clip${covered === 1 ? '' : 's'} sitting entirely inside it ${covered === 1 ? 'was' : 'were'} left in place — trim or delete ${covered === 1 ? 'it' : 'them'} if you meant to replace ${covered === 1 ? 'it' : 'them'}.`,
    durationMs: 7000,
  });
}

/**
 * Insert the marked range into the active composition.
 *
 * Returns the new node's id, or null when the insert produced nothing to trim
 * (an unreadable SVG, an asset the router declined) — the caller surfaces
 * that rather than reporting a success it did not get.
 */
export async function insertFromSource(
  asset: ImportedAsset,
  range: SourceRange,
  placement: Placement,
  opts: { overwrite?: boolean } = {},
): Promise<string | null> {
  const controller = getTimelineController();
  // Captured BEFORE the (async) insert: the transport may be running, and the
  // clip must land where the playhead was when the user pressed the button —
  // the same rule, and the same reason, as `insertMediaAtPlayhead`.
  const at = placement.at === 'playhead' ? controller.currentSeconds
    : placement.at === 'end' ? compEndSeconds()
      : Math.max(0, placement.seconds);

  // B3-legacy: engine gap — `createLayer` builds the factory's minimal footage node; the insert
  // router (`insertMedia`: contain-fit, PAR, SVG parse, audio layers, sequences) has no API form.
  await insertMedia(asset);
  // `insertMedia` selects what it created — the contract every insert path in
  // sceneInsert keeps, and the only reliable way to find the node.
  const nodeId = [...useSelectionStore.getState().ids][0] ?? null;
  if (!nodeId) return null;
  // Sync EXPLICITLY rather than trusting the App's SceneGraphChanged
  // subscription to have run: this verb edits the bar it just created, so its
  // existence cannot depend on who else is mounted.
  controller.syncFromScene();

  const placed = sourceRangeEdit(nodeId, range, at);
  if (!placed) return nodeId;
  const commands: Command[] = [placed.command];
  let covered = 0;
  if (opts.overwrite) {
    const o = overwriteCommands(nodeId, placed.bar.start, placed.bar.start + placed.bar.duration);
    commands.push(...o.commands);
    covered = o.covered;
  }
  const res = await edit(opts.overwrite ? 'Overwrite from Source' : 'Insert from Source', commands);
  if (res.ok) reportCovered(covered);
  return nodeId;
}

/**
 * A new composition holding ONLY the marked range.
 *
 * `createCompositionFromFootage` already sizes and paces a comp to the clip;
 * this shortens it to the range and trims the layer to match, so "new comp
 * from range" produces a comp whose duration IS the shot rather than the whole
 * rush with the shot somewhere inside it.
 */
export async function newCompFromRange(asset: ImportedAsset, range: SourceRange): Promise<string> {
  // B3-legacy: engine gap — `createComposition{fromItems}` does not conform the comp to the
  // footage as `createCompositionFromFootage` does (probed fps, open tab, selection).
  const compId = await createCompositionFromFootage(asset);
  const nodeId = [...useSelectionStore.getState().ids][0] ?? null;
  const controller = getTimelineController();
  const length = Math.max(0, range.outSec - range.inSec);
  const commands: Command[] = [];
  if (nodeId) {
    controller.syncFromScene(compId);
    const placed = sourceRangeEdit(nodeId, range, 0);
    if (placed) commands.push(placed.command);
  }
  if (length > 0) {
    // The composition's duration through the engine: it writes the comp
    // record (what the UI reads and serializes) AND the controller (what the
    // ruler, work area and loop range are built from) — the two halves
    // `createOrAdoptComposition` documents at its own tail.
    commands.push({ type: 'setCompositionSettings', comp: compId, patch: { duration: compTime(length) } });
  }
  await edit('New Comp from Range', commands);
  return compId;
}
