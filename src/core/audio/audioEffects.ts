/**
 * Audio effects — AE's audio-effect family, as ONE graph builder shared by
 * live playback and offline mixdown.
 *
 * ## The parity contract, which is the whole design
 *
 * `audioParams.ts` states the rule this file follows: level was "the first
 * property through this seam; pan, fades and **audio-effect parameters are the
 * same shape and should reuse `buildParamRamp` rather than growing a second
 * scheduling path**". The failure being prevented is a mix that sounds right
 * while scrubbing and renders differently — discoverable only by exporting and
 * listening, which is the worst possible feedback loop.
 *
 * So there is exactly one function that turns a list of effects into audio
 * nodes — {@link connectAudioEffects} — and both `AudioEngine` (live) and
 * `audioMixdown` (offline `OfflineAudioContext`) call it. Every node type used
 * here exists identically on both context types, which is why the biquad family
 * was chosen first: `BiquadFilterNode` is the same object with the same maths
 * in both, so parity is structural rather than something to be tested for.
 *
 * `audioEffectParity.test.ts` asserts that both call sites build through this
 * function, because the failure mode is a future effect wired into one path
 * only — which no listening test would catch until an export.
 *
 * ## The ten, and what each is made of
 *
 *   Parametric EQ  → BiquadFilter 'peaking'
 *   Bass & Treble  → BiquadFilter 'lowshelf' + 'highshelf'
 *   High-Low Pass  → BiquadFilter 'highpass' | 'lowpass'
 *   Delay          → DelayNode + a feedback GainNode
 *   Reverb         → ConvolverNode over a GENERATED impulse response
 *   Flange & Chorus→ DelayNode whose delayTime an LFO modulates
 *   Tone           → Oscillators summed IN, not filtered
 *   Modulator      → an LFO driving a GainNode's gain at audio rate
 *   Stereo Mixer   → ChannelSplitter → four gains → ChannelMerger
 *   Backwards      → not a node at all; see {@link reverseBuffer}
 *
 * ## Two things the first four never needed
 *
 * **Some effects have their own SOURCES.** An LFO or a tone generator is an
 * `AudioScheduledSourceNode`, and one that is never started is silence while
 * one that is never stopped keeps its subgraph alive for the life of the
 * context. Neither is something this function can decide, because the voice's
 * window belongs to the caller — so {@link connectAudioEffects} hands the
 * sources back and the two call sites start and stop them with the buffer they
 * already schedule. Returning them rather than starting them here is what makes
 * the leak impossible to write by accident.
 *
 * **Reverb's impulse response is GENERATED, not shipped.** Decaying noise,
 * from a seeded hash rather than `Math.random`, for the same reason the path
 * operators use one: a render must be reproducible, and an impulse that
 * differed between preview and export would make a reverb tail that changes
 * every time you export — audible, and impossible to diagnose from the UI. It
 * also avoids shipping a binary asset for an effect most projects never use.
 *
 * ## Ordering
 *
 * The chain applies in list order, source → … → gain, so an EQ before a delay
 * colours the dry signal and its echoes alike, while after it colours only the
 * echoes. That is the same convention as the visual effect stack.
 */

import {  type PropPath } from '@motion/animation';

/** Every audio effect. See the header for what each is built from. */
export type AudioEffectType =
  | 'parametric-eq' | 'bass-treble' | 'high-low-pass' | 'delay'
  | 'reverb' | 'flange-chorus' | 'tone' | 'modulator' | 'stereo-mixer'
  | 'backwards'
  // Added 2026-09-12 to close the gap against AE 26.3, which shipped four
  // audio effects this cycle. All three are built from native nodes; see
  // `audioGate.ts` for why the fourth (Gate) is a baked verb instead.
  | 'compressor' | 'distortion' | 'de-esser';

/**
 * The waveforms a generator can make.
 *
 * Wider than `OscillatorType` because AE's Tone offers White Noise, which is
 * not an oscillator at all — it is a looping buffer of hashed samples. Keeping
 * it in the same field is right anyway: to the user it is one "what shape is
 * this sound" question, and the graph builder is the only place that cares
 * which kind of node answers it.
 */
