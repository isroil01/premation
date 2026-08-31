/**
 * The repaint coalescer.
 *
 * The bug it exists to prevent is a RATE bug, so every test here counts
 * emissions rather than inspecting them: N landings inside one frame must cost
 * exactly one repaint, and the frame boundary has to be the only thing that
 * releases it.
 */

import { RepaintScheduler, syncFlushScheduler, rafFlushScheduler } from './repaintScheduler';

/** A hand-driven "animation frame": nothing runs until `tick()` is called. */
function fakeFrames() {
  let queued: (() => void)[] = [];
  return {
    schedule: (flush: () => void): void => { queued.push(flush); },
    tick(): void {
      const run = queued;
      queued = [];
      for (const fn of run) fn();
    },
    get depth(): number { return queued.length; },
  };
}

describe('RepaintScheduler — coalescing', () => {
  it('collapses N landings inside one frame into exactly one repaint', () => {
    const frames = fakeFrames();
    const emitted: string[] = [];
    const s = new RepaintScheduler((id) => emitted.push(id), frames.schedule);

    // A streaming pump landing its whole lookahead between two displayed frames.
    for (let i = 0; i < 25; i++) s.request('clip.mp4');

    expect(emitted).toEqual([]);      // nothing before the frame boundary
    expect(frames.depth).toBe(1);     // and only ONE flush was ever scheduled
    frames.tick();
    expect(emitted).toEqual(['clip.mp4']);
    expect(s.flushCount).toBe(1);
  });

  it('a landing in the NEXT frame produces a second repaint', () => {
    const frames = fakeFrames();
    const emitted: string[] = [];
    const s = new RepaintScheduler((id) => emitted.push(id), frames.schedule);

    s.request('clip.mp4');
    s.request('clip.mp4');
    frames.tick();
    s.request('clip.mp4');
    frames.tick();

    expect(emitted).toEqual(['clip.mp4', 'clip.mp4']);
    expect(s.flushCount).toBe(2);
  });

  it('an idle frame emits nothing', () => {
    const frames = fakeFrames();
    const emitted: string[] = [];
    const s = new RepaintScheduler((id) => emitted.push(id), frames.schedule);
    frames.tick();
    expect(emitted).toEqual([]);
    expect(s.flushCount).toBe(0);
  });

  it('keeps sources distinct — coalescing is a rate change, not an id change', () => {
    const frames = fakeFrames();
    const emitted: string[] = [];
    const s = new RepaintScheduler((id) => emitted.push(id), frames.schedule);

    s.request('a.mp4');
    s.request('b.mp4');
    s.request('a.mp4');
    frames.tick();

    // One flush, one event per distinct source — a listener can still tell
    // which media moved.
    expect(s.flushCount).toBe(1);
    expect(emitted.sort()).toEqual(['a.mp4', 'b.mp4']);
  });

  it('work marked dirty BY a listener belongs to the next frame, not this one', () => {
    const frames = fakeFrames();
    const emitted: string[] = [];
    let reentered = false;
    const s: RepaintScheduler = new RepaintScheduler((id) => {
      emitted.push(id);
      // A listener that re-renders can land another decode synchronously.
      if (!reentered) { reentered = true; s.request('b.mp4'); }
    }, frames.schedule);

    s.request('a.mp4');
    frames.tick();
    expect(emitted).toEqual(['a.mp4']);   // b did NOT ride along
    frames.tick();
    expect(emitted).toEqual(['a.mp4', 'b.mp4']);
  });
});

describe('RepaintScheduler — the offline scheduler', () => {
  it('emits before request() returns', () => {
    const emitted: string[] = [];
    const s = new RepaintScheduler((id) => emitted.push(id), syncFlushScheduler);
    s.request('clip.mp4');
    // No tick, no rAF, no timer: an offline render must never park work behind
    // a display callback that a hidden window may not deliver.
    expect(emitted).toEqual(['clip.mp4']);
    expect(s.pending).toBe(false);
  });

  it('swapping the scheduler flushes what the OLD one was still holding', () => {
    const frames = fakeFrames();
    const emitted: string[] = [];
    const s = new RepaintScheduler((id) => emitted.push(id), frames.schedule);
    s.request('clip.mp4');
    expect(emitted).toEqual([]);
    s.setScheduler(syncFlushScheduler);
    // Otherwise this repaint is stranded against a rAF that is about to stop.
    expect(emitted).toEqual(['clip.mp4']);
  });
});

describe('rafFlushScheduler', () => {
  it('uses requestAnimationFrame when there is one', () => {
    const orig = globalThis.requestAnimationFrame;
    const calls: (() => void)[] = [];
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame =
      (cb: () => void) => { calls.push(cb); return 1; };
    try {
      let ran = false;
      rafFlushScheduler(() => { ran = true; });
      expect(calls).toHaveLength(1);
      expect(ran).toBe(false);
      calls[0]!();
      expect(ran).toBe(true);
    } finally {
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = orig;
    }
  });

  it('falls back to a macrotask rather than dropping the flush', () => {
    const orig = globalThis.requestAnimationFrame;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
    jest.useFakeTimers();
    try {
      let ran = false;
      rafFlushScheduler(() => { ran = true; });
      expect(ran).toBe(false);
      jest.runAllTimers();
      // A repaint that never happens is a frozen viewport — worse than a late one.
      expect(ran).toBe(true);
    } finally {
      jest.useRealTimers();
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = orig;
    }
  });
});
