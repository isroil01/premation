import {
  snapKeyframeTime,
  snapKeyframeGroup,
  DEFAULT_SNAP_THRESHOLD_PX,
  type SnapOptions,
} from './keyframeSnap';

/** 100 px/s at 30fps — 8px threshold ≈ 0.08s. */
const base: SnapOptions = { pixelsPerSecond: 100, frameDuration: 1 / 30 };

describe('snapKeyframeTime — priority', () => {
  it('snaps to the playhead when in range', () => {
    const r = snapKeyframeTime(2.03, { ...base, playheadTime: 2 });
    expect(r.time).toBe(2);
    expect(r.target).toEqual({ time: 2, kind: 'playhead' });
  });

  it('prefers the playhead even when a keyframe is CLOSER', () => {
    // The playhead was parked deliberately; a neighbouring keyframe was not.
    const r = snapKeyframeTime(2.05, { ...base, playheadTime: 2, keyframeTimes: [2.045] });
    expect(r.target!.kind).toBe('playhead');
    expect(r.time).toBe(2);
  });

  it('snaps to another keyframe when no playhead is in range', () => {
    const r = snapKeyframeTime(3.02, { ...base, playheadTime: 9, keyframeTimes: [3] });
    expect(r.time).toBe(3);
    expect(r.target!.kind).toBe('keyframe');
  });

  it('takes the NEAREST keyframe among several', () => {
    const r = snapKeyframeTime(3.0, { ...base, keyframeTimes: [3.06, 3.01, 2.95] });
    expect(r.time).toBeCloseTo(3.01, 6);
  });

  it('falls back to the frame grid when nothing is in range', () => {
    const r = snapKeyframeTime(1.017, { ...base, playheadTime: 9, keyframeTimes: [5] });
    expect(r.target!.kind).toBe('frame');
    // 1.017s at 30fps → frame 30.51 → 31 → 1.0333s
    expect(r.time).toBeCloseTo(31 / 30, 6);
  });

  it('does not snap to targets outside the threshold', () => {
    const r = snapKeyframeTime(2.5, { ...base, playheadTime: 2, keyframeTimes: [3] });
    expect(r.target!.kind).toBe('frame');
  });
});

describe('snapKeyframeTime — the threshold is in pixels, so zoom-independent', () => {
  it('a target 0.05s away snaps when zoomed in', () => {
    // 400 px/s → 0.05s is 20px away... beyond an 8px threshold.
    expect(snapKeyframeTime(2.05, { ...base, pixelsPerSecond: 400, playheadTime: 2 }).target!.kind).toBe('frame');
  });

  it('the same target snaps when zoomed out', () => {
    // 40 px/s → 0.05s is 2px away, comfortably inside.
    expect(snapKeyframeTime(2.05, { ...base, pixelsPerSecond: 40, playheadTime: 2 }).target!.kind).toBe('playhead');
  });

  it('a degenerate zoom cannot make everything snap', () => {
    const r = snapKeyframeTime(5, { ...base, pixelsPerSecond: 0, playheadTime: 2 });
    expect(r.target!.kind).toBe('frame');
  });

  it('honours a custom threshold', () => {
    const far = { ...base, playheadTime: 2, thresholdPx: DEFAULT_SNAP_THRESHOLD_PX };
    expect(snapKeyframeTime(2.09, far).target!.kind).toBe('frame');
    expect(snapKeyframeTime(2.09, { ...far, thresholdPx: 40 }).target!.kind).toBe('playhead');
  });
});

describe('snapKeyframeTime — disabled (Alt)', () => {
  it('returns the raw time, not even frame-quantized', () => {
    const r = snapKeyframeTime(1.2345, { ...base, playheadTime: 1.23, disabled: true });
    expect(r.time).toBe(1.2345);
    expect(r.target).toBeNull();
  });
});

describe('snapKeyframeGroup — the group moves as one body', () => {
  it('applies ONE offset so spacing is preserved', () => {
    // Two keys 0.5s apart; the first is near the playhead.
    const { delta, target } = snapKeyframeGroup([2.03, 2.53], { ...base, playheadTime: 2 });
    expect(target!.kind).toBe('playhead');
    expect(delta).toBeCloseTo(-0.03, 6);
    // Applying the delta keeps them 0.5s apart — they do not collapse together.
    const moved = [2.03 + delta, 2.53 + delta];
    expect(moved[1]! - moved[0]!).toBeCloseTo(0.5, 6);
    expect(moved[0]!).toBeCloseTo(2, 6);
  });

  it('lets a LATER member be the one that snaps', () => {
    const { delta, target } = snapKeyframeGroup([1.0, 2.04], { ...base, playheadTime: 2 });
    expect(target!.kind).toBe('playhead');
    expect(1.0 + delta).toBeCloseTo(0.96, 6);
    expect(2.04 + delta).toBeCloseTo(2, 6);
  });

  it('prefers a playhead hit on any member over a keyframe hit on another', () => {
    const { target } = snapKeyframeGroup([1.02, 2.04], { ...base, playheadTime: 2, keyframeTimes: [1] });
    expect(target!.kind).toBe('playhead');
  });

  it('picks the closest member within the same kind', () => {
    const { delta } = snapKeyframeGroup([1.06, 3.01], { ...base, keyframeTimes: [1, 3] });
    // 3.01 → 3 is a 0.01 move; 1.06 → 1 is 0.06. The nearer one wins.
    expect(delta).toBeCloseTo(-0.01, 6);
  });

  it('is a no-op for an empty selection', () => {
    expect(snapKeyframeGroup([], base)).toEqual({ delta: 0, target: null });
  });

  it('still frame-quantizes when nothing is in range', () => {
    const { delta, target } = snapKeyframeGroup([1.017], { ...base, playheadTime: 9 });
    expect(target!.kind).toBe('frame');
    expect(1.017 + delta).toBeCloseTo(31 / 30, 6);
  });
});
