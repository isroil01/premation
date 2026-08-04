/**
 * Convert Audio to Keyframes — the three channels, hand-derived.
 *
 * ## The fixture, and why every number in it is awkward on purpose (rule 3a)
 *
 * 100 Hz, 10 fps → 10 samples per frame, 4 frames. Each frame holds a CONSTANT
 * sample value, so its RMS is just that value and the whole envelope can be
 * derived on paper:
 *
 *   left   1.00  0.50  0.00  0.25
 *   right  0.50  0.50  0.50  0.50
 *   both   = sqrt((L² + R²) / 2)  — 20 samples pooled per frame
 *          0.7906  0.5000  0.3536  0.3953
 *
 * Shared peak = 1.0 (left, frame 0), so ×100:
 *
 *   left   100    50    0    25
 *   right   50    50   50    50
 *   both    79.1  50   35.4  39.5
 *
 * What that choice makes REACHABLE, each of which a tidier signal hides:
 *
 *  * left VARIES, so a constant-amplitude tone is excluded — an implementation
 *    that returned a flat envelope, or the peak for every frame, fails.
 *  * left ≠ right, so the channels are separable. Give both channels the same
 *    samples and every channel assertion passes with left and right swapped.
 *  * right never reaches 100. That is the assertion that pins SHARED
 *    normalisation: normalise each channel to its own peak and right becomes
 *    [100,100,100,100], which is exactly the bug that would make the Left and
 *    Right sliders useless while looking perfectly reasonable on screen.
 *  * left frame 2 is exactly 0 — silence inside a non-silent clip.
 *
 * And what the CONSTANT-per-frame choice excludes, closed by the boundary
 * fixtures below: with a constant frame, RMS and mean-of-absolute-values are
 * the SAME number, and every sample is positive. So neither "mean instead of
 * RMS" nor "summed v instead of v²" can be seen by anything above.
 */

import {
  amplitudeEnvelope,
  amplitudeEnvelopes,
  AUDIO_CHANNELS,
  type AudioChannel,
} from './audioKeyframes';

/** A stub AudioBuffer over per-channel sample arrays. */
function stereo(left: number[], right: number[], sampleRate = 100): AudioBuffer {
  const ch = [new Float32Array(left), new Float32Array(right)];
  return {
    duration: left.length / sampleRate,
    length: left.length,
    sampleRate,
    numberOfChannels: 2,
    getChannelData: (i: number) => ch[i]!,
  } as unknown as AudioBuffer;
}

/**
 * Mono — and it THROWS on any channel but 0, as a real `AudioBuffer` does.
 *
 * The obvious stub (`getChannelData: () => data`) ignores the index and hands
 * the same samples back for every channel, which silently makes the mono
 * fallback untestable: reading channel 1 of a one-channel buffer "works" in
 * the fixture and raises IndexSizeError in a browser. Verified by breaking —
 * with the lenient stub, hard-wiring Right to channel 1 fails NOTHING.
 */
function mono(samples: number[], sampleRate = 100): AudioBuffer {
  const data = new Float32Array(samples);
  return {
    duration: samples.length / sampleRate,
    length: samples.length,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: (i: number) => {
      if (i !== 0) throw new Error(`IndexSizeError: channel ${i} of a mono buffer`);
      return data;
    },
  } as unknown as AudioBuffer;
}

const rep = (v: number, n = 10) => Array<number>(n).fill(v);

/** The paper fixture above. */
const FIXTURE = stereo(
  [...rep(1.0), ...rep(0.5), ...rep(0.0), ...rep(0.25)],
  [...rep(0.5), ...rep(0.5), ...rep(0.5), ...rep(0.5)],
);

