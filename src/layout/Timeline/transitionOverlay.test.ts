/**
 * Where a transition's bracket is drawn.
 *
 * ## Rule 5·0 — the observable
 *
 * The observable is the RECTANGLE: which span of comp seconds it covers and
 * which rows it straddles. That is what the user sees and what the grips are
 * hit-tested against, so the assertions are on the box, never on intermediate
 * arithmetic.
 *
 * ## Rule 3a — what the clean fixture would exclude
 *
 * A single cut, one bar per node, and rows in model order. Every one of those
 * would let a wrong implementation pass:
 *
 *   • one bar per node hides the fact that a split CLONES the node, so a node
 *     can own several bars and only one pair actually meets;
 *   • rows in model order hides the difference between `tracks.indexOf` and the
 *     flattened row list an expanded layer produces;
 *   • one cut hides a layout that draws every transition at the same place.
 *
 * So the fixture gives node `a` two bars, puts the rows out of model order, and
 * lays out two transitions at once.
 */

import type { TimelineTrack, TimelineClip } from './TimelineModel';
import type { TransitionRecord } from '@core/timeline/transitionStore';
import { layoutTransitions, pickCutBars, durationFromEdgeDrag, barsByNode } from './transitionOverlay';

const FPS = 30;

function clip(id: string, nodeId: string, trackId: string, start: number, duration: number): TimelineClip {
  return { id, nodeId, trackId, start, duration } as unknown as TimelineClip;
}

function track(id: string, clips: TimelineClip[]): TimelineTrack {
  // `TrackId` is a branded string, and these fixtures only ever need it as a
  // key — hence the double cast rather than minting real branded ids.
  return { id, name: id, clips } as unknown as TimelineTrack;
}

/**
 * Two cuts, three rows, and node `a` owning two bars.
 *
 *   row 0 (t_a) : a#1 [0, 1)            a#2 [2, 3)
 *   row 1 (t_b) :            b  [1, 2)
 *   row 2 (t_c) :                                  c  [3, 4)
 *
 * `a#1 → b` at 1s and `a#2 → c` at 3s are the two cuts; `a#2` is the decoy that
 * a "bar 0 of each node" implementation would pick for the first of them.
 */
const TRACKS: TimelineTrack[] = [
  track('t_a', [clip('a1', 'a', 't_a', 0, 1), clip('a2', 'a', 't_a', 2, 1)]),
  track('t_b', [clip('b1', 'b', 't_b', 1, 1)]),
  track('t_c', [clip('c1', 'c', 't_c', 3, 1)]),
];

/** Rows deliberately NOT in model order — an expanded layer reorders nothing,
 *  but it does insert sub-rows, and this stands in for that displacement. */
const ROW_OF = (id: string): number | undefined => ({ t_a: 4, t_b: 7, t_c: 2 })[id];

function rec(over: Partial<TransitionRecord> = {}): TransitionRecord {
  return {
    id: 't1',
    leftNodeId: 'a',
    rightNodeId: 'b',
    kind: 'dipToBlack',
    durationFrames: 12,
    alignment: 'centred',
    ...over,
  };
}

describe('barsByNode', () => {
  it('groups every bar under its scene node, in time order', () => {
    const map = barsByNode(TRACKS);
    expect(map.get('a')?.map((c) => c.id)).toEqual(['a1', 'a2']);
    expect(map.get('b')?.map((c) => c.id)).toEqual(['b1']);
  });

  it('sorts by start even when the model lists them backwards', () => {
    const reversed = [track('t_a', [clip('a2', 'a', 't_a', 2, 1), clip('a1', 'a', 't_a', 0, 1)])];
    expect(barsByNode(reversed).get('a')?.map((c) => c.id)).toEqual(['a1', 'a2']);
  });
});

describe('pickCutBars — which of a node’s bars this transition sits between', () => {
  it('takes the pair whose SEAM is tightest for a non-overlapping kind', () => {
    // `a2` starts at 2 and `b1` ends at 2, so a naive "smallest gap in either
    // direction" would be just as happy with the wrong pair. The seam that
    // matters is left-out to right-in: a1 ends where b1 starts.
    const bars = barsByNode(TRACKS);
    const pair = pickCutBars(bars.get('a') ?? [], bars.get('b') ?? [], false);
    expect(pair?.left.id).toBe('a1');
    expect(pair?.right.id).toBe('b1');
  });

  it('takes the pair sharing the most TIME for an overlapping kind', () => {
    const lefts = [clip('L1', 'a', 't_a', 0, 10), clip('L2', 'a', 't_a', 40, 10)];
    const rights = [clip('R1', 'b', 't_b', 8, 10), clip('R2', 'b', 't_b', 49, 10)];
    // L1/R1 share 2s, L2/R2 share 1s. The bigger overlap is the transition.
    const pair = pickCutBars(lefts, rights, true);
    expect(pair?.left.id).toBe('L1');
    expect(pair?.right.id).toBe('R1');
  });

  it('finds nothing when no pair overlaps at all', () => {
    const lefts = [clip('L', 'a', 't_a', 0, 1)];
    const rights = [clip('R', 'b', 't_b', 5, 1)];
    expect(pickCutBars(lefts, rights, true)).toBeNull();
  });
});

