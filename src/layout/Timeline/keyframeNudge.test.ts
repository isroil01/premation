import { createNudgeBatcher, nudgeForKey, SUBFRAME_NUDGE_DIVISIONS } from './keyframeNudge';

describe('nudgeForKey', () => {
  const f = 1 / 30;
  it('arrows step a frame, Shift ten', () => {
    expect(nudgeForKey('ArrowRight', { shift: false, alt: false }, f)).toEqual({ dt: f, dv: 0 });
    expect(nudgeForKey('ArrowLeft', { shift: true, alt: false }, f)).toEqual({ dt: -10 * f, dv: 0 });
  });

  it('Alt turns the vertical arrows into value nudges', () => {
    expect(nudgeForKey('ArrowUp', { shift: false, alt: true }, f)).toEqual({ dt: 0, dv: 1 });
    expect(nudgeForKey('ArrowDown', { shift: true, alt: true }, f)).toEqual({ dt: 0, dv: -10 });
    // Without Alt the vertical arrows belong to row navigation.
    expect(nudgeForKey('ArrowUp', { shift: false, alt: false }, f)).toBeNull();
    // Alt on a horizontal arrow is not a nudge either (it is snap-free drag elsewhere).
    expect(nudgeForKey('ArrowRight', { shift: false, alt: true }, f)).toBeNull();
    expect(nudgeForKey('a', { shift: false, alt: false }, f)).toBeNull();
  });

  it('Ctrl/Cmd steps a fraction of a frame — the sub-frame nudge', () => {
    const fine = f / SUBFRAME_NUDGE_DIVISIONS;
    expect(nudgeForKey('ArrowRight', { shift: false, alt: false, meta: true }, f))
      .toEqual({ dt: fine, dv: 0 });
    expect(nudgeForKey('ArrowLeft', { shift: false, alt: false, meta: true }, f))
      .toEqual({ dt: -fine, dv: 0 });
  });

  it('reaches a time between two frames, which the frame step cannot', () => {
    // The whole point: ten sub-frame presses land exactly on the next frame,
    // and the nine in between are times no other gesture can produce.
    const fine = nudgeForKey('ArrowRight', { shift: false, alt: false, meta: true }, f)!.dt;
    expect(fine * SUBFRAME_NUDGE_DIVISIONS).toBeCloseTo(f, 12);
    expect(fine).toBeLessThan(f);
    expect(fine).toBeGreaterThan(0);
  });

  it('reads Ctrl+Shift as fine, not as ten sub-frames', () => {
    // Ten sub-frames is one frame, which the unmodified key already does —
    // so the coarse modifier has nothing to add on top of the fine one.
    expect(nudgeForKey('ArrowRight', { shift: true, alt: false, meta: true }, f))
      .toEqual({ dt: f / SUBFRAME_NUDGE_DIVISIONS, dv: 0 });
  });

  it('leaves the VALUE step alone when Ctrl is held', () => {
    // Ctrl is the time axis's fine modifier; the value arrows keep their steps.
    expect(nudgeForKey('ArrowUp', { shift: false, alt: true, meta: true }, f))
      .toEqual({ dt: 0, dv: 1 });
    expect(nudgeForKey('ArrowUp', { shift: true, alt: true, meta: true }, f))
      .toEqual({ dt: 0, dv: 10 });
  });

  it('treats an absent meta flag as the old behaviour', () => {
    // Callers that predate the sub-frame step pass no `meta` at all.
    expect(nudgeForKey('ArrowRight', { shift: false, alt: false }, f)).toEqual({ dt: f, dv: 0 });
  });
});

describe('createNudgeBatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('applies every press but commits a burst once, with the total', () => {
    const begin = jest.fn();
    const apply = jest.fn();
    const commit = jest.fn();
    const b = createNudgeBatcher({ begin, apply, commit }, 300);
    b.push({ dt: 1, dv: 0 });
    jest.advanceTimersByTime(200);
    b.push({ dt: 1, dv: 0 });
    jest.advanceTimersByTime(200);
    const total = b.push({ dt: 0, dv: 2 });
    expect(total).toEqual({ dt: 2, dv: 2 });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(3);
    expect(commit).not.toHaveBeenCalled();
    expect(b.isOpen()).toBe(true);
    jest.advanceTimersByTime(300);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith({ dt: 2, dv: 2 });
    expect(b.isOpen()).toBe(false);
  });

  it('a pause longer than the window starts a new undo step', () => {
    const commit = jest.fn();
    const b = createNudgeBatcher({ begin: () => {}, apply: () => {}, commit }, 300);
    b.push({ dt: 1, dv: 0 });
    jest.advanceTimersByTime(301);
    b.push({ dt: 1, dv: 0 });
    jest.advanceTimersByTime(301);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('flush commits early and is a no-op when nothing is pending', () => {
    const commit = jest.fn();
    const b = createNudgeBatcher({ begin: () => {}, apply: () => {}, commit }, 300);
    b.flush();
    expect(commit).not.toHaveBeenCalled();
    b.push({ dt: 1, dv: 0 });
    b.flush();
    expect(commit).toHaveBeenCalledWith({ dt: 1, dv: 0 });
    jest.advanceTimersByTime(400);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