describe('amplitudeEnvelopes — the three AE channels', () => {
  const envs = () => amplitudeEnvelopes(FIXTURE, 10, AUDIO_CHANNELS);

  it('left matches the hand-derived envelope', () => {
    expect(envs().get('left')).toEqual([100, 50, 0, 25]);
  });

  it('right matches the hand-derived envelope', () => {
    expect(envs().get('right')).toEqual([50, 50, 50, 50]);
  });

  it('both channels is the pooled RMS, not the mean of the two', () => {
    // sqrt((L²+R²)/2) per frame. The MEAN of left and right would give
    // [75, 50, 25, 37.5] — different in three of the four frames.
    const both = envs().get('both')!;
    expect(both[0]).toBeCloseTo(79.1, 6);
    expect(both[1]).toBeCloseTo(50, 6);
    expect(both[2]).toBeCloseTo(35.4, 6);
    expect(both[3]).toBeCloseTo(39.5, 6);
  });

  /**
   * The decisive one. Independent per-channel normalisation is the natural
   * implementation (three calls to `amplitudeEnvelope`) and it destroys the
   * only information the split exists to carry.
   */
  it('normalises the channels against ONE SHARED peak', () => {
    const e = envs();
    expect(Math.max(...e.get('right')!)).toBe(50);
    expect(Math.max(...e.get('left')!)).toBe(100);
    // Stated as the ratio too: right is exactly half of left's peak, because
    // 0.5 is exactly half of 1.0 in the source.
    expect(Math.max(...e.get('right')!) * 2).toBe(Math.max(...e.get('left')!));
  });

  it('asking for one channel alone reduces to its own peak', () => {
    // The existing single-track path must not change: `['both']` on its own
    // normalises against both's peak, exactly as `amplitudeEnvelope` does.
    const alone = amplitudeEnvelopes(FIXTURE, 10, ['both']).get('both')!;
    expect(alone).toEqual(amplitudeEnvelope(FIXTURE, 10, 'both'));
    expect(Math.max(...alone)).toBe(100);
  });
});

describe('the constant-frame fixture’s blind spots', () => {
  /**
   * RMS ≠ mean(|v|) only when the frame is not constant. Half a frame at full
   * scale and half silent: RMS = sqrt(0.5) = 0.7071, mean|v| = 0.5. Against a
   * full-scale second frame that is 70.7 versus 50 — far apart enough that no
   * rounding explains it.
   */
  it('is RMS, not the mean of absolute values', () => {
    const b = mono([...rep(1, 5), ...rep(0, 5), ...rep(1, 10)]);
    const env = amplitudeEnvelope(b, 10);
    expect(env[0]).toBeCloseTo(70.7, 6);
    expect(env[1]).toBe(100);
  });

  /**
   * Every sample in the main fixture is positive, so summing `v` instead of
   * `v²` would agree with it. An alternating frame separates them: RMS is 1,
   * while the signed sum is 0.
   */
  it('squares the samples — a symmetric wave is loud, not silent', () => {
    const alt = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const env = amplitudeEnvelope(mono([...alt, ...rep(1, 10)]), 10);
    expect(env[0]).toBe(100);
    expect(env[1]).toBe(100);
  });
});

describe('boundaries', () => {
  /**
   * Silence must produce ZEROS, not an empty array and not NaN. An empty
   * envelope writes no keyframes at all, which looks identical to "the
   * conversion did not run" — the failure this boundary exists to separate.
   */
  it('a silent clip yields zeros, one per frame', () => {
    const silent = stereo(rep(0, 40), rep(0, 40));
    const e = amplitudeEnvelopes(silent, 10, AUDIO_CHANNELS);
    for (const c of AUDIO_CHANNELS) {
      expect(e.get(c)).toEqual([0, 0, 0, 0]);
      expect(e.get(c)!.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  /** One silent channel must not drag the others down or divide by zero. */
  it('a silent channel is zeros while the other keeps its scale', () => {
    const half = stereo([...rep(1, 20), ...rep(0.5, 20)], rep(0, 40));
    const e = amplitudeEnvelopes(half, 10, AUDIO_CHANNELS);
    expect(e.get('right')).toEqual([0, 0, 0, 0]);
    expect(e.get('left')).toEqual([100, 100, 50, 50]);
  });

  /**
   * MONO answers all three from its single channel. The literal reading —
   * "channel 1 does not exist, so Right is silent" — makes a mono voiceover
   * drive nothing off Right, which reads as a broken feature.
   */
  it('a mono clip answers all three channels identically', () => {
    const m = mono([...rep(1, 10), ...rep(0.25, 10)]);
    const e = amplitudeEnvelopes(m, 10, AUDIO_CHANNELS);
    expect(e.get('left')).toEqual([100, 25]);
    expect(e.get('right')).toEqual([100, 25]);
    expect(e.get('both')).toEqual([100, 25]);
  });

  it('an empty buffer yields an empty envelope rather than throwing', () => {
    expect(amplitudeEnvelope(mono([]), 10)).toEqual([]);
    expect(amplitudeEnvelope(mono([1, 1]), 0)).toEqual([]);
  });

  /** Requesting nothing is not an error — it is no work. */
  it('an empty channel list yields an empty map', () => {
    expect(amplitudeEnvelopes(FIXTURE, 10, [] as AudioChannel[]).size).toBe(0);
  });
});
