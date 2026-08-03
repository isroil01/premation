/**
 * Audio Spectrum — the analysis, asserted against synthesised signals.
 *
 * A spectrum analyser is unusually easy to ship broken-but-plausible: bars that
 * move look right, and only a generated tone proves they move for the right
 * reason. So the assertions here are "a 1 kHz sine puts its energy in the 1 kHz
 * band", not "the output changes".
 *
 * Two design choices are pinned because losing either degrades it silently:
 * logarithmic band edges (linear edges bury bass and vocals in the first bar),
 * and the Hann window (without it the window's own edges read as broadband
 * signal and the spectrum never goes quiet).
 */

import { spectrumBands, resolveAudioSpectrum, SPECTRUM_FFT_SIZE, __setSpectrumBufferProviderForTest } from './audioSpectrum';

const RATE = 44100;

/** `seconds` of a pure sine at `freq`. */
function sine(freq: number, n = SPECTRUM_FFT_SIZE, rate = RATE): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function silence(n = SPECTRUM_FFT_SIZE): Float32Array {
  return new Float32Array(n);
}

/** Index of the largest band. */
const peakBand = (m: readonly number[]): number => m.indexOf(Math.max(...m));

describe('spectrumBands', () => {
  it('returns exactly the requested number of bands', () => {
    expect(spectrumBands(sine(1000), RATE, 16, 40, 16000)).toHaveLength(16);
    expect(spectrumBands(sine(1000), RATE, 64, 40, 16000)).toHaveLength(64);
  });

  it('reports silence as silence', () => {
    // The assertion the Hann window exists for. Without it, the window's hard
    // edges are a discontinuity the transform reports as real broadband energy,
    // and a silent passage still shows bars.
    const m = spectrumBands(silence(), RATE, 32, 40, 16000);
    expect(Math.max(...m)).toBe(0);
  });

  it('clamps every band to 0..1', () => {
    const loud = sine(1000);
    for (let i = 0; i < loud.length; i++) loud[i] = loud[i]! * 50;
    const m = spectrumBands(loud, RATE, 32, 40, 16000);
    for (const v of m) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('puts a LOW tone in a low band and a HIGH tone in a high band', () => {
    // The core correctness claim: energy lands where the frequency is.
    const bands = 32;
    const low = peakBand(spectrumBands(sine(120), RATE, bands, 40, 16000));
    const high = peakBand(spectrumBands(sine(8000), RATE, bands, 40, 16000));
    expect(low).toBeLessThan(high);
    expect(low).toBeLessThan(bands / 3);
    expect(high).toBeGreaterThan(bands / 2);
  });

  it('moves the peak upward as the tone rises', () => {
    const bands = 48;
    const at = (f: number) => peakBand(spectrumBands(sine(f), RATE, bands, 40, 16000));
    expect(at(200)).toBeLessThanOrEqual(at(800));
    expect(at(800)).toBeLessThanOrEqual(at(3000));
    expect(at(3000)).toBeLessThanOrEqual(at(10000));
  });

  it('spaces bands LOGARITHMICALLY, so the bass half of the ear gets half the bars', () => {
    // With linear edges nearly every band sits above 5 kHz, where music has
    // little energy, and 120 Hz / 400 Hz / 900 Hz all collapse into bar 0 — the
    // classic "it only wiggles on the left" spectrum.
    const bands = 32;
    const a = peakBand(spectrumBands(sine(120), RATE, bands, 40, 16000));
    const b = peakBand(spectrumBands(sine(400), RATE, bands, 40, 16000));
    const c = peakBand(spectrumBands(sine(900), RATE, bands, 40, 16000));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('honours the start/end frequency range', () => {
    // Narrowing the range must re-spread the same tone across the bars.
    const wide = peakBand(spectrumBands(sine(1000), RATE, 32, 40, 16000));
    const narrow = peakBand(spectrumBands(sine(1000), RATE, 32, 800, 1300));
    expect(wide).not.toBe(narrow);
  });

  it('survives an empty or degenerate input rather than throwing', () => {
    expect(spectrumBands(new Float32Array(0), RATE, 8, 40, 16000)).toEqual(new Array(8).fill(0));
    expect(() => spectrumBands(sine(1000), 0, 8, 40, 16000)).not.toThrow();
    expect(() => spectrumBands(sine(1000), RATE, 8, 5000, 100)).not.toThrow();
  });

  it('is deterministic', () => {
    // Preview and export must agree, and a scrub back to a frame must repaint
    // the same bars.
    expect(spectrumBands(sine(1000), RATE, 32, 40, 16000))
      .toEqual(spectrumBands(sine(1000), RATE, 32, 40, 16000));
  });
});

describe('resolveAudioSpectrum', () => {
  afterEach(() => __setSpectrumBufferProviderForTest());

  it('returns a silent spectrum of the right length when no layer is chosen', () => {
    // Inert while the user is still picking a layer — not an error, and not an
    // empty array the drawing code would have to special-case.
    expect(resolveAudioSpectrum({ sourceLayerId: '', bands: 12, startFreq: 40, endFreq: 16000 }, 0))
      .toEqual(new Array(12).fill(0));
  });

  it('returns a silent spectrum when the referenced layer does not exist', () => {
    expect(resolveAudioSpectrum({ sourceLayerId: 'nope', bands: 8, startFreq: 40, endFreq: 16000 }, 1))
      .toEqual(new Array(8).fill(0));
  });

  it('never throws while the source is undecoded', () => {
    __setSpectrumBufferProviderForTest(() => undefined);
    expect(() =>
      resolveAudioSpectrum({ sourceLayerId: 'x', bands: 8, startFreq: 40, endFreq: 16000 }, 1),
    ).not.toThrow();
  });
});
