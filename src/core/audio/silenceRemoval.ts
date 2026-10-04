/**
 * Silence removal — "cut the dead air out of this take", as one edit.
 *
 * The pieces to do this by hand have all been here for a while: split a bar at
 * the playhead, delete a bar, slide the survivors left. Doing it by hand on a
 * ten-minute talking-head take is forty cuts, eighty drags, and a soundtrack
 * that ends up one frame out of sync with the picture somewhere in the middle.
 * This is that operation with the arithmetic done once and correctly.
 *
 * ## Two shapes, deliberately separated
 *
 * {@link detectSilences} is PURE: samples in, source-second ranges out. No
 * scene, no engine, no Web Audio. That is what lets the dialog show a real
 * "will remove N gaps totalling S s" readout computed by the same code that
 * does the cut, rather than by a cheaper estimate that agrees on the easy cases
 * and disagrees exactly where the parameters are doing something interesting.
 *
 * {@link removeSilences} is the scene half: map source seconds onto comp time
 * through each layer's clip bars, cut, delete, close the gap.
 *
 * ## Why the ripple is done by hand
 *
 * `TimelineController.deleteLayerForClip({ ripple: true })` shifts every later
 * bar **on the same track**, and in this app a composition is ONE track — every
 * layer of the comp shares it (`compositionTrackIds`). So the built-in ripple
 * would drag unrelated layers left, and doing it once per paired layer would
 * shift the shared neighbours twice. What this module wants is narrower: close
 * the gap on the layers being cut and nothing else. So it deletes without
 * ripple and moves the survivors itself with `setClipStart`.
 *
 * ## Why intervals are processed last-first
 *
 * Closing a gap changes the comp time of everything after it. Walking the
 * removals in DESCENDING order means every interval's coordinates are still
 * valid when its turn comes, with no running offset to keep — and no running
 * offset is one fewer thing to get wrong on the day a clip boundary lands
 * exactly on a cut.
 *
 * ## The audio/video pairing
 *
 * A video layer in this app IS its own audio source (see
 * `docs/VIDEO_EDITING_PIPELINE.md` §15 and `readVideoAudioVoices`) — there is
 * no stored link between a picture layer and a sound layer, because normally
 * there is only one layer. When a project DOES hold both (an audio layer
 * imported from the same file, a detached take), the only thing tying them
 * together is the **asset id**, so that is what {@link pairedAudioNodeIds}
 * matches on. It is honest about what it is: same file, same comp.
 */

import {
  type AudioClipTiming,
} from './audioScene';

// ── Detection (pure) ────────────────────────────────────────────────

/** A span of the SOURCE file, in seconds, that should go away. */
export interface SilenceRange {
  startSec: number;
  endSec: number;
}

export interface SilenceOptions {
  /** At or below this RMS level, a window counts as quiet. Default -40 dBFS. */
  thresholdDb?: number;
  /** Quiet runs shorter than this are left alone. Default 400 ms. */
  minSilenceMs?: number;
  /** Margin of silence kept at each end of a removed gap. Default 80 ms. */
  paddingMs?: number;
  /** RMS analysis hop, ms — the resolution of a cut. Default 10 ms. */
  windowMs?: number;
}

export const DEFAULT_SILENCE_OPTIONS: Required<SilenceOptions> = {
  thresholdDb: -40,
  minSilenceMs: 400,
  paddingMs: 80,
  windowMs: 10,
};

/** RMS of `samples[from, to)` as dBFS. Silence returns a large negative, not −∞. */
function windowDb(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return 20 * Math.log10(Math.sqrt(sum / n) + 1e-9);
}

/**
 * Spans of `samples` quiet enough, and long enough, to cut out.
 *
 * The order of operations is a choice: a run is measured against
 * `minSilenceMs` at its RAW length, and the padding is taken off AFTERWARDS.
 * Insetting first would make `minSilenceMs` mean "min silence plus twice the
 * padding", so raising the padding would silently start sparing gaps the user
 * had already asked to lose — two controls, one of them lying.
 *
 * A run that the padding eats entirely is dropped rather than returned empty:
 * there is nothing left to remove, and a zero-length range downstream is a
 * split at a point with no material between the two halves.
 */