export type AudioWaveform = OscillatorType | 'white-noise';

export interface AudioEffect {
  /** Stable identity, so keyframes scope to an EFFECT and survive reordering —
   *  the same reason `PathOp.id` exists. */
  id: string;
  type: AudioEffectType;
  enabled?: boolean;
  /** Effect parameters, by key. Numbers only: these ride `buildParamRamp`. */
  params?: Record<string, number>;
  /** High-Low Pass only — which side to keep. Discrete, so not keyframeable:
   *  interpolating it would mean a frame that is half a highpass. */
  mode?: 'highpass' | 'lowpass';
  /**
   * Oscillator shape, for the three effects that carry one (Tone, Flange &
   * Chorus, Modulator).
   *
   * A separate field from `mode` rather than a widened union: they are answers
   * to different questions, and one field holding both would let a document
   * store `{ type: 'tone', mode: 'lowpass' }` and typecheck. Discrete for the
   * same reason `mode` is — half a sine and half a square is not a waveform.
   */
  wave?: AudioWaveform;
  /**
   * Distortion only — which transfer curve to clip through.
   *
   * Discrete for the same reason `mode` and `wave` are: halfway between a tube
   * and a fuzz is not a curve, it is a different curve, and interpolating the
   * two would produce a shape neither option describes.
   */
  curve?: DistortionCurve;
  /**
   * Boolean options, by key — Invert Phase, Stereo Voices, Swap Channels,
   * Sibilance Only.
   *
   * A list rather than a field each, because these are the same KIND of thing
   * and adding a field per effect would mean widening `AudioEffect` every time
   * an effect grows a checkbox — the interface would slowly become the union of
   * every effect's options, and a document could typecheck while holding
   * `{ type: 'tone', swapChannels: true }`.
   *
   * Discrete, like `mode` and `wave`, so deliberately NOT keyframeable: there
   * is no halfway between a phase inverted and not.
   *
   * Absent means "no flags set", so an effect nobody has ticked anything on
   * stores no key at all and round-trips byte for byte.
   */
  flags?: string[];
}

/** True when `flag` is set on this effect. */
export function hasFlag(fx: AudioEffect, flag: string): boolean {
  return fx.flags?.includes(flag) === true;
}

/**
 * The boolean options each effect offers, in display order.
 *
 * The inspector renders straight from this, the same way it renders `params`
 * from {@link AUDIO_EFFECT_DEFS} — so a flag cannot exist as a control without
 * the graph builder having somewhere to read it, nor be read without appearing.
 */
export const AUDIO_EFFECT_FLAGS: Partial<Record<AudioEffectType, ReadonlyArray<{ key: string; label: string; hint?: string }>>> = {
  backwards: [
    { key: 'swapChannels', label: 'Swap Channels', hint: 'Play the left channel on the right, and vice versa.' },
  ],
  'stereo-mixer': [
    { key: 'invertPhase', label: 'Invert Phase', hint: 'Flip both channels, so two sounds at one frequency stop cancelling.' },
  ],
  'flange-chorus': [
    { key: 'invertPhase', label: 'Invert Phase', hint: 'Emphasises the high frequencies rather than the low.' },
    { key: 'stereoVoices', label: 'Stereo Voices', hint: 'Alternate the voices left and right across the image.' },
  ],
  'de-esser': [
    { key: 'sibilanceOnly', label: 'Sibilance Only', hint: 'Monitor just the band being treated, to find the right frequency.' },
  ],
};

