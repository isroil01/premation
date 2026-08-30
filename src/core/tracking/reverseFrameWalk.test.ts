/**
 * The reverse walk's contract is a performance one, so the tests measure
 * work, not just answers: how many times each frame was decoded, and how many
 * planes were alive at once. A version that returns the right frames by
 * re-decoding the GOP every step passes a correctness-only suite and is the
 * exact bug this module exists to prevent.
 */

import { chunkFramesFor, createReverseFrameWalk } from './reverseFrameWalk';
import type { LumaPlane } from './patchMatch';

/** A 1×1 plane whose single sample is the frame index — identity you can
 *  assert on without caring about pixels. */
function stamp(index: number): LumaPlane {
  return { data: new Float32Array([index]), width: 1, height: 1 };
}

/** A decoder stand-in that records every frame it was asked to produce. */
function recorder(): {
  readAscending: (lo: number, hi: number, emit: (i: number, p: LumaPlane) => void) => Promise<void>;
  decoded: number[];
  chunks: Array<[number, number]>;
} {
  const decoded: number[] = [];
  const chunks: Array<[number, number]> = [];
  return {
    decoded,
    chunks,
    async readAscending(lo, hi, emit) {
      chunks.push([lo, hi]);
      for (let i = lo; i <= hi; i++) {
        decoded.push(i);
        emit(i, stamp(i));
      }
    },
  };
}

