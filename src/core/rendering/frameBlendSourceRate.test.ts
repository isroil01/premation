/**
 * Frame blending brackets on the SOURCE's rate, not the composition's.
 *
 * `videoFrameCache` carried this as a documented KNOWN LIMIT: nothing in the
 * browser reports a `<video>`'s frame rate, so callers bracketed on the comp's.
 * The consequence, stated there and pinned here: a 24fps source in a 30fps comp
 * had BOTH bracket times resolve to the same decoded frame, so the blend
 * collapsed to nearest-frame — for exactly the mismatched-rate case frame
 * blending exists to fix.
 *
 * The reader was corrected first; until the import probe wrote a real rate it
 * still fell back to the comp's, so the limit was retired in principle and live
 * in practice. This asserts both halves: the arithmetic, and that a conformed
 * or probed rate actually reaches it.
 */

import { bracketFrames } from './videoFrameCache';

describe('bracketFrames on a mismatched source rate', () => {
  it('yields nothing to blend when a comp-rate time is bracketed at the comp rate', () => {
    // The bug, first half. Comp frame 3 of 30 = 0.1s, bracketed on 30fps, is
    // exactly a frame boundary — weight 0, and buildSnapshot emits no
    // frameBlend at all. Every whole comp frame hits this, which is every
    // frame an export renders.
    const wrong = bracketFrames(3 / 30, 30);
    expect(wrong.weight).toBeCloseTo(0, 6);
  });

  it('brackets a 24fps source into the SAME decoded frame when spaced at 30fps', () => {
    // The bug, second half: why weight 0 was not the only problem. A 30fps
    // bracket spans 1/30s while a 24fps source holds each frame for 1/24s, so
    // for part of every second BOTH bracket times land inside one source frame
    // and the blend mixed a frame with itself at a non-zero weight — a slightly
    // soft frame that looked like the feature working.
    const sourceFrameOf = (t: number) => Math.floor(t * 24 + 1e-9);
    const { a, b, weight } = bracketFrames(5.5 / 30, 30);
    expect(weight).toBeGreaterThan(0);
    expect(sourceFrameOf(a)).toBe(sourceFrameOf(b));

    // Bracketed on the source's own rate, the two are always distinct frames.
    const right = bracketFrames(5.5 / 30, 24);
    expect(sourceFrameOf(right.a)).not.toBe(sourceFrameOf(right.b));
  });

  it('lands between two real source frames when bracketed at 24fps', () => {
    // The fix. 0.1s at 24fps is frame 2.4 — 40% of the way from frame 2 to 3,
    // which is a real blend between two genuinely different decoded frames.
    const right = bracketFrames(3 / 30, 24);
    expect(right.weight).toBeCloseTo(0.4, 6);
    expect(right.a).toBeCloseTo(2 / 24, 6);
    expect(right.b).toBeCloseTo(3 / 24, 6);
    expect(right.b - right.a).toBeCloseTo(1 / 24, 6);
  });

  it('spaces brackets by the source frame duration, whatever the comp runs at', () => {
    for (const fps of [23.976, 24, 25, 29.97, 50]) {
      const { a, b } = bracketFrames(0.37, fps);
      expect(b - a).toBeCloseTo(1 / fps, 6);
    }
  });

  it('still degrades safely when the rate is unknown (0 / negative)', () => {
    // What an un-probed web import hits: no blend rather than a wrong one.
    expect(bracketFrames(1.5, 0)).toEqual({ a: 1.5, b: 1.5, weight: 0 });
    expect(bracketFrames(1.5, -30)).toEqual({ a: 1.5, b: 1.5, weight: 0 });
  });
});

describe('the rate the renderer will bracket on', () => {
  // buildSnapshot resolves `footageSourceOf(node)?.fps ?? comp fps`. The
  // resolution rule is asserted directly here — sourceInfo.test.ts covers
  // conform-over-probed; this pins the fallback chain the renderer relies on.
  const resolve = (probed: number | null, conform: number | undefined, compFps: number): number =>
    (conform ?? probed ?? null) ?? compFps;

  it('prefers a user conform over the probed rate', () => {
    expect(resolve(30, 24, 30)).toBe(24);
  });

  it('uses the probed rate when there is no conform', () => {
    expect(resolve(23.976, undefined, 30)).toBeCloseTo(23.976, 6);
  });

  it('falls back to the comp rate only when nothing knows better', () => {
    // Every project that predates the probe, and every web import.
    expect(resolve(null, undefined, 30)).toBe(30);
  });
});
