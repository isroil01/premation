/**
 * Beat detection, tested against signals whose correct answer is known.
 *
 * This is the reason the package is pure. A detector validated by looking at a
 * waveform is validated by whoever is looking; a detector fed a click track
 * synthesised at exactly 120 BPM either says 120 or it does not.
 *
 * The negative cases matter as much as the positive ones. A detector that finds
 * a tempo in silence, or in noise, is worse than one that finds nothing —
 * downstream, a confident wrong tempo puts every cut in the wrong place, while
 * `bpm: 0` falls back to the brief's pacing and nobody notices.
 */

import {
  analyseAudio, downmix, estimateTempo, fftInPlace, onsetEnvelope, pickOnsets, snapToBeat,
} from './analyse';

const SR = 44100;

/** A click track: short bursts of noise at a fixed tempo. */
function clickTrack(bpm: number, seconds: number, o: { offsetSec?: number } = {}): Float32Array {
  const buf = new Float32Array(Math.round(SR * seconds));
  const period = (60 / bpm) * SR;
  const clickLen = Math.round(SR * 0.02);
  // A deterministic pseudo-noise burst — `Math.random()` would make a failure
  // impossible to reproduce.
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  for (let t = Math.round((o.offsetSec ?? 0) * SR); t < buf.length; t += period) {
    const start = Math.round(t);
    for (let i = 0; i < clickLen && start + i < buf.length; i++) {
      // Decaying burst: a rectangular one has an offset AND an onset, and the
      // offset would show up as a second peak if the flux were not positive-only.
      buf[start + i] = rnd() * 2 * (1 - i / clickLen);
    }
  }
  return buf;
}

/** A steady tone — energy, but no transients and no periodicity. */
function tone(freq: number, seconds: number): Float32Array {
  const buf = new Float32Array(Math.round(SR * seconds));
  for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5;
  return buf;
}

describe('fft', () => {
  it('puts a pure tone in the bin it belongs in', () => {
    // The guard on everything downstream: if the transform is wrong, every flux
    // value is wrong and the tempo tests could still pass by coincidence.
    const n = 1024;
    const bin = 64;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
    fftInPlace(re, im);
    const mags = Array.from({ length: n / 2 }, (_, b) => Math.hypot(re[b]!, im[b]!));
    const peak = mags.indexOf(Math.max(...mags));
    expect(peak).toBe(bin);
  });

  it('leaves a constant signal entirely in DC', () => {
    const n = 256;
    const re = new Float32Array(n).fill(1);
    const im = new Float32Array(n);
    fftInPlace(re, im);
    expect(Math.hypot(re[0]!, im[0]!)).toBeCloseTo(n, 3);
    for (let b = 1; b < 8; b++) expect(Math.hypot(re[b]!, im[b]!)).toBeLessThan(1e-3);
  });
});

describe('downmix', () => {
  it('returns the single channel untouched', () => {
    const ch = new Float32Array([1, -1, 0.5]);
    expect(downmix([ch])).toBe(ch);
  });

  it('averages rather than sums — two identical channels must not clip', () => {
    const a = new Float32Array([1, 1]);
    const b = new Float32Array([1, 1]);
    expect(Array.from(downmix([a, b]))).toEqual([1, 1]);
  });
});

describe('tempo', () => {
  it.each([90, 120, 140, 174])('finds %i BPM in a click track', (bpm) => {
    const a = analyseAudio([clickTrack(bpm, 12)], SR);
    // Within 2 BPM: the envelope hop quantises the achievable lag, so exactness
    // is not available and demanding it would be a test that fails on arithmetic
    // rather than on behaviour.
    expect(Math.abs(a.bpm - bpm)).toBeLessThanOrEqual(2);
    expect(a.tempoConfidence).toBeGreaterThan(0.2);
  });

  it('reports no tempo for silence rather than inventing one', () => {
    const a = analyseAudio([new Float32Array(SR * 5)], SR);
    expect(a.bpm).toBe(0);
    expect(a.beats).toEqual([]);
    expect(a.onsets).toEqual([]);
  });

  it('is not confident about a steady tone', () => {
    // A sustained note has energy but no transients. Whatever tempo comes out of
    // a flat correlation is noise, and the confidence has to say so — this is
    // what the caller checks before trusting the grid.
    const a = analyseAudio([tone(440, 6)], SR);
    expect(a.tempoConfidence).toBeLessThan(0.35);
  });

  it('gives the same answer twice — no hidden randomness', () => {
    const buf = clickTrack(128, 8);
    const a = analyseAudio([buf], SR);
    const b = analyseAudio([buf], SR);
    expect(a.bpm).toBe(b.bpm);
    expect(a.beats).toEqual(b.beats);
  });
});

