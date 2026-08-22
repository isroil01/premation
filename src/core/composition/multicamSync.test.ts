/**
 * Audio-sync math for multicam alignment. Synthetic signals with KNOWN
 * offsets — the recovered lag must match what we buried, or clip bars would
 * shift footage out of sync while reporting success.
 */

import { rmsEnvelope, bestLagSeconds, nccAtLag, mixToMonoChannels, ENVELOPE_HZ } from './multicamSync';

/** Pseudo-random "speech" PCM: sum of enveloped bursts, deterministic. */
function syntheticPcm(seconds: number, sampleRate: number, seed = 1): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  const rand = (): number => {
    // xorshift32 — deterministic across runs, no Math.random in tests.
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s % 10000) / 10000;
  };
  // ~8 bursts/second of varying loudness — enough envelope structure to
  // correlate on, silence between them.
  const bursts = Math.round(seconds * 8);
  for (let b = 0; b < bursts; b++) {
    const at = Math.round(rand() * (n - sampleRate * 0.05));
    const len = Math.round(sampleRate * (0.01 + rand() * 0.04));
    const amp = 0.2 + rand() * 0.8;
    const freq = 100 + rand() * 900;
    for (let i = 0; i < len && at + i < n; i++) {
      const w = Math.sin((Math.PI * i) / len); // half-sine envelope
      out[at + i]! += amp * w * Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }
  }
  return out;
}

describe('rmsEnvelope', () => {
  it('emits hz samples per second and tracks energy', () => {
    const sr = 8000;
    const pcm = new Float32Array(sr * 2); // 2s: silence then a tone
    for (let i = sr; i < sr * 2; i++) pcm[i] = Math.sin((2 * Math.PI * 440 * i) / sr);
    const env = rmsEnvelope(pcm, sr, 100);
    expect(env.length).toBe(200);
    // First second ~0, second second ~0.707 (RMS of a sine).
    expect(env[50]).toBeCloseTo(0, 5);
    expect(env[150]!).toBeGreaterThan(0.6);
  });
});

describe('bestLagSeconds', () => {
  const sr = 8000;

  it('recovers a known positive offset (other trails ref)', () => {
    const master = syntheticPcm(20, sr, 7);
    // "other" camera started 3.5s EARLIER, so shared content sits 3.5s later
    // in its file: other = [3.5s silence] + master.
    const pad = Math.round(3.5 * sr);
    const other = new Float32Array(pad + master.length);
    other.set(master, pad);
    const lag = bestLagSeconds(rmsEnvelope(master, sr), rmsEnvelope(other, sr), ENVELOPE_HZ, 10);
    expect(lag.score).toBeGreaterThan(0.8);
    expect(lag.lagSec).toBeCloseTo(3.5, 1);
  });

  it('recovers a known negative offset (other leads ref)', () => {
    const master = syntheticPcm(20, sr, 7);
    // "other" camera started 2s LATE: its file is master minus the first 2s.
    const cut = Math.round(2 * sr);
    const other = master.slice(cut);
    const lag = bestLagSeconds(rmsEnvelope(master, sr), rmsEnvelope(other, sr), ENVELOPE_HZ, 10);
    expect(lag.score).toBeGreaterThan(0.8);
    expect(lag.lagSec).toBeCloseTo(-2, 1);
  });

  it('reports low confidence for unrelated audio', () => {
    const a = syntheticPcm(15, sr, 3);
    const b = syntheticPcm(15, sr, 99);
    const lag = bestLagSeconds(rmsEnvelope(a, sr), rmsEnvelope(b, sr), ENVELOPE_HZ, 10);
    expect(lag.score).toBeLessThan(0.5);
  });

  it('refuses to conclude from silence', () => {
    const silent = new Float32Array(ENVELOPE_HZ * 10);
    expect(nccAtLag(silent, silent, 0, ENVELOPE_HZ)).toBe(-1);
  });
});

describe('mixToMonoChannels', () => {
  it('averages channels', () => {
    const l = new Float32Array([1, 1, 1]);
    const r = new Float32Array([0, 0.5, 1]);
    const m = mixToMonoChannels([l, r], 3);
    expect([...m]).toEqual([0.5, 0.75, 1]);
  });
});