/** Parameter defaults, and the inert value for each. */
export const AUDIO_EFFECT_DEFS: Record<AudioEffectType, {
  label: string;
  params: ReadonlyArray<{ key: string; label: string; unit?: string; min: number; max: number; default: number }>;
}> = {
  /*
    THREE bands, as AE has. Band 1 keeps the original `frequency` / `gain` / `q`
    keys, so a project saved before this shipped opens with its EQ unchanged and
    two inert bands appended — a band whose gain is 0 is a filter that does
    nothing, which is why there is no separate "Band Enabled" control to get out
    of sync with the gain beside it.
  */
  'parametric-eq': {
    label: 'Parametric EQ',
    params: [
      { key: 'frequency', label: 'Band 1 Frequency', unit: 'Hz', min: 20, max: 20000, default: 1000 },
      { key: 'gain', label: 'Band 1 Gain', unit: 'dB', min: -40, max: 40, default: 0 },
      // Q below 0.0001 is rejected by the spec; the floor keeps a swept Q safe.
      { key: 'q', label: 'Band 1 Q', min: 0.1, max: 20, default: 1 },
      { key: 'frequency2', label: 'Band 2 Frequency', unit: 'Hz', min: 20, max: 20000, default: 3000 },
      { key: 'gain2', label: 'Band 2 Gain', unit: 'dB', min: -40, max: 40, default: 0 },
      { key: 'q2', label: 'Band 2 Q', min: 0.1, max: 20, default: 1 },
      { key: 'frequency3', label: 'Band 3 Frequency', unit: 'Hz', min: 20, max: 20000, default: 8000 },
      { key: 'gain3', label: 'Band 3 Gain', unit: 'dB', min: -40, max: 40, default: 0 },
      { key: 'q3', label: 'Band 3 Q', min: 0.1, max: 20, default: 1 },
    ],
  },
  'bass-treble': {
    label: 'Bass & Treble',
    params: [
      { key: 'bass', label: 'Bass', unit: 'dB', min: -40, max: 40, default: 0 },
      { key: 'treble', label: 'Treble', unit: 'dB', min: -40, max: 40, default: 0 },
    ],
  },
  'high-low-pass': {
    label: 'High-Low Pass',
    params: [
      { key: 'cutoff', label: 'Cutoff', unit: 'Hz', min: 20, max: 20000, default: 1000 },
      { key: 'q', label: 'Resonance', min: 0.1, max: 20, default: 0.707 },
    ],
  },
  delay: {
    label: 'Delay',
    params: [
      { key: 'time', label: 'Delay Time', unit: 's', min: 0, max: 5, default: 0.25 },
      { key: 'feedback', label: 'Feedback', unit: '%', min: 0, max: 95, default: 30 },
      { key: 'mix', label: 'Dry/Wet', unit: '%', min: 0, max: 100, default: 40 },
    ],
  },
  reverb: {
    label: 'Reverb',
    params: [
      { key: 'decay', label: 'Decay Time', unit: 's', min: 0.1, max: 10, default: 1.8 },
      { key: 'preDelay', label: 'Pre-Delay', unit: 'ms', min: 0, max: 200, default: 20 },
      // Reverb without a dry path is a wash with no transient, so the default
      // leans dry — AE's Reverb defaults to 20% wet for the same reason.
      { key: 'mix', label: 'Dry/Wet', unit: '%', min: 0, max: 100, default: 20 },
      // Both shape the IR rather than a live param — see the graph case.
      { key: 'diffusion', label: 'Diffusion', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'brightness', label: 'Brightness', unit: '%', min: 0, max: 100, default: 50 },
    ],
  },
  'flange-chorus': {
    label: 'Flange & Chorus',
    params: [
      // Voice separation IS the difference between the two effects: a few
      // milliseconds comb-filters (flange), tens of milliseconds detunes
      // (chorus). One effect with one control rather than two effects, which is
      // how AE ships it.
      { key: 'separation', label: 'Voice Separation', unit: 'ms', min: 0.1, max: 40, default: 3 },
      { key: 'depth', label: 'Modulation Depth', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'rate', label: 'Modulation Rate', unit: 'Hz', min: 0.05, max: 10, default: 0.4 },
      // Feedback is what makes a flange ring. Chorus uses none.
      { key: 'feedback', label: 'Feedback', unit: '%', min: -95, max: 95, default: 0 },
      { key: 'mix', label: 'Dry/Wet', unit: '%', min: 0, max: 100, default: 50 },
      /*
        VOICES is what separates the two halves of this effect's name. One
        delayed copy comb-filters (flange); several, at different LFO phases,
        read as a small choir (chorus). Defaulting to 1 keeps every project
        saved before this exactly as it sounded.
      */
      { key: 'voices', label: 'Voices', min: 1, max: 8, default: 1 },
      // AE's advice: 360 ÷ voices spreads them evenly around the cycle.
      { key: 'phase', label: 'Voice Phase Change', unit: '°', min: 0, max: 360, default: 90 },
    ],
  },
  /*
    FIVE tones, as AE has, so the effect can make a chord rather than a beep.
    Tones 2–5 default to 0 Hz, which is AE's own "this tone is off" convention
    and keeps an existing single-tone project sounding identical.
  */
  tone: {
    label: 'Tone',
    params: [
      { key: 'frequency', label: 'Frequency 1', unit: 'Hz', min: 0, max: 20000, default: 440 },
      { key: 'frequency2', label: 'Frequency 2', unit: 'Hz', min: 0, max: 20000, default: 0 },
      { key: 'frequency3', label: 'Frequency 3', unit: 'Hz', min: 0, max: 20000, default: 0 },
      { key: 'frequency4', label: 'Frequency 4', unit: 'Hz', min: 0, max: 20000, default: 0 },
      { key: 'frequency5', label: 'Frequency 5', unit: 'Hz', min: 0, max: 20000, default: 0 },
      { key: 'level', label: 'Level', unit: 'dB', min: -60, max: 0, default: -12 },
    ],
  },
  /*
    AE splits FREQUENCY modulation (vibrato) from AMPLITUDE modulation
    (tremolo), and the two sound nothing alike. We had only the amplitude half,
    under the name `depth`; it keeps that name and meaning, and `fmDepth` adds
    the vibrato, defaulting to 0 so nothing already built changes.
  */
  modulator: {
    label: 'Modulator',
    params: [
      { key: 'rate', label: 'Modulation Rate', unit: 'Hz', min: 0.1, max: 5000, default: 30 },
      { key: 'depth', label: 'Amplitude Modulation', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'fmDepth', label: 'Modulation Depth', unit: '%', min: 0, max: 100, default: 0 },
    ],
  },
  'stereo-mixer': {
    label: 'Stereo Mixer',
    params: [
      { key: 'leftLevel', label: 'Left Level', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'rightLevel', label: 'Right Level', unit: '%', min: 0, max: 200, default: 100 },
      // −100 is hard left, +100 hard right. A channel panned to the far side
      // is how you swap the stereo image, which is what this effect is for.
      { key: 'leftPan', label: 'Left Pan', unit: '%', min: -100, max: 100, default: -100 },
      { key: 'rightPan', label: 'Right Pan', unit: '%', min: -100, max: 100, default: 100 },
    ],
  },
  /*
    ── The AE 26.3 additions ──────────────────────────────────────────
    Built entirely from native nodes. That is a constraint, not a
    coincidence: an `AudioWorklet` would have to be reimplemented against
    the `OfflineAudioContext` the export uses and the two proved to agree,
    which is the argument `ducking.ts` sets out at length. Where a control
    could only be honoured by a worklet it is absent rather than faked —
    see the graph cases for exactly which, and why.
  */
  compressor: {
    label: 'Compressor',
    params: [
      { key: 'threshold', label: 'Threshold', unit: 'dB', min: -60, max: 0, default: -16 },
      { key: 'ratio', label: 'Ratio', unit: ':1', min: 1, max: 20, default: 3 },
      { key: 'knee', label: 'Knee', unit: 'dB', min: 0, max: 30, default: 15 },
      { key: 'attack', label: 'Attack', unit: 'ms', min: 0, max: 400, default: 6 },
      { key: 'release', label: 'Release', unit: 'ms', min: 1, max: 1000, default: 440 },
      // Compression lowers everything; makeup puts the level back.
      { key: 'makeupGain', label: 'Makeup Gain', unit: 'dB', min: -30, max: 30, default: 0 },
      { key: 'outputLimit', label: 'Output Limit', unit: 'dB', min: -30, max: 0, default: 0 },
    ],
  },
  distortion: {
    label: 'Distortion',
    params: [
      { key: 'drive', label: 'Drive', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'gain', label: 'Gain', min: 0, max: 300, default: 25 },
      { key: 'mix', label: 'Mix', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'volume', label: 'Volume', min: 0, max: 100, default: 11 },
      // The bitcrusher half. 16 bits is transparent; 4 is a ring tone.
      { key: 'resolution', label: 'Resolution', unit: 'bit', min: 1, max: 16, default: 16 },
    ],
  },
  'de-esser': {
    label: 'De-esser',
    params: [
      { key: 'threshold', label: 'Threshold', unit: 'dB', min: -60, max: 0, default: -20 },
      { key: 'frequency', label: 'Frequency', unit: 'Hz', min: 2000, max: 16000, default: 7000 },
      { key: 'bandwidth', label: 'Bandwidth', unit: 'Hz', min: 500, max: 8000, default: 3000 },
      { key: 'attack', label: 'Attack', unit: 'ms', min: 0, max: 50, default: 1 },
      { key: 'release', label: 'Release', unit: 'ms', min: 5, max: 500, default: 50 },
    ],
  },
  backwards: {
    label: 'Backwards',
    // No parameters. It is a buffer transform, not a filter — see
    // `reverseBuffer`, and note that `connectAudioEffects` deliberately passes
    // it through untouched.
    params: [],
  },
};

