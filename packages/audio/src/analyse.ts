/**
 * Beat and onset detection — Tier D.
 *
 * ## What this is for
 *
 * A piece cut to music and a piece cut to a stopwatch look different in a way
 * nobody has to be told. The caster already decides beat boundaries; without
 * this it decides them from the brief's pacing alone, so a track playing
 * underneath is decoration rather than structure. With it, the sequencer can put
 * its cuts where the music already puts them.
 *
 * ## Method
 *
 * Standard and deliberately unglamorous:
 *
 *  1. **Downmix and frame.** Mono, hop of 512 samples (~11.6ms at 44.1k), window
 *     of 1024. That hop is the resolution limit — around one frame at 60fps,
 *     which is as precise as a cut can be anyway.
 *  2. **Spectral flux.** Per frame, the sum of POSITIVE changes in magnitude per
 *     bin. Positive-only is the whole trick: a note ending is not an onset, and
 *     counting it produces an envelope that peaks between the beats.
 *  3. **Adaptive threshold.** A local median plus a margin. A fixed threshold
 *     finds every onset in a loud passage and none in a quiet one, which is how
 *     naive detectors "lose the beat" during a breakdown.
 *  4. **Tempo by autocorrelation** of the flux envelope over 60–190 BPM, then
 *     **phase** by testing every offset within one beat and taking the one whose
 *     beat positions collect the most flux.
 *
 * ## Why the FFT is in this file
 *
 * It is 40 lines and it removes a dependency from a package that otherwise has
 * none. `@motion/audio` is pure: no DOM, no `AudioContext`, no Web Audio. It
 * takes samples and returns numbers, which is what makes it testable against
 * synthesised signals where the right answer is known exactly.
 */

/** Analysis result. Times are SECONDS from the start of the buffer. */
export interface AudioAnalysis {
  /** Estimated tempo. 0 when no periodicity was found. */
  bpm: number;
  /** Confidence in `bpm`, 0..1. Below ~0.25 the tempo is a guess. */
  tempoConfidence: number;
  /** Beat grid, from the detected tempo and phase. */
  beats: number[];
  /** Detected transients. Denser than `beats` and not aligned to them. */
  onsets: number[];
  /** The raw flux envelope and its frame rate, for callers that want to draw it. */
  envelope: Float32Array;
  envelopeHz: number;
  /** Seconds of audio analysed. */
  durationSec: number;
}

export interface AnalyseOptions {
  /** Samples between frames. Lower is more precise and slower. */
  hop?: number;
  /** Frame size. Must be a power of two and >= hop. */
  frame?: number;
  /** Tempo search range. */
  minBpm?: number;
  maxBpm?: number;
  /** How far above the local median a peak must sit to count, in median units. */
  onsetSensitivity?: number;
}

const DEFAULTS = {
  hop: 512,
  frame: 1024,
  minBpm: 60,
  maxBpm: 190,
  /**
   * How far above the local median a peak must sit.
   *
   * 2.2, not 1.4. A drum transient clears its neighbourhood by a wide margin; a
   * sustained tone whose frequency sits between two FFT bins produces a periodic
   * leakage ripple that clears 1.4 comfortably, so a held note came back as a
   * click track. Raising the ratio separates the two without an absolute level
   * threshold, which would have thrown away quiet passages instead.
   */
  onsetSensitivity: 2.2,
} as const;

/**
 * In-place iterative radix-2 FFT.
 *
 * `re` and `im` are the interleaved-free real and imaginary parts, both of
 * length `n` (a power of two). Only magnitudes are read downstream, so no
 * normalisation is applied — a constant scale factor cannot change where the
 * peaks are.
 */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + len / 2]!;
        const bi = im[i + k + len / 2]!;
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[i + k] = ar + tr;
        im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr;
        im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Mix any channel count down to mono without changing length. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] = out[i]! + (ch[i] ?? 0);
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] = out[i]! * scale;
  return out;
}

/**
 * The spectral-flux onset envelope.
 *
 * One value per frame: the summed POSITIVE magnitude change since the previous
 * frame. Rising energy is an onset; falling energy is a note ending, and
 * including it puts peaks in the gaps between beats.
 */
export function onsetEnvelope(
  mono: Float32Array,
  sampleRate: number,
  o: { hop: number; frame: number },
): { envelope: Float32Array; envelopeHz: number } {
  const { hop, frame } = o;
  const bins = frame / 2;
  const frames = Math.max(0, Math.floor((mono.length - frame) / hop) + 1);
  const envelope = new Float32Array(Math.max(0, frames));

  // A Hann window, precomputed. Without it every frame boundary is a step
  // discontinuity, which spreads energy across all bins and buries the onsets in
  // spectral leakage.
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));

  const re = new Float32Array(frame);
  const im = new Float32Array(frame);
  let prev = new Float32Array(bins);

  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < frame; i++) {
      re[i] = (mono[start + i] ?? 0) * win[i]!;
      im[i] = 0;
    }
    fftInPlace(re, im);

    let flux = 0;
    const mag = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      const m = Math.hypot(re[b]!, im[b]!);
      mag[b] = m;
      const d = m - prev[b]!;
      if (d > 0) flux += d;
    }
    envelope[f] = flux;
    prev = mag;
  }

  return { envelope, envelopeHz: sampleRate / hop };
}

