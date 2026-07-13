import {
  computePeaks,
  mixToMono,
  peakAtNorm,
  amplitudeAt,
  waveformPath,
  type WaveformPeaks,
} from './waveform';

describe('computePeaks', () => {
  it('takes the max absolute sample per bucket', () => {
    const s = new Float32Array([0, 0.2, -0.9, 0.1, 0.5, -0.3]);
    const peaks = computePeaks(s, 2);
    expect(peaks).toHaveLength(2);
    expect(peaks[0]).toBeCloseTo(0.9); // first half
    expect(peaks[1]).toBeCloseTo(0.5); // second half
  });

  it('clamps amplitudes above 1', () => {
    expect(computePeaks(new Float32Array([2, -3]), 1)[0]).toBe(1);
  });

  it('returns silence for empty input', () => {
    const peaks = computePeaks(new Float32Array([]), 4);
    expect(peaks).toHaveLength(4);
    expect(Array.from(peaks)).toEqual([0, 0, 0, 0]);
  });

  it('never produces fewer buckets than requested', () => {
    expect(computePeaks(new Float32Array([0.5]), 8)).toHaveLength(8);
  });
});

describe('mixToMono', () => {
  it('averages channels sample-by-sample', () => {
    const l = new Float32Array([1, 0, -1]);
    const r = new Float32Array([0, 0, 1]);
    const mono = mixToMono([l, r], 3);
    expect(Array.from(mono)).toEqual([0.5, 0, 0]);
  });

  it('treats a missing channel sample as silence', () => {
    const mono = mixToMono([new Float32Array([1, 1])], 3);
    expect(mono[2]).toBe(0);
  });
});

describe('peakAtNorm', () => {
  it('interpolates between buckets', () => {
    const peaks = new Float32Array([0, 1]);
    expect(peakAtNorm(peaks, 0)).toBeCloseTo(0);
    expect(peakAtNorm(peaks, 0.5)).toBeCloseTo(0.5);
    expect(peakAtNorm(peaks, 1)).toBeCloseTo(1);
  });

  it('clamps out-of-range positions', () => {
    const peaks = new Float32Array([0.2, 0.8]);
    expect(peakAtNorm(peaks, -1)).toBeCloseTo(0.2);
    expect(peakAtNorm(peaks, 2)).toBeCloseTo(0.8);
  });
});

describe('amplitudeAt', () => {
  const wave: WaveformPeaks = { buckets: 2, peaks: new Float32Array([0.4, 0.8]), duration: 2 };

  it('samples the envelope by time', () => {
    expect(amplitudeAt(wave, 0)).toBeCloseTo(0.4);
    expect(amplitudeAt(wave, 2)).toBeCloseTo(0.8);
  });

  it('reads silence outside the clip', () => {
    expect(amplitudeAt(wave, -0.5)).toBe(0);
    expect(amplitudeAt(wave, 3)).toBe(0);
  });
});

describe('waveformPath', () => {
  it('produces a closed mirrored path', () => {
    const d = waveformPath(new Float32Array([0.5, 1]), 100, 40);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });

  it('is empty for degenerate input', () => {
    expect(waveformPath(new Float32Array([]), 100, 40)).toBe('');
    expect(waveformPath(new Float32Array([1]), 0, 40)).toBe('');
  });
});