/**
 * The waveforms an oscillator-carrying effect may use.
 *
 * `custom` is deliberately absent: it requires a `PeriodicWave` built from
 * coefficients, which is not something a numeric parameter block can carry and
 * not something this UI can offer.
 */
export const OSC_WAVES: readonly OscillatorType[] = ['sine', 'triangle', 'sawtooth', 'square'];

/** Every waveform a generator offers, including the one that is not an
 *  oscillator. See {@link AudioWaveform}. */
export const AUDIO_WAVEFORMS: ReadonlyArray<{ value: AudioWaveform; label: string }> = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'sawtooth', label: 'Saw' },
  { value: 'square', label: 'Square' },
  { value: 'white-noise', label: 'White Noise' },
];

/** AE's six distortion characters. */
export type DistortionCurve =
  | 'soft-clip' | 'hard-clip' | 'saturation-1' | 'saturation-2' | 'tube' | 'fuzz';

export const DISTORTION_CURVES: ReadonlyArray<{ value: DistortionCurve; label: string }> = [
  { value: 'soft-clip', label: 'Soft Clip' },
  { value: 'hard-clip', label: 'Hard Clip' },
  { value: 'saturation-1', label: 'Saturation 1' },
  { value: 'saturation-2', label: 'Saturation 2' },
  { value: 'tube', label: 'Tube' },
  { value: 'fuzz', label: 'Fuzz' },
];

