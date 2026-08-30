/**
 * One-click tracking, on synthetic footage where the true answer is known to
 * the pixel — so "it tracked something" and "it tracked the right thing" can
 * be told apart.
 *
 * The scene is a moving corner over fixed low-amplitude texture. Everything
 * asserted here is a decision the user would otherwise have made by hand.
 */

import { mergeBidirectional, planTrack, runAutoTrack } from './autoTrack';
import type { LumaPlane } from './patchMatch';
import type { TrackSample } from './tracker';

const W = 200;
const H = 200;

/** A hard corner at (cx, cy) over a fine texture that gives the correlation
 *  surface a single sharp peak (see patchMatch.test.ts's `scene`). */
function frame(cx: number, cy: number): LumaPlane {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const quadrant = (x >= cx) === (y >= cy) ? 0.8 : 0.2;
      data[y * W + x] = quadrant + 0.04 * Math.sin(x * 1.3) * Math.cos(y * 0.7);
    }
  }
  return { data, width: W, height: H };
}

/** A frame with no structure at all. */
function flatFrame(): LumaPlane {
  return { data: new Float32Array(W * H).fill(0.5), width: W, height: H };
}

/** Corner position at frame `i` for a constant-velocity move. */
const at = (i: number, vx: number, vy = 0) => ({ x: 100 + vx * i, y: 100 + vy * i });

/** Frame readers over a constant-velocity clip, recording request order. */
function clip(vx: number, vy = 0): {
  forwardAt: (i: number) => Promise<LumaPlane>;
  backwardAt: (i: number) => Promise<LumaPlane>;
  requests: number[];
} {
  const requests: number[] = [];
  const read = async (i: number): Promise<LumaPlane> => {
    requests.push(i);
    const p = at(i, vx, vy);
    return frame(p.x, p.y);
  };
  return { forwardAt: read, backwardAt: read, requests };
}

