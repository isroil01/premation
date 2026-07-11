/**
 * TimeRange — a half-open span of time expressed in **frames** (the engine's
 * canonical unit). `start` is inclusive, `end = start + duration` is exclusive.
 * Pure value helpers; no allocations beyond the returned object.
 */

export interface TimeRange {
  /** Inclusive start, in frames. */
  start: number;
  /** Length in frames (>= 0). */
  duration: number;
}

export function range(start: number, duration: number): TimeRange {
  return { start, duration: Math.max(0, duration) };
}

export function fromStartEnd(start: number, end: number): TimeRange {
  return { start: Math.min(start, end), duration: Math.abs(end - start) };
}

export function end(r: TimeRange): number {
  return r.start + r.duration;
}

/** Inclusive-start, exclusive-end containment (a zero-length range contains nothing). */
export function contains(r: TimeRange, frame: number): boolean {
  return frame >= r.start && frame < r.start + r.duration;
}

/** True when a frame is within [start, end] inclusive on both ends. */
export function touches(r: TimeRange, frame: number): boolean {
  return frame >= r.start && frame <= r.start + r.duration;
}

export function intersects(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.start + b.duration && b.start < a.start + a.duration;
}

export function intersection(a: TimeRange, b: TimeRange): TimeRange | null {
  const s = Math.max(a.start, b.start);
  const e = Math.min(end(a), end(b));
  if (e <= s) return null;
  return { start: s, duration: e - s };
}

export function union(a: TimeRange, b: TimeRange): TimeRange {
  const s = Math.min(a.start, b.start);
  const e = Math.max(end(a), end(b));
  return { start: s, duration: e - s };
}

export function clampFrame(r: TimeRange, frame: number): number {
  return Math.min(end(r), Math.max(r.start, frame));
}

export function shift(r: TimeRange, delta: number): TimeRange {
  return { start: r.start + delta, duration: r.duration };
}

export function equals(a: TimeRange, b: TimeRange, epsilon = 1e-9): boolean {
  return Math.abs(a.start - b.start) < epsilon && Math.abs(a.duration - b.duration) < epsilon;
}
