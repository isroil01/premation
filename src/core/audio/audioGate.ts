/**
 * Noise Gate — silence a layer while it is below a threshold.
 *
 * ## Why this is a baked verb and not a chain effect
 *
 * AE ships Gate as an audio effect. We ship it as a verb that writes level
 * keyframes, and the reason is the same one `ducking.ts` sets out at length: a
 * gate is a DYNAMICS processor, so it needs an envelope follower with state
 * between blocks, and Web Audio has no node for that. The only real-time answer
 * is an `AudioWorklet`, which would then have to be reimplemented against the
 * `OfflineAudioContext` the export uses, and the two proved to agree — for a
 * processor whose whole behaviour is history-dependent, that proof is the hard
 * part, and getting it wrong means an export that gates differently from the
 * preview.
 *
 * (The Compressor and De-esser that shipped alongside this ARE chain effects,
 * because `DynamicsCompressorNode` is a real dynamics processor the platform
 * already implements identically in both contexts. Gate is the one AE effect
 * with no native equivalent — a compressor only acts ABOVE its threshold, and a
 * gate is the opposite: it acts below.)
 *
 * Baking has a second advantage that is not a consolation prize. The result is
 * keyframes on `audioLevelDb`, which means you can SEE where the gate closed,
 * drag a point that closed too early, and keep the rest. A gate you cannot see
 * is a gate you cannot fix.
 *
 * The cost — shared with ducking — is that the bake goes stale if the source
 * changes, so the parameters are remembered on the node and the panel offers a
 * re-run.
 */

import {  type Keyframe } from '@motion/animation';
import {  MIN_LEVEL_DB } from './audioParams';
/*
  `envToDb` is IMPORTED, not written here.

  `analyseAudioEnvelope` does not return linear amplitude — it returns a 0..1
  position on a −60…0 dB scale (it compresses there, for the same reason
  `spectrumBands` does). Treating that as an amplitude and running it through
  `20·log10` is a unit error that squashes a 21 dB range into 3 dB, and the
  visible symptom is a Threshold control that does nothing across most of its
  travel. This module had exactly that bug until a walkthrough with a real clip
  found it; ducking never did, because it has always used this conversion.
*/
import { thinLevels, envToDb } from './ducking';

export interface GateParams {
  /** Level at or below which the layer is closed down, dBFS. */
  thresholdDb: number;
  /** Time to open once the signal crosses the threshold, ms. */
  attackMs: number;
  /** Stay open this long after it drops back below, ms. */
  holdMs: number;
  /** Time to close once the hold expires, ms. */
  releaseMs: number;
  /**
   * How far down a closed gate goes, in dB below the layer's own level.
   *
   * AE's Gate silences outright. A finite floor is offered because a hard
   * silence between phrases sounds like a dropout on anything with room tone,
   * and "duck the hiss 20 dB" is usually what was actually wanted. The default
   * is full silence, matching AE.
   */
  rangeDb: number;
}

export const DEFAULT_GATE: GateParams = {
  thresholdDb: -60,
  attackMs: 10,
  holdMs: 40,
  releaseMs: 220,
  rangeDb: -60,
};

/**
 * The per-frame gain, in dB relative to the layer's own level, that a gate
 * applies to this envelope.
 *
 * Pure — an envelope in, a curve out — so the shape the dialog previews is
 * exactly the shape that gets written, which is the property `duckLevels` is
 * built around too.
 *
 * The state machine is deliberately the mirror of `duckLevels`: that one pulls
 * the level DOWN while a sidechain is present, this one pulls it down while its
 * OWN signal is absent. Hold exists for the same reason in both — without it,
 * a signal hovering at the threshold chatters the gain open and shut, which is
 * far more audible than whatever the gate was cleaning up.
 */
export function gateLevels(
  env: Float32Array | readonly number[],
  opts: Partial<GateParams> & { fps?: number } = {},
): Float32Array {
  const e = env instanceof Float32Array ? env : Float32Array.from(env);
  const out = new Float32Array(e.length);
  if (e.length === 0) return out;

  const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;
  const thresholdDb = opts.thresholdDb ?? DEFAULT_GATE.thresholdDb;
  const rangeDb = Math.min(0, opts.rangeDb ?? DEFAULT_GATE.rangeDb);
  const holdFrames = Math.max(0, Math.round(((opts.holdMs ?? DEFAULT_GATE.holdMs) / 1000) * fps));
  const attackFrames = Math.max(1, Math.round(((opts.attackMs ?? DEFAULT_GATE.attackMs) / 1000) * fps));
  const releaseFrames = Math.max(1, Math.round(((opts.releaseMs ?? DEFAULT_GATE.releaseMs) / 1000) * fps));

  const depth = Math.abs(rangeDb);
  // Attack OPENS the gate (towards 0), release CLOSES it (towards −range).
  const openStep = depth / attackFrames;
  const closeStep = depth / releaseFrames;

  // Start closed: a take that begins with room tone should not have its first
  // frames pass through while the gate works out that nothing is happening.
  let heldFor = holdFrames + 1;
  let gain = rangeDb;
  for (let f = 0; f < e.length; f++) {
    const above = envToDb(e[f] ?? 0) >= thresholdDb;
    if (above) heldFor = 0;
    else heldFor++;
    const target = above || heldFor <= holdFrames ? 0 : rangeDb;

    if (gain < target) gain = Math.min(target, gain + openStep);
    else if (gain > target) gain = Math.max(target, gain - closeStep);
    out[f] = gain;
  }
  return out;
}

/**
 * The keyframes a gate writes for one layer.
 *
 * Split out from the apply so the curve can be previewed and tested without a
 * scene. `toKeyframeTime` is injected for the same reason `planFade` takes it:
 * the caller knows the layer's own time axis.
 */
export function planGate(
  env: Float32Array,
  opts: {
    fps: number;
    startCompSec: number;
    baseLevelDb: number;
    toKeyframeTime: (compSec: number) => number;
  } & Partial<GateParams>,
): Keyframe[] {
  const curve = gateLevels(env, opts);
  if (curve.length === 0) return [];

  const levels = new Float32Array(curve.length);
  for (let f = 0; f < curve.length; f++) {
    // Clamp to the audible floor: below it every value sounds identical, and
    // letting the track run to −200 dB only makes it awkward to edit by hand.
    levels[f] = Math.max(MIN_LEVEL_DB, opts.baseLevelDb + (curve[f] ?? 0));
  }

  const seen = new Set<number>();
  const out: Keyframe[] = [];
  for (const f of thinLevels(levels)) {
    const t = opts.toKeyframeTime(opts.startCompSec + f / opts.fps);
    // A retimed layer can map several comp frames onto one layer time; two
    // keyframes there is a step, and the second would win arbitrarily.
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ t, value: Math.round((levels[f] ?? 0) * 100) / 100, easing: 'linear' });
  }
  return out;
}

/** Where a gate's settings are remembered, so it can be re-run. */
export const GATE_PROP = '__gate';

export function readGate(node: { components: ReadonlyArray<{ props?: unknown }> }): GateParams | null {
  for (const c of node.components) {
    const v = (c.props as Record<string, unknown> | undefined)?.[GATE_PROP];
    if (v && typeof v === 'object') return { ...DEFAULT_GATE, ...(v as Partial<GateParams>) };
  }
  return null;
}
