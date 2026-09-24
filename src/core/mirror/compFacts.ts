/**
 * A composition's SETTINGS in the units the editor's controls have always
 * shown (B4) — frames per second as the number the user typed, the duration in
 * seconds, the start timecode in frames, the work area in seconds. The mirror
 * speaks rationals and flicks (`CompSettings`); these convert. Pure.
 */

import { flicksToSeconds, type CompSettings, type LayerTiming, type Rational } from '@motion/engine-api';

/**
 * Frames per second as stored (29.97, 23.976, 30): the API's NTSC rates are
 * exact rationals (30000/1001), which print as 29.97002997…; the editor's
 * settings were typed to three decimals, so that is what they round back to.
 */
export function rateToFps(rate: Rational | undefined, fallback = 30): number {
  if (!rate || !(rate.num > 0) || !(rate.den > 0)) return fallback;
  return Math.round((rate.num / rate.den) * 1000) / 1000;
}

/** The composition's frame rate (as stored). */
export function settingsFps(s: Pick<CompSettings, 'frameRate'> | undefined, fallback = 30): number {
  return rateToFps(s?.frameRate, fallback);
}

/** The composition's length, seconds. */
export function settingsDurationSeconds(s: Pick<CompSettings, 'duration'> | undefined, fallback = 10): number {
  return s ? flicksToSeconds(s.duration) : fallback;
}

/** The displayed timecode of frame 0 (AE Start Timecode), in frames. */
export function settingsStartFrame(s: Pick<CompSettings, 'startTimecode' | 'frameRate'> | undefined): number {
  return s ? Math.round(flicksToSeconds(s.startTimecode) * settingsFps(s)) : 0;
}

/** The work area, seconds (`end` exclusive). */
export function settingsWorkArea(s: Pick<CompSettings, 'workArea'> | undefined): { start: number; end: number } | null {
  if (!s) return null;
  const start = flicksToSeconds(s.workArea.start);
  return { start, end: start + flicksToSeconds(s.workArea.duration) };
}

/**
 * Whether a work area is SET: the API states "none" as the whole composition
 * (`{ start: 0, duration }`), so a range covering exactly that reads as unset —
 * what the timeline controller's `getWorkArea() === null` meant.
 */
export function settingsHasWorkArea(s: Pick<CompSettings, 'workArea' | 'duration'> | undefined): boolean {
  return !!s && !(s.workArea.start === 0 && s.workArea.duration === s.duration);
}

/** The work area in seconds when one is set (`settingsHasWorkArea`), else null. */
export function settingsSetWorkArea(s: Pick<CompSettings, 'workArea' | 'duration'> | undefined): { start: number; end: number } | null {
  return settingsHasWorkArea(s) ? settingsWorkArea(s) : null;
}

/** A time (flicks) in frames at `fps` — snapped to the whole frame when it is one within rounding. */
export function framesOfTime(t: number, fps: number): number {
  const x = flicksToSeconds(t) * fps;
  const r = Math.round(x);
  return Math.abs(x - r) < 1e-6 ? r : x;
}

/**
 * A layer's clip bar in FRAMES of its composition (the timeline's `ClipData`:
 * start, duration, sourceIn, sourceDuration — null when unbounded), from its
 * mirror `LayerTiming`: the span from the first bar's in-point to the last
 * bar's out-point, which is THE bar for a layer that has one.
 */
export function timingBarFrames(
  timing: Pick<LayerTiming, 'inPoint' | 'outPoint' | 'startTime' | 'sourceDuration'>,
  fps: number,
): { start: number; duration: number; sourceIn: number; sourceDuration: number | null } {
  const start = framesOfTime(timing.inPoint, fps);
  const end = framesOfTime(timing.outPoint, fps);
  return {
    start,
    duration: Math.max(0, end - start),
    sourceIn: start - framesOfTime(timing.startTime, fps),
    sourceDuration: timing.sourceDuration !== undefined ? framesOfTime(timing.sourceDuration, fps) : null,
  };
}

const worldCache = new Map<string, Record<string, unknown>>();

/**
 * The composition's World settings (`CompSettings.world`, JSON until typed —
 * ENGINE_API §11: default environment preset, ground level, sky backdrop,
 * SSAO), parsed; `{}` when absent or unreadable. Same object per JSON string.
 */
export function settingsWorld(s: Pick<CompSettings, 'world'> | undefined): Readonly<Record<string, unknown>> {
  const raw = s?.world;
  if (!raw) return EMPTY_WORLD;
  let hit = worldCache.get(raw);
  if (!hit) {
    try {
      const v = JSON.parse(raw) as unknown;
      hit = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : EMPTY_WORLD;
    } catch {
      hit = EMPTY_WORLD;
    }
    if (worldCache.size > 64) worldCache.clear();
    worldCache.set(raw, hit);
  }
  return hit;
}

const EMPTY_WORLD: Record<string, unknown> = Object.freeze({}) as Record<string, unknown>;
