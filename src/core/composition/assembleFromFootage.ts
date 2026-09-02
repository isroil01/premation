/**
 * "Assemble from Footage" — a rush becomes a cut.
 *
 * Every piece of this already existed and none of them were joined up. Scene
 * Edit Detection could find the cuts in a camera master and split the clip at
 * each one; `sequenceLayerBars` could lay bars end-to-end with a dissolve;
 * `deleteLayerForClip` could remove a shot. Turning an hour-long recording into
 * an assembly therefore took four separate gestures, the middle two of which
 * had to be repeated per shot, and each of which was its own undo entry — so
 * backing out of a bad detection meant forty presses of Ctrl+Z.
 *
 * This is the one gesture: detect, split, drop the runts, sequence with a
 * dissolve, one undo entry.
 *
 * ## What each option is actually doing
 *
 *  • SENSITIVITY is the detector's own threshold (a multiple of the local
 *    median frame distance — see `SceneEditOptions`). Exposed because the right
 *    value is footage-dependent in a way no default can fix: a locked-off
 *    interview needs a low one, a handheld run-and-gun a high one, and the
 *    symptom of a wrong guess (four hundred "cuts", or none) is obvious enough
 *    that a user can correct it in one retry.
 *
 *  • DISSOLVE is the overlap handed to `sequenceLayerBars`, in FRAMES. Above 0
 *    it both overlaps the bars and writes the opacity ramps, which is why it
 *    shortens the assembly — a dissolve is not free time.
 *
 *  • DROP SHOTS SHORTER THAN removes the detector's debris. A histogram walk
 *    over real footage finds two- and three-frame "shots" at whip pans and
 *    flash frames; they are not shots, and leaving them in a cut is worse than
 *    the un-split master. The last surviving shot is never dropped, whatever
 *    the threshold: an empty comp is not an assembly.
 *
 * ## Why the splits are walked here rather than through `applySceneEditsAsSplits`
 *
 * That function returns a COUNT. This needs the node id of every shot — to
 * measure them, to drop some and to sequence the rest — and a split mints a
 * fresh node for its right half, so the ids only exist as the walk produces
 * them. The walk rule is the same one it documents: cuts ascending, each
 * applied to whichever bar currently covers it, which after the first split is
 * the previous right half.
 */

import { useUIStore } from '@stores/uiStore';
import { detectSceneEdits } from '@core/tracking/sceneEditDetectLayer';
import { getTimelineController } from '@core/timeline/TimelineController';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';

export interface AssembleOptions {
  /** Detector threshold. Undefined keeps `SceneEditOptions`' own default (5). */
  sensitivity?: number;
  /** Frames of cross-dissolve on each cut. 0 butts the shots together. */
  dissolveFrames: number;
  /** Shots shorter than this many frames are removed. 0 keeps every shot. */
  minShotFrames: number;
}

export interface AssembleReport {
  status: 'completed' | 'cancelled';
  /** Cuts the detector found. */
  cuts: number;
  /** Shots left in the comp when it finished. */
  shots: number;
  /** Shots removed for being shorter than `minShotFrames`. */
  dropped: number;
  /** Whether the bars were re-laid (false when there was nothing to re-lay). */
  sequenced: boolean;
}

/**
 * The mutating half: split `nodeId`'s clip at `cutsCompSec`, drop the runts and
 * sequence the survivors. Synchronous, so it can run inside one history entry.
 *
 * Pure geometry + scene work — it does no detection and shows no UI, which is
 * what makes it testable without WebCodecs.
 */
