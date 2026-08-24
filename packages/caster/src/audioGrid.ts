/**
 * Align the caster beat grid to a detected audio beat grid.
 *
 * Pure — no DOM, no decoding. The host analyses audio and passes seconds;
 * this decides where brief beats land on that grid.
 */

import type { Beat, BriefBeat, CreativeBrief, Sequence, SurvivalKind } from './types';
import type { SlotContent } from '@motion/design-system';
import { GENERATED_MEDIA } from './types';
import { MIN_BEAT_MS, survivalBetween, tagsForPurpose } from './sequencer';

/** Beat grid from `@motion/audio` / `analyse_audio`. */
export interface AudioGrid {
  beats: readonly number[];
  durationSec: number;
  tempoConfidence: number;
}

export function audioGridUsable(audio: AudioGrid | undefined): audio is AudioGrid {
  return !!audio && audio.tempoConfidence >= 0.25 && audio.beats.length >= 4 && audio.durationSec > 1;
}

/**
 * Place brief beats on the music grid.
 *
 * Each beat gets a slice between consecutive cut points. Cut points are chosen
 * from the detected beat times so boundaries land on transients rather than a
 * stopwatch.
 */
export function sequenceToAudioGrid(
  brief: CreativeBrief,
  audio: AudioGrid,
  autoCarry = true,
): Sequence {
  const raw = brief.beats.length ? brief.beats : [{ purpose: 'hero', weight: 1, content: {} } as BriefBeat];
  const n = raw.length;
  const totalMs = Math.max(MIN_BEAT_MS * n, Math.min(brief.totalDurationMs, Math.round(audio.durationSec * 1000)));
  const times = audio.beats.filter((t) => t >= 0 && t * 1000 <= totalMs);
  const grid = times.length >= 2 ? times : [0, audio.durationSec];

  const cutsMs: number[] = [0];
  for (let i = 1; i < n; i++) {
    const targetSec = (totalMs * i) / n / 1000;
    let pick = grid[grid.length - 1]!;
    for (const t of grid) {
      if (t >= targetSec) { pick = t; break; }
    }
    cutsMs.push(Math.round(pick * 1000));
  }
  cutsMs.push(totalMs);

  const beats: Beat[] = [];
  for (let i = 0; i < n; i++) {
    const startMs = cutsMs[i]!;
    const endMs = cutsMs[i + 1]!;
    const durationMs = Math.max(MIN_BEAT_MS, endMs - startMs);
    const b = raw[i]!;
    const content: SlotContent =
      b.art && !b.content.mediaAssetId ? { ...b.content, mediaAssetId: GENERATED_MEDIA } : b.content;
    beats.push({
      index: i,
      startMs,
      durationMs,
      purpose: b.purpose,
      content,
      tags: tagsForPurpose(b.purpose),
      ...(b.art ? { art: b.art } : {}),
    });
  }

  const boundaries: { atMs: number; survivors: number }[] = [];
  for (let i = 0; i < beats.length - 1; i++) {
    const found = survivalBetween(beats[i]!.content, beats[i + 1]!.content);
    const survival =
      found ?? (autoCarry ? { kind: 'carry_motion' as SurvivalKind, role: 'mark' as const } : undefined);
    if (survival) beats[i] = { ...beats[i]!, survival };
    boundaries.push({
      atMs: beats[i]!.startMs + beats[i]!.durationMs,
      survivors: survival ? 1 : 0,
    });
  }

  return { beats, totalDurationMs: totalMs, boundaries };
}