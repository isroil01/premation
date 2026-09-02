import {
  collectClipSnapTargets,
  snapClipTime,
  snapClipEdges,
  DEFAULT_CLIP_SNAP_THRESHOLD_PX,
  type ClipSnapOptions,
  type ClipSnapTarget,
} from './clipSnap';
import type { TimelineTrack } from './TimelineModel';

/** 100 px/s at 30 fps — the default 8px radius is 0.08s wide. */
const base: ClipSnapOptions = { pixelsPerSecond: 100, frameDuration: 1 / 30 };

const track = (id: string, clips: Array<{ id: string; start: number; duration: number }>): TimelineTrack =>
  ({
    id,
    name: id,
    clips: clips.map((c) => ({ ...c, trackId: id, nodeId: id })),
  }) as unknown as TimelineTrack;

describe('collectClipSnapTargets', () => {
  it('collects both edges of every clip on every track', () => {
    const targets = collectClipSnapTargets({
      tracks: [
        track('a', [{ id: 'c1', start: 1, duration: 2 }]),
        track('b', [{ id: 'c2', start: 5, duration: 1 }]),
      ],
    });
    const times = targets.filter((t) => t.kind === 'clip').map((t) => t.time).sort((x, y) => x - y);
    expect(times).toEqual([1, 3, 5, 6]);
  });

  it('EXCLUDES the dragged clip — a bar must not snap to itself', () => {
    const targets = collectClipSnapTargets({
      tracks: [track('a', [{ id: 'dragged', start: 1, duration: 2 }, { id: 'other', start: 5, duration: 1 }])],
      excludeClipIds: ['dragged'],
    });
    const times = targets.filter((t) => t.kind === 'clip').map((t) => t.time).sort((x, y) => x - y);
    expect(times).toEqual([5, 6]);
  });

  it('accepts a Set of excluded ids too', () => {
    const targets = collectClipSnapTargets({
      tracks: [track('a', [{ id: 'x', start: 4, duration: 1 }])],
      excludeClipIds: new Set(['x']),
    });
    expect(targets.some((t) => t.kind === 'clip')).toBe(false);
  });

  it('includes the playhead, comp/layer markers, work area and comp bounds', () => {
    const t = track('a', []);
    const withMarkers: TimelineTrack = { ...t, markers: [{ id: 'lm', time: 7, label: 'L' }] };
    const targets = collectClipSnapTargets({
      tracks: [withMarkers],
      playheadTime: 2.5,
      markers: [{ id: 'cm', time: 4, label: 'C' }],
      workArea: { start: 1, end: 8 },
      compDuration: 10,
    });
    const find = (time: number): ClipSnapTarget | undefined => targets.find((x) => x.time === time);
    expect(find(2.5)?.kind).toBe('playhead');
    expect(find(4)?.kind).toBe('marker');
    expect(find(7)?.kind).toBe('marker');
    expect(find(1)?.kind).toBe('workArea');
    expect(find(8)?.kind).toBe('workArea');
    expect(find(0)?.kind).toBe('comp');
    expect(find(10)?.kind).toBe('comp');
  });

  it('collapses duplicate times into one target, keeping the strongest kind', () => {
    const targets = collectClipSnapTargets({
      tracks: [
        track('a', [{ id: 'c1', start: 2, duration: 1 }]),
        track('b', [{ id: 'c2', start: 2, duration: 3 }]),
      ],
      playheadTime: 2,
    });
    const at2 = targets.filter((t) => t.time === 2);
    expect(at2).toHaveLength(1);
    expect(at2[0]!.kind).toBe('playhead');
  });

  it('always offers comp start, and comp end only when a duration is given', () => {
    const none = collectClipSnapTargets({ tracks: [] });
    expect(none.map((t) => t.time)).toEqual([0]);
    const zero = collectClipSnapTargets({ tracks: [], compDuration: 0 });
    expect(zero.map((t) => t.time)).toEqual([0]);
  });
});

