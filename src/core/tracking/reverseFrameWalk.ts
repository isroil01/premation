/**
 * Walking a clip BACKWARDS without paying for it quadratically.
 *
 * Tracking forward is easy: a video decoder is a forward machine, and
 * `SequentialFrameReader` streams a range through it decoding each frame
 * exactly once. Tracking backward — which one-click tracking needs, because
 * the playhead is normally in the MIDDLE of the shot and the user means "this
 * whole clip" — has no such luck. Asking a decoder for frame N, then N-1,
 * then N-2 means seeking to the preceding keyframe and re-decoding the GOP
 * every single time: O(GOP) work per frame, O(n·GOP) per walk, which on
 * long-GOP footage is the difference between four seconds and four minutes.
 *
 * So the frames are decoded in the only order a decoder likes and consumed in
 * the order the tracker likes, one bounded CHUNK at a time:
 *
 *     decode  ──►  [ lo ................ hi ]  ──►  cached
 *     serve   ◄──  [ hi ................ lo ]  ◄──  from cache
 *
 * Each frame is decoded once per walk (plus its GOP preroll, once per chunk),
 * and the cache never holds more than one chunk. The chunk LENGTH is derived
 * from a byte budget rather than fixed, because the thing being cached is a
 * full luma plane: 2 MB at 1080p, 8.3 MB at 4K. A fixed 64-frame chunk is
 * 128 MB of comfort on HD footage and 530 MB — an out-of-memory crash — on
 * 4K. Deriving it means the same code is fast on the small case and safe on
 * the big one, which is the only version worth having.
 *
 * The module owns chunking and nothing else. Decoding is injected, so the
 * whole policy is testable without WebCodecs, a demuxer, or a file.
 */

import type { LumaPlane } from './patchMatch';

/** Fewer than this per chunk and GOP preroll dominates the walk. */
const MIN_CHUNK = 4;

/**
 * More than this and a long, small-resolution clip would buffer thousands of
 * frames for no gain — the win is already flat once preroll is amortized.
 */
const MAX_CHUNK = 240;

/**
 * Working-set ceiling for cached planes.
 *
 * 256 MB rather than something daintier because the chunk length this divides
 * into is what decides how often the walk pays GOP preroll, and preroll is the
 * entire cost here. Measured on 4K/GOP-91 footage: a 128 MB budget gives
 * 16-frame chunks and ~3.1 decodes per useful frame; 256 MB gives 31 and ~1.9.
 * The buffer is transient (one walk) and holds plain luma, nowhere near the
 * renderer's GPU or decoder pools.
 */
const DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024;

export interface ReverseFrameWalkOptions {
  /** Highest presentation index the walk will ask for (where it starts). */
  from: number;
  /** Lowest presentation index the walk will ask for. Must be ≤ `from`. */
  to: number;
  /** Bytes one cached luma plane occupies — width × height × bytesPerSample. */
  planeBytes: number;
  /**
   * Decode `[lo..hi]` ASCENDING, handing each frame's luma to `emit`. Planes
   * passed to `emit` are retained, so they must not alias a buffer the caller
   * reuses for the next frame.
   */
  readAscending: (
    lo: number,
    hi: number,
    emit: (index: number, plane: LumaPlane) => void,
  ) => Promise<void>;
  /** Working-set ceiling in bytes. Default 256 MB. */
  budgetBytes?: number;
  /**
   * Presentation index of the keyframe that `index`'s GOP starts at.
   *
   * Supplying it lets a chunk START on a keyframe whenever one is within
   * reach, which costs nothing (the chunk only gets shorter) and removes that
   * chunk's preroll entirely. Omitting it is correct, just slower.
   */
  keyframeAtOrBefore?: (index: number) => number;
}

export interface ReverseFrameWalk {
  /**
   * The luma plane for `index`. Requests must be NON-INCREASING — the mirror
   * of `SequentialFrameReader`'s non-decreasing contract, and for the same
   * reason: going back on your word means re-decoding, and a silent
   * re-decode is how an O(n) walk becomes O(n²) without anyone noticing.
   */
  frameAt: (index: number) => Promise<LumaPlane>;
  /** Drop the cache. Safe to call twice; `frameAt` throws afterwards. */
  close: () => void;
  /** Frames per chunk actually chosen — surfaced for tests and diagnostics. */
  readonly chunkFrames: number;
}

/** Frames that fit the budget, clamped to the range where chunking pays. */
export function chunkFramesFor(planeBytes: number, budgetBytes = DEFAULT_BUDGET_BYTES): number {
  if (!(planeBytes > 0)) return MAX_CHUNK;
  const fits = Math.floor(budgetBytes / planeBytes);
  return Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, fits));
}

export function createReverseFrameWalk(opts: ReverseFrameWalkOptions): ReverseFrameWalk {
  if (opts.to > opts.from) {
    throw new Error('createReverseFrameWalk: `to` must not be above `from`.');
  }
  const chunkFrames = chunkFramesFor(opts.planeBytes, opts.budgetBytes);
  let cache = new Map<number, LumaPlane>();
  let cacheLo = Number.POSITIVE_INFINITY;
  let lastRequested = Number.POSITIVE_INFINITY;
  let closed = false;

  const loadChunkFor = async (index: number): Promise<void> => {
    const hi = index;
    let lo = Math.max(opts.to, hi - chunkFrames + 1);
    // Snap UP to a keyframe when one sits inside the budgeted span: decoding
    // then starts exactly where the chunk does, so the chunk pays no preroll
    // at all. Snapping up only ever shrinks the chunk, so the budget still
    // holds; a keyframe BELOW the span is out of reach and preroll stands.
    const keyframe = opts.keyframeAtOrBefore?.(hi);
    if (keyframe !== undefined && keyframe > lo && keyframe <= hi) lo = keyframe;
    // Replaced, not merged: the previous chunk covers frames this walk has
    // already passed and will never ask for again. Holding it would double
    // the working set to buy nothing.
    const next = new Map<number, LumaPlane>();
    await opts.readAscending(lo, hi, (i, plane) => {
      if (i >= lo && i <= hi) next.set(i, plane);
    });
    cache = next;
    cacheLo = lo;
  };

  return {
    chunkFrames,
    async frameAt(index: number): Promise<LumaPlane> {
      if (closed) throw new Error('Reverse frame walk is closed.');
      const target = Math.max(opts.to, Math.min(opts.from, Math.floor(index)));
      if (target > lastRequested) {
        throw new Error('Reverse frame walk requests must be non-increasing.');
      }
      lastRequested = target;
      if (!cache.has(target)) {
        if (target >= cacheLo) {
          // Inside the loaded span but absent: the decoder skipped it (a
          // dropped or corrupt frame). Re-reading would not conjure it, and
          // silently substituting a neighbour would hand the tracker a
          // duplicate frame reported as motion — so this is fatal and loud.
          throw new Error(`Frame ${target} is missing from the decoded range.`);
        }
        await loadChunkFor(target);
      }
      const plane = cache.get(target);
      if (!plane) throw new Error(`Frame ${target} could not be decoded.`);
      return plane;
    },
    close(): void {
      closed = true;
      cache = new Map();
      cacheLo = Number.POSITIVE_INFINITY;
    },
  };
}
