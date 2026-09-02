/**
 * WHERE a transition is drawn, and where a cut can be dropped on.
 *
 * Pure geometry over the timeline VIEW MODEL, in comp SECONDS and row indices —
 * the two units the lanes already lay out in. It lives here rather than inside
 * `Timeline.tsx` for the same reason `clipCuts` does: it runs inside a
 * pointermove and a render, so it has to be testable without a DOM, and the
 * arithmetic is exactly the kind that is right on the day and one frame out a
 * month later.
 *
 * ## Why the box is measured off the BARS, not off the record
 *
 * A record says "12 frames, centred". The obvious drawing is therefore "six
 * frames either side of the cut" — and it is wrong the moment anything moves,
 * because the cut it refers to is no longer where the record was written: a
 * roll, a trim, a slip on a neighbour, or an insufficient handle that clamped
 * the overlap shorter than asked all leave the record's arithmetic describing a
 * region the bars do not occupy. The bracket would then float beside the
 * overlap it is supposed to bracket.
 *
 * So for the OVERLAPPING kinds the box is the overlap the two bars actually
 * share, read straight off the model. The record only chooses which pair of
 * bars to measure. The dips do not overlap — there is nothing to read — so
 * those alone fall back to the record's own region, anchored on the seam the
 * two bars really meet at.
 */

import type { TimelineTrack, TimelineClip } from './TimelineModel';
import type {
  TransitionRecord,
  TransitionKind,
  TransitionAlignment,
} from '@core/timeline/transitionStore';
import { TRANSITION_SHORT } from '@core/timeline/transitionStore';
import { transitionOverlaps, transitionRegion } from '@core/timeline/transitions';

/**
 * Where a transition sits relative to the cut it spans, in cycle order.
 *
 * The record has carried `alignment` since transitions shipped and every entry
 * point hard-coded 'centred', so two thirds of the model were unreachable from
 * the UI. Centred leads the cycle because it is the default and what a
 * dissolve usually wants; the two one-sided placements follow.
 *
 * Here rather than in `Timeline.tsx` because the clip context menu offers the
 * same three by name, and two lists of the same three eventually disagree
 * about their labels.
 */
export const TRANSITION_ALIGNMENTS: readonly TransitionAlignment[] = [
  'centred',
  'startAtCut',
  'endAtCut',
];

/** Human labels for `TRANSITION_ALIGNMENTS`. */
export const TRANSITION_ALIGNMENT_LABEL: Record<TransitionAlignment, string> = {
  centred: 'Centred',
  startAtCut: 'Start at cut',
  endAtCut: 'End at cut',
};

/** The next alignment in the cycle — wraps, so clicking forever is harmless. */
export function nextTransitionAlignment(current: TransitionAlignment): TransitionAlignment {
  const i = TRANSITION_ALIGNMENTS.indexOf(current);
  return TRANSITION_ALIGNMENTS[(i + 1) % TRANSITION_ALIGNMENTS.length] ?? 'centred';
}

export interface TransitionBox {
  id: string;
  kind: TransitionKind;
  /** Drawn on the bracket. */
  label: string;
  /** Comp SECONDS. */
  start: number;
  end: number;
  /**
   * The cut itself, in comp seconds — where the two bars met before the
   * transition pushed them apart. Everything about resizing is measured from
   * here rather than from the opposite edge: a centred transition grows at BOTH
   * ends, so "drag the right grip, hold the left one still" would fight the
   * alignment and jump on release.
   */
  cut: number;
  /** Topmost / bottommost view row the two bars occupy. */
  topRow: number;
  bottomRow: number;
  leftClipId: string;
  rightClipId: string;
}

