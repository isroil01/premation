/**
 * Clip — the placement of a source on the timeline, in frames. It is the
 * temporal heart of a {@link Layer}: where it sits on the timeline (`start` +
 * `duration`) and which part of its source it shows (`sourceIn`). Trimming and
 * splitting are expressed here as pure geometry so the same math powers layers,
 * previews, and tests.
 *
 * `sourceDuration` (when known) bounds trims so a clip can't show media that
 * doesn't exist; leave it `null` for generative/infinite sources.
 */

import type { TimeRange } from '../utils/TimeRange';

export interface ClipData {
  /** Timeline start, in frames. */
  start: number;
  /** Length on the timeline, in frames. */
  duration: number;
  /** Offset into the source media where playback begins, in frames. */
  sourceIn: number;
  /** Total source length in frames, or null for unbounded sources. */
  sourceDuration: number | null;
}

export class Clip {
  start: number;
  duration: number;
  sourceIn: number;
  sourceDuration: number | null;

  constructor(data: Partial<ClipData> = {}) {
    this.start = data.start ?? 0;
    this.duration = Math.max(0, data.duration ?? 0);
    this.sourceIn = data.sourceIn ?? 0;
    this.sourceDuration = data.sourceDuration ?? null;
  }

  /** Exclusive timeline end frame. */
  get end(): number {
    return this.start + this.duration;
  }

  /** Source frame currently mapped to timeline `frame` (no bounds check). */
  get sourceOut(): number {
    return this.sourceIn + this.duration;
  }

  get range(): TimeRange {
    return { start: this.start, duration: this.duration };
  }

  contains(frame: number): boolean {
    return frame >= this.start && frame < this.end;
  }

  /** Map a timeline frame to the corresponding source frame. */
  sourceFrameAt(frame: number): number {
    return this.sourceIn + (frame - this.start);
  }

  /**
   * Trim the head to a new timeline start, holding the tail (end) fixed and
   * advancing `sourceIn` so the media stays in sync. Clamped so duration stays
   * >= `minDuration`. For BOUNDED sources `sourceIn` can't go negative (there is
   * no media before frame 0); unbounded/generative sources (shapes, text —
   * `sourceDuration === null`) may extend their head freely — the source mapping
   * stays consistent because `sourceIn` shifts with `start`.
   */
  trimStart(newStart: number, minDuration = 1): void {
    const tail = this.end;
    let start = Math.min(newStart, tail - minDuration);
    if (this.sourceDuration !== null) {
      // Don't pull source-in below 0 — the media has nothing before frame 0.
      const deltaMax = this.sourceIn; // how far left we can move start
      start = Math.max(start, this.start - deltaMax);
    }
    const delta = start - this.start;
    this.start = start;
    this.duration = tail - start;
    this.sourceIn += delta;
  }

  /**
   * Trim the tail to a new timeline end, holding the head (start) fixed. Clamped
   * to `minDuration` and to the remaining source length when bounded.
   */
  trimEnd(newEnd: number, minDuration = 1): void {
    let end = Math.max(newEnd, this.start + minDuration);
    if (this.sourceDuration !== null) {
      const maxEnd = this.start + (this.sourceDuration - this.sourceIn);
      end = Math.min(end, maxEnd);
    }
    this.duration = end - this.start;
  }

  /** Move the whole clip along the timeline (source mapping unchanged). */
  shift(deltaFrames: number): void {
    this.start += deltaFrames;
  }

  /**
   * Slip: shift which part of the source plays under a FIXED bar.
   * `start` and `duration` stay put; only `sourceIn` moves. Bounded sources
   * clamp so the window stays inside `[0, sourceDuration]`.
   */
  slip(deltaFrames: number): void {
    let next = this.sourceIn + deltaFrames;
    if (this.sourceDuration !== null) {
      const maxIn = Math.max(0, this.sourceDuration - this.duration);
      next = Math.max(0, Math.min(maxIn, next));
    } else {
      next = Math.max(0, next);
    }
    this.sourceIn = next;
  }

  /**
   * Split at a timeline frame, returning the data for the right-hand clip. This
   * clip becomes the left part (end at `frame`); the returned data is a new clip
   * starting at `frame` with the correct `sourceIn`. Returns null when the frame
   * is outside the clip's interior.
   */
  split(frame: number, minDuration = 1): ClipData | null {
    if (frame - this.start < minDuration || this.end - frame < minDuration) return null;
    const rightStart = frame;
    const rightDuration = this.end - frame;
    const rightSourceIn = this.sourceFrameAt(frame);
    // Left part shrinks to [start, frame).
    this.duration = frame - this.start;
    return {
      start: rightStart,
      duration: rightDuration,
      sourceIn: rightSourceIn,
      sourceDuration: this.sourceDuration,
    };
  }