describe('layoutTransitions', () => {
  it('measures an OVERLAPPING kind off the bars, not off the record', () => {
    /*
     * The point of the whole module. The record says 12 frames; the bars
     * actually share 0.5s (15 frames) because a roll moved the cut after the
     * transition was applied. Drawing the record's number would leave the
     * bracket floating beside the overlap it is supposed to bracket.
     */
    const tracks = [
      track('t_a', [clip('L', 'a', 't_a', 0, 1.5)]),
      track('t_b', [clip('R', 'b', 't_b', 1.0, 1)]),
    ];
    const [box] = layoutTransitions([rec({ kind: 'crossDissolve' })], tracks, ROW_OF, FPS);
    expect(box?.start).toBeCloseTo(1.0, 6);
    expect(box?.end).toBeCloseTo(1.5, 6);
  });

  it('measures a DIP off the record, because there is no overlap to read', () => {
    // 12 frames centred at 30fps → 0.2s either side of the seam at 1s.
    const [box] = layoutTransitions([rec()], TRACKS, ROW_OF, FPS);
    expect(box?.start).toBeCloseTo(1 - 6 / FPS, 6);
    expect(box?.end).toBeCloseTo(1 + 6 / FPS, 6);
  });

  it('spans the two bars’ ROWS, in screen order rather than model order', () => {
    // t_a is row 4 and t_b is row 7, so the box runs 4..7 — not 0..1, which is
    // what reading `tracks.indexOf` would give.
    const [box] = layoutTransitions([rec()], TRACKS, ROW_OF, FPS);
    expect(box?.topRow).toBe(4);
    expect(box?.bottomRow).toBe(7);
  });

  it('normalises the rows when the incoming clip is drawn ABOVE the outgoing one', () => {
    // t_c is row 2, above t_a's row 4. A box with topRow > bottomRow renders
    // with a negative height, i.e. not at all.
    const [box] = layoutTransitions(
      [rec({ id: 't2', leftNodeId: 'a', rightNodeId: 'c' })],
      TRACKS,
      ROW_OF,
      FPS,
    );
    expect(box?.topRow).toBe(2);
    expect(box?.bottomRow).toBe(4);
  });

  it('lays two transitions out in DIFFERENT places', () => {
    // Rule 3a's second cut: with one transition, a layout that always returns
    // the same rectangle passes everything above.
    const boxes = layoutTransitions(
      [rec(), rec({ id: 't2', leftNodeId: 'a', rightNodeId: 'c' })],
      TRACKS,
      ROW_OF,
      FPS,
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.start).not.toBeCloseTo(boxes[1]?.start ?? 0, 3);
  });

  it('drops a transition whose layers are not currently drawn', () => {
    // Shy, filtered by search, or in another composition entirely. Pinning it
    // to row 0 would draw a bracket over an unrelated layer.
    expect(layoutTransitions([rec({ rightNodeId: 'missing' })], TRACKS, ROW_OF, FPS)).toHaveLength(0);
    expect(layoutTransitions([rec()], TRACKS, () => undefined, FPS)).toHaveLength(0);
  });

  it('drops an overlapping transition whose overlap has been trimmed away', () => {
    // The bars no longer meet, so there is nothing to bracket — better an
    // absent box than one of negative width drawn at the wrong place.
    const tracks = [
      track('t_a', [clip('L', 'a', 't_a', 0, 1)]),
      track('t_b', [clip('R', 'b', 't_b', 2, 1)]),
    ];
    expect(layoutTransitions([rec({ kind: 'crossDissolve' })], tracks, ROW_OF, FPS)).toHaveLength(0);
  });

  it('carries the kind and a short label through', () => {
    const [box] = layoutTransitions([rec({ kind: 'wipe' })], TRACKS, ROW_OF, FPS);
    // Wipe overlaps, and these bars only touch — so there is nothing to draw.
    expect(box).toBeUndefined();
    const [dip] = layoutTransitions([rec({ kind: 'dipToWhite' })], TRACKS, ROW_OF, FPS);
    expect(dip?.kind).toBe('dipToWhite');
    expect(dip?.label).toBe('Dip White');
  });
});

describe('durationFromEdgeDrag', () => {
  const box = { cut: 2 };

  it('a CENTRED transition grows at both ends, so the pointer is worth double', () => {
    // Drag the right grip 0.5s past the cut: the transition is 0.5s on that
    // side and 0.5s on the other, so 30 frames, not 15. Halving this is the
    // bug where the bracket lags behind the pointer by a factor of two.
    expect(durationFromEdgeDrag(box, 'end', 2.5, 'centred', FPS)).toBe(30);
    expect(durationFromEdgeDrag(box, 'start', 1.5, 'centred', FPS)).toBe(30);
  });

  it('a one-sided alignment takes the pointer at face value', () => {
    expect(durationFromEdgeDrag(box, 'end', 2.5, 'startAtCut', FPS)).toBe(15);
    expect(durationFromEdgeDrag(box, 'start', 1.5, 'endAtCut', FPS)).toBe(15);
  });

  it('never returns less than one frame, however far past the cut you drag', () => {
    // Dragging the right grip to the LEFT of the cut is a negative span. A
    // zero- or negative-length transition is a cut; the way to make one is to
    // delete the record.
    expect(durationFromEdgeDrag(box, 'end', 0.5, 'centred', FPS)).toBe(1);
  });
});