/** Every bar in the model, grouped by the scene node behind it. */
export function barsByNode(tracks: ReadonlyArray<TimelineTrack>): Map<string, TimelineClip[]> {
  const out = new Map<string, TimelineClip[]>();
  for (const track of tracks) {
    for (const clip of track.clips ?? []) {
      const list = out.get(clip.nodeId);
      if (list) list.push(clip);
      else out.set(clip.nodeId, [clip]);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Which of the two nodes' bars this transition sits between.
 *
 * A node can own several bars (every split clones the node, but a re-split of
 * one half does not), so "bar 0 of each" is not good enough — only one pair
 * actually meets. `overlapping` picks the ranking: an overlap-based transition
 * wants the pair sharing the most time, a dip the pair whose seam is tightest.
 */
export function pickCutBars(
  lefts: ReadonlyArray<TimelineClip>,
  rights: ReadonlyArray<TimelineClip>,
  overlapping: boolean,
): { left: TimelineClip; right: TimelineClip } | null {
  let best: { left: TimelineClip; right: TimelineClip } | null = null;
  let bestScore = overlapping ? 0 : Number.POSITIVE_INFINITY;
  for (const left of lefts) {
    for (const right of rights) {
      if (left.id === right.id) continue;
      if (overlapping) {
        const shared = Math.min(left.start + left.duration, right.start + right.duration) -
          Math.max(left.start, right.start);
        if (shared > bestScore) {
          bestScore = shared;
          best = { left, right };
        }
      } else {
        const seam = Math.abs(left.start + left.duration - right.start);
        if (seam < bestScore) {
          bestScore = seam;
          best = { left, right };
        }
      }
    }
  }
  return best;
}

/**
 * Lay every transition out over the rows.
 *
 * `rowOf` maps a track id to its index in the flattened row list — the caller
 * owns that, because expanded property sub-rows shift it and only the timeline
 * knows which tracks are open. A transition whose bars are not currently drawn
 * (filtered out, shy, scrolled away as a row that no longer exists) is dropped
 * rather than pinned to row 0.
 */
export function layoutTransitions(
  transitions: ReadonlyArray<TransitionRecord>,
  tracks: ReadonlyArray<TimelineTrack>,
  rowOf: (trackId: string) => number | undefined,
  fps: number,
): TransitionBox[] {
  const bars = barsByNode(tracks);
  const rate = fps > 0 ? fps : 30;
  const out: TransitionBox[] = [];
  for (const rec of transitions) {
    const lefts = bars.get(rec.leftNodeId);
    const rights = bars.get(rec.rightNodeId);
    if (!lefts || !rights) continue;
    const overlapping = transitionOverlaps(rec.kind);
    const pair = pickCutBars(lefts, rights, overlapping);
    if (!pair) continue;
    const topRow = rowOf(pair.left.trackId);
    const bottomRow = rowOf(pair.right.trackId);
    if (topRow === undefined || bottomRow === undefined) continue;

    let start: number;
    let end: number;
    let cut: number;
    if (overlapping) {
      start = Math.max(pair.left.start, pair.right.start);
      end = Math.min(pair.left.start + pair.left.duration, pair.right.start + pair.right.duration);
      if (end <= start) continue; // the overlap is gone — so is the transition's box
      cut = rec.alignment === 'startAtCut' ? start : rec.alignment === 'endAtCut' ? end : (start + end) / 2;
    } else {
      const region = transitionRegion(rec.durationFrames, rec.alignment);
      cut = (pair.left.start + pair.left.duration + pair.right.start) / 2;
      start = cut - region.before / rate;
      end = cut + region.after / rate;
      if (end <= start) continue;
    }

    out.push({
      id: rec.id,
      kind: rec.kind,
      label: TRANSITION_SHORT[rec.kind],
      start,
      end,
      cut,
      topRow: Math.min(topRow, bottomRow),
      bottomRow: Math.max(topRow, bottomRow),
      leftClipId: pair.left.id,
      rightClipId: pair.right.id,
    });
  }
  return out;
}

/**
 * How long a transition would become if its `edge` were dragged to `time`.
 *
 * The other end stays put, so dragging the right grip of a centred dissolve
 * lengthens it by twice what the pointer travelled — which is what "centred"
 * means and what every NLE does. Frames, clamped to at least one: a zero-length
 * transition is a cut, and the way to make one is to delete this.
 */
export function durationFromEdgeDrag(
  box: { cut: number },
  edge: 'start' | 'end',
  time: number,
  alignment: 'centred' | 'startAtCut' | 'endAtCut',
  fps: number,
): number {
  const rate = fps > 0 ? fps : 30;
  // Measured from the CUT outwards, so the grip stays under the pointer for
  // every alignment. A centred transition puts half either side, so the half
  // the pointer defines is worth twice as much duration.
  const half = edge === 'end' ? time - box.cut : box.cut - time;
  const frames = half * rate * (alignment === 'centred' ? 2 : 1);
  return Math.max(1, Math.round(frames));
}