export function applyAssembly(
  nodeId: string,
  cutsCompSec: ReadonlyArray<number>,
  opts: AssembleOptions,
): { shots: string[]; dropped: number; sequenced: boolean } {
  const c = getTimelineController();
  const fps = c.fpsForNode(nodeId) || 30;

  // Where the master sits NOW. The assembly has to end up starting here
  // whatever the drop pass removes — see the re-anchor below.
  const anchorFrame = c.getLayersForNode(nodeId)[0]?.start ?? 0;

  // ── Split ────────────────────────────────────────────────────────
  const shots: string[] = [nodeId];
  let current = nodeId;
  for (const sec of [...cutsCompSec].sort((a, b) => a - b)) {
    const frame = Math.round(sec * fps);
    const host = c.getLayersForNode(current).find((l) => frame > l.start && frame < l.end);
    if (!host) continue;
    const rightLayerId = c.splitClip(host.id, sec);
    if (!rightLayerId) continue;
    const rightNodeId = c.timeline.getLayer(rightLayerId)?.sourceId;
    if (!rightNodeId) continue;
    shots.push(rightNodeId);
    current = rightNodeId;
  }

  // ── Drop the runts ───────────────────────────────────────────────
  const minKeep = Math.max(0, Math.round(opts.minShotFrames));
  let dropped = 0;
  if (minKeep > 0) {
    // Measured BEFORE any deletion: dropping is not a ripple here (sequencing
    // below closes the gaps), but re-reading a bar list mid-loop after the
    // scene changed under it is how a stale id gets deleted twice.
    const spans = shots.map((id) => ({ id, bar: c.getLayersForNode(id)[0] }));
    const survivors = spans.filter((s) => s.bar && s.bar.duration >= minKeep);
    // Never everything. A threshold that would empty the comp is a threshold
    // the user got wrong, and the useful answer is the un-culled assembly.
    if (survivors.length > 0) {
      for (const s of spans) {
        if (!s.bar || s.bar.duration >= minKeep) continue;
        if (c.deleteLayerForClip(s.bar.id)) {
          dropped++;
          const at = shots.indexOf(s.id);
          if (at >= 0) shots.splice(at, 1);
        }
      }
    }
  }

  // ── Re-anchor ────────────────────────────────────────────────────
  //
  // Sequencing lays the bars out FROM the first one, which it never moves. So
  // dropping the opening shots would leave the whole assembly starting wherever
  // the first survivor happened to fall — three seconds of nothing in front of
  // a cut that used to begin at zero. Putting the first survivor back on the
  // master's own start is what makes "drop the runts" mean "and close the hole
  // they left" rather than "and shift the film".
  //
  // Done here rather than inside the loop above because it must also cover the
  // ONE-survivor case, which `sequenceLayerBars` refuses (it needs a pair) and
  // which is exactly what an over-eager threshold produces.
  const firstBar = shots[0] ? c.getLayersForNode(shots[0])[0] : undefined;
  if (firstBar && firstBar.start !== anchorFrame) {
    c.setClipStart(firstBar.id, anchorFrame / fps);
    c.invalidateLayerIndex();
  }

  // ── Sequence ─────────────────────────────────────────────────────
  //
  // Always, when there is more than one shot: with a dissolve it writes the
  // ramps, and without one it closes the gaps the drop pass left. Splitting
  // alone leaves the bars contiguous, so a no-drop / no-dissolve run is a
  // no-op rather than a move.
  const overlap = Math.max(0, Math.round(opts.dissolveFrames));
  const sequenced = c.sequenceLayerBars(shots, overlap / fps, { crossfade: overlap > 0 });

  useSelectionStore.getState().set(shots);
  bumpScene();
  return { shots, dropped, sequenced };
}

/**
 * Detect the cuts in `nodeId`'s clip, reporting progress the way Scene Edit
 * Detection does — one dismissible notification updated in place, because the
 * walk is decode-bound and takes a minute on an hour of 4K.
 *
 * Separate from `applyAssembly` because it is async and cancellable, and
 * because everything it does is a pure read: nothing has changed if it throws.
 */
export async function detectForAssembly(
  nodeId: string,
  opts: AssembleOptions,
): Promise<{ cutsCompSec: number[]; status: 'completed' | 'cancelled' }> {
  const fps = getTimelineController().fpsForNode(nodeId) || 30;
  let liveId = useUIStore.getState().notify({
    level: 'info',
    message: 'Assemble from Footage: reading frames… 0%',
    durationMs: 0,
  });
  let last = -1;
  try {
    const result = await detectSceneEdits({
      nodeId,
      fps,
      ...(opts.sensitivity !== undefined ? { sensitivity: opts.sensitivity } : {}),
      onProgress: (f) => {
        const pct = Math.round(f * 100);
        if (pct !== last && pct % 5 === 0) {
          last = pct;
          useUIStore.getState().dismissNotification(liveId);
          liveId = useUIStore.getState().notify({
            level: 'info',
            message: `Assemble from Footage: reading frames… ${pct}%`,
            durationMs: 0,
          });
        }
      },
    });
    return { cutsCompSec: result.cutsCompSec, status: result.status };
  } finally {
    useUIStore.getState().dismissNotification(liveId);
  }
}