/** Samples in a WaveShaper lookup table. 2048 is smooth enough that the
 *  quantisation of the TABLE is inaudible under the quantisation the
 *  bitcrusher is deliberately adding. */
const CURVE_SAMPLES = 2048;

/**
 * The transfer function for one distortion character, as a WaveShaper curve.
 *
 * Pure and exported so the shapes are unit-testable: the properties that matter
 * (odd symmetry, monotonic, bounded, and inert at zero drive) are easy to
 * assert and impossible to hear yourself into confidence about.
 *
 * `bits` is the bitcrusher, applied AFTER the shaping — quantising the output
 * of the curve, which is what a low-resolution converter does. At 16 bits the
 * step is smaller than the table's own resolution, so it changes nothing.
 */
export function distortionCurve(kind: DistortionCurve, drivePercent: number, bits = 16): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_SAMPLES);
  const d = Math.max(0, Math.min(100, drivePercent)) / 100;
  // `k` spans "barely touched" to "hard", shaped so the first half of the
  // control does something audible rather than all the action living at the top.
  const k = 1 + d * d * 60;
  const levels = bits >= 16 ? 0 : Math.pow(2, Math.max(1, Math.min(16, bits))) - 1;

  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const x = (i / (CURVE_SAMPLES - 1)) * 2 - 1;
    let y: number;
    switch (kind) {
      case 'hard-clip':
        y = Math.max(-1, Math.min(1, x * (1 + d * 9)));
        break;
      case 'saturation-1':
        y = Math.tanh(x * k * 0.5);
        break;
      case 'saturation-2':
        // Steeper than tanh near the origin, so it colours quiet passages too.
        y = Math.sign(x) * (1 - Math.exp(-Math.abs(x) * k * 0.6));
        break;
      case 'tube':
        /*
          ASYMMETRIC on purpose. A valve clips the two halves of the wave
          differently, and that asymmetry is what produces the even harmonics
          people mean by "tube warmth" — a symmetric curve makes only odd ones
          and sounds like a transistor.
        */
        y = x >= 0 ? Math.tanh(x * k * 0.5) : Math.tanh(x * k * 0.3) * 0.85;
        break;
      case 'fuzz': {
        // Near-square: almost everything is pushed to the rails.
        const t = Math.tanh(x * (1 + d * 200));
        y = t * 0.9 + Math.sign(x) * 0.1 * d;
        break;
      }
      case 'soft-clip':
      default:
        // The classic arctan soft clip: linear through the origin, bending
        // gently into the rails, so at zero drive it is exactly a wire.
        y = d === 0 ? x : Math.atan(x * k) / Math.atan(k);
        break;
    }
    // Bitcrush: snap to the nearest of `levels` steps across -1..1.
    if (levels > 0) y = Math.round(((y + 1) / 2) * levels) / levels * 2 - 1;
    curve[i] = Math.max(-1, Math.min(1, y));
  }
  return curve;
}

