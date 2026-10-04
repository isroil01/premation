/**
 * Convert Audio to Keyframes (AE's keyframe assistant) — sample an audio
 * layer's decoded buffer into a per-frame RMS loudness envelope and write it
 * as a keyframe track (`audioAmplitude`, 0–100) on the audio layer. Drive
 * anything from it: parent a scale/opacity expression to the track, or
 * copy keyframes onto other properties.
 *
 * ## Why this used to freeze the app
 *
 * The write loop called `defaultAnimation.setKeyframe` once per keyframe. That
 * method is built for INTERACTIVE authoring: it re-scans and re-sorts the whole
 * track AND fires a synchronous app-wide change notification (scene bump →
 * hit-test rebuild → autosave schedule) on every call. A three-minute track at
 * 30 fps is 5400 frames and RMS jitter keeps thousands of them, so one click
 * meant thousands of O(n) inserts and thousands of full app notifications on the
 * main thread — the UI was wedged until it finished.
 *
 * The engine already ships the right primitives: {@link AnimationEngine.setKeyframes}
 * (sort once, notify once) and {@link AnimationEngine.batch} (hold notifications
 * for a bulk write). {@link applyAudioKeyframes} uses both, so the same job is
 * one sort and one notification.
 */

import {  CONTROL_PREFIX } from '@core/animation/expressionControls';

export const AUDIO_AMPLITUDE_PROP = 'audioAmplitude';

/** Tunables for the conversion (surfaced in the inspector's popover). */
export interface AudioKeyframeOptions {
  /**
   * Sample every Nth frame. 1 = every frame (AE's behaviour), higher values
   * trade temporal detail for a track you can actually hand-edit.
   */
  frameStep: number;
  /**
   * Keep a frame only when it moves at least this far (0–100) from the last
   * KEPT frame. Higher = fewer, punchier keyframes; 0 keeps every sample.
   */
  minDelta: number;
  /** Box-smooth the envelope over this many samples before thinning (1 = off). */
  smoothing: number;
  /** Scale the 0–100 envelope (2 = double the swing, clamped to 0–100). */
  gain: number;
  /** Property to write the track to. */
  prop: string;
}

export const DEFAULT_AUDIO_KEYFRAME_OPTIONS: AudioKeyframeOptions = {
  frameStep: 1,
  minDelta: 2,
  smoothing: 1,
  gain: 1,
  prop: AUDIO_AMPLITUDE_PROP,
};

/**
 * Which channels an envelope reads — AE's three, and the three it writes as
 * sliders.
 *
 * A MONO buffer answers all three from its single channel rather than giving
 * Right zeros. "Channel 1 of a one-channel file" is the literal reading and it
 * is the wrong one: a mono voiceover driving a rig off Right would animate
 * nothing, which reads as a broken feature rather than as a property of the
 * source.
 */
export type AudioChannel = 'both' | 'left' | 'right';

export const AUDIO_CHANNELS: readonly AudioChannel[] = ['both', 'left', 'right'];

/** Slider names, matching AE's. */
export const AUDIO_CHANNEL_LABELS: Record<AudioChannel, string> = {
  both: 'Both Channels',
  left: 'Left',
  right: 'Right',
};

