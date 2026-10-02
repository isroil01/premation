/**
 * The idle pump's span.
 *
 * Every case here is one the pump cannot report on its own: it fills frames
 * silently, behind a mask, on an idle editor. A wrong span shows up as "the
 * green bar stops one frame short" or "the loop still stutters at the top",
 * both of which are easy to live with and impossible to diagnose.
 */

import { idleCacheSpan, nextSpanFrame } from './idleCacheSpan';

const base = {
  playhead: 0,
  lastCompFrame: 299, // 10s at 30fps
  fps: 30,
  workArea: null,
  wholeSpan: true,
  aheadSeconds: 5,
};

describe('idleCacheSpan — the work area', () => {
  it('fills exactly the work area', () => {
    const span = idleCacheSpan({ ...base, workArea: { start: 2, end: 5 } });
    expect(span).toMatchObject({ start: 60, end: 149, length: 90 });
  });

  it('stops one frame short of the exclusive end', () => {
    // `getWorkArea().end` is start + duration. Caching frame 150 would cache a
    // frame from outside the work area — the exporter has had this exact bug.
    expect(idleCacheSpan({ ...base, workArea: { start: 2, end: 5 } })?.end).toBe(149);
  });

  it('clamps a work area that runs past the composition', () => {
    const span = idleCacheSpan({ ...base, workArea: { start: 0, end: 999 } });
    expect(span?.end).toBe(299);
  });

  it('starts just after the playhead when the playhead is inside it', () => {
    const span = idleCacheSpan({ ...base, playhead: 90, workArea: { start: 2, end: 5 } });
    expect(span?.from).toBe(91);
  });

  it('starts at the head when the playhead is outside it', () => {
    const span = idleCacheSpan({ ...base, playhead: 10, workArea: { start: 2, end: 5 } });
    expect(span?.from).toBe(60);
  });

  it('starts at the head when the playhead is on the LAST frame of the span', () => {
    // There is nothing after it, and the head is where playback would wrap to.
    const span = idleCacheSpan({ ...base, playhead: 149, workArea: { start: 2, end: 5 } });
    expect(span?.from).toBe(60);
  });

  it('is null for an empty work area rather than a one-frame span', () => {
    expect(idleCacheSpan({ ...base, workArea: { start: 5, end: 5 } })).toBeNull();
  });
});

describe('idleCacheSpan — no work area', () => {
  it('fills the whole composition', () => {
    expect(idleCacheSpan(base)).toMatchObject({ start: 0, end: 299, length: 300 });
  });

  it('still starts after the playhead', () => {
    expect(idleCacheSpan({ ...base, playhead: 120 })?.from).toBe(121);
  });
});

describe('idleCacheSpan — the preference off', () => {
  it('falls back to a short look-ahead', () => {
    const span = idleCacheSpan({ ...base, playhead: 60, wholeSpan: false });
    expect(span).toMatchObject({ start: 61, end: 211 });
  });

  it('ignores the work area entirely', () => {
    const span = idleCacheSpan({ ...base, playhead: 0, wholeSpan: false, workArea: { start: 5, end: 9 } });
    expect(span?.start).toBe(1);
  });

  it('clamps the look-ahead to the end of the composition', () => {
    expect(idleCacheSpan({ ...base, playhead: 290, wholeSpan: false })?.end).toBe(299);
  });

  it('is null at the very last frame, where there is nothing ahead', () => {
    expect(idleCacheSpan({ ...base, playhead: 299, wholeSpan: false })).toBeNull();
  });
});

describe('idleCacheSpan — degenerate inputs', () => {
  it('is null for a composition with no frames', () => {
    expect(idleCacheSpan({ ...base, lastCompFrame: -1 })).toBeNull();
  });

  it('is null for a zero frame rate', () => {
    expect(idleCacheSpan({ ...base, fps: 0 })).toBeNull();
  });

  it('clamps a playhead outside the composition', () => {
    expect(idleCacheSpan({ ...base, playhead: 5000 })?.from).toBe(0);
  });
});

describe('nextSpanFrame', () => {
  const span = { start: 60, end: 149, from: 90, length: 90 };

  it('advances within the span', () => {
    expect(nextSpanFrame(90, span)).toBe(91);
  });

  it('wraps at the end, so the head of a loop gets cached too', () => {
    expect(nextSpanFrame(149, span)).toBe(60);
  });

  it('one lap of `length` steps returns to where it started', () => {
    let f = span.from;
    for (let i = 0; i < span.length; i++) f = nextSpanFrame(f, span);
    expect(f).toBe(span.from);
  });

  it('a lap visits every frame in the span exactly once', () => {
    const seen = new Set<number>();
    let f = span.from;
    for (let i = 0; i < span.length; i++) {
      seen.add(f);
      f = nextSpanFrame(f, span);
    }
    expect(seen.size).toBe(span.length);
    expect(Math.min(...seen)).toBe(span.start);
    expect(Math.max(...seen)).toBe(span.end);
  });
});
