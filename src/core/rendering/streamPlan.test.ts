/**
 * The cache budget and the streaming lookahead, in one place.
 *
 * These were two constants in the same file that did not know about each
 * other: a 512MB per-source budget and a 25-frame lookahead. At 4K a decoded
 * RGBA frame is 3840 × 2160 × 4 = 33.2MB, so the budget held 15 frames while
 * the stream decoded 25 ahead — the stream's own lookahead evicted the frames
 * it had decoded and the renderer had not displayed yet. Guaranteed miss on
 * every 4K source, and every loop pass a full cold decode.
 *
 * The class of bug is "two numbers that must agree, written independently", so
 * the fix is a derivation and the test is an invariant that holds for every
 * frame size rather than three hand-checked cases.
 */

import {
  streamPlanFor,
  ExactVideoFrameCache,
  type ExactSourceLike,
  type LoadedExactSource,
  type SequentialReaderLike,
} from './exactVideoFrames';
import type { DecodedFrameLike } from '@core/video/exactVideoSource';
import type { DemuxedVideo } from '@core/video/mp4Demuxer';

const MB = 1024 * 1024;
const DEFAULT_BUDGET = 512 * MB;
const rgba = (w: number, h: number): number => w * h * 4;

describe('streamPlanFor — the invariant', () => {
  it('never lets the lookahead outrun the capacity, at any frame size', () => {
    // Every mode anyone might drop on a timeline, plus the absurd ends.
    const sizes: [number, number][] = [
      [64, 64], [320, 240], [640, 360], [960, 540], [1280, 720],
      [1920, 1080], [2048, 858], [2560, 1440], [3840, 2160], [4096, 2160],
      [6144, 3456], [7680, 4320], [15360, 8640],
    ];
    for (const [w, h] of sizes) {
      const plan = streamPlanFor(DEFAULT_BUDGET, rgba(w, h));
      // The lookahead AND the same span behind it (loop-back, frame blend, the
      // nearest-neighbour stand-in) must both be holdable.
      expect(plan.ahead * 2).toBeLessThanOrEqual(plan.capacity);
      expect(plan.capacity * plan.frameBytes).toBeLessThanOrEqual(plan.budgetBytes);
      expect(plan.ahead).toBeGreaterThanOrEqual(4);
    }
  });

  it('holds the invariant across budgets too, not just frame sizes', () => {
    for (const budget of [1, 1024, MB, 64 * MB, 512 * MB, 4096 * MB]) {
      for (const [w, h] of [[960, 540], [1920, 1080], [3840, 2160]] as [number, number][]) {
        const plan = streamPlanFor(budget, rgba(w, h));
        expect(plan.ahead * 2).toBeLessThanOrEqual(plan.capacity);
      }
    }
  });

  it('leaves 1080p and below exactly where the original constant put them', () => {
    // The flat 25 was tuned for 1080p and was right there. Self-tuning must not
    // quietly make the common case shallower.
    expect(streamPlanFor(DEFAULT_BUDGET, rgba(960, 540)).ahead).toBe(25);
    expect(streamPlanFor(DEFAULT_BUDGET, rgba(1280, 720)).ahead).toBe(25);
    expect(streamPlanFor(DEFAULT_BUDGET, rgba(1920, 1080)).ahead).toBe(25);
  });

  it('shortens the lookahead at 4K rather than evicting its own decodes', () => {
    const plan = streamPlanFor(DEFAULT_BUDGET, rgba(3840, 2160));
    expect(plan.capacity).toBe(16);
    expect(plan.ahead).toBe(8);
    // The shape the bug report was made of: a flat 25 into a cache of 16, so
    // 2 x 25 = 50 frames were wanted resident where 16 fit.
    expect(plan.ahead * 2).toBeLessThanOrEqual(plan.capacity);
  });

  it('raises the budget when one frame is a large fraction of it', () => {
    // 8K RGBA is 132MB — four frames exceed the 512MB default outright. A cache
    // that cannot hold a usable lookahead is worse than one slightly over
    // budget, so the frame-count floor wins here.
    const plan = streamPlanFor(DEFAULT_BUDGET, rgba(7680, 4320));
    expect(plan.budgetBytes).toBeGreaterThan(DEFAULT_BUDGET);
    expect(plan.capacity).toBe(8);
    expect(plan.ahead).toBe(4);
  });

  it('tolerates a nonsense frame size without producing a nonsense plan', () => {
    for (const bytes of [0, -1, 0.5, NaN]) {
      const plan = streamPlanFor(DEFAULT_BUDGET, bytes);
      expect(plan.frameBytes).toBeGreaterThanOrEqual(1);
      expect(plan.ahead * 2).toBeLessThanOrEqual(plan.capacity);
    }
  });
});

// ── The same invariant, through the real cache ──────────────────────

const FPS = 30;
const FRAMES = 600;

/** A stub source whose frames report a chosen display size, so the cache
 *  measures a real 540p / 1080p / 4K byte cost. */
function sizedSource(w: number, h: number) {
  const decoded: number[] = [];
  const source: ExactSourceLike = {
    frameIndexAt(timeUs: number): number {
      let i = 0;
      while (i + 1 < FRAMES && ((i + 1) / FPS) * 1e6 <= timeUs) i += 1;
      return i;
    },
    frameAt(presIdx: number): Promise<DecodedFrameLike> {
      decoded.push(presIdx);
      return Promise.resolve({
        timestamp: Math.round((presIdx / FPS) * 1e6),
        displayWidth: w,
        displayHeight: h,
        close: () => undefined,
      } as unknown as DecodedFrameLike);
    },
    close: () => undefined,
  };
  return { source, decoded, w, h };
}

