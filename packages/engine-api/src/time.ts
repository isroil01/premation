/**
 * API time is an integer count of FLICKS (1/705,600,000 s) — ENGINE_API.md §3.2.
 *
 * 705,600,000 is divisible by every common frame rate (24, 25, 30, 48, 50, 60,
 * 90, 100, 120) and by the NTSC rates' denominators (24000/1001 → 29,429,400
 * flicks per frame exactly), so frame boundaries are exact integers and no
 * "+1 µs" nudge is needed. A JS number holds flicks exactly for ±147 days.
 *
 * The TypeScript engine stores seconds (keyframes) and frames (clips); the
 * EngineClient converts at the seam with these functions and nowhere else.
 */

export const FLICKS_PER_SECOND = 705_600_000;

/** Seconds → flicks, rounded to the nearest flick. */
export function secondsToFlicks(seconds: number): number {
  return Math.round(seconds * FLICKS_PER_SECOND);
}

export function flicksToSeconds(flicks: number): number {
  return flicks / FLICKS_PER_SECOND;
}

/** Frame index at rate num/den → flicks (exact for every rate whose flicks-per-frame is an integer). */
export function frameToFlicks(frame: number, num: number, den = 1): number {
  // Flicks-per-frame first: frame * 705.6e6 * den would leave the exact-integer range.
  return Math.round(frame * ((FLICKS_PER_SECOND * den) / num));
}

/** Flicks → frame index at rate num/den (floor: the frame that is showing). */
export function flicksToFrame(flicks: number, num: number, den = 1): number {
  // The epsilon only matters for rates whose flicks-per-frame is not an integer.
  return Math.floor(flicks / ((FLICKS_PER_SECOND * den) / num) + 1e-9);
}
