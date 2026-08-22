/**
 * The frame index: the pure arithmetic between a demuxed sample table and
 * exact random access.
 *
 * An MP4's samples arrive in DECODE order, and with B-frames that is not the
 * order anyone watches them in — the fixture this module is tested against
 * decodes `I P B B…` while presenting `I B B P…`. Three questions have to be
 * answered before a `VideoDecoder` can show "frame 7", and all three are
 * container arithmetic, not decoding:
 *
 *  1. WHICH sample is presentation frame 7? Sort by `cts`. The composition
 *     timestamps also start late by the B-frame delay (ffmpeg parks the offset
 *     in an edit list), so presentation time is normalized to the first
 *     DISPLAYED frame — frame 0 is at 0µs whatever the container says.
 *  2. WHERE must decoding start? At the latest sync sample at-or-before the
 *     frame's own decode position — its GOP's keyframe. Feeding a decoder
 *     anything else is undefined behaviour wearing a timestamp.
 *  3. HOW FAR must decoding run? Through the highest decode index among the
 *     GOP's presentation frames up to and including the target — a B-frame
 *     needs the future reference it was predicted from, which sits EARLIER in
 *     decode order than the B-frame's own presentation slot.
 *
 * Everything here is integers-in, integers-out (µs, from the track timescale),
 * so it is exactly testable in jest with no decoder anywhere near it.
 */

/** What the index needs from a demuxed sample — a subset of mp4Demuxer's
 *  `DemuxedSample`, kept structural so synthetic tables test edge cases. */
export interface IndexableSample {
  dts: number;
  cts: number;
  isKey: boolean;
  /** In track timescale units, like cts/dts. */
  duration: number;
}

export interface FrameEntry {
  /** Position of this frame's sample in the decode-order sample list. */
  decodeIndex: number;
  /** Presentation start, µs, normalized so the first displayed frame is 0. */
  timeUs: number;
  durationUs: number;
  /** Decode-order index of the GOP keyframe decoding must start from. */
  keyDecodeIndex: number;
  /** Decode-order index decoding must run THROUGH (inclusive) to emit this
   *  frame — the running max of decodeIndex over the GOP's presentation
   *  frames so far, which is ≥ decodeIndex exactly when B-frames reorder. */
  feedThroughDecodeIndex: number;
}

export interface VideoFrameIndex {
  /** Presentation order. */
  frames: FrameEntry[];
  /** End of the last frame, µs. */
  durationUs: number;
}

const toUs = (units: number, timescale: number): number =>
  Math.round((units * 1e6) / timescale);

export function buildFrameIndex(
  samples: readonly IndexableSample[],
  timescale: number,
): VideoFrameIndex {
  if (samples.length === 0 || !(timescale > 0)) return { frames: [], durationUs: 0 };

  // Question 2, per decode position: the latest sync at-or-before it. A stream
  // whose first sample is not marked sync is malformed; clamping its GOP start
  // to 0 decodes from the top, which is the least wrong thing to do with it.
  const keyOf = new Array<number>(samples.length);
  let lastKey = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i]!.isKey) lastKey = i;
    keyOf[i] = lastKey;
  }

  // Question 1: presentation order, ties broken by decode order so the sort
  // is total and deterministic.
  const order = samples.map((_s, i) => i);
  order.sort((a, b) => (samples[a]!.cts - samples[b]!.cts) || (a - b));

  const cts0 = samples[order[0]!]!.cts;
  const frames: FrameEntry[] = [];
  // Question 3: running max of decode index, reset when the GOP changes.
  let curKey = -1;
  let runMax = -1;
  for (const decodeIndex of order) {
    const s = samples[decodeIndex]!;
    const k = keyOf[decodeIndex]!;
    if (k !== curKey) {
      curKey = k;
      runMax = decodeIndex;
    } else {
      runMax = Math.max(runMax, decodeIndex);
    }
    frames.push({
      decodeIndex,
      timeUs: toUs(s.cts - cts0, timescale),
      durationUs: toUs(s.duration, timescale),
      keyDecodeIndex: k,
      feedThroughDecodeIndex: runMax,
    });
  }

  const last = frames[frames.length - 1]!;
  return { frames, durationUs: last.timeUs + last.durationUs };
}

/** The presentation index showing at `timeUs`: the last frame starting at or
 *  before it, clamped to the clip — matching how every player treats the
 *  half-open [start, start+duration) a frame owns. */
export function frameAtTime(index: VideoFrameIndex, timeUs: number): number {
  const n = index.frames.length;
  if (n === 0) return 0;
  if (timeUs <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.frames[mid]!.timeUs <= timeUs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
