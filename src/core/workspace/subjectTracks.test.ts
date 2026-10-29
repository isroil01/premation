import { frameAt, isTracked, neighbourFixes, retrackRange, reviewSpans, type TrackFrame } from './subjectTracks';

const FPS = 10;
/** Frames 0…n−1 at 10 fps, confident unless listed in `low` (frame → confidence), fixes at `fixes`. */
function walk(n: number, low: Record<number, number> = {}, fixes: number[] = []): TrackFrame[] {
  return Array.from({ length: n }, (_, i) => ({ time: i / FPS, confidence: low[i] ?? 0.95, fix: fixes.includes(i) }));
}

describe('subject tracking lanes', () => {
  it('tells a tracked subject from one selected on a few frames', () => {
    expect(isTracked(walk(20), FPS)).toBe(true);
    expect(isTracked([{ time: 0, fix: true }, { time: 1, fix: true }, { time: 2, fix: true }], FPS)).toBe(false);
    expect(isTracked(walk(2), FPS)).toBe(false);
  });

  it('joins consecutive unsure frames into one span, with its lowest confidence', () => {
    const spans = reviewSpans(walk(20, { 4: 0.3, 5: 0.1, 6: 0.4, 12: 0.2 }), FPS);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.start).toBeCloseTo(0.4);
    expect(spans[0]!.end).toBeCloseTo(0.6);
    expect(spans[0]!.lowest).toBeCloseTo(0.1);
    expect(spans[1]!.start).toBeCloseTo(1.2);
    expect(spans[1]!.end).toBeCloseTo(1.2);
  });

  it('never flags a fix or an unmeasured frame', () => {
    const frames = walk(10, { 3: 0.1 }, [3]);
    frames[6] = { time: 0.6, fix: false };
    expect(reviewSpans(frames, FPS)).toEqual([]);
  });

  it('bounds a re-track by the fixes either side, inside the tracked span', () => {
    const frames = walk(30, {}, [0, 10, 25]);
    expect(neighbourFixes(frames, 1.5, FPS)).toEqual({ before: 1.0, after: 2.5 });
    const r = retrackRange(frames, 1.5, FPS)!;
    expect(r.start).toBeCloseTo(1.1);
    expect(r.end).toBeCloseTo(2.4);
    // From a fix itself: up to its neighbours, the fix included.
    const atFix = retrackRange(frames, 1.0, FPS)!;
    expect(atFix.start).toBeCloseTo(0.1);
    expect(atFix.end).toBeCloseTo(2.4);
    // Past the last fix: to the end of the tracked frames.
    expect(retrackRange(frames, 2.7, FPS)!.end).toBeCloseTo(2.9);
  });

  it('has nothing to re-track outside the tracked frames', () => {
    expect(retrackRange(walk(10), 3, FPS)).toBeNull();
    expect(retrackRange([], 0, FPS)).toBeNull();
  });

  it('finds the stored frame within half a frame', () => {
    const frames = walk(5);
    expect(frameAt(frames, 0.21, FPS)?.time).toBeCloseTo(0.2);
    expect(frameAt(frames, 0.9, FPS)).toBeUndefined();
  });
});
