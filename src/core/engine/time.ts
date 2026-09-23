/**
 * Time at the seam (ENGINE_API.md §3.2). API times are integer flicks; the TS
 * engine keeps keyframes in seconds and clip bars in frames of the owning
 * composition's rate. These are the only conversions the local engine uses.
 */

import { FLICKS_PER_SECOND, secondsToFlicks, flicksToSeconds } from '@motion/engine-api';
import type { Rational, TimeRange } from '@motion/engine-api';
import { useProjectStore } from '@stores/projectStore';
import { fail } from './errors';

export { secondsToFlicks, flicksToSeconds, FLICKS_PER_SECOND };

/** The comp's frame rate as a float (what the TS timeline stores). */
export function compFps(compId: string): number {
  const fps = useProjectStore.getState().comps[compId]?.fps;
  return typeof fps === 'number' && fps > 0 ? fps : 30;
}

/** A float rate as an exact rational: integers, NTSC (×1000/1001), else millis. */
export function fpsToRational(fps: number): Rational {
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  const ntsc = Math.round(fps * 1.001);
  if (Math.abs((ntsc * 1000) / 1001 - fps) < 1e-3) return { num: ntsc * 1000, den: 1001 };
  return { num: Math.round(fps * 1000), den: 1000 };
}

export function rationalToFps(r: Rational): number {
  if (!(r.num > 0) || !(r.den > 0)) fail('invalidArgument', 'frame rate must be positive');
  return r.num / r.den;
}

/** Frames of a comp → flicks (exact for every rate whose frame is an integer number of flicks). */
export function framesToFlicks(frames: number, fps: number): number {
  const r = fpsToRational(fps);
  return Math.round((frames * FLICKS_PER_SECOND * r.den) / r.num);
}

/** Flicks → frames, rounded to the nearest frame (bars are frame-quantized). */
export function flicksToFrames(flicks: number, fps: number): number {
  const r = fpsToRational(fps);
  return Math.round((flicks * r.num) / (FLICKS_PER_SECOND * r.den));
}

export function checkTime(t: number, what = 'time'): void {
  if (!Number.isInteger(t)) fail('invalidArgument', `${what} must be an integer number of flicks`);
}

export function rangeEnd(r: TimeRange): number {
  return r.start + r.duration;
}