function loaderFor(stub: { source: ExactSourceLike; w: number; h: number }) {
  return (): Promise<LoadedExactSource> =>
    Promise.resolve({
      source: stub.source,
      width: stub.w,
      height: stub.h,
      demuxed: { samples: new Array(FRAMES).fill(0) } as unknown as DemuxedVideo,
      lastPresIndex: FRAMES - 1,
    });
}

/** A reader that hands back frames of the right size, in order. */
function readerFactory(stub: { w: number; h: number; decoded: number[] }) {
  return (_d: DemuxedVideo, _from: number, _to: number): SequentialReaderLike => ({
    frameAt(presIdx: number): Promise<DecodedFrameLike> {
      stub.decoded.push(presIdx);
      return Promise.resolve({
        timestamp: Math.round((presIdx / FPS) * 1e6),
        displayWidth: stub.w,
        displayHeight: stub.h,
        close: () => undefined,
      } as unknown as DecodedFrameLike);
    },
    close: () => undefined,
  });
}

const flush = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

describe('the cache measures its own frame size', () => {
  it.each([
    ['540p', 960, 540, 25],
    ['1080p', 1920, 1080, 25],
    ['4K', 3840, 2160, 8],
  ])('derives the plan from a real decoded %s frame', async (_name, w, h, ahead) => {
    const stub = sizedSource(w, h);
    const cache = new ExactVideoFrameCache(
      DEFAULT_BUDGET,
      loaderFor(stub),
      () => true,
      readerFactory(stub),
    );
    cache.get('a.mp4', 0);
    await flush();
    cache.get('a.mp4', 0);
    await flush();

    const plan = cache.stats('a.mp4')!.plan!;
    expect(plan.frameBytes).toBe(rgba(w, h));
    expect(plan.ahead).toBe(ahead);
    expect(plan.ahead * 2).toBeLessThanOrEqual(plan.capacity);
  });
});

describe('a stream never evicts what it has decoded and not yet displayed', () => {
  /*
    These walk 120 displayed frames for real, settling the pump twice per frame
    — ~240 macrotasks, ~3s each on an idle machine. That length is the POINT:
    the bug only appears once the walk has passed more frames than the cache can
    hold, so a shorter walk would pass under the very code it exists to catch.

    Against jest's 5s default that left about 1.6x of headroom, which the full
    suite (12 projects in parallel) eats — the failure then reads as a
    correctness regression in the eviction rule rather than as a busy machine.
  */
  jest.setTimeout(30_000);

  it('4K: decoding forward past the capacity keeps the target resident', async () => {
    const stub = sizedSource(3840, 2160);
    const cache = new ExactVideoFrameCache(
      DEFAULT_BUDGET,
      loaderFor(stub),
      () => true,
      readerFactory(stub),
    );

    cache.get('a.mp4', 0);
    await flush();

    // Play forward through far more frames than the 15-frame 4K capacity. The
    // pump is decoding ahead the whole time, so every displayed frame is a
    // chance for the lookahead to evict the playhead's own frame.
    const misses: number[] = [];
    for (let f = 0; f < 120; f++) {
      const r = cache.get('a.mp4', f / FPS);
      if (r.state !== 'frame' || !r.exact) misses.push(f);
      await flush();
      await flush();
    }

    // Warm-up misses at the head are expected — the stream has to start. What
    // must NOT happen is misses continuing once it is running, which is the
    // signature of a lookahead evicting its own decodes.
    const lateMisses = misses.filter((f) => f > 20);
    expect(lateMisses).toEqual([]);
  });

  it('stays inside its own budget while doing it', async () => {
    // The protection above is what stops the lookahead evicting the playhead.
    // On its own it would "work" by holding whatever the lookahead asked for —
    // at a flat 25-frame lookahead that is 25 x 31.6 MiB of protected frames,
    // 790 MiB against a 512 MiB budget. The derived depth is what keeps the
    // protected window inside the cache instead of blowing past it.
    const stub = sizedSource(3840, 2160);
    const cache = new ExactVideoFrameCache(
      DEFAULT_BUDGET,
      loaderFor(stub),
      () => true,
      readerFactory(stub),
    );
    cache.get('a.mp4', 0);
    await flush();
    let peak = 0;
    for (let f = 0; f < 120; f++) {
      cache.get('a.mp4', f / FPS);
      await flush();
      await flush();
      peak = Math.max(peak, cache.stats('a.mp4')!.bytes);
    }
    const plan = cache.stats('a.mp4')!.plan!;
    expect(peak).toBeLessThanOrEqual(plan.budgetBytes);
    expect(plan.budgetBytes).toBe(DEFAULT_BUDGET);
  });

  it('decodes each frame ONCE across a forward pass', async () => {
    const stub = sizedSource(3840, 2160);
    const cache = new ExactVideoFrameCache(
      DEFAULT_BUDGET,
      loaderFor(stub),
      () => true,
      readerFactory(stub),
    );
    cache.get('a.mp4', 0);
    await flush();
    for (let f = 0; f < 60; f++) {
      cache.get('a.mp4', f / FPS);
      await flush();
      await flush();
    }
    // Re-decoding a frame the cache was told to hold is the whole bug.
    const counts = new Map<number, number>();
    for (const i of stub.decoded) counts.set(i, (counts.get(i) ?? 0) + 1);
    const repeated = [...counts].filter(([, n]) => n > 1);
    expect(repeated).toEqual([]);
  });
});
