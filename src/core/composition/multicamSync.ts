/**
 * Audio-based multicam alignment — the sync half of a Premiere-style multicam.
 *
 * Pure signal math, deliberately free of Web Audio and scene types so it runs
 * under jest on synthetic arrays: decode and clip-bar plumbing live in
 * `multicam.ts` (`alignMulticamByAudio`).
 *
 * Method: RMS envelopes (not raw PCM — sample-accurate audio alignment does
 * not survive different mic distances and codecs, energy contours do), then
 * normalized cross-correlation, coarse-to-fine: a decimated pass over the
 * whole lag range picks the neighbourhood, a full-rate pass refines it. NCC
 * because plain correlation on unnormalized envelopes just finds the loudest
 * stretch, not the matching one.
 */

/** Envelope sample rate the aligner works at. ~5 ms resolution at 200 Hz —
 *  well under a frame at any editorial rate. */
export const ENVELOPE_HZ = 200;

/** Coarse pass decimation. 200/8 = 25 Hz still resolves clap transients. */
const COARSE_FACTOR = 8;

/** Overlap shorter than this can correlate by accident — refuse to conclude. */
const MIN_OVERLAP_SECONDS = 1;

/** Mono RMS envelope of PCM at `hz` samples per second. */
export function rmsEnvelope(pcm: Float32Array, sampleRate: number, hz: number = ENVELOPE_HZ): Float32Array {
  const window = Math.max(1, Math.round(sampleRate / hz));
  const n = Math.floor(pcm.length / window);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * window;
    for (let j = 0; j < window; j++) {
      const v = pcm[base + j]!;
      sum += v * v;
    }
    out[i] = Math.sqrt(sum / window);
  }
  return out;
}

/** Average-of-`factor` decimation for the coarse pass. */
function decimate(env: Float32Array, factor: number): Float32Array {
  const n = Math.floor(env.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += env[i * factor + j]!;
    out[i] = sum / factor;
  }
  return out;
}

/**
 * Normalized cross-correlation of `other` against `ref` at an integer lag
 * (in envelope samples): compares ref[i] with other[i + lag] over their
 * overlap. Returns -1 for degenerate overlaps (too short, or zero variance —
 * silence matches silence everywhere, which is not evidence).
 */
export function nccAtLag(ref: Float32Array, other: Float32Array, lag: number, minOverlap: number): number {
  const start = Math.max(0, -lag);
  const end = Math.min(ref.length, other.length - lag);
  const n = end - start;
  if (n < minOverlap) return -1;
  let meanR = 0;
  let meanO = 0;
  for (let i = start; i < end; i++) {
    meanR += ref[i]!;
    meanO += other[i + lag]!;
  }
  meanR /= n;
  meanO /= n;
  let dot = 0;
  let eR = 0;
  let eO = 0;
  for (let i = start; i < end; i++) {
    const a = ref[i]! - meanR;
    const b = other[i + lag]! - meanO;
    dot += a * b;
    eR += a * a;
    eO += b * b;
  }
  if (eR <= 1e-12 || eO <= 1e-12) return -1;
  return dot / Math.sqrt(eR * eO);
}

function bestLagInRange(
  ref: Float32Array,
  other: Float32Array,
  minLag: number,
  maxLag: number,
  minOverlap: number,
): { lag: number; score: number } {
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = nccAtLag(ref, other, lag, minOverlap);
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  return { lag: bestLag, score: bestScore };
}

export interface LagResult {
  /** Seconds. Positive = the event happens LATER in `other`'s own file than in
   *  `ref`'s — i.e. `other`'s bar must start `lagSec` EARLIER to line up. */
  lagSec: number;
  /** Peak normalized correlation, -1..1. Below ~0.3 treat as "not found". */
  score: number;
}

/**
 * Best alignment lag of `other` relative to `ref`, both RMS envelopes at
 * `hz`. Searches ±`maxLagSec` coarse (decimated), then refines around the
 * winner at full envelope rate.
 */
export function bestLagSeconds(
  ref: Float32Array,
  other: Float32Array,
  hz: number = ENVELOPE_HZ,
  maxLagSec?: number,
): LagResult {
  const minOverlap = Math.max(2, Math.round(MIN_OVERLAP_SECONDS * hz));
  const maxLag = Math.round((maxLagSec ?? Math.max(ref.length, other.length) / hz) * hz);

  const cRef = decimate(ref, COARSE_FACTOR);
  const cOther = decimate(other, COARSE_FACTOR);
  const cMax = Math.ceil(maxLag / COARSE_FACTOR);
  const coarse = bestLagInRange(
    cRef, cOther, -cMax, cMax, Math.max(2, Math.round(minOverlap / COARSE_FACTOR)),
  );

  // Refine one coarse step either side of the winner, at full rate.
  const centre = coarse.lag * COARSE_FACTOR;
  const fine = bestLagInRange(
    ref, other,
    Math.max(-maxLag, centre - COARSE_FACTOR * 2),
    Math.min(maxLag, centre + COARSE_FACTOR * 2),
    minOverlap,
  );
  return { lagSec: fine.lag / hz, score: fine.score };
}

/** Mix planar channel data to mono in place of Web Audio (testable). */
export function mixToMonoChannels(channels: ReadonlyArray<Float32Array>, length: number): Float32Array {
  const out = new Float32Array(length);
  if (channels.length === 0) return out;
  for (const ch of channels) {
    const n = Math.min(length, ch.length);
    for (let i = 0; i < n; i++) out[i]! += ch[i]!;
  }
  const k = 1 / channels.length;
  for (let i = 0; i < length; i++) out[i]! *= k;
  return out;
}
