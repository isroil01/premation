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

import { defaultAnimation, type PropPath } from '@motion/animation';
import { buildRamp, applyRamp } from './audioParams';

/** Every audio effect. See the header for what each is built from. */
export type AudioEffectType =
  | 'parametric-eq' | 'bass-treble' | 'high-low-pass' | 'delay'
  | 'reverb' | 'flange-chorus' | 'tone' | 'modulator' | 'stereo-mixer'
  | 'backwards';

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
  wave?: OscillatorType;
}

/** Parameter defaults, and the inert value for each. */
export const AUDIO_EFFECT_DEFS: Record<AudioEffectType, {
  label: string;
  params: ReadonlyArray<{ key: string; label: string; unit?: string; min: number; max: number; default: number }>;
}> = {
  'parametric-eq': {
    label: 'Parametric EQ',
    params: [
      { key: 'frequency', label: 'Frequency', unit: 'Hz', min: 20, max: 20000, default: 1000 },
      { key: 'gain', label: 'Gain', unit: 'dB', min: -40, max: 40, default: 0 },
      // Q below 0.0001 is rejected by the spec; the floor keeps a swept Q safe.
      { key: 'q', label: 'Q', min: 0.1, max: 20, default: 1 },
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
    ],
  },
  tone: {
    label: 'Tone',
    params: [
      { key: 'frequency', label: 'Frequency', unit: 'Hz', min: 20, max: 20000, default: 440 },
      { key: 'level', label: 'Level', unit: 'dB', min: -60, max: 0, default: -12 },
    ],
  },
  modulator: {
    label: 'Modulator',
    params: [
      { key: 'rate', label: 'Modulation Rate', unit: 'Hz', min: 0.1, max: 5000, default: 30 },
      { key: 'depth', label: 'Modulation Depth', unit: '%', min: 0, max: 100, default: 50 },
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

/** The effects that read `wave`. Anything else showing the control would be
 *  offering a setting nothing consumes. */
export const WAVE_EFFECTS: ReadonlySet<AudioEffectType> = new Set<AudioEffectType>([
  'tone', 'flange-chorus', 'modulator',
]);

/** Shelf corner frequencies for Bass & Treble, matching AE's fixed bands. */
const BASS_SHELF_HZ = 320;
const TREBLE_SHELF_HZ = 3200;

/** Longest delay line we allocate. `DelayNode` needs its max up front. */
const MAX_DELAY_SEC = 5;

/** dB → linear gain. −60 dB is the floor the Tone control bottoms out at. */
const dbToGain = (db: number): number => 10 ** (db / 20);

/**
 * A reverb impulse response, generated rather than shipped.
 *
 * Exponentially decaying noise: the standard synthetic IR, and enough for the
 * "put this in a room" job an audio effect on a motion-graphics layer is doing.
 * It is not a convolution of a real space, and does not claim to be.
 *
 * ★ The noise is a SEEDED HASH, never `Math.random`. Two renders of one project
 * must produce the same file, and a reverb tail is long enough that a different
 * noise field is audible rather than academic — the same reason the path
 * operators hash instead of randomising. It also means the live preview and the
 * offline export share a tail, which is the whole point of this module.
 *
 * `preDelaySec` is silence in front of the decay: the gap before the first
 * reflection, which is what makes a room read as large rather than merely wet.
 */
function impulseResponse(
  ctx: BaseAudioContext,
  decaySec: number,
  preDelaySec: number,
  seed: number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const pre = Math.max(0, Math.round(preDelaySec * rate));
  const tail = Math.max(1, Math.round(decaySec * rate));
  // Stereo, and the two channels use DIFFERENT hash streams. One field copied
  // to both would put the whole tail dead centre, which sounds like a mono
  // effect bolted onto a stereo mix rather than like a space.
  const buf = ctx.createBuffer(2, pre + tail, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < tail; i++) {
      let h = (i + 1) * 374761393 + ch * 668265263 + seed * 2246822519;
      h = (h ^ (h >>> 13)) * 1274126177;
      const noise = (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
      // Exponential decay to −60 dB across the requested time, which is the
      // usual definition of a reverb's decay (RT60).
      data[pre + i] = noise * 10 ** ((-3 * i) / tail);
    }
  }
  return buf;
}

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
function cachedImpulse(ctx: BaseAudioContext, decay: number, preDelay: number, seed: number): AudioBuffer {
  const key = `${ctx.sampleRate}|${decay.toFixed(3)}|${preDelay.toFixed(4)}|${seed}`;
  let ir = irCache.get(key);
  if (!ir) {
    ir = impulseResponse(ctx, decay, preDelay, seed);
    irCache.set(key, ir);
  }
  return ir;
}

/** Only for tests — the cache is process-wide and would leak between them. */
export function clearImpulseCacheForTests(): void {
  irCache.clear();
}

function num(fx: AudioEffect, key: string, fallback: number): number {
  const v = fx.params?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Clamp, applied INSIDE a derivation so it holds at every sampled point.
 *
 * The distinction matters once parameters animate. Clamping the static value
 * once and then scheduling an unclamped curve through it lets a keyframed sweep
 * leave the safe range in the middle — which for Q or feedback is not "sounds
 * wrong" but "throws in the audio thread" or "never decays".
 */
const clampTo = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const def = (t: AudioEffectType, key: string): number =>
  AUDIO_EFFECT_DEFS[t].params.find((p) => p.key === key)?.default ?? 0;

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

/** True when this effect parameter carries keyframes on this layer. */
export function isEffectParamAnimated(nodeId: string, effectId: string, param: string): boolean {
  const path = audioEffectPropPath(effectId, param);
  return defaultAnimation.tracksFor(nodeId).some((t) => t.prop === path && t.keyframes.length > 0);
}

/**
 * One effect parameter at a composition time, falling back to its static value.
 *
 * Mirrors `sampleLevelDb` exactly, and returns the parameter's own units — no
 * dB conversion, because only Tone's Level is in decibels and that conversion
 * belongs at the one node that needs it, not in the sampler.
 */
export function sampleEffectParam(
  nodeId: string,
  effectId: string,
  param: string,
  staticValue: number,
  compSec: number,
): number {
  const v = defaultAnimation.sample(nodeId, audioEffectPropPath(effectId, param), compSec);
  return typeof v === 'number' && Number.isFinite(v) ? v : staticValue;
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

/**
 * Build the effect chain and connect it between `from` and the returned node.
 *
 * Returns `from` unchanged when there is nothing to apply, so a layer with no
 * effects allocates no nodes and the graph is byte-identical to what it was
 * before this file existed. That is what keeps existing projects silent-safe.
 *
 * `ctx` is deliberately typed as `BaseAudioContext` — the common supertype of
 * `AudioContext` and `OfflineAudioContext` — because accepting only the former
 * is exactly how a live-only code path gets written by accident.
 */
export function connectAudioEffects(
  ctx: BaseAudioContext,
  from: AudioNode,
  effects: readonly AudioEffect[] | undefined,
  automation?: EffectAutomation,
): AudioEffectChain {
  if (!effects || effects.length === 0) return { node: from, sources: [] };
  let node: AudioNode = from;
  const sources: AudioScheduledSourceNode[] = [];

  for (const fx of effects) {
    if (fx.enabled === false) continue;

    /**
     * Give an AudioParam its value — scheduled when animated, assigned when not.
     *
     * Every parameter assignment in this function goes through here, so
     * "animatable" is a property of the whole effect family rather than of the
     * effects someone remembered to wire. `derive` maps the effect's own
     * parameters to the value this particular param wants, which is what lets a
     * single control drive several nodes: Dry/Wet is `mix` on one gain and
     * `1 − mix` on another, and Depth is both the LFO's swing and the base gain
     * it swings around.
     *
     * `keys` is what to WATCH. A param derived from `mix` alone must not
     * re-schedule because `time` is keyframed, and — more importantly — a
     * param whose keys are all static keeps the single assignment it always
     * had, so an unanimated project builds precisely the graph it used to.
     */
    const bind = (
      target: AudioParam,
      keys: readonly string[],
      derive: (read: (key: string) => number) => number,
    ): void => {
      const staticRead = (k: string): number => num(fx, k, def(fx.type, k));
      const animatedKeys = automation
        ? keys.filter((k) => isEffectParamAnimated(automation.nodeId, fx.id, k))
        : [];
      if (!automation || animatedKeys.length === 0) {
        target.value = derive(staticRead);
        return;
      }
      const ramp = buildRamp(
        (compSec) => derive((k) => (
          animatedKeys.includes(k)
            ? sampleEffectParam(automation.nodeId, fx.id, k, staticRead(k), compSec)
            : staticRead(k)
        )),
        automation.startCompSec,
        automation.durationSec,
        { animated: true },
      );
      applyRamp(target, ramp, automation.whenCtx);
    };
    switch (fx.type) {
      case 'parametric-eq': {
        const f = ctx.createBiquadFilter();
        f.type = 'peaking';
        bind(f.frequency, ['frequency'], (r) => r('frequency'));
        bind(f.gain, ['gain'], (r) => r('gain'));
        // The spec rejects Q <= 0, and the clamp is INSIDE the derivation so it
        // applies at every sampled point of an animated sweep — a curve that
        // passes through zero would throw mid-render, which is worse than
        // sounding wrong.
        bind(f.Q, ['q'], (r) => Math.max(0.0001, r('q')));
        node = node.connect(f);
        break;
      }
      case 'bass-treble': {
        // TWO nodes, not one: a shelf filter shapes one end of the spectrum, so
        // bass and treble cannot share a node. They are chained low → high.
        const low = ctx.createBiquadFilter();
        low.type = 'lowshelf';
        // The corner frequencies are FIXED (AE's bands), so they are assigned
        // rather than bound — there is no parameter behind them to animate.
        low.frequency.value = BASS_SHELF_HZ;
        bind(low.gain, ['bass'], (r) => r('bass'));
        const high = ctx.createBiquadFilter();
        high.type = 'highshelf';
        high.frequency.value = TREBLE_SHELF_HZ;
        bind(high.gain, ['treble'], (r) => r('treble'));
        node = node.connect(low).connect(high);
        break;
      }
      case 'high-low-pass': {
        const f = ctx.createBiquadFilter();
        f.type = fx.mode === 'lowpass' ? 'lowpass' : 'highpass';
        bind(f.frequency, ['cutoff'], (r) => r('cutoff'));
        bind(f.Q, ['q'], (r) => Math.max(0.0001, r('q')));
        node = node.connect(f);
        break;
      }
      case 'delay': {
        /**
         * Dry and wet in PARALLEL, summed — not a delay in series.
         *
         * A DelayNode alone shifts the whole signal later, which is a latency
         * bug, not an echo. The echo is the delayed copy mixed UNDER the
         * original, so the input fans out to a dry gain and a delay line whose
         * output feeds back into itself.
         */
        const delay = ctx.createDelay(MAX_DELAY_SEC);
        bind(delay.delayTime, ['time'], (r) => clampTo(r('time'), 0, MAX_DELAY_SEC));
        const feedback = ctx.createGain();
        // Capped below 1 at every sampled point, not merely at build time: at
        // unity the loop rings forever, which in an offline render is a file
        // that never decays rather than an effect.
        bind(feedback.gain, ['feedback'], (r) => clampTo(r('feedback') / 100, 0, 0.95));
        // Dry and wet are ONE control read two ways. Both watch `mix`, so a
        // keyframed Dry/Wet moves the pair in opposite directions in step —
        // binding only the wet side would raise the effect without lowering the
        // signal under it, and the layer would get louder as it got wetter.
        const dry = ctx.createGain();
        bind(dry.gain, ['mix'], (r) => 1 - clampTo(r('mix') / 100, 0, 1));
        const wet = ctx.createGain();
        bind(wet.gain, ['mix'], (r) => clampTo(r('mix') / 100, 0, 1));
        const sum = ctx.createGain();

        node.connect(dry).connect(sum);
        node.connect(delay);
        delay.connect(feedback).connect(delay); // the regeneration loop
        delay.connect(wet).connect(sum);
        node = sum;
        break;
      }
      case 'reverb': {
        /*
          Dry and wet in parallel, exactly as Delay is, and for the same reason:
          a ConvolverNode in series replaces the signal with its reverberation,
          which is a special effect rather than a room.
        */
        /*
          Decay and Pre-Delay are NOT animatable, and that is a property of the
          effect rather than an omission. They determine the impulse RESPONSE —
          a buffer, built once and handed to the node — and there is no
          AudioParam behind them to schedule. Animating them would mean
          regenerating and swapping a multi-second buffer mid-voice, which is a
          click at best. Dry/Wet is the control that rides automation here, and
          it is the one a fade actually wants.
        */
        const decay = clampTo(num(fx, 'decay', def('reverb', 'decay')), 0.1, 10);
        const preMs = clampTo(num(fx, 'preDelay', def('reverb', 'preDelay')), 0, 200);

        const conv = ctx.createConvolver();
        // `normalize = false`: the generated IR already decays from unity, and
        // letting the node renormalise would make loudness depend on the decay
        // TIME — a longer tail would come back quieter, so sweeping Decay would
        // change the level as a side effect.
        conv.normalize = false;
        // Seeded from the effect's own id, so two reverbs in one project have
        // different tails (as two real spaces would) while each is stable
        // across renders.
        conv.buffer = cachedImpulse(ctx, decay, preMs / 1000, hashId(fx.id));

        const dry = ctx.createGain();
        bind(dry.gain, ['mix'], (r) => 1 - clampTo(r('mix') / 100, 0, 1));
        const wet = ctx.createGain();
        bind(wet.gain, ['mix'], (r) => clampTo(r('mix') / 100, 0, 1));
        const sum = ctx.createGain();
        node.connect(dry).connect(sum);
        node.connect(conv).connect(wet).connect(sum);
        node = sum;
        break;
      }
      case 'flange-chorus': {
        /*
          A delay line whose length an LFO moves. That single mechanism is both
          effects: a few milliseconds of separation comb-filters the signal
          against itself (flange), tens of milliseconds read as a second
          slightly-detuned voice (chorus).

          The LFO drives `delayTime` through a depth gain rather than being
          summed into the audio, so it is a control signal and never audible on
          its own.
        */
        /** Base delay, in seconds, from the Voice Separation control. */
        const baseOf = (r: (k: string) => number): number => clampTo(r('separation'), 0.1, 40) / 1000;

        const delay = ctx.createDelay(MAX_DELAY_SEC);
        // The LFO is CONNECTED to this same param. A connected input sums with
        // whatever value is scheduled, so a keyframed separation moves the
        // centre the LFO sweeps around rather than fighting it.
        bind(delay.delayTime, ['separation'], baseOf);
        const lfo = ctx.createOscillator();
        lfo.type = fx.wave ?? 'sine';
        bind(lfo.frequency, ['rate'], (r) => clampTo(r('rate'), 0.05, 10));
        const lfoDepth = ctx.createGain();
        // HALF the base separation at full depth, so the delay can never reach
        // zero — and derived from BOTH controls, so automating either one keeps
        // that guarantee. A delay line crossing zero clicks, and at exactly zero
        // the feedback loop becomes a direct connection: instant runaway.
        bind(lfoDepth.gain, ['separation', 'depth'],
          (r) => baseOf(r) * 0.5 * clampTo(r('depth') / 100, 0, 1));
        lfo.connect(lfoDepth).connect(delay.delayTime);
        sources.push(lfo);

        const feedback = ctx.createGain();
        // Signed: negative feedback inverts the comb and hollows the sound out,
        // which is half of what a flanger is for.
        bind(feedback.gain, ['feedback'], (r) => clampTo(r('feedback') / 100, -0.95, 0.95));
        const dry = ctx.createGain();
        bind(dry.gain, ['mix'], (r) => 1 - clampTo(r('mix') / 100, 0, 1));
        const wet = ctx.createGain();
        bind(wet.gain, ['mix'], (r) => clampTo(r('mix') / 100, 0, 1));
        const sum = ctx.createGain();

        node.connect(dry).connect(sum);
        node.connect(delay);
        delay.connect(feedback).connect(delay);
        delay.connect(wet).connect(sum);
        node = sum;
        break;
      }
      case 'tone': {
        /*
          A GENERATOR, so it is summed IN rather than filtering what arrives.
          Every other effect here transforms `node`; this one adds to it, which
          is why the chain is a sum and the input still reaches the output
          untouched. Placing it in the chain at all (rather than beside it) is
          what lets a later EQ or reverb treat the tone along with the layer.
        */
        const osc = ctx.createOscillator();
        osc.type = fx.wave ?? 'sine';
        // A keyframed frequency is a SWEEP, and the ramp scheduler is what makes
        // it one: assigning `.value` per frame would step the pitch once per
        // render quantum, which is the zipper noise `audioParams` exists to
        // avoid — audible here as a staircase rather than a glide.
        bind(osc.frequency, ['frequency'], (r) => clampTo(r('frequency'), 20, 20000));
        const amp = ctx.createGain();
        // dB → linear INSIDE the derivation, so an animated Level interpolates
        // in decibels (which is how a fade is heard) rather than in amplitude.
        bind(amp.gain, ['level'], (r) => dbToGain(clampTo(r('level'), -60, 0)));
        const sum = ctx.createGain();
        node.connect(sum);
        osc.connect(amp).connect(sum);
        sources.push(osc);
        node = sum;
        break;
      }
      case 'modulator': {
        /*
          Amplitude modulation: an LFO driving a gain at audio rate. Below ~20 Hz
          that is a tremolo; above it, sidebands appear and it becomes the metallic
          ring-modulation AE's Modulator is known for. One mechanism, and the Rate
          control is what moves between them — hence a range that spans both.

          The base gain is `1 − depth` and the LFO contributes `depth`, so the
          signal is never amplified: at depth 0 the gain sits at 1 and the effect
          is inaudible, and at depth 1 it swings the full 0…2 around... which is
          why the LFO's own gain is `depth` and the base `1 − depth`, keeping the
          peak at 1 and the effect a modulation rather than a boost.
        */
        const vca = ctx.createGain();
        // Base and swing both watch `depth` and always sum to 1 — automating it
        // keeps the peak at unity through the whole sweep. Binding only one of
        // the pair would make Depth a volume control at one end of its travel.
        bind(vca.gain, ['depth'], (r) => 1 - clampTo(r('depth') / 100, 0, 1));
        const lfo = ctx.createOscillator();
        lfo.type = fx.wave ?? 'sine';
        bind(lfo.frequency, ['rate'], (r) => clampTo(r('rate'), 0.1, 5000));
        const lfoDepth = ctx.createGain();
        bind(lfoDepth.gain, ['depth'], (r) => clampTo(r('depth') / 100, 0, 1));
        lfo.connect(lfoDepth).connect(vca.gain);
        sources.push(lfo);

        node = node.connect(vca);
        break;
      }
      case 'stereo-mixer': {
        /*
          Split to two channels, level and pan each independently, merge back.

          Four gains and not two, because panning a channel means sending it to
          BOTH outputs at complementary amounts — that is what a pan control is.
          Two gains could only set each channel's loudness, which is the half of
          this effect that already exists as `level`.

          Equal-power (cosine/sine) rather than linear: a linear pan dips ~3 dB
          in the middle, so sweeping a source across the image would sound like
          it also moved away.
        */
        // −1…+1 → an angle in 0…π/2, then cosine to the left and sine to the
        // right. cos² + sin² = 1, so total power is constant across the sweep.
        const legGain = (level: number, pan: number, side: 'l' | 'r'): number => {
          const a = (clampTo(pan, -1, 1) + 1) / 2 * (Math.PI / 2);
          return clampTo(level, 0, 2) * (side === 'l' ? Math.cos(a) : Math.sin(a));
        };

        const split = ctx.createChannelSplitter(2);
        const merge = ctx.createChannelMerger(2);
        /*
          Each leg is bound to BOTH of its own controls.

          A leg's gain is level × pan, so automating either one has to move it.
          Watching only the level would freeze the image the moment a pan was
          keyframed — the effect would appear to work until someone animated the
          control it exists for.
        */
        const leg = (levelKey: string, panKey: string, side: 'l' | 'r'): GainNode => {
          const n = ctx.createGain();
          bind(n.gain, [levelKey, panKey],
            (r) => legGain(r(levelKey) / 100, r(panKey) / 100, side));
          return n;
        };
        node.connect(split);
        // Channel 0 (left in) fans out to both merger inputs, and so does 1.
        split.connect(leg('leftLevel', 'leftPan', 'l'), 0).connect(merge, 0, 0);
        split.connect(leg('leftLevel', 'leftPan', 'r'), 0).connect(merge, 0, 1);
        split.connect(leg('rightLevel', 'rightPan', 'l'), 1).connect(merge, 0, 0);
        split.connect(leg('rightLevel', 'rightPan', 'r'), 1).connect(merge, 0, 1);
        node = merge;
        break;
      }
      case 'backwards':
        /*
          Deliberately nothing. Backwards reverses the SOURCE BUFFER, which
          happens before the graph exists — see `reverseBuffer` and
          `backwardsOffset`. Listed here rather than left to the default so a
          reader does not conclude it was forgotten.
        */
        break;
      default:
        // An unknown type passes the signal through untouched. A stored project
        // from a newer build must stay audible, not fall silent.
        break;
    }
  }
  return { node, sources };
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

/** FNV-style hash of an effect id, so a seed is stable across sessions. */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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