function channelIndices(buffer: AudioBuffer, ch: AudioChannel): number[] {
  const n = buffer.numberOfChannels;
  if (n <= 1) return [0];
  if (ch === 'left') return [0];
  if (ch === 'right') return [Math.min(1, n - 1)];
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Per-frame RMS, UN-normalised, for one channel selection.
 *
 * Split out because the three-slider output has to normalise the channels
 * TOGETHER — see {@link amplitudeEnvelopes}.
 */
function rawEnvelope(buffer: AudioBuffer, fps: number, channel: AudioChannel): number[] {
  if (fps <= 0 || buffer.length === 0) return [];
  const frames = Math.max(1, Math.ceil(buffer.duration * fps));
  const samplesPerFrame = Math.max(1, Math.floor(buffer.sampleRate / fps));
  const channels = channelIndices(buffer, channel).map((c) => buffer.getChannelData(c));
  const out = new Array<number>(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * samplesPerFrame;
    const end = Math.min(buffer.length, start + samplesPerFrame);
    let sum = 0;
    let n = 0;
    for (const ch of channels) {
      for (let i = start; i < end; i++) {
        const v = ch[i]!;
        sum += v * v;
        n++;
      }
    }
    out[f] = n > 0 ? Math.sqrt(sum / n) : 0;
  }
  return out;
}

/** Scale an RMS envelope to 0–100 against `peak`, in 0.1 steps. */
function scaleTo100(env: readonly number[], peak: number): number[] {
  if (peak <= 0) return env.map(() => 0);
  return env.map((v) => Math.round((v / peak) * 1000) / 10);
}

/**
 * Per-frame RMS amplitude, normalized to 0–100 against the clip's own peak.
 * Pure math over the decoded buffer — one value per frame at `fps`.
 */
export function amplitudeEnvelope(
  buffer: AudioBuffer,
  fps: number,
  channel: AudioChannel = 'both',
): number[] {
  const raw = rawEnvelope(buffer, fps, channel);
  let peak = 0;
  for (const v of raw) if (v > peak) peak = v;
  return scaleTo100(raw, peak);
}

/**
 * All requested channels at once, normalised against ONE SHARED peak.
 *
 * This is the part that cannot be had by calling `amplitudeEnvelope` three
 * times — and three calls is the OBVIOUS code, which is what makes this worth a
 * paragraph. Each call normalises to its own peak, so every channel reaches
 * 100: a track with a quiet right side yields a Right slider that swings
 * exactly as hard as Left. The relative loudness between the channels is the
 * only information the split exists to carry, and the obvious implementation
 * destroys it.
 *
 * It destroys it while LOOKING CORRECT ON SCREEN. Three sliders, all moving,
 * all in range, all following the music — nothing about the result says it is
 * wrong. It stays wrong until someone tries to drive something from the
 * difference between two channels and cannot work out why it never varies.
 *
 * The peak is taken across the envelopes ACTUALLY requested, so asking for
 * `['both']` alone reduces to `amplitudeEnvelope`'s own-peak behaviour exactly.
 * That is what keeps the existing single-track conversion unchanged.
 */
export function amplitudeEnvelopes(
  buffer: AudioBuffer,
  fps: number,
  channels: readonly AudioChannel[],
): Map<AudioChannel, number[]> {
  const raws = new Map<AudioChannel, number[]>();
  let peak = 0;
  for (const c of channels) {
    const raw = rawEnvelope(buffer, fps, c);
    raws.set(c, raw);
    for (const v of raw) if (v > peak) peak = v;
  }
  const out = new Map<AudioChannel, number[]>();
  for (const [c, raw] of raws) out.set(c, scaleTo100(raw, peak));
  return out;
}

/** Thin an envelope: keep frames where the value moves ≥ `minDelta` from the
 *  last KEPT frame (plus first/last), so flat stretches don't spam keyframes. */
export function thinEnvelope(env: readonly number[], minDelta = 0.5): Array<{ frame: number; value: number }> {
  if (env.length === 0) return [];
  const out: Array<{ frame: number; value: number }> = [{ frame: 0, value: env[0]! }];
  let last = env[0]!;
  for (let f = 1; f < env.length - 1; f++) {
    if (Math.abs(env[f]! - last) >= minDelta) {
      out.push({ frame: f, value: env[f]! });
      last = env[f]!;
    }
  }
  if (env.length > 1) out.push({ frame: env.length - 1, value: env[env.length - 1]! });
  return out;
}

/** Centred box smooth over `window` samples (odd or even; 1 = identity). */
export function smoothEnvelope(env: readonly number[], window: number): number[] {
  const w = Math.max(1, Math.floor(window));
  if (w <= 1 || env.length === 0) return [...env];
  const half = Math.floor(w / 2);
  const out = new Array<number>(env.length);
  // Running sum — O(n) rather than O(n·w), which matters at 5000+ frames.
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < env.length; i++) {
    const wantLo = Math.max(0, i - half);
    const wantHi = Math.min(env.length - 1, i + half);
    while (hi < wantHi) sum += env[++hi]!;
    while (lo < wantLo) sum -= env[lo++]!;
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

/**
 * Envelope → keyframes, applying every option except the property choice.
 * PURE — no engine, no scene — so the inspector can run it just to COUNT the
 * keyframes a setting would produce, and show that before anything is written.
 */
export function planAudioKeyframes(
  env: readonly number[],
  opts: AudioKeyframeOptions,
): Array<{ frame: number; value: number }> {
  if (env.length === 0) return [];
  const smoothed = smoothEnvelope(env, opts.smoothing);
  const gain = Number.isFinite(opts.gain) ? opts.gain : 1;
  const scaled = gain === 1 ? smoothed : smoothed.map((v) => Math.min(100, Math.max(0, v * gain)));

  // Decimate BEFORE thinning so `frameStep` is a hard ceiling on density.
  const step = Math.max(1, Math.floor(opts.frameStep));
  const sampledFrames: number[] = [];
  const sampled: number[] = [];
  for (let f = 0; f < scaled.length; f += step) {
    sampledFrames.push(f);
    sampled.push(scaled[f]!);
  }
  const lastFrame = scaled.length - 1;
  if (sampledFrames[sampledFrames.length - 1] !== lastFrame && lastFrame >= 0) {
    sampledFrames.push(lastFrame);
    sampled.push(scaled[lastFrame]!);
  }

  return thinEnvelope(sampled, Math.max(0, opts.minDelta)).map((k) => ({
    frame: sampledFrames[k.frame]!,
    value: Math.round(k.value * 10) / 10,
  }));
}

/** The prop path a named slider control keyframes on. */
export const sliderProp = (name: string): string => CONTROL_PREFIX + name;

export interface AudioSliderNullResult {
  /** The created null's node id, or null when it could not be created. */
  nodeId: string | null;
  /** Keyframes written per channel. */
  written: Map<AudioChannel, number>;
}