describe('planTrack', () => {
  it('picks the corner near the hint and sizes both windows', () => {
    const plan = planTrack(frame(100, 100), [frame(103, 100)], { hint: { x: 100, y: 100 }, radius: 40 });
    expect(plan).not.toBeNull();
    expect(Math.hypot(plan!.x - 100, plan!.y - 100)).toBeLessThanOrEqual(6);
    expect(plan!.featureHalf).toBeGreaterThanOrEqual(6);
    expect(plan!.searchHalf).toBeGreaterThanOrEqual(8);
  });

  it('sizes the search window from the measured motion, not a constant', () => {
    const slow = planTrack(frame(100, 100), [frame(101, 100)], { hint: { x: 100, y: 100 }, radius: 40 })!;
    const fast = planTrack(frame(100, 100), [frame(130, 100)], { hint: { x: 100, y: 100 }, radius: 40 })!;
    expect(slow.motionPerFrame).toBeCloseTo(1, 0);
    expect(fast.motionPerFrame).toBeCloseTo(30, 0);
    // The fast clip's window must actually reach next frame's position; the
    // slow clip's must not pay for a reach it will never use.
    expect(fast.searchHalf).toBeGreaterThanOrEqual(30);
    expect(slow.searchHalf).toBeLessThan(fast.searchHalf);
  });

  it('clamps the search window rather than tracking a whole quadrant', () => {
    // 120 px/frame is beyond what a correlation window can honestly cover.
    const plan = planTrack(frame(100, 100), [frame(100, 100)], { hint: { x: 100, y: 100 }, radius: 40 })!;
    expect(plan.searchHalf).toBeLessThanOrEqual(64);
  });

  it('falls back to a default window when there is no next frame', () => {
    const plan = planTrack(frame(100, 100), [], { hint: { x: 100, y: 100 }, radius: 40 })!;
    expect(plan.motionPerFrame).toBeNull();
    expect(plan.searchHalf).toBe(20);
  });

  it('refuses a featureless frame instead of planning a doomed track', () => {
    expect(planTrack(flatFrame(), [flatFrame()], { hint: { x: 100, y: 100 } })).toBeNull();
  });

  it('believes a displacement that two frames agree on', () => {
    // 5 px/frame: the second probe sits at 10 px, exactly twice the first.
    const plan = planTrack(
      frame(100, 100),
      [frame(105, 100), frame(110, 100)],
      { hint: { x: 100, y: 100 }, radius: 40 },
    )!;
    expect(plan.motionPerFrame).toBeCloseTo(5, 0);
  });

  it('throws out a displacement the second frame contradicts', () => {
    // The one-frame probe says 5 px; the two-frame probe says 5 px as well,
    // which is what a RIVAL at a fixed offset looks like — a real feature
    // moving at 5 px/frame would be at 10 px by now. Unmeasurable, so the
    // plan must fall back rather than size a window around a phantom.
    const plan = planTrack(
      frame(100, 100),
      [frame(105, 100), frame(105, 100)],
      { hint: { x: 100, y: 100 }, radius: 40 },
    )!;
    expect(plan.motionPerFrame).toBeNull();
    expect(plan.searchHalf).toBe(20);
  });

  it('picks a companion feature far enough away to read rotation from', () => {
    // Two corners 70 px apart on a plain field: the second is the companion,
    // and the baseline between them is what carries angle and length.
    const twoCorners = (): LumaPlane => {
      const data = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const a = Math.abs(x - 70) < 20 && Math.abs(y - 100) < 20 ? ((x >= 70) === (y >= 100) ? 0.9 : 0.1) : 0.5;
          const b = Math.abs(x - 140) < 20 && Math.abs(y - 100) < 20 ? ((x >= 140) === (y >= 100) ? 0.9 : 0.1) : 0.5;
          data[y * W + x] = a !== 0.5 ? a : b;
        }
      }
      return { data, width: W, height: H };
    };
    const plan = planTrack(twoCorners(), [], { hint: { x: 70, y: 100 }, radius: 40 })!;
    expect(plan.companion).not.toBeNull();
    const baseline = Math.hypot(plan.companion!.x - plan.x, plan.companion!.y - plan.y);
    expect(baseline).toBeGreaterThan(20);
  });

  it('reports no companion when nothing else nearby is trackable', () => {
    // A quadrant corner spanning the WHOLE frame: exactly one corner, at the
    // centre, and nothing else. (Drawing the corner inside a BOX instead would
    // give the box's own four corners away for free — which is what makes a
    // lone feature surprisingly hard to synthesize, and why this frame has no
    // drawn edges at all.) The only candidate is the primary itself, and the
    // separation rule rejects it, so position-only is the honest answer.
    const data = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) data[y * W + x] = (x >= 100) === (y >= 100) ? 0.9 : 0.1;
    }
    const lone: LumaPlane = { data, width: W, height: H };
    expect(planTrack(lone, [], { hint: { x: 100, y: 100 }, radius: 30 })!.companion).toBeNull();
  });

  it('accepts a single probe when that is all the clip has left', () => {
    // One frame from the end there is no second probe, and refusing to
    // measure would mean every shot's tail got the default window.
    const plan = planTrack(frame(100, 100), [frame(104, 100)], { hint: { x: 100, y: 100 }, radius: 40 })!;
    expect(plan.motionPerFrame).toBeCloseTo(4, 0);
  });

  it('tightens the window on ambiguous, repeating texture', () => {
    // A checkerboard: strong corners everywhere, near-identical. Both clips
    // move by the same 8 px, so the ONLY thing that can separate the two
    // window sizes is the ambiguity of the feature.
    //
    // The faint non-repeating grain rides along with the shift. Without it the
    // pattern is EXACTLY periodic, every rival correlates a perfect 1.0, and
    // no probe radius can tell the true peak from a rival — a limit of
    // synthetic grids, not of footage, where grain and lighting always break
    // the tie. With it, the probe measures the real 8 px.
    const checker = (shift: number): LumaPlane => {
      const data = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cell = (Math.floor((x - shift) / 20) + Math.floor(y / 20)) % 2 === 0 ? 0.8 : 0.2;
          data[y * W + x] = cell + 0.05 * Math.sin((x - shift) * 0.11) * Math.cos(y * 0.13);
        }
      }
      return { data, width: W, height: H };
    };
    const ambiguous = planTrack(checker(0), [checker(8)], { hint: { x: 100, y: 100 }, radius: 40 })!;
    const distinct = planTrack(frame(100, 100), [frame(108, 100)], { hint: { x: 100, y: 100 }, radius: 40 })!;
    expect(ambiguous.feature.distinctness).toBeLessThan(0.5);
    expect(distinct.feature.distinctness).toBeGreaterThan(0.5);
    // Both measured the same motion, so the tighter window is the ambiguity
    // response and nothing else.
    expect(ambiguous.motionPerFrame).toBeCloseTo(distinct.motionPerFrame!, 0);
    expect(ambiguous.searchHalf).toBeLessThan(distinct.searchHalf);
  });
});

describe('mergeBidirectional', () => {
  const s = (frameIndex: number): TrackSample =>
    ({ frame: frameIndex, x: frameIndex, y: 0, confidence: 1, coasted: false });

  it('produces one ascending list with the shared anchor appearing once', () => {
    // Both walks start AT the anchor and emit it first.
    const merged = mergeBidirectional([s(10), s(9), s(8)], [s(10), s(11), s(12)]);
    expect(merged.map((m) => m.frame)).toEqual([8, 9, 10, 11, 12]);
  });

  it('keeps the backward walk’s anchor when both directions have one', () => {
    const backwardAnchor = { ...s(10), confidence: 0.5 };
    const merged = mergeBidirectional([backwardAnchor, s(9)], [s(10), s(11)]);
    expect(merged.find((m) => m.frame === 10)!.confidence).toBe(0.5);
  });

  it('handles one-sided walks', () => {
    expect(mergeBidirectional([], [s(4), s(5)]).map((m) => m.frame)).toEqual([4, 5]);
    expect(mergeBidirectional([s(5), s(4)], []).map((m) => m.frame)).toEqual([4, 5]);
    expect(mergeBidirectional([], [])).toEqual([]);
  });
});