describe('snapClipTime', () => {
  const targets: ClipSnapTarget[] = [
    { time: 2, kind: 'clip' },
    { time: 5, kind: 'playhead' },
  ];

  it('snaps to a target inside the radius', () => {
    const r = snapClipTime(2.05, targets, base);
    expect(r.time).toBe(2);
    expect(r.target).toEqual({ time: 2, kind: 'clip' });
  });

  it('respects the radius — outside it, the frame grid does the work', () => {
    // 0.09s away at 100px/s = 9px > the 8px radius.
    const r = snapClipTime(2.09, targets, base);
    expect(r.target!.kind).toBe('frame');
    expect(r.time).toBeCloseTo(Math.round(2.09 * 30) / 30, 10);
  });

  it('measures the radius in PIXELS, so it scales with zoom', () => {
    const far = 0.5;
    // At 10px/s, 0.5s is only 5px away — inside the radius.
    expect(snapClipTime(2 + far, targets, { ...base, pixelsPerSecond: 10 }).target!.kind).toBe('clip');
    // At 100px/s the same distance is 50px — well outside it.
    expect(snapClipTime(2 + far, targets, base).target!.kind).toBe('frame');
  });

  it('honours an explicit thresholdPx', () => {
    expect(snapClipTime(2.15, targets, base).target!.kind).toBe('frame');
    expect(snapClipTime(2.15, targets, { ...base, thresholdPx: 20 }).target!.kind).toBe('clip');
    expect(DEFAULT_CLIP_SNAP_THRESHOLD_PX).toBe(8);
  });

  it('picks the NEAREST target regardless of kind', () => {
    const mixed: ClipSnapTarget[] = [
      { time: 4.99, kind: 'playhead' },
      { time: 5.02, kind: 'clip' },
    ];
    // The clip edge is 0.02 away, the playhead 0.03 — nearest wins, unlike the
    // keyframe snapper where the playhead always outranks.
    const r = snapClipTime(5.04, mixed, base);
    expect(r.target).toEqual({ time: 5.02, kind: 'clip' });
  });

  it('breaks an exact tie by kind rank, so the guide line does not flicker', () => {
    const tied: ClipSnapTarget[] = [
      { time: 3.02, kind: 'marker' },
      { time: 2.98, kind: 'playhead' },
    ];
    expect(snapClipTime(3, tied, base).target!.kind).toBe('playhead');
    // …and the same answer whichever order they arrive in.
    expect(snapClipTime(3, [...tied].reverse(), base).target!.kind).toBe('playhead');
  });

  it('does nothing at all when disabled (Alt) — not even the frame grid', () => {
    const r = snapClipTime(2.017, targets, { ...base, disabled: true });
    expect(r.time).toBe(2.017);
    expect(r.target).toBeNull();
  });

  it('does not treat every time as in range when the zoom is zero', () => {
    const r = snapClipTime(2.5, targets, { ...base, pixelsPerSecond: 0 });
    expect(r.target!.kind).toBe('frame');
  });

  it('leaves the time alone when there is no frame grid either', () => {
    const r = snapClipTime(2.5, targets, { ...base, frameDuration: 0 });
    expect(r).toEqual({ time: 2.5, target: null });
  });
});

describe('snapClipEdges', () => {
  const targets: ClipSnapTarget[] = [
    { time: 2, kind: 'clip' },
    { time: 6, kind: 'playhead' },
  ];

  it('considers BOTH edges of a moved bar and moves it as one body', () => {
    // Bar [4, 6.03): the head is nowhere near a target, the TAIL is 0.03 from
    // the playhead. The whole bar shifts by -0.03; its duration is untouched.
    const { delta, target } = snapClipEdges([4, 6.03], targets, base);
    expect(delta).toBeCloseTo(-0.03, 10);
    expect(target).toEqual({ time: 6, kind: 'playhead' });
  });

  it('snaps the head when the head is the nearer edge', () => {
    const { delta, target } = snapClipEdges([2.02, 8.5], targets, base);
    expect(delta).toBeCloseTo(-0.02, 10);
    expect(target!.time).toBe(2);
  });

  it('picks the nearer of two in-range edges', () => {
    // Head 0.05 from the clip edge, tail 0.01 from the playhead.
    const { delta, target } = snapClipEdges([2.05, 6.01], targets, base);
    expect(delta).toBeCloseTo(-0.01, 10);
    expect(target!.kind).toBe('playhead');
  });

  it('never lets the frame grid outrank a real target', () => {
    // The head sits exactly on a frame boundary (grid distance 0); the tail is
    // 0.02s from the playhead. The playhead must still win.
    const { target } = snapClipEdges([4, 6.02], targets, base);
    expect(target!.kind).toBe('playhead');
  });

  it('falls back to the frame grid when nothing is in range', () => {
    const { delta, target } = snapClipEdges([4.017], targets, base);
    expect(target!.kind).toBe('frame');
    expect(4.017 + delta).toBeCloseTo(Math.round(4.017 * 30) / 30, 10);
  });

  it('takes a single edge for a trim', () => {
    const { delta, target } = snapClipEdges([1.98], targets, base);
    expect(delta).toBeCloseTo(0.02, 10);
    expect(target!.time).toBe(2);
  });

  it('is a no-op when disabled', () => {
    expect(snapClipEdges([2.01, 6.01], targets, { ...base, disabled: true })).toEqual({
      delta: 0,
      target: null,
    });
  });

  it('is a no-op for an empty edge list', () => {
    expect(snapClipEdges([], targets, base)).toEqual({ delta: 0, target: null });
  });
});

describe('end-to-end: collect then snap', () => {
  it('butts a dragged bar against its neighbour on another track', () => {
    const tracks = [
      track('a', [{ id: 'dragged', start: 3.04, duration: 2 }]),
      track('b', [{ id: 'neighbour', start: 1, duration: 2 }]),
    ];
    const targets = collectClipSnapTargets({
      tracks,
      excludeClipIds: ['dragged'],
      playheadTime: 9,
      compDuration: 10,
    });
    const { delta, target } = snapClipEdges([3.04, 5.04], targets, base);
    // Neighbour ends at 3 — the head lands on it exactly.
    expect(3.04 + delta).toBeCloseTo(3, 10);
    expect(target).toEqual({ time: 3, kind: 'clip' });
  });

  it('cannot be pinned by its own edges', () => {
    const tracks = [track('a', [{ id: 'dragged', start: 3, duration: 2 }])];
    const targets = collectClipSnapTargets({ tracks, excludeClipIds: ['dragged'] });
    // Dragged 0.01s to the right of where it started; without the exclusion the
    // bar's own start would drag it straight back.
    const { target } = snapClipEdges([3.01, 5.01], targets, base);
    expect(target!.kind).toBe('frame');
  });
});
