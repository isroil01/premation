/**
 * Cut discovery.
 *
 * The case that drove this file is the CROSS-ROW one: this editor's split
 * clones the scene node, so the two halves of a fresh cut are on two rows, and
 * a same-track search would find nothing exactly when the user reaches for the
 * roll tool. It is asserted first because it is the one that looks wrong.
 */

import type { TimelineTrack } from './TimelineModel';
import { collectClipCuts, findClipCutNear } from './clipCuts';

/** One row holding one bar — the shape `deriveTimelineTracks` produces. */
function row(id: string, clips: Array<{ id: string; start: number; duration: number }>): TimelineTrack {
  return {
    id: id as TimelineTrack['id'],
    name: id,
    clips: clips.map((c) => ({
      id: c.id,
      trackId: id as never,
      nodeId: id as never,
      start: c.start,
      duration: c.duration,
    })),
  };
}

describe('collectClipCuts', () => {
  it('finds a cut between bars on DIFFERENT rows — the split case', () => {
    const tracks = [row('a', [{ id: 'la', start: 0, duration: 2 }]), row('b', [{ id: 'lb', start: 2, duration: 3 }])];
    const cuts = collectClipCuts(tracks);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({
      time: 2,
      leftClipId: 'la',
      rightClipId: 'lb',
      leftNodeId: 'a',
      rightNodeId: 'b',
      leftTrackId: 'a',
      rightTrackId: 'b',
    });
  });

  it('finds nothing when the bars do not touch', () => {
    const tracks = [row('a', [{ id: 'la', start: 0, duration: 2 }]), row('b', [{ id: 'lb', start: 4, duration: 3 }])];
    expect(collectClipCuts(tracks)).toEqual([]);
  });

  it('accepts a seam inside the tolerance', () => {
    // A hand-assembled edit that is one frame out still reads as a cut.
    const tracks = [row('a', [{ id: 'la', start: 0, duration: 2 }]), row('b', [{ id: 'lb', start: 2.03, duration: 3 }])];
    expect(collectClipCuts(tracks, { seamTolerance: 0.05 })).toHaveLength(1);
    expect(collectClipCuts(tracks, { seamTolerance: 0.01 })).toHaveLength(0);
  });

  it('never pairs a node with itself', () => {
    // `rollEdit` refuses this pair, so offering it would arm a drag that can
    // only ever do nothing.
    const tracks = [row('a', [{ id: 'l1', start: 0, duration: 2 }, { id: 'l2', start: 2, duration: 2 }])];
    expect(collectClipCuts(tracks)).toEqual([]);
  });

  it('is direction-aware — a right bar is never treated as the left one', () => {
    const tracks = [row('a', [{ id: 'la', start: 2, duration: 2 }]), row('b', [{ id: 'lb', start: 0, duration: 2 }])];
    const cuts = collectClipCuts(tracks);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ leftClipId: 'lb', rightClipId: 'la', time: 2 });
  });

  it('finds every cut in a three-clip chain', () => {
    const tracks = [
      row('a', [{ id: 'la', start: 0, duration: 2 }]),
      row('b', [{ id: 'lb', start: 2, duration: 2 }]),
      row('c', [{ id: 'lc', start: 4, duration: 2 }]),
    ];
    expect(collectClipCuts(tracks).map((c) => c.time).sort()).toEqual([2, 4]);
  });
});

describe('findClipCutNear', () => {
  const tracks = [
    row('a', [{ id: 'la', start: 0, duration: 2 }]),
    row('b', [{ id: 'lb', start: 2, duration: 2 }]),
    // A second, unrelated pair cutting at the SAME time on other rows — the
    // ordinary case in a comp cut to a beat.
    row('c', [{ id: 'lc', start: 0, duration: 2 }]),
    row('d', [{ id: 'ld', start: 2, duration: 2 }]),
  ];
  const cuts = collectClipCuts(tracks);

  it('returns null outside the radius', () => {
    expect(findClipCutNear(cuts, 1.0, 0.1)).toBeNull();
  });

  it('finds the cut inside the radius', () => {
    expect(findClipCutNear(cuts, 2.04, 0.1)).not.toBeNull();
  });

  it('pairs every coincident out with every coincident in', () => {
    // Stated so the ranking below is read against what it is actually ranking:
    // four bars meeting on one frame produce four pairs, only two of which are
    // the edits a person sees.
    expect(cuts).toHaveLength(4);
  });

  it('prefers the cut on the row the pointer is over, then the nearest rows', () => {
    // Without this the roll would be applied to whichever coincident pair
    // happened to be built first — an edit somewhere else on screen. Row `d`
    // appears in two pairs (a→d and c→d); the one whose other half is next to
    // it wins.
    expect(findClipCutNear(cuts, 2, 0.1, 'd')).toMatchObject({ leftTrackId: 'c', rightTrackId: 'd' });
    expect(findClipCutNear(cuts, 2, 0.1, 'a')).toMatchObject({ leftTrackId: 'a', rightTrackId: 'b' });
  });

  it('falls back to the nearest when the pointer’s row has no cut', () => {
    const spread = collectClipCuts([
      row('a', [{ id: 'la', start: 0, duration: 2 }]),
      row('b', [{ id: 'lb', start: 2, duration: 2 }]),
      row('g', [{ id: 'lg', start: 0, duration: 2.5 }]),
      row('h', [{ id: 'lh', start: 2.5, duration: 2 }]),
    ]);
    expect(findClipCutNear(spread, 2.4, 1, 'zzz')).toMatchObject({ time: 2.5 });
  });
});
