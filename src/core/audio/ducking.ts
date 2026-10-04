/**
 * Ducking — hold the music down while somebody is talking.
 *
 * Every part of this already existed and none of them had met: `audioDriver`
 * can turn a layer's sound into a per-frame envelope with real attack/release
 * ballistics, `audioParams` samples `audioLevelDb` per frame into the gain
 * ramp that both the live engine and the export mixdown schedule, and the
 * timeline can hold a keyframe track on it. What was missing is the sentence:
 * *duck this music 12 dB under that voice*.
 *
 * ## Why keyframes and not a sidechain compressor node
 *
 * Web Audio has no sidechain input. A real-time detector would have to run in
 * an `AudioWorklet`, be reimplemented for the `OfflineAudioContext` the export
 * uses, and then the two would have to be proved to agree — and they would not,
 * because the offline render has no scrub position and the live one has no
 * future. Baked keyframes have none of that: they are the same numbers in
 * preview, in export, and on screen, they survive a project save, and the user
 * can drag one afterwards. That last part is the real argument. A compressor
 * you cannot see is a compressor you cannot fix.
 *
 * The cost is that the bake goes stale when the voice track changes, which is
 * why the parameters are remembered on the node as `__ducking` and the panel
 * offers **Re-duck**. That is the same contract `audioDriver` has with
 * `__audioDriver`, deliberately: a baked track with no record of where it came
 * from is indistinguishable from hand-drawn keyframes the moment the panel
 * closes.
 *
 * ## Shape
 *
 * {@link duckLevels} is pure — a per-frame sidechain envelope in, a per-frame
 * gain in dB out — so the same curve the dialog previews is the curve that gets
 * written.
 */

import type { SceneNode } from '@core/types';

// ── The curve (pure) ────────────────────────────────────────────────

export interface DuckingParams {
  /** How far the music drops while the voice is present. Negative dB. */
  duckDb: number;
  /** Sidechain level at or above which the voice counts as present, dBFS. */
  thresholdDb: number;
  /** Time to reach the full duck, ms. */
  attackMs: number;
  /** Time to come back to unity, ms. */
  releaseMs: number;
  /** Stay ducked this long after the voice drops out, ms. */
  holdMs: number;
}

export const DEFAULT_DUCKING: DuckingParams = {
  duckDb: -12,
  thresholdDb: -30,
  attackMs: 60,
  releaseMs: 400,
  holdMs: 200,
};

export interface DuckLevelOptions extends Partial<DuckingParams> {
  /** Frame rate the envelope is sampled at — attack/release/hold are in ms. */
  fps?: number;
}

/**
 * The scale {@link analyseAudioEnvelope} reports on: 0 ⇒ −60 dBFS, 1 ⇒ 0 dBFS.
 *
 * Exported because the threshold in {@link DuckingParams} is in dBFS while the
 * envelope is 0..1, and a caller that gets the conversion wrong gets a duck
 * that never opens or never closes. There is exactly one right answer and it
 * belongs next to the thing that needs it.
 */
export function envToDb(x: number): number {
  return (x <= 0 ? 0 : x > 1 ? 1 : x) * 60 - 60;
}

