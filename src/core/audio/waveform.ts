/**
 * Waveform math — reduce decoded PCM audio to a compact per-bucket
 * peak envelope for drawing, and sample the envelope at a point in time so
 * properties can be audio-driven.
 *
 * Pure and deterministic: the peak/mix/sample helpers take plain Float32Array
 * data (no Web Audio, no DOM) so they unit-test cleanly. Actual decoding lives
 * in {@link AudioEngine} which owns the AudioContext.
 */

import { clamp01 } from '@utils/lang';

export interface WaveformPeaks {
  /** Number of buckets in {@link peaks}. */
  buckets: number;
  /** Per-bucket peak amplitude 0..1 (max |sample| in the bucket). */
  peaks: Float32Array;
  /** Clip duration in seconds. */
  duration: number;
}

/**
 * Reduce raw mono samples to `buckets` peak amplitudes — the max absolute
 * sample within each bucket, so transients survive downsampling. Amplitudes are
 * clamped to [0,1].
 */
export function computePeaks(samples: Float32Array, buckets: number): Float32Array {
  const n = Math.max(1, Math.floor(buckets));
  const out = new Float32Array(n);
  if (samples.length === 0) return out;
  const per = samples.length / n;
  for (let b = 0; b < n; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((b + 1) * per)));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(samples[i] ?? 0);
      if (a > peak) peak = a;
    }
    out[b] = peak > 1 ? 1 : peak;
  }
  return out;
}

/**
 * Down-mix per-channel PCM to a single mono track (simple average). `length` is
 * the sample count per channel; channels shorter than it are read as silence.
 */
export function mixToMono(channels: readonly Float32Array[], length: number): Float32Array {
  const out = new Float32Array(Math.max(0, length));
  if (channels.length === 0) return out;
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Peak amplitude at a normalized position `tNorm` (0..1) across the envelope,
 * with linear interpolation between adjacent buckets. Returns 0 for an empty
 * envelope.
 */
export function peakAtNorm(peaks: Float32Array, tNorm: number): number {
  if (peaks.length === 0) return 0;
  if (peaks.length === 1) return peaks[0] ?? 0;
  const x = clamp01(tNorm) * (peaks.length - 1);
  const i = Math.floor(x);
  const frac = x - i;
  const a = peaks[i] ?? 0;
  const b = peaks[Math.min(peaks.length - 1, i + 1)] ?? a;
  return a + (b - a) * frac;
}

/**
 * Peak amplitude (0..1) of a waveform at time `tSec`. Times outside
 * [0, duration] read as silence. Used both to draw a playhead marker and to
 * drive the expression engine's `audio` accessor.
 */
export function amplitudeAt(wave: WaveformPeaks, tSec: number): number {
  if (wave.duration <= 0 || tSec < 0 || tSec > wave.duration) return 0;
  return peakAtNorm(wave.peaks, tSec / wave.duration);
}

/**
 * The slice of a waveform's peaks covering `[fromSec, toSec]` of the SOURCE.
 *
 * A clip bar shows a WINDOW onto its source, not the whole file: trimming moves
 * the window's edges and slipping slides it along. Drawing the full peak array
 * across the bar — which is what a clip bar did before this existed — meant the
 * waveform showed the whole file squeezed into whatever width the bar happened
 * to be, so the peaks under the playhead were not the audio you would hear
 * there, and trimming or slipping visibly changed nothing.
 *
 * Returns an empty array when the range is degenerate or entirely outside the
 * file, so callers can skip drawing rather than render a flat line that looks
 * like silence.
 */
export function peaksInRange(
  wave: WaveformPeaks,
  fromSec: number,
  toSec: number,
): Float32Array {
  if (wave.duration <= 0 || wave.peaks.length === 0) return new Float32Array(0);
  const from = Math.max(0, Math.min(fromSec, wave.duration));
  const to = Math.max(0, Math.min(toSec, wave.duration));
  if (!(to > from)) return new Float32Array(0);

  const n = wave.peaks.length;
  const lo = Math.floor((from / wave.duration) * n);
  // `ceil` so a window shorter than one bucket still yields the bucket it
  // touches rather than nothing at all.
  const hi = Math.min(n, Math.max(lo + 1, Math.ceil((to / wave.duration) * n)));
  return wave.peaks.subarray(lo, hi);
}

/**
 * Build an SVG path string for a symmetric (mirrored) waveform filling a
 * `width`×`height` box, baseline centred. Pure geometry so it can be unit
 * tested and reused by any renderer.
 */
export function waveformPath(peaks: Float32Array, width: number, height: number): string {
  if (peaks.length === 0 || width <= 0 || height <= 0) return '';
  const mid = height / 2;
  // Span the FULL width: the last sample sits at `width`, not one step short
  // of it. Dividing by `peaks.length` left a trailing gap of one bucket —
  // 0.1% and invisible across a 1024-bucket envelope, but a clip bar trimmed
  // to a short window draws from only a handful of buckets, where the same gap
  // is a visible chunk of empty bar at the end of the waveform.
  const step = peaks.length > 1 ? width / (peaks.length - 1) : width;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i < peaks.length; i++) {
    const x = i * step;
    const h = (peaks[i] ?? 0) * mid;
    top.push(`${x.toFixed(2)},${(mid - h).toFixed(2)}`);
    bottom.push(`${x.toFixed(2)},${(mid + h).toFixed(2)}`);
  }
  bottom.reverse();
  return `M${top.join(' L')} L${bottom.join(' L')} Z`;
}