/** Median of a slice, without mutating the input. */
function median(values: Float32Array, from: number, to: number): number {
  const lo = Math.max(0, from);
  const hi = Math.min(values.length, to);
  if (hi <= lo) return 0;
  const slice = Array.prototype.slice.call(values, lo, hi) as number[];
  slice.sort((a, b) => a - b);
  const mid = slice.length >> 1;
  return slice.length % 2 ? slice[mid]! : (slice[mid - 1]! + slice[mid]!) / 2;
}

/**
 * Peaks in the envelope that clear a LOCAL threshold.
 *
 * The threshold is a running median over ~0.4s either side, times a margin. A
 * global threshold finds every onset in the loud half of a track and none in the
 * quiet half — which is exactly how a detector appears to "lose the beat" during
 * a breakdown and find it again at the drop.
 */
export function pickOnsets(
  envelope: Float32Array,
  envelopeHz: number,
  sensitivity: number,
): number[] {
  const half = Math.max(2, Math.round(envelopeHz * 0.4));
  // A tiny global floor, and no more than tiny.
  //
  // First attempt was 12% of the global peak, to stop a sustained tone's
  // bin-leakage ripple registering as a click track. It worked, and it also
  // deleted every onset in a passage 8% the volume of the loudest — which is the
  // exact case the LOCAL threshold exists for. One failure traded for another.
  //
  // The real discriminator is not absolute level, it is how far a peak stands
  // above its own neighbourhood: a transient towers over the local median, a
  // leakage ripple barely clears it. So the ratio does the work (see
  // `onsetSensitivity`, raised to 2.2 for the same reason) and this floor is set
  // low enough to catch only numerical noise.
  let peak = 0;
  for (let i = 0; i < envelope.length; i++) if (envelope[i]! > peak) peak = envelope[i]!;
  const floor = peak * 0.005;
  // Two onsets inside 50ms are one onset with a wobble; a drum hit does not
  // retrigger that fast and reporting both makes every cut a double.
  const minGapFrames = Math.max(1, Math.round(envelopeHz * 0.05));
  const out: number[] = [];
  let last = -Infinity;

  for (let i = 1; i < envelope.length - 1; i++) {
    const v = envelope[i]!;
    if (v <= envelope[i - 1]! || v < envelope[i + 1]!) continue; // not a local peak
    const thresh = median(envelope, i - half, i + half) * sensitivity;
    if (v < thresh || v <= 0 || v < floor) continue;
    if (i - last < minGapFrames) continue;
    out.push(i / envelopeHz);
    last = i;
  }
  return out;
}

/**
 * Tempo by autocorrelating the onset envelope.
 *
 * Returns the lag (in frames) with the strongest periodicity inside the BPM
 * range, and a confidence: the peak's height relative to the mean correlation.
 * A flat correlation means no periodicity, which is the honest answer for
 * speech or ambience and must not be dressed up as a tempo.
 */
export function estimateTempo(
  envelope: Float32Array,
  envelopeHz: number,
  minBpm: number,
  maxBpm: number,
): { bpm: number; confidence: number; lagFrames: number } {
  const minLag = Math.max(1, Math.floor((60 / maxBpm) * envelopeHz));
  const maxLag = Math.min(envelope.length - 1, Math.ceil((60 / minBpm) * envelopeHz));
  if (maxLag <= minLag) return { bpm: 0, confidence: 0, lagFrames: 0 };

  // Mean-remove first. A DC offset makes every lag correlate strongly and the
  // "peak" ends up wherever the overlap window is longest — always the shortest
  // lag, i.e. always the fastest tempo in range.
  let mean = 0;
  for (let i = 0; i < envelope.length; i++) mean += envelope[i]!;
  mean /= Math.max(1, envelope.length);

  // An envelope with no VARIATION has no tempo, and this gate is the difference
  // between an honest answer and a confident wrong one.
  //
  // Measured before it existed: silence returned 191 BPM. Every lag scored
  // exactly zero, so the search kept the first candidate it saw — the shortest
  // lag, which is the fastest tempo in range. A sustained tone scored 0.55
  // confidence for the same reason, differently: its correlation is flat, and a
  // confidence defined as a peak's height relative to a flat field is measuring
  // rounding error.
  //
  // Downstream this matters more than a missed beat. `bpm: 0` falls back to the
  // brief's pacing and nobody notices; a confident wrong tempo puts every cut in
  // the wrong place for the whole piece.
  let variance = 0;
  for (let i = 0; i < envelope.length; i++) {
    const d = envelope[i]! - mean;
    variance += d * d;
  }
  variance /= Math.max(1, envelope.length);
  // Relative to the mean, so the gate is scale-free: a quiet track and a loud one
  // with the same dynamics must be judged the same.
  const relative = mean > 0 ? Math.sqrt(variance) / mean : 0;
  if (variance <= 0 || relative < 0.25) return { bpm: 0, confidence: 0, lagFrames: 0 };

  const scores: number[] = [];
  let best = { lag: 0, score: -Infinity };
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const n = envelope.length - lag;
    for (let i = 0; i < n; i++) sum += (envelope[i]! - mean) * (envelope[i + lag]! - mean);
    const score = sum / Math.max(1, n);
    scores.push(score);
    if (score > best.score) best = { lag, score };
  }

  const avg = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
  const spread = Math.max(...scores) - Math.min(...scores);
  // Two factors, and both have to hold. How much the winning lag stands out from
  // the field, AND how strong it is in absolute terms against the envelope's own
  // variance — a peak can dominate a field of noise and still be noise.
  const prominence = spread > 0 ? Math.max(0, Math.min(1, (best.score - avg) / spread)) : 0;
  const strength = Math.max(0, Math.min(1, best.score / variance));
  const confidence = prominence * strength;
  const bpm = best.lag > 0 ? (60 * envelopeHz) / best.lag : 0;
  return { bpm: Number(bpm.toFixed(2)), confidence: Number(confidence.toFixed(3)), lagFrames: best.lag };
}

