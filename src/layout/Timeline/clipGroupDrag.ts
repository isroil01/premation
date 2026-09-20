/**
 * Moving a MULTI-ROW selection of clip bars as one gesture — pure geometry.
 *
 * Dragging a bar used to move exactly the bar under the pointer, whatever else
 * was selected. Selecting eight layers and dragging one of them moved one of
 * them, so a "shift this section two seconds later" edit was eight drags, each
 * one a chance to lose the relative spacing that made it a section.
 *
 * What the group drag has to get right, and what this module is here to pin:
 *
 *   • WHICH bars move. The selection addresses SCENE NODES (a row), but a row
 *     can carry several bars — a split clip is one node and three bars — and
 *     all of them travel together or the split comes apart.
 *   • The DELTA is clamped ONCE for the whole group, against the earliest bar
 *     in it. Clamping bar-by-bar at t=0 is the bug that silently collapses a
 *     spread selection into a stack the moment it touches the start of the
 *     comp, and there is no undo that brings the spacing back because the
 *     spacing was never recorded.
 *   • A STAGGER offset is per-ROW, not per-bar, so two bars on one row keep
 *     their distance from each other while the rows fan out.
 */

/** The minimum a bar drag needs to know about a bar. */
export interface GroupClip {
  /** Bar id — what a move is addressed to. */
  id: string;
  /** Scene node the bar belongs to — what the SELECTION is addressed to. */
  trackId: string;
  /** Bar start in seconds. */
  start: number;
  /** Bar length in seconds. Unused by the move, carried for the caller. */
  duration: number;
  locked?: boolean;
}

/**
 * The bars a drag on `grabbedClipId` should move.
 *
 * A drag that starts on a bar OUTSIDE the selection moves that bar alone —
 * matching every other list-and-drag interface, and matching the pointer-down
 * handler, which has already replaced the selection with the grabbed row by
 * the time the drag begins.
 *
 * Locked bars are dropped rather than refused: a selection of ten rows where
 * one happens to be locked should move the other nine, not nothing.
 */
export function groupDragTargets(
  clips: ReadonlyArray<GroupClip>,
  selectedTrackIds: ReadonlyArray<string>,
  grabbedClipId: string,
): GroupClip[] {
  const grabbed = clips.find((c) => c.id === grabbedClipId);
  if (!grabbed) return [];
  const selected = new Set(selectedTrackIds);
  if (!selected.has(grabbed.trackId)) return grabbed.locked ? [] : [grabbed];
  return clips.filter((c) => selected.has(c.trackId) && !c.locked);
}

/**
 * The largest part of `dtSec` the group can travel without any bar crossing
 * `minTime`. Returns `dtSec` unchanged when nothing is in the way.
 */
export function clampGroupDelta(
  targets: ReadonlyArray<GroupClip>,
  dtSec: number,
  minTime = 0,
): number {
  if (targets.length === 0) return dtSec;
  let earliest = Infinity;
  for (const c of targets) earliest = Math.min(earliest, c.start);
  if (!Number.isFinite(earliest)) return dtSec;
  return Math.max(dtSec, minTime - earliest);
}

export interface GroupDragOptions {
  /**
   * Extra per-ROW time, indexed by the row's position in `rowOrder`. This is
   * where a stagger enters the drag.
   */
  rowOffsets?: ReadonlyArray<number>;
  /** Row ids in display order — what `rowOffsets` is indexed by. */
  rowOrder?: ReadonlyArray<string>;
  /** Floor the group may not cross. */
  minTime?: number;
  /** Frame duration in seconds; when set, every start lands on the grid. */
  frameDuration?: number;
}

/**
 * Where every bar in the group ends up: `start + delta + its row's offset`,
 * with the whole set shifted back if any part of it would cross `minTime`.
 *
 * The clamp is applied to the COMBINED move (delta plus offsets) rather than to
 * the delta alone, because a balanced stagger moves some rows earlier than the
 * pointer went — those are the bars that reach t=0 first, and clamping only the
 * pointer delta would let them through.
 */
export function groupDragStarts(
  targets: ReadonlyArray<GroupClip>,
  dtSec: number,
  opts: GroupDragOptions = {},
): Map<string, number> {
  const out = new Map<string, number>();
  if (targets.length === 0) return out;

  const { rowOffsets, rowOrder, minTime = 0, frameDuration } = opts;
  const rowIndex = new Map<string, number>();
  if (rowOrder) rowOrder.forEach((id, i) => rowIndex.set(id, i));

  const offsetFor = (trackId: string): number => {
    if (!rowOffsets || rowOffsets.length === 0) return 0;
    const i = rowIndex.get(trackId);
    return i === undefined ? 0 : (rowOffsets[i] ?? 0);
  };

  // Pass one: the unclamped destinations, and the earliest of them.
  let earliest = Infinity;
  const raw: Array<{ id: string; start: number }> = [];
  for (const c of targets) {
    const start = c.start + dtSec + offsetFor(c.trackId);
    raw.push({ id: c.id, start });
    earliest = Math.min(earliest, start);
  }

  // Pass two: one shift for the whole group, so relative spacing survives.
  const push = Number.isFinite(earliest) && earliest < minTime ? minTime - earliest : 0;
  for (const { id, start } of raw) {
    const t = start + push;
    out.set(id, frameDuration && frameDuration > 0 ? Math.round(t / frameDuration) * frameDuration : t);
  }
  return out;
}

/**
 * Rows the group spans, in `rowOrder` order — the list a stagger's offsets are
 * generated for. Distinct, because a row with three bars is still one row and
 * must get one offset, not three.
 */
export function groupRows(
  targets: ReadonlyArray<GroupClip>,
  rowOrder: ReadonlyArray<string>,
): string[] {
  const present = new Set(targets.map((c) => c.trackId));
  const out = rowOrder.filter((id) => present.has(id));
  // A target on a row the caller did not list still counts as a row, or its
  // bars would silently take row 0's offset.
  for (const id of present) if (!out.includes(id)) out.push(id);
  return out;
}