/** The effects that read `wave`. Anything else showing the control would be
 *  offering a setting nothing consumes. */
export const WAVE_EFFECTS: ReadonlySet<AudioEffectType> = new Set<AudioEffectType>([
  'tone', 'flange-chorus', 'modulator',
]);

/**
 * Impulse responses, memoised by the parameters that determine them.
 *
 * Generating one is O(decay × sampleRate) — a 10-second tail at 48 kHz is
 * nearly a million samples per channel — and `connectAudioEffects` runs on
 * every voice start, which during scrubbing is many times a second. Keyed by
 * sample rate as well, because live and offline contexts differ in it and an IR
 * built at the wrong rate would play back at the wrong length.
 */
const irCache = new Map<string, AudioBuffer>();

/** Only for tests — the cache is process-wide and would leak between them. */
export function clearImpulseCacheForTests(): void {
  irCache.clear();
}

/**
 * The keyframe path for one audio effect's parameter.
 *
 * Scoped by effect ID rather than index, so reordering the chain does not hand
 * an effect its neighbour's automation — the same failure `pathOpPropPath`
 * exists to prevent.
 */
export function audioEffectPropPath(effectId: string, param: string): PropPath {
  return `audiofx.${effectId}.${param}`;
}

/**
 * What building a chain produced: where to connect onward, and what to schedule.
 *
 * The `sources` half exists because an LFO and a tone generator are
 * `AudioScheduledSourceNode`s, and this function cannot know the voice's
 * window — the caller owns that. Handing them back rather than starting them
 * here means the two failure modes are unwritable: an unstarted oscillator is
 * silence, and an unstopped one holds its subgraph alive for the life of the
 * context. Both are invisible until someone profiles or listens closely.
 */
export interface AudioEffectChain {
  /** Connect this onward. `from` itself when the chain is empty. */
  node: AudioNode;
  /** Start and stop these with the voice. Empty for every effect that filters. */
  sources: AudioScheduledSourceNode[];
}

/**
 * The voice window, for effect parameters that are keyframed.
 *
 * Absent means "assign the static values", which is what a caller with no
 * animation to schedule should do — and what every caller did before effect
 * parameters were animatable.
 *
 * Present means every AudioParam this chain owns is SCHEDULED rather than
 * assigned, through the same `buildRamp`/`applyRamp` pair the level uses. The
 * reason effect parameters were kept numeric in the first place is that they
 * are the same shape as level and can ride the same scheduler; growing a second
 * one is the failure `audioParams.ts` opens by warning about.
 */
export interface EffectAutomation {
  /** The layer's node id — the animation tracks hang off it. */
  nodeId: string;
  /** Composition time this voice begins at. Ramps are sampled from here. */
  startCompSec: number;
  /** How long the voice lasts, in seconds. */
  durationSec: number;
  /** Context time to anchor the schedule at (`ctx.currentTime`, or `win.when`). */
  whenCtx: number;
}