describe('chunkFramesFor', () => {
  it('scales the chunk to the frame size, not to a fixed count', () => {
    const hd = chunkFramesFor(1920 * 1080); // ~2 MB
    const uhd = chunkFramesFor(3840 * 2160); // ~8.3 MB
    expect(hd).toBeGreaterThan(uhd);
    // The budget is a ceiling on the working set, not a target: whatever it is
    // set to, one chunk of 4K planes must fit inside it.
    expect(uhd * 3840 * 2160).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it('never drops below a useful chunk, however huge the frame', () => {
    expect(chunkFramesFor(2 * 1024 * 1024 * 1024)).toBe(4);
  });

  it('never grows without bound on tiny frames', () => {
    expect(chunkFramesFor(16)).toBe(240);
  });

  it('treats a nonsense plane size as unconstrained rather than dividing by zero', () => {
    expect(chunkFramesFor(0)).toBe(240);
  });
});

describe('createReverseFrameWalk', () => {
  it('serves frames in descending order', async () => {
    const rec = recorder();
    const walk = createReverseFrameWalk({ from: 20, to: 0, planeBytes: 4, readAscending: rec.readAscending });
    const seen: number[] = [];
    for (let i = 20; i >= 0; i--) seen.push((await walk.frameAt(i)).data[0]!);
    expect(seen).toEqual([...Array(21).keys()].reverse());
  });

  it('decodes each frame exactly once across the whole walk', async () => {
    const rec = recorder();
    // 4 frames per chunk over 20 frames = 6 chunks: the case where a naive
    // implementation re-reads from the range start every time.
    const walk = createReverseFrameWalk({
      from: 19, to: 0, planeBytes: 8, budgetBytes: 32, readAscending: rec.readAscending,
    });
    expect(walk.chunkFrames).toBe(4);
    for (let i = 19; i >= 0; i--) await walk.frameAt(i);
    expect(rec.decoded.length).toBe(20);
    expect(new Set(rec.decoded).size).toBe(20);
  });

  it('reads ascending within every chunk — the order a decoder can serve', async () => {
    const rec = recorder();
    const walk = createReverseFrameWalk({
      from: 19, to: 0, planeBytes: 8, budgetBytes: 32, readAscending: rec.readAscending,
    });
    for (let i = 19; i >= 0; i--) await walk.frameAt(i);
    for (const [lo, hi] of rec.chunks) expect(hi).toBeGreaterThanOrEqual(lo);
    // Chunks themselves march backwards, and tile the range without gaps.
    expect(rec.chunks).toEqual([[16, 19], [12, 15], [8, 11], [4, 7], [0, 3]]);
  });

  it('clamps the first chunk at the range floor instead of decoding below it', async () => {
    const rec = recorder();
    const walk = createReverseFrameWalk({
      from: 5, to: 3, planeBytes: 8, budgetBytes: 80, readAscending: rec.readAscending,
    });
    await walk.frameAt(5);
    expect(rec.chunks).toEqual([[3, 5]]);
  });

  it('holds at most one chunk of planes at a time', async () => {
    let alive = 0;
    let peak = 0;
    const walk = createReverseFrameWalk({
      from: 19,
      to: 0,
      planeBytes: 8,
      budgetBytes: 32,
      async readAscending(lo, hi, emit) {
        // Each new chunk replaces the last, so `alive` must fall back to the
        // chunk size rather than climbing to the whole range.
        alive = 0;
        for (let i = lo; i <= hi; i++) {
          emit(i, stamp(i));
          alive++;
          peak = Math.max(peak, alive);
        }
      },
    });
    for (let i = 19; i >= 0; i--) await walk.frameAt(i);
    expect(peak).toBe(walk.chunkFrames);
  });

  describe('keyframe alignment', () => {
    /** A GOP table: keyframes every `gop` frames. */
    const kf = (gop: number) => (i: number) => Math.floor(i / gop) * gop;

    it('starts a chunk ON a keyframe when one is inside the budgeted span', async () => {
      const rec = recorder();
      // Chunk 8, keyframes every 5. Unaligned, chunk 1 would be [13..20] and
      // the decoder would re-decode 13,14 to reach 15 — pure waste.
      const walk = createReverseFrameWalk({
        from: 20, to: 0, planeBytes: 8, budgetBytes: 64,
        keyframeAtOrBefore: kf(5), readAscending: rec.readAscending,
      });
      expect(walk.chunkFrames).toBe(8);
      for (let i = 20; i >= 0; i--) await walk.frameAt(i);
      // Every chunk begins exactly on a multiple of 5.
      for (const [lo] of rec.chunks) expect(lo % 5).toBe(0);
    });

    it('never exceeds the budget by aligning — snapping only shortens a chunk', async () => {
      const rec = recorder();
      const walk = createReverseFrameWalk({
        from: 40, to: 0, planeBytes: 8, budgetBytes: 64,
        keyframeAtOrBefore: kf(7), readAscending: rec.readAscending,
      });
      for (let i = 40; i >= 0; i--) await walk.frameAt(i);
      for (const [lo, hi] of rec.chunks) expect(hi - lo + 1).toBeLessThanOrEqual(walk.chunkFrames);
    });

    it('leaves the chunk alone when the keyframe is out of reach', async () => {
      const rec = recorder();
      // GOP 50 with a chunk of 8: no keyframe is ever inside the span, so the
      // budgeted boundaries must stand rather than blowing past the budget.
      const walk = createReverseFrameWalk({
        from: 20, to: 0, planeBytes: 8, budgetBytes: 64,
        keyframeAtOrBefore: kf(50), readAscending: rec.readAscending,
      });
      for (let i = 20; i >= 0; i--) await walk.frameAt(i);
      expect(rec.chunks).toEqual([[13, 20], [5, 12], [0, 4]]);
    });

    it('still decodes every frame exactly once when aligning', async () => {
      const rec = recorder();
      const walk = createReverseFrameWalk({
        from: 20, to: 0, planeBytes: 8, budgetBytes: 64,
        keyframeAtOrBefore: kf(5), readAscending: rec.readAscending,
      });
      for (let i = 20; i >= 0; i--) await walk.frameAt(i);
      expect(new Set(rec.decoded).size).toBe(21);
      expect(rec.decoded.length).toBe(21);
    });
  });

  it('rejects a request that goes back up', async () => {
    const rec = recorder();
    const walk = createReverseFrameWalk({ from: 10, to: 0, planeBytes: 4, readAscending: rec.readAscending });
    await walk.frameAt(10);
    await walk.frameAt(9);
    await expect(walk.frameAt(10)).rejects.toThrow(/non-increasing/);
  });

  it('repeats a frame without re-decoding it — stretched clips re-read', async () => {
    const rec = recorder();
    const walk = createReverseFrameWalk({ from: 10, to: 0, planeBytes: 4, readAscending: rec.readAscending });
    await walk.frameAt(8);
    const before = rec.decoded.length;
    expect((await walk.frameAt(8)).data[0]).toBe(8);
    expect(rec.decoded.length).toBe(before);
  });

  it('clamps requests outside the declared range', async () => {
    const rec = recorder();
    const walk = createReverseFrameWalk({ from: 10, to: 5, planeBytes: 4, readAscending: rec.readAscending });
    expect((await walk.frameAt(99)).data[0]).toBe(10);
    expect((await walk.frameAt(-99)).data[0]).toBe(5);
  });

  it('fails loudly when the decoder skipped a frame inside the chunk', async () => {
    const walk = createReverseFrameWalk({
      from: 10,
      to: 0,
      planeBytes: 4,
      async readAscending(lo, hi, emit) {
        for (let i = lo; i <= hi; i++) if (i !== 7) emit(i, stamp(i));
      },
    });
    await walk.frameAt(8);
    // Substituting frame 8 or 6 here would read to the tracker as "the
    // feature did not move", which is a measurement, not a gap.
    await expect(walk.frameAt(7)).rejects.toThrow(/missing/);
  });

  it('refuses a range that is not actually backwards', () => {
    expect(() =>
      createReverseFrameWalk({ from: 0, to: 5, planeBytes: 4, readAscending: recorder().readAscending }),
    ).toThrow(/must not be above/);
  });

  it('drops its cache on close and refuses further reads', async () => {
    const rec = recorder();
    const walk = createReverseFrameWalk({ from: 10, to: 0, planeBytes: 4, readAscending: rec.readAscending });
    await walk.frameAt(10);
    walk.close();
    walk.close();
    await expect(walk.frameAt(9)).rejects.toThrow(/closed/);
  });
});
