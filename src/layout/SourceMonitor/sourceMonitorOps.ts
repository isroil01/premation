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
 * range is expressed the way the timeline already expresses every trim:
 * `trimClipTo('end')` then `trimClipTo('start')` (end first — moving the head
 * first can momentarily invert the bar and the engine clamps it to one frame,
 * which is exactly how `clipWindow` once produced sliver bars), and finally
 * `setClipStart` to place it. `trimStart` advances `sourceIn` by the same
 * delta it moves `start`, which is what makes the bar show the marked part of
 * the file rather than the first N seconds of it.
 *
 * ── What "overwrite" honestly means here ────────────────────────────────
 * This app is not a single-track NLE: layers are scene nodes with a z-order,
 * and clips overlapping in time is the normal case, not a collision. So
 * overwrite does the bounded, reversible thing — it trims the clips the new
 * one lands on top of, and SPLITS a clip that spans the whole insert. A clip
 * that sits ENTIRELY inside the range is left alone and reported, because the
 * only way to "overwrite" it would be to delete the user's layer, and a button
 * that silently deletes layers is not a trim.
 */

import { insertMedia } from '@core/scene/sceneInsert';
import { createCompositionFromFootage } from '@core/composition/compositionOps';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
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

/**
 * Give `nodeId`'s clip the marked source window, placed at `atSeconds`.
 *
 * Returns the clip id, or null when the node has no bar (nothing was seeded,
 * or the caller ran before `syncFromScene`).
 */
export function applySourceRange(nodeId: string, range: SourceRange, atSeconds: number): string | null {
  const controller = getTimelineController();
  const clip = controller.getLayersForNode(nodeId)[0];
  if (!clip) return null;
  const fps = controller.fpsForNode(nodeId) || 30;
  // The bar's own origin, not zero: `syncFromScene` seeds `start: 0`, but a
  // caller that placed the layer first would otherwise have its offset read as
  // part of the source window.
  const barStart = clip.start / fps;
  // End BEFORE start — see the header.
  controller.trimClipTo(clip.id, 'end', barStart + range.outSec);
  controller.trimClipTo(clip.id, 'start', barStart + range.inSec);
  controller.setClipStart(clip.id, Math.max(0, atSeconds));
  // A trim mutates the clip in place; nothing else invalidates the memoized
  // per-track sourceId → layers index.
  controller.invalidateLayerIndex();
  return clip.id;
}

/**
 * Trim whatever the new clip lands on top of. See the header for what this
 * deliberately does NOT do. Returns how many clips were left untouched
 * because they sit entirely inside the range.
 */
export function overwriteUnder(keepClipId: string, startSeconds: number, endSeconds: number): number {
  const controller = getTimelineController();
  const fps = controller.timeline.getFrameRate().fps || 30;
  const startF = Math.round(startSeconds * fps);
  const endF = Math.round(endSeconds * fps);
  let covered = 0;
  // Snapshot: splitting adds a layer to the same track, and a live array would
  // hand the loop the piece it just made.
  for (const l of [...controller.layersOfComp()]) {
    if (l.id === keepClipId) continue;
    const s = l.start;
    const e = l.start + l.duration;
    if (e <= startF || s >= endF) continue; // no overlap
    if (s < startF && e > endF) {
      // Spans the whole insert: cut a hole in it.
      controller.splitClip(l.id, endSeconds);
      controller.trimClipTo(l.id, 'end', startSeconds);
    } else if (s < startF) {
      controller.trimClipTo(l.id, 'end', startSeconds);
    } else if (e > endF) {
      controller.trimClipTo(l.id, 'start', endSeconds);
    } else {
      covered++;
    }
  }
  controller.invalidateLayerIndex();
  return covered;
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

  await insertMedia(asset);
  // `insertMedia` selects what it created — the contract every insert path in
  // sceneInsert keeps, and the only reliable way to find the node.
  const nodeId = [...useSelectionStore.getState().ids][0] ?? null;
  if (!nodeId) return null;
  // Sync EXPLICITLY rather than trusting the App's SceneGraphChanged
  // subscription to have run: this verb edits the bar it just created, so its
  // existence cannot depend on who else is mounted.
  controller.syncFromScene();

  const clipId = applySourceRange(nodeId, range, at);
  if (clipId && opts.overwrite) {
    const clip = controller.getLayersForNode(nodeId)[0];
    const fps = controller.fpsForNode(nodeId) || 30;
    if (clip) {
      const covered = overwriteUnder(clipId, clip.start / fps, (clip.start + clip.duration) / fps);
      if (covered > 0) {
        useUIStore.getState().notify({
          level: 'info',
          message: `Overwrote the range. ${covered} clip${covered === 1 ? '' : 's'} sitting entirely inside it ${covered === 1 ? 'was' : 'were'} left in place — trim or delete ${covered === 1 ? 'it' : 'them'} if you meant to replace ${covered === 1 ? 'it' : 'them'}.`,
          durationMs: 7000,
        });
      }
    }
  }
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
  const compId = await createCompositionFromFootage(asset);
  const nodeId = [...useSelectionStore.getState().ids][0] ?? null;
  const controller = getTimelineController();
  const length = Math.max(0, range.outSec - range.inSec);
  if (nodeId) {
    controller.syncFromScene(compId);
    applySourceRange(nodeId, range, 0);
  }
  if (length > 0) {
    // Both halves, in this order — the comp record is what the UI reads and
    // what serializes; the controller is what the ruler, work area and loop
    // range are built from. Writing one without the other is the disagreement
    // `createOrAdoptComposition` documents at its own tail.
    useProjectStore.getState().actions.updateComp(compId, { durationSeconds: length });
    controller.setDurationSeconds(length);
  }
  return compId;
}
