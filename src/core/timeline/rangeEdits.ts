/**
 * Lift, Extract and Ripple Delete — the three ways an NLE removes material.
 *
 * They differ in exactly one thing, and it is worth naming because the words
 * are used loosely everywhere else:
 *
 *   • **Lift**    removes what is inside a time range and LEAVES THE HOLE.
 *                 Everything after it stays where it was, so a cut you were
 *                 happy with three minutes later is still on the same frame.
 *   • **Extract** removes the same material and CLOSES the hole — every bar
 *                 after the range slides left by the range's length.
 *   • **Ripple delete** is Extract addressed by LAYER rather than by range:
 *                 the layer goes and its own track closes up behind it.
 *
 * ## Why this is not in the Timeline package
 *
 * Removing a range is not one edit. It splits every bar that straddles either
 * boundary, deletes the pieces that fall inside, and (Extract) slides the rest.
 * The splits create SCENE NODES that did not exist when the operation began, so
 * the engine's own command history — which records clip geometry and nothing
 * else — cannot describe the inverse. `runAsOneHistoryEntry` captures the whole
 * document before and after instead, which is the same route
 * `transcriptOps.deleteTimeRanges` takes for the same reason, and the reason
 * `TimelineController.splitLayerAtFrame` documents at length.
 *
 * ## Frames, not seconds, at the boundary
 *
 * Bars are frames (`Clip.start/duration`, `Layer.start/end`, end EXCLUSIVE);
 * the range arrives in comp seconds because that is what the playhead, the work
 * area and the transcript all speak. The conversion happens ONCE, here, and
 * every comparison below is integer-on-integer — a half-frame boundary is the
 * classic way a cut lands one frame early on some layers and not others.
 */

/** A half-open span of COMPOSITION seconds. */
export interface RangeSeconds {
  start: number;
  end: number;
}

export interface RangeEditResult {
  /** Comp seconds the edit removed (0 when nothing was in the range). */
  removedSeconds: number;
  /** Bars cut at a range boundary. */
  splits: number;
  /** Bar pieces removed outright. */
  deletedClips: number;
  /** Bars slid left to close the gap. Always 0 for a lift. */
  rippled: number;
}

/**
 * Whether a bar lies wholly inside `[startF, endF)`.
 *
 * Pure and exported because it is the one predicate that decides whether a
 * piece is deleted or kept, and getting it wrong by one frame either orphans a
 * one-frame sliver at each boundary or eats a frame the user could see. `end`
 * is EXCLUSIVE on both sides, so a bar ending exactly at `endF` is inside.
 */
export function barIsInsideRange(
  bar: { start: number; end: number },
  startF: number,
  endF: number,
): boolean {
  return bar.start >= startF && bar.end <= endF;
}

/** Whether a boundary falls strictly inside a bar, i.e. the bar must be split. */
export function barStraddles(bar: { start: number; end: number }, frame: number): boolean {
  return bar.start < frame && bar.end > frame;
}