export function detectSilences(
  samples: Float32Array,
  sampleRate: number,
  opts: SilenceOptions = {},
): SilenceRange[] {
  if (sampleRate <= 0 || samples.length === 0) return [];

  const thresholdDb = opts.thresholdDb ?? DEFAULT_SILENCE_OPTIONS.thresholdDb;
  const minSilenceMs = Math.max(0, opts.minSilenceMs ?? DEFAULT_SILENCE_OPTIONS.minSilenceMs);
  const paddingMs = Math.max(0, opts.paddingMs ?? DEFAULT_SILENCE_OPTIONS.paddingMs);
  const windowMs = Math.max(1, opts.windowMs ?? DEFAULT_SILENCE_OPTIONS.windowMs);

  const hop = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const windows = Math.ceil(samples.length / hop);
  const minSec = minSilenceMs / 1000;
  const padSec = paddingMs / 1000;
  const totalSec = samples.length / sampleRate;

  const out: SilenceRange[] = [];
  let runStart = -1;

  const closeRun = (endWindow: number): void => {
    if (runStart < 0) return;
    const startSec = (runStart * hop) / sampleRate;
    const endSec = Math.min(totalSec, (endWindow * hop) / sampleRate);
    runStart = -1;
    if (endSec - startSec < minSec) return;
    const a = startSec + padSec;
    const b = endSec - padSec;
    if (b - a <= 0) return;
    out.push({ startSec: a, endSec: b });
  };

  for (let w = 0; w < windows; w++) {
    const from = w * hop;
    const quiet = windowDb(samples, from, Math.min(samples.length, from + hop)) <= thresholdDb;
    if (quiet) {
      if (runStart < 0) runStart = w;
      continue;
    }
    closeRun(w);
  }
  closeRun(windows);
  return out;
}

/** Total seconds {@link detectSilences} would take out. */
export function totalSilenceSec(ranges: readonly SilenceRange[]): number {
  let sum = 0;
  for (const r of ranges) sum += Math.max(0, r.endSec - r.startSec);
  return sum;
}

// ── Source → comp time (pure) ───────────────────────────────────────

/** A span of COMPOSITION time to cut out, in seconds. */
export interface CompInterval {
  start: number;
  end: number;
}

/**
 * Source-second ranges onto the comp timeline, through one layer's clip bars.
 *
 * A range only exists in the comp where a bar is actually playing that part of
 * the file: trimmed-away material has no comp time, and a range spanning a cut
 * between two bars becomes two intervals rather than one that would swallow
 * whatever sits between them.
 */
export function rangesToCompIntervals(
  timings: ReadonlyArray<AudioClipTiming>,
  ranges: readonly SilenceRange[],
): CompInterval[] {
  const out: CompInterval[] = [];
  for (const t of timings) {
    const barLen = Math.max(0, t.outSec - t.inSec);
    if (barLen <= 0) continue;
    for (const r of ranges) {
      const from = Math.max(r.startSec, t.inSec);
      const to = Math.min(r.endSec, t.outSec);
      if (to <= from) continue;
      out.push({ start: t.startSec + (from - t.inSec), end: t.startSec + (to - t.inSec) });
    }
  }
  return mergeIntervals(out);
}

/** Sort and coalesce overlapping/abutting intervals. */
export function mergeIntervals(intervals: readonly CompInterval[]): CompInterval[] {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: CompInterval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end + 1e-9) {
      if (iv.end > last.end) last.end = iv.end;
      continue;
    }
    out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

// ── The cut ─────────────────────────────────────────────────────────

export interface RemoveSilencesResult {
  /** Comp-time gaps actually closed. */
  gaps: number;
  /** Seconds taken out of the composition. */
  secondsRemoved: number;
  /** Clip bars deleted across every paired layer. */
  clipsDeleted: number;
  /** Set when nothing could be done, in a sentence the dialog can show. */
  error?: string;
}
