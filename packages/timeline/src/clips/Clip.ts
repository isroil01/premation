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
