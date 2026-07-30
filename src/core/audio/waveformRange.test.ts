/**
 * A clip bar's waveform shows the audible WINDOW, not the whole file.
 *
 * The bug this guards is the quiet kind: a clip bar drew `wave.peaks` entire,
 * scaled to whatever width the bar happened to be. It looked like a working
 * waveform — peaks, silence, shape — but the peaks under the playhead were not
 * the audio you would hear there, and trimming or slipping the bar changed
 * nothing on screen. Cutting to a beat off that display is guesswork dressed
 * up as precision.
 */

import { peaksInRange, waveformPath, type WaveformPeaks } from './waveform';

/** 10 seconds, 10 buckets — one per second, each identifiable by value. */
function wave(): WaveformPeaks {
  return {
    buckets: 10,
    duration: 10,
    peaks: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]),
  };
}

describe('peaksInRange', () => {
  it('returns the whole file for the full range', () => {
    expect(Array.from(peaksInRange(wave(), 0, 10))).toHaveLength(10);
  });

  it('slices to a trimmed window', () => {
    // Seconds 2..5 → buckets 2,3,4.
    expect(Array.from(peaksInRange(wave(), 2, 5))).toEqual([0.3, 0.4, 0.5].map((v) => expect.closeTo(v, 5)));
  });

  it('a slipped window of the same LENGTH reads different audio', () => {
    // The distinction the old code could not show: same duration, different
    // part of the source. Slip must visibly change the waveform.
    const a = Array.from(peaksInRange(wave(), 0, 3));
    const b = Array.from(peaksInRange(wave(), 5, 8));
    expect(a).toHaveLength(b.length);
    expect(a).not.toEqual(b);
  });

  it('trimming the in-point drops the head of the waveform', () => {
    const full = Array.from(peaksInRange(wave(), 0, 10));
    const trimmed = Array.from(peaksInRange(wave(), 4, 10));
    expect(trimmed).toEqual(full.slice(4));
  });

  it('clamps a window that runs past the end of the file', () => {
    // A bar dragged longer than its source: draw what exists, not garbage.
    expect(Array.from(peaksInRange(wave(), 8, 99))).toEqual([0.9, 1.0].map((v) => expect.closeTo(v, 5)));
  });

  it('yields at least one bucket for a window shorter than a bucket', () => {
    // A heavily zoomed-in bar must still draw something rather than vanish.
    expect(peaksInRange(wave(), 3.1, 3.2).length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for a degenerate or inverted range', () => {
    expect(peaksInRange(wave(), 5, 5)).toHaveLength(0);
    expect(peaksInRange(wave(), 7, 3)).toHaveLength(0);
    expect(peaksInRange(wave(), 20, 30)).toHaveLength(0);
  });

  it('returns empty for a waveform with no duration', () => {
    expect(peaksInRange({ buckets: 0, duration: 0, peaks: new Float32Array(0) }, 0, 5)).toHaveLength(0);
  });
});

describe('the path drawn from a slice', () => {
  it('fills the bar width regardless of how much of the source it covers', () => {
    // Both windows draw across the same bar; the SHAPE differs, the extent
    // does not. A slice that drew narrower would leave a gap at the bar's end.
    const short = waveformPath(peaksInRange(wave(), 0, 2), 100, 20);
    const long = waveformPath(peaksInRange(wave(), 0, 10), 100, 20);
    for (const d of [short, long]) {
      const xs = [...d.matchAll(/([\d.]+),/g)].map((m) => Number(m[1]));
      expect(Math.max(...xs)).toBeGreaterThan(90);
    }
  });

  it('produces nothing for an empty slice, so the caller can skip drawing', () => {
    expect(waveformPath(peaksInRange(wave(), 5, 5), 100, 20)).toBe('');
  });
});
