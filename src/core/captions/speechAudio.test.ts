/**
 * The audio maths, without Web Audio.
 *
 * The resampler is the part that can be silently wrong: it produces a file the
 * provider happily transcribes, and the only symptom is that every caption
 * drifts against the picture by a growing amount. An off-by-one in the output
 * length is a rate error, and a rate error is a drift.
 */

import { resampleLinear, toMono, SPEECH_SAMPLE_RATE } from './speechAudio';
import type { PcmSource } from '@core/audio/audioMixdown';

function source(channels: Float32Array[], sampleRate = 48000): PcmSource {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    getChannelData: (c: number) => channels[c] as Float32Array,
  };
}

describe('toMono', () => {
  it('passes a mono buffer through', () => {
    const mono = new Float32Array([0.1, -0.2, 0.3]);
    expect(Array.from(toMono(source([mono])))).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(-0.2, 6),
      expect.closeTo(0.3, 6),
    ]);
  });

  it('averages channels rather than summing them into clipping', () => {
    const left = new Float32Array([1, 1]);
    const right = new Float32Array([0, -1]);
    expect(Array.from(toMono(source([left, right])))).toEqual([0.5, 0]);
  });

  it('handles a buffer with no channels at all', () => {
    expect(toMono(source([])).length).toBe(0);
  });
});

describe('resampleLinear', () => {
  it('is a no-op at the same rate', () => {
    const samples = new Float32Array([1, 2, 3]);
    expect(resampleLinear(samples, 48000, 48000)).toBe(samples);
  });

  it('shortens by exactly the rate ratio, which is what stops caption drift', () => {
    // One second at 48 kHz must be one second at 16 kHz. If this is off by a
    // percent, a five-minute transcript ends three seconds out of step.
    const oneSecond = new Float32Array(48000);
    expect(resampleLinear(oneSecond, 48000, SPEECH_SAMPLE_RATE).length).toBe(16000);
  });

  it('interpolates between samples rather than dropping them', () => {
    // 4 samples at 4 Hz → 2 at 2 Hz: positions 0 and 2 of a ramp.
    const ramp = new Float32Array([0, 1, 2, 3]);
    const out = resampleLinear(ramp, 4, 2);
    expect(Array.from(out)).toEqual([0, 2]);
  });

  it('upsamples too, blending between neighbours', () => {
    const out = resampleLinear(new Float32Array([0, 1]), 1, 2);
    expect(out.length).toBe(4);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  it('does not click at the end by reading past the last sample', () => {
    const out = resampleLinear(new Float32Array([1, 1, 1, 1]), 4, 3);
    for (const s of out) expect(s).toBeCloseTo(1, 6);
  });

  it('handles an empty buffer', () => {
    expect(resampleLinear(new Float32Array(0), 48000, 16000).length).toBe(0);
  });
});
