/**
 * The beat grid — where the music's pulse lands on the composition's timeline.
 *
 * `@motion/audio`'s `analyseAudio` already does the DSP (spectral-flux onset
 * envelope, autocorrelation tempo, phase) and has done since the AI caster
 * shipped. What has never existed is a way for a PERSON to use it: the beats
 * were computed, handed to a language model, and thrown away. This module is
 * the missing half — beats in COMPOSITION time, which is the only form in
 * which a marker can be placed or a layer timed to them.
 *
 * ── Audio time is not comp time ────────────────────────────────────
 * The analyser returns seconds from the start of the FILE. The audio layer it
 * came from may start ten seconds into the comp, be trimmed twenty seconds
 * into the file, and be stretched. `keyframeToCompTime` is the inverse of the
 * chain every keyframe already uses, so beats go through it rather than
 * through an offset computed here — one time axis, one implementation.
 *
 * ── Confidence is reported, not enforced ───────────────────────────
 * `core/ai/audioForCaster.ts` analyses the same way but returns *undefined*
 * below 0.25 confidence, because a language model given a bad grid will time a
 * whole piece to it and cannot tell. A person can: they see the markers land
 * off the beat. So the grid comes back with its confidence attached and the
 * command says what it thinks, rather than silently refusing.
 */

import { analyseAudio } from '@motion/audio';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { assetIdOf } from '@core/source/sourceInfo';
import { keyframeToCompTime } from '@core/timeline/TimelineController';
import { useAssetStore } from '@stores/assetStore';

/** Matches `audioForCaster` — a long file would stall the UI on decode. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/** Below this the grid is shown but described as unreliable. */
export const LOW_CONFIDENCE = 0.25;

export interface BeatGrid {
  /** The audio layer the grid came from. */
  nodeId: string;
  bpm: number;
  /** 0..1. Below `LOW_CONFIDENCE` the tempo is a guess — say so. */
  tempoConfidence: number;
  /** Beat times in COMPOSITION seconds, ascending. */
  beatsCompSec: number[];
  /** Detected onsets (transients) in composition seconds — not all are beats. */
  onsetsCompSec: number[];
}

let cache: { key: string; grid: BeatGrid | null } | null = null;

/** Test seam — drop the decode cache. */
export function resetBeatGridCache(): void {
  cache = null;
}

/**
 * The audio layer to analyse: the one given, else the first in the scene.
 *
 * `traverse`, NOT `flattenScene`. On a fresh unsaved project every layer hangs
 * off the VIRTUAL `comp_root`, which is a fallback id with no engine node
 * behind it — so `getRoots()` is empty, and `flattenScene` (which walks roots
 * downwards) returns nothing at all while the layers are plainly there.
 * Measured: a scene with an audio layer and five solids flattened to `[]` and
 * traversed to all six, which made every beat command report itself disabled
 * with the music sitting in the timeline.
 */
export function findAudioLayer(preferredId?: string): string | undefined {
  if (preferredId) {
    const node = defaultSceneGraph.getNode(preferredId);
    if (node && readNodeKind(node) === 'audio') return preferredId;
  }
  let found: string | undefined;
  defaultSceneGraph.traverse((n) => {
    if (found === undefined && readNodeKind(n) === 'audio') found = n.id;
  });
  return found;
}

/**
 * Beats for the layers being timed, starting at or after `fromTime`.
 *
 * Pure, and separate from the analysis because it holds the only judgement
 * call: what to do when the music runs out before the layers do. Dropping the
 * remaining layers would silently animate fewer things than were selected, and
 * piling them on the last beat would look like a bug — so the grid is EXTENDED
 * at the tempo it was keeping, which is what a musician counting past the end
 * of a bar does.
 */
export function beatsForLayers(
  beatsCompSec: readonly number[],
  fromTime: number,
  count: number,
): number[] {
  if (count <= 0) return [];
  // Sorted defensively. `analyseLayerBeats` already sorts, but this is exported
  // and pure, and an unordered grid here would hand back start times that go
  // backwards — layers animating in the wrong order, with nothing to point at.
  const upcoming = beatsCompSec.filter((t) => t >= fromTime - 1e-6).sort((a, b) => a - b);
  if (upcoming.length === 0) return Array.from({ length: count }, (_, i) => fromTime + i);
  if (upcoming.length >= count) return upcoming.slice(0, count);

  // Keep counting at the last interval the music actually kept. With only one
  // beat to go on there is no interval to infer, so fall back to the average
  // across the whole grid, and to one second if even that is unavailable.
  const out = upcoming.slice();
  const interval =
    upcoming.length >= 2
      ? upcoming[upcoming.length - 1]! - upcoming[upcoming.length - 2]!
      : beatsCompSec.length >= 2
        ? (beatsCompSec[beatsCompSec.length - 1]! - beatsCompSec[0]!) / (beatsCompSec.length - 1)
        : 1;
  while (out.length < count) out.push(out[out.length - 1]! + Math.max(1e-3, interval));
  return out;
}

/** Every `nth` beat — half-time and double-time phrasing from one grid. */
export function everyNthBeat(beatsCompSec: readonly number[], n: number): number[] {
  const step = Math.max(1, Math.round(n));
  return beatsCompSec.filter((_, i) => i % step === 0);
}

/**
 * Decode the audio layer and return its beat grid in composition time.
 *
 * Returns null when there is no audio layer, the media is unreadable or too
 * long to decode, or the clip holds no detectable pulse at all. Every one of
 * those is a sentence the command shows the user, not an exception.
 */
export async function analyseLayerBeats(preferredId?: string): Promise<BeatGrid | null> {
  const nodeId = findAudioLayer(preferredId);
  if (!nodeId) return null;

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const assetId = assetIdOf(node);
  const src = useAssetStore.getState().assets.find((a) => a.id === assetId)?.src;
  if (!src) return null;

  // Keyed on the LAYER as well as the asset: the same file trimmed differently
  // on two layers has two different grids in comp time.
  const key = `${nodeId}:${assetId}:${src}`;
  if (cache?.key === key) return cache.grid;

  try {
    const res = await fetch(src);
    if (!res.ok) {
      cache = { key, grid: null };
      return null;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_AUDIO_BYTES) {
      cache = { key, grid: null };
      return null;
    }

    const AudioCtor =
      (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext
      ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return null;

    const actx = new AudioCtor();
    void actx.suspend?.();
    const decoded = await actx.decodeAudioData(buf);
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    const analysis = analyseAudio(channels, decoded.sampleRate);
    void actx.close();

    if (analysis.beats.length === 0) {
      cache = { key, grid: null };
      return null;
    }

    const toComp = (mediaSec: number): number => keyframeToCompTime(nodeId, mediaSec);
    const grid: BeatGrid = {
      nodeId,
      bpm: analysis.bpm,
      tempoConfidence: analysis.tempoConfidence,
      // Sorted after mapping: a reversed or retimed layer can invert the order,
      // and every consumer here assumes ascending.
      beatsCompSec: analysis.beats.map(toComp).sort((a, b) => a - b),
      onsetsCompSec: analysis.onsets.map(toComp).sort((a, b) => a - b),
    };
    cache = { key, grid };
    return grid;
  } catch {
    cache = { key, grid: null };
    return null;
  }
}
