/**
 * Audio parameters that vary over time.
 *
 * Deliberately built as "audio properties sample per frame like every other
 * animatable property", not as a levels special case. Level is the first
 * property through this seam; pan, fades and audio-effect parameters are the
 * same shape and should reuse `buildParamRamp` rather than growing a second
 * scheduling path.
 *
 * ## Why a ramp and not a per-frame assignment
 *
 * The obvious implementation — read the level each frame and assign
 * `gain.gain.value` — produces **zipper noise**. An AudioParam's `.value` is a
 * step change applied at an arbitrary point inside the next render quantum, so
 * a level sliding from 0 dB to -20 dB over a second becomes ~60 discontinuities
 * in the waveform, each an audible click. Web Audio's whole automation API
 * exists to avoid this: schedule the curve ON the param and let the audio
 * thread interpolate it at sample rate, between control-rate points.
 *
 * So both the live engine and the offline mixdown build a ramp — a list of
 * (time, gain) points — with the SAME function here, and apply it with
 * `setValueAtTime` + `linearRampToValueAtTime`. One curve builder, so preview
 * and export cannot drift apart. That is the failure this seam is shaped to
 * prevent: a gain curve that sounds right while scrubbing and renders
 * differently, discoverable only by exporting and listening.
 */

import { defaultAnimation } from '@motion/animation';

/** Animatable level track, in decibels. */
export const AUDIO_LEVEL_DB_PROP = 'audioLevelDb';

/**
 * Level at or below this is silence.
 *
 * -60 dB is 0.1% amplitude — inaudible under any real programme material, and
 * far enough down that a fade reaching it reads as "off" rather than "very
 * quiet". Clamping here also keeps the dB→gain curve away from the asymptote,
 * where a slider drag would otherwise spend most of its travel inaudible.
 */
export const MIN_LEVEL_DB = -60;

/** Loudest boost the UI offers. +12 dB is ~4x amplitude — enough to rescue a
 *  quiet recording, short of the range where clipping is the only outcome. */
export const MAX_LEVEL_DB = 12;

/** Decibels → linear amplitude. At or below {@link MIN_LEVEL_DB}, exactly 0. */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= MIN_LEVEL_DB) return 0;
  return Math.pow(10, db / 20);
}

/**
 * The legacy percent level (100 = unity) as decibels.
 *
 * Both layer kinds stored a percent before this: audio layers as `__level`,
 * video layers as `audioLevel`. They are read through here so an existing
 * project keeps its exact gain — 100% is 0 dB, 50% is about -6 dB — instead of
 * being reinterpreted as a dB number and jumping 100 dB on load.
 */
export function percentToDb(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return MIN_LEVEL_DB;
  return Math.max(MIN_LEVEL_DB, 20 * Math.log10(percent / 100));
}

/** True when this node has level keyframes (so a constant is not enough). */
export function isLevelAnimated(nodeId: string): boolean {
  return defaultAnimation
    .tracksFor(nodeId)
    .some((t) => t.prop === AUDIO_LEVEL_DB_PROP && t.keyframes.length > 0);
}

/**
 * Level in dB for a node at a composition time, falling back to its static
 * value when there are no keyframes.
 */
export function sampleLevelDb(nodeId: string, compSec: number, staticDb: number): number {
  const v = defaultAnimation.sample(nodeId, AUDIO_LEVEL_DB_PROP, compSec);
  return typeof v === 'number' ? v : staticDb;
}

/** One scheduled point: `offsetSec` after the voice starts, this linear gain. */
export interface RampPoint {
  offsetSec: number;
  gain: number;
}

/** How often an animated parameter is sampled when building a ramp.
 *
 *  50 Hz is comfortably above the ~20 Hz where stepped gain changes start to
 *  be heard as a beat rather than a slope, and far below a per-sample curve's
 *  cost. Between points the audio thread interpolates linearly at sample rate,
 *  so this is the resolution of the CONTROL curve, not of the audio. */
const RAMP_HZ = 50;

/**
 * Build the gain curve for one voice over `durationSec` of composition time.
 *
 * `startCompSec` is where the voice begins on the comp timeline; offsets in the
 * returned points are relative to the voice's own start, which is what both
 * `AudioBufferSourceNode.start(when)` and the offline scheduler need.
 *
 * A voice whose level is not animated returns exactly one point — a constant —
 * so the common case costs nothing and schedules no ramp at all.
 */
export function buildParamRamp(
  nodeId: string,
  staticDb: number,
  startCompSec: number,
  durationSec: number,
  opts?: { animated?: boolean; hz?: number },
): RampPoint[] {
  return buildRamp(
    (compSec) => dbToGain(sampleLevelDb(nodeId, compSec, staticDb)),
    startCompSec,
    durationSec,
    { animated: opts?.animated ?? isLevelAnimated(nodeId), hz: opts?.hz },
  );
}

/**
 * The scheduling half of {@link buildParamRamp}, with the level semantics gone.
 *
 * Everything except the dB conversion — the sample rate, the end pin, the
 * single-point unanimated case — is a property of scheduling an AudioParam
 * rather than of what the parameter MEANS. Audio-effect parameters need all of
 * it and none of the decibels.
 *
 * Extracted rather than copied, deliberately. This module opens by saying
 * effect parameters "are the same shape and should reuse `buildParamRamp`
 * rather than growing a second scheduling path"; a second sampler with its own
 * rate and its own end-pin rule IS that second path, and the two would drift on
 * the day one of them fixed a rounding bug.
 *
 * `sampleAt` takes COMPOSITION time while the points it returns are offsets
 * from the voice's start. Keeping those in different units is what lets a seek
 * into the middle of a curve pick it up where the playhead is instead of
 * restarting it.
 */
export function buildRamp(
  sampleAt: (compSec: number) => number,
  startCompSec: number,
  durationSec: number,
  opts?: { animated?: boolean; hz?: number },
): RampPoint[] {
  const first = { offsetSec: 0, gain: sampleAt(startCompSec) };
  if (opts?.animated !== true || !(durationSec > 0)) return [first];

  const hz = opts?.hz ?? RAMP_HZ;
  const step = 1 / hz;
  const points: RampPoint[] = [first];
  for (let t = step; t < durationSec; t += step) {
    points.push({ offsetSec: t, gain: sampleAt(startCompSec + t) });
  }
  // Always pin the end, so a curve that changes between the last sampled point
  // and the voice's end is not held flat through the tail.
  const endGain = sampleAt(startCompSec + durationSec);
  const last = points[points.length - 1]!;
  if (Math.abs(last.offsetSec - durationSec) > 1e-6) points.push({ offsetSec: durationSec, gain: endGain });
  return points;
}

/**
 * Schedule a ramp onto a live AudioParam, starting at context time `whenCtx`.
 *
 * `setValueAtTime` for the first point then `linearRampToValueAtTime` for the
 * rest: the first call is what anchors the interpolation, and without it the
 * ramp would start from whatever value the param happened to hold, producing a
 * slide from the previous clip's level into this one.
 */
export function applyRamp(param: AudioParam, ramp: readonly RampPoint[], whenCtx: number): void {
  const head = ramp[0];
  if (!head) return;
  try {
    param.cancelScheduledValues(whenCtx);
  } catch {
    /* not all implementations accept a past time; the sets below still apply */
  }
  param.setValueAtTime(head.gain, whenCtx);
  for (let i = 1; i < ramp.length; i++) {
    const p = ramp[i]!;
    param.linearRampToValueAtTime(p.gain, whenCtx + p.offsetSec);
  }
}