describe('phase', () => {
  it('puts the grid on the clicks, not between them', () => {
    // Tempo without phase is worse than nothing: every cut lands exactly halfway
    // between two beats, which reads as deliberately off.
    const offset = 0.25;
    const a = analyseAudio([clickTrack(120, 12, { offsetSec: offset })], SR);
    expect(a.beats.length).toBeGreaterThan(4);
    const period = 60 / 120;
    for (const beat of a.beats.slice(1, 6)) {
      const phaseErr = Math.abs(((beat - offset) % period) + period) % period;
      const wrapped = Math.min(phaseErr, period - phaseErr);
      expect(wrapped).toBeLessThan(0.06);
    }
  });
});

describe('onsets', () => {
  it('finds roughly one onset per click', () => {
    const seconds = 8;
    const bpm = 120;
    const a = analyseAudio([clickTrack(bpm, seconds)], SR);
    const expected = (bpm / 60) * seconds;
    expect(a.onsets.length).toBeGreaterThan(expected * 0.7);
    expect(a.onsets.length).toBeLessThan(expected * 1.4);
  });

  it('never reports two onsets inside 50ms', () => {
    // A drum hit does not retrigger that fast; two detections that close are one
    // transient with a wobble, and reporting both makes every cut a double.
    const a = analyseAudio([clickTrack(174, 10)], SR);
    for (let i = 1; i < a.onsets.length; i++) {
      expect(a.onsets[i]! - a.onsets[i - 1]!).toBeGreaterThanOrEqual(0.049);
    }
  });

  it('keeps finding onsets after a big level drop', () => {
    // The adaptive-threshold case. With a global threshold the quiet half goes
    // undetected, which is exactly how a detector appears to lose the beat
    // during a breakdown.
    const loud = clickTrack(120, 6);
    const quiet = clickTrack(120, 6);
    for (let i = 0; i < quiet.length; i++) quiet[i] = quiet[i]! * 0.08;
    const joined = new Float32Array(loud.length + quiet.length);
    joined.set(loud, 0);
    joined.set(quiet, loud.length);

    const a = analyseAudio([joined], SR);
    const cut = loud.length / SR;
    const inQuiet = a.onsets.filter((t) => t > cut + 0.5).length;
    expect(inQuiet).toBeGreaterThan(4);
  });

  it('finds nothing in a signal with no transients', () => {
    const { envelope, envelopeHz } = onsetEnvelope(tone(220, 4), SR, { hop: 512, frame: 1024 });
    const onsets = pickOnsets(envelope, envelopeHz, 1.4);
    // A handful of edge artefacts is tolerable; a click per beat is not.
    expect(onsets.length).toBeLessThan(8);
  });
});

describe('degenerate input', () => {
  it('handles a buffer shorter than one frame', () => {
    const a = analyseAudio([new Float32Array(100)], SR);
    expect(a.bpm).toBe(0);
    expect(a.durationSec).toBeCloseTo(100 / SR, 6);
  });

  it('handles a zero sample rate without dividing by it', () => {
    const a = analyseAudio([new Float32Array(4096)], 0);
    expect(Number.isFinite(a.durationSec)).toBe(true);
    expect(a.bpm).toBe(0);
  });

  it('handles an empty channel list', () => {
    const a = analyseAudio([new Float32Array(0)], SR);
    expect(a.bpm).toBe(0);
    expect(a.onsets).toEqual([]);
  });

  it('never returns NaN anywhere', () => {
    const a = analyseAudio([clickTrack(120, 4)], SR);
    expect(Number.isFinite(a.bpm)).toBe(true);
    expect(Number.isFinite(a.tempoConfidence)).toBe(true);
    for (const t of [...a.beats, ...a.onsets]) expect(Number.isFinite(t)).toBe(true);
  });
});

describe('snapToBeat', () => {
  const beats = [0, 0.5, 1, 1.5, 2];

  it('snaps a near miss onto the grid', () => {
    expect(snapToBeat(0.52, beats)).toBe(0.5);
  });

  it('leaves a time that is nowhere near a beat alone', () => {
    // Quantising everything is the failure mode: a technique with a 300ms
    // minimum cannot be dragged 400ms to reach a beat, and forcing it loses the
    // syncopation that made cutting to music worth doing.
    expect(snapToBeat(0.75, beats)).toBe(0.75);
  });

  it('is a no-op with no grid', () => {
    expect(snapToBeat(1.234, [])).toBe(1.234);
  });
});
