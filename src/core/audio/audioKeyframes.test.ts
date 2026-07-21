/**
 * Audio → keyframes: RMS envelope + thinning (pure math over a stub buffer).
 */

import { amplitudeEnvelope, thinEnvelope } from './audioKeyframes';

/** A one-channel stub AudioBuffer with the given samples at `sampleRate`. */
function buffer(samples: number[], sampleRate = 100): AudioBuffer {
  const data = new Float32Array(samples);
  return {
    duration: samples.length / sampleRate,
    length: samples.length,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

describe('amplitudeEnvelope', () => {
  it('one value per frame, normalized to 0–100 against the clip peak', () => {
    // 100 Hz buffer at 10 fps → 10 samples per frame, 2 frames.
    // Frame 0: silence. Frame 1: full-scale square wave → the peak.
    const env = amplitudeEnvelope(buffer([...Array(10).fill(0), ...Array(10).fill(1)]), 10);
    expect(env).toHaveLength(2);
    expect(env[0]).toBe(0);
    expect(env[1]).toBe(100);
  });

  it('intermediate loudness lands between 0 and 100', () => {
    const env = amplitudeEnvelope(
      buffer([...Array(10).fill(0.5), ...Array(10).fill(1)]),
      10,
    );
    expect(env[0]).toBeGreaterThan(40);
    expect(env[0]).toBeLessThan(60);
    expect(env[1]).toBe(100);
  });

  it('an all-silent buffer yields zeros (no divide-by-zero)', () => {
    const env = amplitudeEnvelope(buffer(Array(30).fill(0)), 10);
    expect(env.every((v) => v === 0)).toBe(true);
  });
});

describe('thinEnvelope', () => {
  it('keeps first + last and drops flat stretches', () => {
    const out = thinEnvelope([10, 10.1, 10.2, 10.1, 10], 0.5);
    expect(out[0]).toEqual({ frame: 0, value: 10 });
    expect(out[out.length - 1]).toEqual({ frame: 4, value: 10 });
    expect(out).toHaveLength(2);
  });

  it('keeps frames that move by at least the delta', () => {
    const out = thinEnvelope([0, 0, 50, 50, 100], 0.5);
    const frames = out.map((k) => k.frame);
    expect(frames).toContain(2);
    expect(frames).toContain(4);
  });
});