  clone(): Clip {
    return new Clip(this.toJSON());
  }

  toJSON(): ClipData {
    return {
      start: this.start,
      duration: this.duration,
      sourceIn: this.sourceIn,
      sourceDuration: this.sourceDuration,
    };
  }

  static fromJSON(data: ClipData): Clip {
    return new Clip(data);
  }
}

/**
 * ROLL — the two-sided trim at a cut.
 *
 * A roll moves the CUT POINT between two abutting clips: the left clip's out
 * and the right clip's in travel together, so the pair's combined length on the
 * timeline never changes and no gap ever opens. That is the whole difference
 * between a roll and the two trims it looks like — trimming the left clip alone
 * leaves a hole, and trimming both by hand is two undo entries and two chances
 * to be one frame out.
 *
 * It lives here, beside {@link Clip.slip} and {@link Clip.trimEnd}, because it
 * is the same kind of thing: pure frame geometry over a pair of clips, with no
 * knowledge of tracks, layers, scene nodes or history. The engine and the UI
 * both need the LIMITS before they need the edit — the timeline draws a HUD
 * while you drag and has to know where the roll stops — so the clamp is
 * exported on its own rather than hidden inside the mutation.
 */

export interface RollLimits {
  /** Most negative delta (frames) the cut may take. `<= 0`. */
  min: number;
  /** Most positive delta (frames) the cut may take. `>= 0`. */
  max: number;
}

/**
 * How far the cut between `left` and `right` may travel, in frames.
 *
 * Four things bound it, and every one of them has bitten a naive
 * implementation:
 *
 *   • the left clip's remaining TAIL HANDLE — source after its out point. An
 *     unbounded source (`sourceDuration === null`: shapes, text, solids) has an
 *     infinite one, which is why this is not simply `sourceDuration - sourceOut`.
 *   • the right clip's remaining HEAD HANDLE — source before its in point, i.e.
 *     `sourceIn`, again infinite when unbounded.
 *   • both clips must keep at least `minDuration` frames on the timeline.
 *   • the cut may not cross frame 0.
 *
 * `left.end` is assumed to be the cut; callers that allow a one-frame seam pass
 * clips that abut within that tolerance and get the same answer.
 */
export function rollLimits(left: Clip, right: Clip, minDuration = 1): RollLimits {
  const INF = Number.POSITIVE_INFINITY;
  // Growing the left clip eats its tail handle; growing the right clip's head
  // (= shrinking it from the left) is bounded by its own length.
  const leftTailHandle = left.sourceDuration === null ? INF : Math.max(0, left.sourceDuration - left.sourceOut);
  const rightRoom = Math.max(0, right.duration - minDuration);
  const max = Math.min(leftTailHandle, rightRoom);

  const rightHeadHandle = right.sourceDuration === null ? INF : Math.max(0, right.sourceIn);
  const leftRoom = Math.max(0, left.duration - minDuration);
  const floor = Math.max(0, right.start); // the cut cannot go negative
  const back = Math.min(leftRoom, rightHeadHandle, floor);
  // `-0` is a real value in JS and `-0 !== 0` under Object.is, so a pinned
  // limit of zero would compare unequal to the zero every caller writes.
  const min = back === 0 ? 0 : -back;

  return { min, max };
}

/**
 * Apply a roll, clamped by {@link rollLimits}. Returns the delta that was
 * ACTUALLY applied — 0 when the cut is already against a limit — so a caller
 * can skip an empty history entry and a HUD can show the truth rather than the
 * pointer's wish.
 *
 * Mutates both clips. `deltaFrames` is truncated: clips are frames, and a
 * fractional roll would desynchronise the pair by a sub-frame that the next
 * integer edit then rounds away in one direction only.
 */
export function rollClips(left: Clip, right: Clip, deltaFrames: number, minDuration = 1): number {
  const { min, max } = rollLimits(left, right, minDuration);
  const d = Math.trunc(Math.max(min, Math.min(max, deltaFrames)));
  if (d === 0) return 0;
  // Order matters only for readability — the two calls are independent, and
  // each was clamped above so neither can clip the other's result.
  left.trimEnd(left.end + d, minDuration);
  right.trimStart(right.start + d, minDuration);
  return d;
}