describe('runAutoTrack', () => {
  it('tracks both ways from the playhead and follows the real motion', async () => {
    const { forwardAt, backwardAt } = clip(2);
    const out = await runAutoTrack({
      anchorFrame: 10,
      firstFrame: 0,
      lastFrame: 20,
      anchorPlane: frame(at(10, 2).x, at(10, 2).y),
      probePlanes: [frame(at(11, 2).x, at(11, 2).y), frame(at(12, 2).x, at(12, 2).y)],
      hint: { x: 120, y: 100 },
      radius: 40,
      forwardAt,
      backwardAt,
    });
    expect(out).not.toBeNull();
    expect(out!.status).toBe('completed');
    expect(out!.tracks[0]!.map((s) => s.frame)).toEqual([...Array(21).keys()]);

    // The corner moves 2 px/frame; the track must move with it, in both
    // directions, and the anchor must land on the feature the plan chose.
    const first = out!.tracks[0]![0]!;
    const last = out!.tracks[0]![out!.tracks[0]!.length - 1]!;
    expect(last.x - first.x).toBeCloseTo(40, 0);
    expect(out!.tracks[0]!.every((s) => !s.coasted)).toBe(true);
  });

  it('tracks forward only when no backward reader is supplied', async () => {
    const { forwardAt } = clip(2);
    const out = await runAutoTrack({
      anchorFrame: 10,
      firstFrame: 0,
      lastFrame: 14,
      anchorPlane: frame(at(10, 2).x, at(10, 2).y),
      probePlanes: [frame(at(11, 2).x, at(11, 2).y), frame(at(12, 2).x, at(12, 2).y)],
      hint: { x: 120, y: 100 },
      radius: 40,
      forwardAt,
    });
    expect(out!.tracks[0]!.map((s) => s.frame)).toEqual([10, 11, 12, 13, 14]);
  });

  it('asks the backward reader for strictly descending frames', async () => {
    // The reverse walk's contract is non-increasing requests; violating it
    // silently re-decodes GOPs and turns an O(n) walk into O(n²).
    const seen: number[] = [];
    const { forwardAt } = clip(2);
    await runAutoTrack({
      anchorFrame: 10,
      firstFrame: 0,
      lastFrame: 12,
      anchorPlane: frame(at(10, 2).x, at(10, 2).y),
      probePlanes: [frame(at(11, 2).x, at(11, 2).y), frame(at(12, 2).x, at(12, 2).y)],
      hint: { x: 120, y: 100 },
      radius: 40,
      forwardAt,
      backwardAt: async (i) => {
        seen.push(i);
        return frame(at(i, 2).x, at(i, 2).y);
      },
    });
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeLessThanOrEqual(seen[i - 1]!);
  });

  it('reports one progress axis across both walks, ending at 1', async () => {
    const seen: number[] = [];
    const { forwardAt, backwardAt } = clip(2);
    await runAutoTrack({
      anchorFrame: 10,
      firstFrame: 5,
      lastFrame: 15,
      anchorPlane: frame(at(10, 2).x, at(10, 2).y),
      probePlanes: [frame(at(11, 2).x, at(11, 2).y), frame(at(12, 2).x, at(12, 2).y)],
      hint: { x: 120, y: 100 },
      radius: 40,
      forwardAt,
      backwardAt,
      onProgress: (f) => {
        seen.push(f);
      },
    });
    expect(seen[0]).toBeLessThan(0.5);
    expect(seen[seen.length - 1]).toBeCloseTo(1, 5);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it('cancels mid-walk and keeps what it measured', async () => {
    const { forwardAt, backwardAt } = clip(2);
    const out = await runAutoTrack({
      anchorFrame: 10,
      firstFrame: 0,
      lastFrame: 20,
      anchorPlane: frame(at(10, 2).x, at(10, 2).y),
      probePlanes: [frame(at(11, 2).x, at(11, 2).y), frame(at(12, 2).x, at(12, 2).y)],
      hint: { x: 120, y: 100 },
      radius: 40,
      forwardAt,
      backwardAt,
      onProgress: (f) => f < 0.2,
    });
    expect(out!.status).toBe('cancelled');
    expect(out!.tracks[0]!.length).toBeGreaterThan(0);
    expect(out!.tracks[0]!.length).toBeLessThan(21);
  });

  it('returns null — not an exception — when nothing is trackable', async () => {
    const out = await runAutoTrack({
      anchorFrame: 0,
      firstFrame: 0,
      lastFrame: 10,
      anchorPlane: flatFrame(),
      probePlanes: [flatFrame(), flatFrame()],
      forwardAt: async () => flatFrame(),
    });
    expect(out).toBeNull();
  });

  it('still returns the anchor sample on a single-frame range', async () => {
    const out = await runAutoTrack({
      anchorFrame: 7,
      firstFrame: 7,
      lastFrame: 7,
      anchorPlane: frame(100, 100),
      probePlanes: [],
      hint: { x: 100, y: 100 },
      radius: 40,
      forwardAt: async () => frame(100, 100),
    });
    expect(out!.tracks[0]!).toHaveLength(1);
    expect(out!.tracks[0]![0]!.frame).toBe(7);
  });
});