/** Inverse of {@link envToDb}. */
export function dbToEnv(db: number): number {
  const v = (db + 60) / 60;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Per-frame gain, in dB, for the ducked layer.
 *
 * `sidechainEnv` is the VOICE's envelope on the 0..1 scale
 * {@link analyseAudioEnvelope} produces (unnormalised — normalising it would
 * make `thresholdDb` mean "relative to the loudest moment in the work area",
 * which is not a threshold).
 *
 * The ramps are LINEAR rather than the one-pole the analyser uses, and that is
 * the point: a one-pole only ever approaches its target, so "duck by 12 dB"
 * would in fact duck by 11.4, and the number in the field would be a number
 * the output never reaches. A linear ramp arrives exactly at `duckDb` after
 * `attackMs` and exactly at 0 after `releaseMs`, which is both what the label
 * claims and what a person drawing this by hand would draw.
 *
 * Hold is applied to the DETECTION, before the ramps — it extends how long the
 * voice counts as present, so a pause between two words does not start a
 * release the next word immediately has to undo. Applying it to the output
 * instead would flatten the top of the duck and leave the release starting at
 * the same place.
 */
export function duckLevels(
  sidechainEnv: Float32Array | readonly number[],
  opts: DuckLevelOptions = {},
): Float32Array {
  const env = sidechainEnv instanceof Float32Array ? sidechainEnv : Float32Array.from(sidechainEnv);
  const out = new Float32Array(env.length);
  if (env.length === 0) return out;

  const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;
  const duckDb = Math.min(0, opts.duckDb ?? DEFAULT_DUCKING.duckDb);
  const thresholdDb = opts.thresholdDb ?? DEFAULT_DUCKING.thresholdDb;
  const holdFrames = Math.max(0, Math.round(((opts.holdMs ?? DEFAULT_DUCKING.holdMs) / 1000) * fps));
  const attackFrames = Math.max(1, Math.round(((opts.attackMs ?? DEFAULT_DUCKING.attackMs) / 1000) * fps));
  const releaseFrames = Math.max(1, Math.round(((opts.releaseMs ?? DEFAULT_DUCKING.releaseMs) / 1000) * fps));

  const depth = Math.abs(duckDb);
  const attackStep = depth / attackFrames;
  const releaseStep = depth / releaseFrames;

  let heldFor = holdFrames; // start open, not mid-hold
  let gain = 0;
  for (let f = 0; f < env.length; f++) {
    const present = envToDb(env[f] ?? 0) >= thresholdDb;
    if (present) heldFor = 0;
    else heldFor++;
    const target = present || heldFor <= holdFrames ? duckDb : 0;

    if (gain > target) gain = Math.max(target, gain - attackStep);
    else if (gain < target) gain = Math.min(target, gain + releaseStep);
    out[f] = gain;
  }
  return out;
}

/**
 * Drop the frames a straight line already passes through.
 *
 * A four-minute track at 30 fps is 7 200 frames, and a duck is flat for most of
 * them — writing one keyframe per frame makes the property row unreadable and
 * the file large for no gain in accuracy. A point is kept when the slope
 * changes across it by more than `tolDb`; the first and last are always kept,
 * so the curve's ends are pinned.
 */
export function thinLevels(values: Float32Array, tolDb = 0.05): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);

  const keep: number[] = [0];
  for (let i = 1; i < n - 1; i++) {
    const prev = values[keep[keep.length - 1] as number] ?? 0;
    const here = values[i] ?? 0;
    const next = values[i + 1] ?? 0;
    const span = i + 1 - (keep[keep.length - 1] as number);
    // What a straight line from the last kept point to `next` would give here.
    const interpolated = prev + ((next - prev) * (i - (keep[keep.length - 1] as number))) / span;
    if (Math.abs(here - interpolated) > tolDb) keep.push(i);
  }
  keep.push(n - 1);
  return keep;
}

// ── The record on the node ──────────────────────────────────────────

/** Hidden prop holding the {@link DuckingRecord} on the music layer. */
export const DUCKING_PROP = '__ducking';

export interface DuckingRecord extends DuckingParams {
  /** Scene node id of the layer supplying the sidechain. */
  voiceNodeId: string;
}

/** Where the record lives — the Transform component, as `__audioDriver` does. */
function duckHost(node: SceneNode): SceneNode['components'][number] | undefined {
  return node.components.find((c) => c.type === 'Transform') ?? node.components[0];
}

const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

/** The ducking remembered on a node, or null. */
export function readDucking(node: SceneNode): DuckingRecord | null {
  const raw = duckHost(node)?.props[DUCKING_PROP];
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<DuckingRecord>;
  if (typeof d.voiceNodeId !== 'string' || !d.voiceNodeId) return null;
  return {
    voiceNodeId: d.voiceNodeId,
    duckDb: num(d.duckDb, DEFAULT_DUCKING.duckDb),
    thresholdDb: num(d.thresholdDb, DEFAULT_DUCKING.thresholdDb),
    attackMs: num(d.attackMs, DEFAULT_DUCKING.attackMs),
    releaseMs: num(d.releaseMs, DEFAULT_DUCKING.releaseMs),
    holdMs: num(d.holdMs, DEFAULT_DUCKING.holdMs),
  };
}

export interface DuckEnvelope {
  /** Sidechain detector, 0..1 per frame — what a preview strip draws. */
  sidechain: Float32Array;
  /** Gain reduction in dB per frame (0 = open, `duckDb` = fully ducked). */
  gainDb: Float32Array;
  start: number;
  end: number;
  fps: number;
}

export interface ApplyDuckingResult {
  keyframes: number;
  /** Deepest gain reduction actually reached, dB. */
  peakDuckDb: number;
  /** Set when nothing could be done, in a sentence the dialog can show. */
  error?: string;
}

/**
 * Duck `musicNodeId` under `voiceNodeId`: write the level track, remember the
 * parameters, one undo entry.
 *
 * The values written are `staticLevel + gain`, not the gain alone. A keyframe
 * on `audioLevelDb` REPLACES the layer's static level (see `sampleLevelDb`), so
 * writing the reduction on its own would silently reset a music bed that had
 * been pulled to −6 dB back up to unity between phrases — the layer would get
 * LOUDER where nobody is talking, which is the opposite of the feature.
 */
/**
 * The ducking as DATA, nothing written (B3z): the level keys at COMPOSITION
 * seconds (the engine converts to the music layer's keyframe axis) and the
 * record to remember. The Ducking dialog sends it as one engine entry
 * (`audio/ducking` + `audio/levels`); {@link applyDucking} is the pre-API writer.
 */
export interface DuckingPlan {
  record: DuckingRecord;
  keys: Array<{ seconds: number; value: number }>;
  peakDuckDb: number;
  error?: string;
}