/**
 * Where the grid starts.
 *
 * Tempo tells you the spacing; it says nothing about where beat one falls, and a
 * grid at the right tempo in the wrong phase is worse than no grid — every cut
 * lands exactly between two beats. So try every offset within one beat and keep
 * whichever collects the most onset energy.
 */
export function estimatePhase(envelope: Float32Array, lagFrames: number): number {
  if (lagFrames <= 0) return 0;
  let best = { offset: 0, sum: -Infinity };
  for (let offset = 0; offset < lagFrames; offset++) {
    let sum = 0;
    for (let i = offset; i < envelope.length; i += lagFrames) sum += envelope[i]!;
    if (sum > best.sum) best = { offset, sum };
  }
  return best.offset;
}

/** Full analysis. `channels` are raw PCM, one array per channel. */
export function analyseAudio(
  channels: readonly Float32Array[],
  sampleRate: number,
  opts: AnalyseOptions = {},
): AudioAnalysis {
  const hop = opts.hop ?? DEFAULTS.hop;
  const frame = opts.frame ?? DEFAULTS.frame;
  const minBpm = opts.minBpm ?? DEFAULTS.minBpm;
  const maxBpm = opts.maxBpm ?? DEFAULTS.maxBpm;
  const sensitivity = opts.onsetSensitivity ?? DEFAULTS.onsetSensitivity;

  const mono = downmix(channels);
  const durationSec = sampleRate > 0 ? mono.length / sampleRate : 0;

  // Too short to hold even one beat at the slowest tempo in range. Returning an
  // empty analysis is the honest answer; inventing a tempo from two frames is
  // how a 300ms sting ends up "at 174 BPM".
  if (mono.length < frame * 2 || sampleRate <= 0) {
    return {
      bpm: 0, tempoConfidence: 0, beats: [], onsets: [],
      envelope: new Float32Array(0), envelopeHz: 0, durationSec,
    };
  }

  const { envelope, envelopeHz } = onsetEnvelope(mono, sampleRate, { hop, frame });
  const onsets = pickOnsets(envelope, envelopeHz, sensitivity);
  const tempo = estimateTempo(envelope, envelopeHz, minBpm, maxBpm);

  const beats: number[] = [];
  if (tempo.lagFrames > 0 && tempo.bpm > 0) {
    const phase = estimatePhase(envelope, tempo.lagFrames);
    for (let f = phase; f < envelope.length; f += tempo.lagFrames) beats.push(f / envelopeHz);
  }

  return {
    bpm: tempo.bpm,
    tempoConfidence: tempo.confidence,
    beats,
    onsets,
    envelope,
    envelopeHz,
    durationSec,
  };
}

/**
 * Snap a time to the nearest beat, but only if it is already close.
 *
 * `toleranceSec` exists because forcing every cut onto the grid is wrong: a
 * technique with a 300ms minimum cannot be dragged 400ms to reach a beat, and a
 * sequence that quantises everything loses the syncopation that made cutting to
 * music worth doing. Out of tolerance, the original time stands.
 */
export function snapToBeat(timeSec: number, beats: readonly number[], toleranceSec = 0.12): number {
  if (!beats.length) return timeSec;
  let best = beats[0]!;
  let bestD = Math.abs(timeSec - best);
  for (const b of beats) {
    const d = Math.abs(timeSec - b);
    if (d < bestD) { best = b; bestD = d; }
  }
  return bestD <= toleranceSec ? best : timeSec;
}
