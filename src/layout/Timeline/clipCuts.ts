/**
 * CUTS — the places where one clip's out-point meets the next clip's in-point.
 *
 * A roll needs a cut, and a cut is not a thing the model stores: it is an
 * emergent fact about two bars that happen to touch. Finding one is pure time
 * math over the view model, so it lives here rather than inside the timeline's
 * pointer handler, where it would be untestable and would run inside a
 * pointermove.
 *
 * ## Why cuts are found ACROSS tracks, not within one
 *
 * The instinct — and what every other NLE does — is "two clips on the same
 * track". That is wrong in this editor, and quietly: splitting a clip here
 * clones the scene node (`splitLayerAtFrame` → `cloneLayerNode`), because the
 * two halves have to be separately selectable and deletable. A row in this
 * timeline is a scene node, so the two halves of a split land on two ADJACENT
 * ROWS, not on one. A same-track search would therefore find no cut at exactly
 * the moment the user has just made one, which is the only moment they reach
 * for the roll tool.
 *
 * So pairs are built over every bar in the comp and the pointer's ROW is used
 * to disambiguate instead — see {@link findClipCutNear}.
 *
 * TIME UNIT: seconds, like `clipSnap` and the rest of the timeline VIEW.
 */

import type { TimelineTrack } from './TimelineModel';

export interface ClipCut {
  /** Where the cut sits, in comp seconds. The LEFT bar's out-point. */
  time: number;
  leftClipId: string;
  rightClipId: string;
  /** Scene nodes behind the two bars — what `rollEdit` addresses. */
  leftNodeId: string;
  rightNodeId: string;
  /** Rows the two bars are drawn on, so the UI can light them while rolling. */
  leftTrackId: string;
  rightTrackId: string;
  /**
   * How many rows apart the two bars are drawn.
   *
   * The tie-breaker that makes cross-row search safe. A comp cut to a beat has
   * many bars ending and starting on the same frame, and pairing every out with
   * every in produces cross pairs between layers that have nothing to do with
   * each other — rolling one of those would trim two unrelated clips. A split's
   * halves are one row apart, a genuinely stacked edit is zero, and a spurious
   * pair is usually much further, so the nearest pair vertically is the one the
   * user means.
   */
  rowDistance: number;
}

interface Edge {
  time: number;
  clipId: string;
  nodeId: string;
  trackId: string;
  row: number;
}

/**
 * Every cut in the model.
 *
 * `seamTolerance` mirrors `Timeline.slideLayer`'s one-frame `abuts` rule: split
 * halves meet exactly, but an edit assembled by hand can be a frame out and is
 * still, to the person looking at it, a cut. Pairs from the SAME scene node are
 * skipped — `rollEdit` refuses those (there is no cut between a thing and
 * itself, and rolling one against the other would just be a trim wearing a
 * different name).
 */
export function collectClipCuts(
  tracks: readonly TimelineTrack[],
  opts: { seamTolerance?: number } = {},
): ClipCut[] {
  const tol = opts.seamTolerance ?? 0;
  const ins: Edge[] = [];
  const outs: Edge[] = [];
  tracks.forEach((track, row) => {
    for (const clip of track.clips ?? []) {
      if (!Number.isFinite(clip.start) || !Number.isFinite(clip.duration)) continue;
      ins.push({ time: clip.start, clipId: clip.id, nodeId: clip.nodeId, trackId: track.id, row });
      outs.push({ time: clip.start + clip.duration, clipId: clip.id, nodeId: clip.nodeId, trackId: track.id, row });
    }
  });

  const cuts: ClipCut[] = [];
  for (const out of outs) {
    for (const inn of ins) {
      if (out.clipId === inn.clipId) continue;
      if (out.nodeId === inn.nodeId) continue;
      if (Math.abs(out.time - inn.time) > tol) continue;
      cuts.push({
        time: out.time,
        leftClipId: out.clipId,
        rightClipId: inn.clipId,
        leftNodeId: out.nodeId,
        rightNodeId: inn.nodeId,
        leftTrackId: out.trackId,
        rightTrackId: inn.trackId,
        rowDistance: Math.abs(out.row - inn.row),
      });
    }
  }
  return cuts;
}

/**
 * The cut under the pointer, or null.
 *
 * `radius` is in the same unit as `time` (the caller converts a pixel radius at
 * the current zoom, so the grab feels identical however far in you are).
 *
 * Several cuts sit within the radius all the time — a comp cut to a beat has
 * every layer starting on the same frame — so candidates are ranked, in order:
 *
 *   1. touches `preferTrackId`, the row the pointer is actually over. That is
 *      the only real signal about which coincident cut the user means.
 *   2. fewer rows apart (`rowDistance`). Without this the winner among equally
 *      close, equally preferred pairs is whichever the double loop happened to
 *      build first, which can be a pairing of two unrelated layers.
 *   3. nearer in time.
 *
 * A remaining tie keeps the incumbent, so the highlight cannot flicker between
 * two identical candidates as the pointer jitters.
 */
export function findClipCutNear(
  cuts: readonly ClipCut[],
  time: number,
  radius: number,
  preferTrackId?: string | null,
): ClipCut | null {
  let best: ClipCut | null = null;
  let bestDist = Infinity;
  let bestPreferred = false;
  for (const cut of cuts) {
    const d = Math.abs(cut.time - time);
    if (d > radius) continue;
    const preferred =
      preferTrackId != null && (cut.leftTrackId === preferTrackId || cut.rightTrackId === preferTrackId);
    let better: boolean;
    if (best === null) better = true;
    else if (preferred !== bestPreferred) better = preferred;
    else if (cut.rowDistance !== best.rowDistance) better = cut.rowDistance < best.rowDistance;
    else better = d < bestDist;
    if (better) {
      best = cut;
      bestDist = d;
      bestPreferred = preferred;
    }
  }
  return best;
}
