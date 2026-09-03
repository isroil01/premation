/**
 * "New Composition from Selected Clips" — several clips in, one cut out.
 *
 * `createCompositionFromFootage` already builds the comp that IS a clip, and
 * `TimelineController.sequenceLayerBars` already lays bars end-to-end with an
 * optional cross-dissolve. What was missing is the gesture every editor starts
 * a rough cut with: select the takes in the bin, get a timeline of them in
 * order. Doing it by hand was New Comp from Footage, then N × Add to
 * Composition (all of which land stacked at frame 0, on top of each other),
 * then select them in the right order, then Sequence Layers.
 *
 * ## The rules it inherits, and the two it adds
 *
 * SIZE, FPS and PAR come from the FIRST clip, through `createCompositionFromFootage`
 * verbatim — including its refusal to guess a frame rate the file did not
 * report. The first clip is the one the user's eye is on when they choose the
 * order, and inventing an "average" of eight clips' resolutions would produce a
 * comp matching none of them.
 *
 * DURATION is the one setting that cannot be inherited: the comp must be the
 * length of the ASSEMBLY, not of its first shot. So it is measured off the bars
 * after sequencing — which is also what makes a positive overlap shorten the
 * comp rather than leave dead air at the end.
 *
 * ORDER is the selection's, which the caller supplies (the Assets panel's row
 * order — see `assetSelection`). Sequencing is by node, and every insert
 * selects what it inserted, which is how each layer's id is recovered.
 */

import type { ImportedAsset } from '@stores/assetStore';
import { createCompositionFromFootage } from './compositionOps';
import { insertMedia } from '@core/scene/sceneInsert';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';

export interface CompFromClipsResult {
  compId: string;
  /** Scene node ids of the placed layers, in the order they were sequenced. */
  nodeIds: string[];
  /** Whether the bars were actually laid end-to-end (false for a single clip). */
  sequenced: boolean;
  /** Frames of overlap applied, 0 when butted together. */
  overlapFrames: number;
}

/**
 * Build a composition from `assets` and lay them end-to-end in that order.
 *
 * `overlapFrames` above 0 overlaps each pair of bars by that many FRAMES and
 * cross-dissolves opacity across the overlap (`writeCrossfades`). Frames, not
 * seconds, because a cut is counted in frames and the comp's rate is the one
 * the first clip brought with it — asking for "0.5s" of dissolve on a 23.976
 * comp is asking for 11.988 frames.
 *
 * Not itself undoable. Wrap it in `runAsOneHistoryEntry` — it touches the comp
 * table, the scene, clip geometry and keyframes, and no smaller inverse exists.
 */
export async function createCompositionFromClips(
  assets: ReadonlyArray<ImportedAsset>,
  overlapFrames = 0,
): Promise<CompFromClipsResult> {
  if (assets.length === 0) throw new Error('Select at least one footage item.');

  const first = assets[0]!;
  // Creates the comp AND places the first clip at full frame, then leaves it
  // selected — the same contract every `insertMedia` honours.
  const compId = await createCompositionFromFootage(first);
  const nodeIds: string[] = [];
  const firstId = useSelectionStore.getState().ids[0];
  if (firstId) nodeIds.push(firstId);

  for (let i = 1; i < assets.length; i++) {
    // Sequentially awaited: concurrent inserts race the selection, which is
    // precisely the channel this loop reads the new layer's id from.
    await insertMedia(assets[i]!);
    const id = useSelectionStore.getState().ids[0];
    if (id && !nodeIds.includes(id)) nodeIds.push(id);
  }

  const controller = getTimelineController();
  // Mirror the just-inserted nodes into clip bars BEFORE sequencing them.
  //
  // `insertMedia` writes the scene and bumps it; the bars are seeded by
  // `syncFromScene`, which the Timeline panel calls from an effect on that
  // bump. An effect has not run by the time this line is reached — so
  // sequencing would find no bars for any of the layers it was handed, refuse
  // (it needs two), and leave every clip stacked at frame 0. Which is the exact
  // pile this operation exists to avoid.
  controller.syncFromScene(compId);

  const fps = controller.fps || 30;
  const overlap = Math.max(0, Math.round(overlapFrames));
  const sequenced = controller.sequenceLayerBars(nodeIds, overlap / fps, {
    crossfade: overlap > 0,
  });

  // The comp is the assembly's length. Measured rather than summed: sequencing
  // is the authority on where the last bar ends, and re-deriving it here from
  // clip durations and the overlap would be a second definition of the same
  // arithmetic (and would disagree the first time either changes).
  let lastFrame = 0;
  for (const id of nodeIds) {
    for (const bar of controller.getLayersForNode(id)) {
      if (bar.end > lastFrame) lastFrame = bar.end;
    }
  }
  if (lastFrame > 0) {
    const durationSeconds = lastFrame / fps;
    useProjectStore.getState().actions.updateComp(compId, { durationSeconds });
    controller.setDurationSeconds(durationSeconds);
  }

  useSelectionStore.getState().set(nodeIds);
  bumpScene();
  return { compId, nodeIds, sequenced, overlapFrames: overlap };
}
