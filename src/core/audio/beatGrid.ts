/**
 * The beat grid — where the music's pulse lands on the composition's timeline.
 *
 * The C++ engine's audioAnalysis job does the DSP (spectral-flux onset
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

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';

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
  // Sorted defensively. The engine's grid is already sorted, but this is exported
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

