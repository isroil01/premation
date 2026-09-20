/**
 * Building a PLUGIN's audio effect into the same WebAudio chain the built-in
 * ones use.
 *
 * ── Where this plugs in, and why there ──────────────────────────────────────
 *
 * `connectAudioEffects` ends in a `default:` branch whose comment reads: "An
 * unknown type passes the signal through untouched. A stored project from a
 * newer build must stay audible, not fall silent." A plugin effect has always
 * landed there — declared, addable, and completely inaudible.
 *
 * This is what that branch consults before giving up. One function, called
 * from the one builder, so a plugin audio effect is wired by exactly the code
 * that wires a Parametric EQ — which is what makes live playback and offline
 * mixdown agree about it without a second implementation to keep true.
 *
 * ── Every setting goes through the caller's `bind` ──────────────────────────
 *
 * The builder owns scheduling: `bind` assigns a static value or lays a ramp
 * over an animated one, and `audioParams.ts`'s rule is that every audio
 * parameter rides that same seam. So this function never touches an
 * `AudioParam` directly — it is handed `bind` and uses it for everything,
 * which is how a keyframed PLUGIN parameter schedules identically to a
 * keyframed built-in one.
 *
 * ── The registry is consulted, never trusted ────────────────────────────────
 *
 * A declaration is validated at parse (`audioEffectSchema.ts`), but the
 * document can name an effect whose plugin is uninstalled, disabled or a
 * different version. Every one of those resolves to "no nodes", and the signal
 * passes through — the same degradation the `default:` branch already promised.
 */

import {
  MAX_DELAY_SECONDS,
  type AudioEffectContribution,
  type AudioNodeValue,
  type PluginAudioNode,
} from './audioEffectSchema';

/**
 * How the caller assigns a value: static or scheduled, its decision.
 *
 * `keys` is what to WATCH — a setting derived from one parameter must not
 * re-schedule because a different one is keyframed.
 */
export type BindParam = (
  target: AudioParam,
  keys: readonly string[],
  derive: (read: (key: string) => number) => number,
) => void;

/** Resolved audio-effect contributions, by namespaced type. Injected so this
 *  module does not import the plugin registry — it is reached from the render
 *  path, which runs in the export worker with no store behind it. */
export type AudioEffectLookup = (type: string) => AudioEffectContribution | undefined;

let lookup: AudioEffectLookup = () => undefined;

export function setPluginAudioEffects(next: AudioEffectLookup): void {
  lookup = next;
}

/** Is `type` an audio effect some installed plugin provides? */
export function isPluginAudioEffect(type: string): boolean {
  return lookup(type) !== undefined;
}

/**
 * Wire one plugin audio effect, returning the new end of the chain.
 *
 * Returns `from` unchanged for anything it cannot build, which is the
 * pass-through the caller already does for an unknown type.
 */
export function connectPluginAudioEffect(
  ctx: BaseAudioContext,
  from: AudioNode,
  type: string,
  bind: BindParam,
): AudioNode {
  const contribution = lookup(type);
  if (!contribution) return from;

  // Each param's ceiling, for the one node that must be built big enough for
  // where a sweep ENDS rather than where it starts. Defaults are NOT needed:
  // every referenced setting goes through `bind`, which reads the live value.
  const maxima = new Map(contribution.params.map((p) => [p.key, p.max]));

  let node: AudioNode = from;
  for (const spec of contribution.chain) {
    const built = buildNode(ctx, spec, maxima, bind);
    if (!built) continue;
    node.connect(built);
    node = built;
  }
  return node;
}

function buildNode(
  ctx: BaseAudioContext,
  spec: PluginAudioNode,
  maxima: ReadonlyMap<string, number>,
  bind: BindParam,
): AudioNode | null {
  /** Assign one declared setting through the caller's scheduler. */
  const apply = (target: AudioParam, value: AudioNodeValue | undefined, fallback: number): void => {
    if (value === undefined) {
      target.value = fallback;
      return;
    }
    if (typeof value === 'number') {
      target.value = value;
      return;
    }
    // A parameter reference. `keys` is the single param it derives from, so a
    // static one keeps the plain assignment it would have had.
    bind(target, [value.param], (read) => read(value.param));
  };

  const set = spec.set ?? {};
  /**
   * The largest value a setting can reach — its own number, or the declared
   * MAXIMUM of the param driving it.
   *
   * The maximum rather than the default, and only a delay line cares: a param
   * that defaults to 0 and sweeps to 2 seconds would otherwise reserve a
   * millisecond, and `DelayNode` cannot grow past what it was built with. The
   * symptom is an animated delay that silently stops getting longer.
   */
  const ceilingOf = (name: string, whenAbsent: number): number => {
    const v = set[name];
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object') return maxima.get(v.param) ?? whenAbsent;
    return whenAbsent;
  };

  switch (spec.kind) {
    case 'biquad': {
      const f = ctx.createBiquadFilter();
      f.type = (spec.type ?? 'peaking') as BiquadFilterType;
      apply(f.frequency, set.frequency, 1000);
      apply(f.Q, set.Q, 1);
      apply(f.gain, set.gain, 0);
      apply(f.detune, set.detune, 0);
      return f;
    }
    case 'gain': {
      const g = ctx.createGain();
      apply(g.gain, set.gain, 1);
      return g;
    }
    case 'delay': {
      // `DelayNode` needs its ceiling at construction and cannot grow past it,
      // so an animated delayTime is clamped by what was reserved here rather
      // than by what it sweeps to. Reserve the declared maximum.
      const want = Math.max(ceilingOf('delayTime', 0), 0.001);
      const d = ctx.createDelay(Math.min(MAX_DELAY_SECONDS, want));
      apply(d.delayTime, set.delayTime, 0);
      return d;
    }
    case 'panner': {
      // `StereoPannerNode` is the same object on both context types, which is
      // why it is here and `PannerNode` (whose HRTF differs) is not.
      const p = ctx.createStereoPanner();
      apply(p.pan, set.pan, 0);
      return p;
    }
    case 'compressor': {
      const c = ctx.createDynamicsCompressor();
      apply(c.threshold, set.threshold, -24);
      apply(c.knee, set.knee, 30);
      apply(c.ratio, set.ratio, 12);
      apply(c.attack, set.attack, 0.003);
      apply(c.release, set.release, 0.25);
      return c;
    }
    case 'waveshaper': {
      const w = ctx.createWaveShaper();
      if (spec.curve && spec.curve.length >= 2) {
        w.curve = Float32Array.from(spec.curve);
      }
      // Oversampling is the host's call, not the plugin's: it is a quality
      // knob with a cost, and the answer is the same for every shaper.
      w.oversample = '2x';
      return w;
    }
    default:
      return null;
  }
}
