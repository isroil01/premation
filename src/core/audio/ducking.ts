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

import { defaultAnimation, type Keyframe } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { runAsOneHistoryEntry } from '@core/composition/compositeEdit';
import type { SceneNode } from '@core/types';
import { AUDIO_LEVEL_DB_PROP, MIN_LEVEL_DB } from './audioParams';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readAudioClipTimings, readAudioVoices, readVideoAudioVoices } from './audioScene';
import { alignSamplesToRange, analyseAudioEnvelope, driverRange } from './audioDriver';
import { audioVoices, loadNodeMono } from './silenceRemoval';

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

/** Remember (or replace) the ducking on a node. */
export function writeDucking(nodeId: string, record: DuckingRecord): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const host = node ? duckHost(node) : undefined;
  if (!node || !host) return;
  defaultSceneGraph.writeProp(nodeId, host.id, DUCKING_PROP, { ...record });
  bumpScene();
}

/** Forget the ducking (does NOT touch the keyframes it wrote). */
export function forgetDucking(nodeId: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const host = node ? duckHost(node) : undefined;
  if (!node || !host) return;
  defaultSceneGraph.writeProp(nodeId, host.id, DUCKING_PROP, undefined);
  bumpScene();
}

// ── Analysis against the scene ──────────────────────────────────────

/** The music layer's static level, which the baked track is written relative to. */
export function staticLevelDbOf(nodeId: string): number {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return 0;
  const kind = readNodeKind(node);
  const voices =
    kind === 'audio' ? readAudioVoices(node) : kind === 'video' ? readVideoAudioVoices(node) : [];
  return voices[0]?.levelDb ?? 0;
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

/**
 * The voice's envelope and the resulting gain curve over the bake range, with
 * nothing written.
 *
 * `normalize: false` and no attack/release on the ANALYSER: the detector must
 * report absolute level for `thresholdDb` to mean anything, and the ballistics
 * belong to {@link duckLevels} — running them in both places would apply the
 * attack twice and make the numbers in the dialog wrong by a factor nobody
 * could predict.
 */
export async function computeDuckEnvelope(
  voiceNodeId: string,
  params: DuckingParams,
  range = driverRange(),
): Promise<DuckEnvelope | null> {
  const src = await loadNodeMono(voiceNodeId);
  if (!src) return null;
  const aligned = alignSamplesToRange(
    src.samples,
    src.sampleRate,
    readAudioClipTimings(voiceNodeId),
    range.start,
    range.end,
  );
  const sidechain = analyseAudioEnvelope(aligned, src.sampleRate, range.fps, {
    band: 'full',
    attackMs: 0,
    releaseMs: 0,
    gate: 0,
    normalize: false,
  });
  if (sidechain.length === 0) return null;
  return {
    sidechain,
    gainDb: duckLevels(sidechain, { ...params, fps: range.fps }),
    start: range.start,
    end: range.end,
    fps: range.fps,
  };
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
export async function applyDucking(
  musicNodeId: string,
  voiceNodeId: string,
  params: DuckingParams,
): Promise<ApplyDuckingResult> {
  if (!defaultSceneGraph.getNode(musicNodeId) || !defaultSceneGraph.getNode(voiceNodeId)) {
    return { keyframes: 0, peakDuckDb: 0, error: 'That layer is gone.' };
  }
  if (musicNodeId === voiceNodeId) {
    return { keyframes: 0, peakDuckDb: 0, error: 'A layer cannot duck under itself.' };
  }

  const range = driverRange();
  const env = await computeDuckEnvelope(voiceNodeId, params, range);
  if (!env) {
    return {
      keyframes: 0,
      peakDuckDb: 0,
      error: 'That layer’s audio has not decoded (or has no sound in this range).',
    };
  }

  const base = staticLevelDbOf(musicNodeId);
  const levels = new Float32Array(env.gainDb.length);
  let peak = 0;
  for (let f = 0; f < env.gainDb.length; f++) {
    const g = env.gainDb[f] ?? 0;
    if (g < peak) peak = g;
    // Clamp to the audible floor: below it every value sounds identical, so
    // letting the track run to −200 dB would just make undoing it by hand hard.
    levels[f] = Math.max(MIN_LEVEL_DB, base + g);
  }

  const seen = new Set<number>();
  const keyframes: Keyframe[] = [];
  for (const f of thinLevels(levels)) {
    const compTime = range.start + f / range.fps;
    if (compTime > range.end + 1e-9) break;
    // The canonical keyframe axis, so the track survives trimming, sliding and
    // time-stretching the music layer afterwards.
    const t = compToKeyframeTime(musicNodeId, compTime, AUDIO_LEVEL_DB_PROP);
    if (seen.has(t)) continue;
    seen.add(t);
    keyframes.push({ t, value: Math.round((levels[f] ?? 0) * 100) / 100, easing: 'linear' });
  }
  if (keyframes.length === 0) return { keyframes: 0, peakDuckDb: 0, error: 'Nothing to write in this range.' };

  await runAsOneHistoryEntry('Duck Music', () => {
    writeDucking(musicNodeId, { ...params, voiceNodeId });
    defaultAnimation.batch(() => {
      // An expression on the level would multiply against the baked track and
      // produce a level that matches neither — the same rule `applyAudioDriver`
      // follows for the property it bakes.
      defaultAnimation.setExpression(musicNodeId, AUDIO_LEVEL_DB_PROP, '');
      defaultAnimation.setKeyframes(musicNodeId, AUDIO_LEVEL_DB_PROP, keyframes);
    });
    bumpScene();
  });

  return { keyframes: keyframes.length, peakDuckDb: Math.round(peak * 10) / 10 };
}

/**
 * Re-run the ducking already recorded on a layer — after the voice was
 * re-recorded, moved, or had its silences cut out.
 */
export async function reduck(musicNodeId: string): Promise<ApplyDuckingResult> {
  const node = defaultSceneGraph.getNode(musicNodeId);
  const record = node ? readDucking(node) : null;
  if (!record) return { keyframes: 0, peakDuckDb: 0, error: 'This layer has no ducking to redo.' };
  return applyDucking(musicNodeId, record.voiceNodeId, record);
}

/** Forget the ducking AND remove the level track it wrote, in one undo entry. */
export async function removeDucking(musicNodeId: string): Promise<boolean> {
  const node = defaultSceneGraph.getNode(musicNodeId);
  if (!node || !readDucking(node)) return false;
  await runAsOneHistoryEntry('Remove Ducking', () => {
    forgetDucking(musicNodeId);
    defaultAnimation.removeTrack(musicNodeId, AUDIO_LEVEL_DB_PROP);
    bumpScene();
  });
  return true;
}

/**
 * Layers that could supply a sidechain, or be ducked: anything with sound.
 *
 * Built from the voice list rather than by walking for `kind === 'audio'`,
 * because a video layer's own track is a legitimate sidechain (a piece to
 * camera under a music bed is the common case) and a kind check would miss
 * every one of them.
 */
export function duckableLayers(): Array<{ id: string; name: string }> {
  return audioVoices().map((v) => ({ id: v.nodeId, name: v.name }));
}
