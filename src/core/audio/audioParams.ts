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

/**
 * Animatable stereo position, −100 (hard left) … +100 (hard right).
 *
 * The second property through this seam, and the reason the seam was written
 * generically: it schedules exactly as level does, so a swept pan is a curve on
 * the audio thread rather than 60 stepped assignments a second.
 *
 * Percent rather than the −1…1 a `StereoPannerNode` takes, because that is the
 * unit the Stereo Mixer effect already uses for its Left/Right Pan params and
 * the unit the inspector shows. The conversion is one place: {@link panToNorm}.
 */
export const AUDIO_PAN_PROP = 'audioPan';

/** Hard left / hard right, in the percent the UI and the document use. */
export const MIN_PAN = -100;
export const MAX_PAN = 100;

/** Pan percent → the −1…1 a `StereoPannerNode` wants, clamped. */
export function panToNorm(pan: number): number {
  if (!Number.isFinite(pan)) return 0;
  return Math.max(-1, Math.min(1, pan / 100));
}

/**
 * The panner a voice needs, or null when it is centred and unanimated.
 *
 * Lives HERE, beside the ramp builders, rather than on the engine — for the
 * same reason `buildParamRamp` does. The live engine and the offline mixdown
 * must ask one question about whether a panner exists, or a voice could pan in
 * the preview and render centred: a divergence that survives every visual check
 * and only surfaces on headphones. Keeping it in `AudioEngine` also made it
 * invisible to every mixdown test that mocks the engine, which is exactly the
 * coverage this seam most needs.
 *
 * Typed structurally rather than against `AudioLayerState`, so this module
 * still knows nothing about the engine.
 */
export function voicePanner(
  ctx: BaseAudioContext,
  l: { pan?: number; panAnimated?: boolean },
): StereoPannerNode | null {
  // An ANIMATED pan needs the node even while it reads centre — the ramp has
  // to have something to be scheduled on.
  if (!l.panAnimated && (l.pan ?? 0) === 0) return null;
  // Not every engine implements it (older Safari). A missing panner is better
  // than a thrown constructor taking the whole voice, and its layer, down.
  if (typeof ctx.createStereoPanner !== 'function') return null;
  const panner = ctx.createStereoPanner();
  panner.pan.value = panToNorm(l.pan ?? 0);
  return panner;
}

/**
 * One scheduled point: `offsetSec` after the voice starts, this param value.
 *
 * `gain` is named for the first property through this seam and kept for every
 * one since — a pan ramp's points carry a −1…1 position in the same field. The
 * field is "whatever this AudioParam takes", already converted out of the
 * document's units by the builder.
 */
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
