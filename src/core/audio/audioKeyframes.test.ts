/**
 * Audio → keyframes: RMS envelope + thinning (pure math over a stub buffer).
 */

import {
  amplitudeEnvelope,
  thinEnvelope,
  smoothEnvelope,
  planAudioKeyframes,
  DEFAULT_AUDIO_KEYFRAME_OPTIONS,
} from './audioKeyframes';

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

describe('smoothEnvelope', () => {
  it('window 1 is the identity', () => {
    expect(smoothEnvelope([1, 9, 2, 8], 1)).toEqual([1, 9, 2, 8]);
  });

  it('flattens a single-sample spike toward its neighbours', () => {
    const out = smoothEnvelope([0, 0, 100, 0, 0], 3);
    expect(out[2]).toBeCloseTo(100 / 3, 6);
    expect(out[1]).toBeCloseTo(100 / 3, 6);
  });

  it('clamps the window at the edges rather than reading past them', () => {
    const out = smoothEnvelope([10, 20, 30], 3);
    expect(out[0]).toBeCloseTo(15, 6); // mean of [10, 20]
    expect(out[2]).toBeCloseTo(25, 6); // mean of [20, 30]
  });
});

describe('planAudioKeyframes', () => {
  const opts = (over: Partial<typeof DEFAULT_AUDIO_KEYFRAME_OPTIONS> = {}) => ({
    ...DEFAULT_AUDIO_KEYFRAME_OPTIONS,
    minDelta: 0,
    smoothing: 1,
    ...over,
  });

  it('frameStep is a hard ceiling on density (and always keeps the last frame)', () => {
    const env = Array.from({ length: 10 }, (_, i) => i * 10);
    const out = planAudioKeyframes(env, opts({ frameStep: 3 }));
    expect(out.map((k) => k.frame)).toEqual([0, 3, 6, 9]);
  });

  it('reports SOURCE frame indices, not decimated ones', () => {
    // The thinning runs over the decimated array; its indices must be mapped
    // back or every keyframe after the first lands at the wrong time.
    const env = [0, 0, 0, 0, 100, 0, 0, 0];
    const out = planAudioKeyframes(env, opts({ frameStep: 2, minDelta: 10 }));
    expect(out.map((k) => k.frame)).toContain(4);
    expect(Math.max(...out.map((k) => k.frame))).toBe(7);
  });

  it('gain scales the envelope and clamps to 0–100', () => {
    const out = planAudioKeyframes([10, 60], opts({ gain: 2 }));
    expect(out.map((k) => k.value)).toEqual([20, 100]);
  });

  it('a coarser detail setting yields strictly fewer keyframes', () => {
    // Sawtooth: every frame moves, so only the settings can thin it.
    const env = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 20 : 60));
    const fine = planAudioKeyframes(env, opts({ frameStep: 1, minDelta: 1 })).length;
    const coarse = planAudioKeyframes(env, opts({ frameStep: 4, minDelta: 8 })).length;
    expect(coarse).toBeLessThan(fine);
  });

  it('an empty envelope plans nothing', () => {
    expect(planAudioKeyframes([], opts())).toEqual([]);
  });
});
