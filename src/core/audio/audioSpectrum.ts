/**
 * Audio Spectrum — the FFT half.
 *
 * The counterpart to `audioWaveformGen`, and deliberately shaped the same way,
 * because that module already solved the hard part of "an effect that reads
 * another layer's audio":
 *
 *   - PURE analysis here ({@link spectrumBands}) — samples in, band magnitudes
 *     out. No engine, no scene, no clock. Unit-testable without a DOM.
 *   - A RESOLVER ({@link resolveAudioSpectrum}) that looks the referenced audio
 *     layer up, converts comp time to clip-local time honouring the layer's bar,
 *     and calls the pure function. Returns an empty array when the source is
 *     missing or not yet decoded — draw nothing, never throw, never block.
 *
 * ── Why the magnitudes are resolved at SNAPSHOT time ────────────────────────
 *
 * The Canvas2D kernel that draws the bars is handed `(oc, w, h, effect)` and
 * nothing else, and that is worth preserving: it is what keeps every effect a
 * pure function of its params, which in turn is what makes preview and export
 * produce identical pixels and makes the content hash meaningful.
 *
 * So the analysis runs in `buildSnapshot`, where the scene and the engine are
 * both in scope, and the resulting band magnitudes are written INTO the effect's
 * params. The kernel then just draws numbers. The magnitudes changing per frame
 * is also exactly what makes the content hash vary per frame for this layer —
 * the same mechanism Timecode uses for the clock.
 */

import { fftInPlace } from '../../../packages/audio/src/analyse';
import { audioEngine } from './AudioEngine';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { audioComponent, readAudioClipTimings } from './audioScene';

/** Analysis window, in samples. A power of two, as the radix-2 FFT requires. */
export const SPECTRUM_FFT_SIZE = 1024;

/**
 * Band magnitudes (0..1) for one analysis window.
 *
 * ── Logarithmic band edges, not linear ─────────────────────────────────────
 *
 * Pitch is logarithmic and so is the ear. Splitting the spectrum into equal
 * linear slices puts almost every band above 5 kHz — where music has very
 * little energy — and crams the bass, kick and vocal range that people actually
 * want to see into the first bar or two. The classic "why does my spectrum only
 * wiggle on the left" bug, and it is a choice of band edges rather than a
 * rendering problem.
 *
 * A Hann window is applied before the transform. Without it the window's hard
 * edges are themselves a discontinuity, and the transform reports their
 * broadband energy as real signal — a spectrum that never goes quiet.
 */
export function spectrumBands(
  samples: Float32Array,
  sampleRate: number,
  bandCount: number,
  startFreq: number,
  endFreq: number,
): number[] {
  const n = SPECTRUM_FFT_SIZE;
  const bands = Math.max(1, Math.round(bandCount));
  if (samples.length === 0 || sampleRate <= 0) return new Array<number>(bands).fill(0);

  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const take = Math.min(n, samples.length);
  for (let i = 0; i < take; i++) {
    // Hann window.
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = samples[i]! * w;
  }
  fftInPlace(re, im);

  // Only the first half of the transform is meaningful for a real input; the
  // rest mirrors it.
  const bins = n / 2;
  const nyquist = sampleRate / 2;
  const lo = Math.max(1, Math.min(nyquist, startFreq));
  const hi = Math.max(lo * 1.01, Math.min(nyquist, endFreq));

  const out: number[] = [];
  for (let b = 0; b < bands; b++) {
    // Log-spaced edges across [lo, hi].
    const f0 = lo * Math.pow(hi / lo, b / bands);
    const f1 = lo * Math.pow(hi / lo, (b + 1) / bands);
    const i0 = Math.max(1, Math.min(bins - 1, Math.floor((f0 / nyquist) * bins)));
    const i1 = Math.max(i0 + 1, Math.min(bins, Math.ceil((f1 / nyquist) * bins)));

    let peak = 0;
    for (let i = i0; i < i1; i++) {
      const mag = Math.hypot(re[i]!, im[i]!);
      if (mag > peak) peak = mag;
    }
    // Peak rather than mean across the band: a mean over a wide high band
    // averages a real transient down into nothing, and the bars stop reacting
    // to exactly the hits people put a spectrum on screen to show.
    //
    // Compressed to dB-ish and normalised. Linear magnitude is unusable on
    // screen — music spans orders of magnitude, so a linear bar chart shows one
    // spike and a flat line.
    const db = 20 * Math.log10(peak + 1e-6);
    const norm = (db + 60) / 60; // −60 dB floor → 0, 0 dB → 1
    out.push(norm < 0 ? 0 : norm > 1 ? 1 : norm);
  }
  return out;
}

/** Config stored on the effect. Mirrors the params in `EFFECT_DEFS`. */
export interface AudioSpectrumRequest {
  sourceLayerId: string;
  bands: number;
  startFreq: number;
  endFreq: number;
}

/** Test seam, mirroring `__setWaveProviderForTest` in audioWaveformGen. */
let getBuffer: (assetId: string) => AudioBuffer | undefined = (id) => audioEngine.decodedBuffer(id);
export function __setSpectrumBufferProviderForTest(fn?: (assetId: string) => AudioBuffer | undefined): void {
  getBuffer = fn ?? ((id) => audioEngine.decodedBuffer(id));
}

/**
 * Resolve band magnitudes for a config against the live scene at `timeSec`.
 *
 * Always returns an array — all zeroes when the source is missing, unset, or not
 * yet decoded. A silent spectrum is the honest picture of "no audio here"; the
 * alternative is a frame that throws while the user is still choosing a layer.
 */
export function resolveAudioSpectrum(
  cfg: AudioSpectrumRequest,
  timeSec: number,
): number[] {
  const bands = Math.max(1, Math.round(cfg.bands));
  const silent = (): number[] => new Array<number>(bands).fill(0);

  const src = cfg.sourceLayerId ? defaultSceneGraph.getNode(cfg.sourceLayerId) : undefined;
  if (!src) return silent();
  const comp = audioComponent(src);
  const assetId = comp && typeof comp.props.__assetId === 'string' ? comp.props.__assetId : '';
  if (!assetId) return silent();
  const buffer = getBuffer(assetId);
  if (!buffer) return silent();

  // Clip-local time, honouring where the source layer's BAR sits and which part
  // of the source it plays — identical reasoning to resolveAudioWaveformPoints,
  // and the reason a trimmed or moved audio layer analyses the right moment.
  const timings = readAudioClipTimings(cfg.sourceLayerId);
  const at = timings.find((t) => timeSec >= t.startSec && timeSec < t.startSec + (t.outSec - t.inSec)) ?? timings[0];
  const localT = at ? at.inSec + (timeSec - at.startSec) : timeSec;
  if (localT < 0 || localT > buffer.duration) return silent();

  const channel = buffer.getChannelData(0);
  const start = Math.max(0, Math.min(channel.length - 1, Math.floor(localT * buffer.sampleRate)));
  const window = channel.subarray(start, Math.min(channel.length, start + SPECTRUM_FFT_SIZE));
  if (window.length === 0) return silent();

  return spectrumBands(
    window instanceof Float32Array ? window : Float32Array.from(window),
    buffer.sampleRate,
    bands,
    cfg.startFreq,
    cfg.endFreq,
  );
}
