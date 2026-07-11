/**
 * Time conversions. The engine's canonical unit is **frames** (a number, usually
 * integer but fractional during smooth playback). These pure functions convert
 * between frames, milliseconds, seconds, and SMPTE timecode for a given
 * {@link FrameRate}. Kept allocation-light for hot seeking paths.
 */

import type { FrameRate } from './FrameRate';

// ── frames ⇄ time ──────────────────────────────────────────────────
export function framesToSeconds(frames: number, rate: FrameRate): number {
  return frames / rate.fps;
}

export function secondsToFrames(seconds: number, rate: FrameRate): number {
  return seconds * rate.fps;
}

export function framesToMs(frames: number, rate: FrameRate): number {
  return (frames / rate.fps) * 1000;
}

export function msToFrames(ms: number, rate: FrameRate): number {
  return (ms / 1000) * rate.fps;
}

/** Snap a (possibly fractional) frame to the nearest whole frame. */
export function roundToFrame(frames: number): number {
  return Math.round(frames);
}

/** Convert between two frame rates, preserving wall-clock time. */
export function convertFrames(frames: number, from: FrameRate, to: FrameRate): number {
  return (frames / from.fps) * to.fps;
}

// ── frames ⇄ timecode ("HH:MM:SS:FF") ─────────────────────────────
export interface TimecodeParts {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  negative: boolean;
}

function pad(n: number, width = 2): string {
  return Math.trunc(Math.abs(n)).toString().padStart(width, '0');
}

/** Break a frame count into timecode parts using the nominal fps. */
export function framesToParts(frames: number, rate: FrameRate): TimecodeParts {
  const n = Math.max(1, rate.nominal);
  const negative = frames < 0;
  let whole = Math.round(Math.abs(frames));
  const ff = whole % n;
  let totalSeconds = Math.floor(whole / n);
  const ss = totalSeconds % 60;
  totalSeconds = Math.floor(totalSeconds / 60);
  const mm = totalSeconds % 60;
  const hh = Math.floor(totalSeconds / 60);
  return { hours: hh, minutes: mm, seconds: ss, frames: ff, negative };
}

/** Format a frame count as SMPTE timecode (frame separator ':'). */
export function framesToTimecode(frames: number, rate: FrameRate): string {
  const p = framesToParts(frames, rate);
  const sep = rate.dropFrame ? ';' : ':';
  return `${p.negative ? '-' : ''}${pad(p.hours)}:${pad(p.minutes)}:${pad(p.seconds)}${sep}${pad(p.frames)}`;
}

/**
 * Parse timecode into frames. Accepts flexible forms from the right:
 * "FF", "SS:FF", "MM:SS:FF", "HH:MM:SS:FF" (drop-frame ';' allowed on the last
 * separator). Non-numeric input throws.
 */
export function timecodeToFrames(tc: string, rate: FrameRate): number {
  const negative = tc.trim().startsWith('-');
  const parts = tc.trim().replace(/^-/, '').split(/[:;]/).map((s) => {
    const v = Number(s);
    if (!Number.isFinite(v)) throw new SyntaxError(`Invalid timecode segment: "${s}"`);
    return v;
  });
  // Right-aligned: frames, seconds, minutes, hours.
  let frames = 0;
  let seconds = 0;
  let minutes = 0;
  let hours = 0;
  const p = parts.reverse();
  frames = p[0] ?? 0;
  seconds = p[1] ?? 0;
  minutes = p[2] ?? 0;
  hours = p[3] ?? 0;
  const n = Math.max(1, rate.nominal);
  const total = frames + (seconds + minutes * 60 + hours * 3600) * n;
  return negative ? -total : total;
}