/** True when this chain would change the signal at all. */
export function hasActiveAudioEffects(effects: readonly AudioEffect[] | undefined): boolean {
  return !!effects?.some((f) => f.enabled !== false);
}

/* ── Backwards: the one effect that is not a node ─────────────────────────── */

/**
 * True when this chain reverses its source.
 *
 * Order-independent on purpose. Every other effect applies in list position;
 * this one cannot, because it happens to the buffer before any node exists. A
 * Backwards anywhere in the stack reverses the clip, and moving it up or down
 * changes nothing — which is worth knowing before someone files it as a bug.
 */
export function hasBackwards(effects: readonly AudioEffect[] | undefined): boolean {
  return !!effects?.some((f) => f.type === 'backwards' && f.enabled !== false);
}

/**
 * Reversed copies, keyed by the buffer they came from.
 *
 * A `WeakMap`, so a reversed copy dies with the asset it mirrors rather than
 * pinning a decoded file in memory for the session. Cached at all because
 * reversing allocates a full second copy of the audio and `startVoice` runs on
 * every seek — without this, scrubbing a reversed layer would reverse the whole
 * file per frame.
 */
const reversedCache = new WeakMap<AudioBuffer, AudioBuffer>();

/** The same audio, sample-reversed. Pure with respect to its input. */
export function reverseBuffer(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const hit = reversedCache.get(buffer);
  if (hit) return hit;
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    const n = src.length;
    for (let i = 0; i < n; i++) dst[i] = src[n - 1 - i]!;
  }
  reversedCache.set(buffer, out);
  return out;
}

/**
 * Where to start reading a REVERSED buffer to hear a given span backwards.
 *
 * ★ The half of Backwards that is easy to miss, and silent when wrong.
 *
 * `source.start(when, offset, duration)` addresses the buffer it was handed. If
 * the buffer is reversed but the offset is not, a clip trimmed to seconds 2–4
 * of a ten-second file plays seconds 6–8 backwards instead — audio, in time,
 * from entirely the wrong part of the file. Nothing errors, and on unfamiliar
 * material nothing sounds obviously wrong either.
 *
 * Mirroring the window fixes it: the span `[offset, offset + duration)` of the
 * forward buffer is `[total − offset − duration, total − offset)` of the
 * reversed one.
 */
export function backwardsOffset(totalSec: number, offset: number, duration: number): number {
  return Math.max(0, totalSec - offset - duration);
}

/** Where the chain lives on a node's `fx` component. */
export const AUDIO_EFFECTS_PROP = 'audioEffects';

/**
 * A node's audio effect chain, validated on the way out.
 *
 * Returns `undefined` rather than `[]` for the empty case, so
 * {@link connectAudioEffects} takes its no-allocation path and a project
 * without effects builds precisely the graph it always did.
 *
 * Entries are filtered rather than trusted: a `.motion` document is data, and a
 * malformed effect that reached the graph builder would either throw inside the
 * audio thread or silence the layer — both worse than being dropped here.
 */
export function readAudioEffects(node: { components: ReadonlyArray<{ type: string; props: unknown }> }): AudioEffect[] | undefined {
  const fx = node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
  const raw = fx?.[AUDIO_EFFECTS_PROP];
  if (!Array.isArray(raw)) return undefined;
  const out: AudioEffect[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Partial<AudioEffect>;
    if (typeof o.id !== 'string' || !o.id) continue;
    if (typeof o.type !== 'string' || !(o.type in AUDIO_EFFECT_DEFS)) continue;
    const params: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.params ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
    }
    out.push({
      id: o.id,
      type: o.type as AudioEffectType,
      params,
      ...(o.enabled === false ? { enabled: false } : {}),
      ...(o.mode === 'lowpass' || o.mode === 'highpass' ? { mode: o.mode } : {}),
      // Validated against the same list the UI offers, not merely typeof
      // 'string': an unknown waveform assigned to `osc.type` throws inside the
      // audio thread, which surfaces as the voice failing to start rather than
      // as a bad document.
      ...(OSC_WAVES.includes(o.wave as OscillatorType) ? { wave: o.wave } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}
