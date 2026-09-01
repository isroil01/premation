/**
 * The Smoother + The Wiggler — the two AE keyframe assistants that were
 * genuinely absent (verified 2026-09-01; the earlier "Smoother"/"Wiggler"
 * grep hits were blur-quality strings and the wiggleTransform SHAPE operator).
 *
 * Assert what the engine STORES, not what the plan intended — the lesson the
 * beat-grid work already paid for.
 */

import { smoothTrackKeyframes, wiggleTrackKeyframes } from './keyframeAssistants';
import { sampleTrack, type Keyframe, type PropertyTrack } from '@motion/animation';

const track = (kfs: Keyframe[]): PropertyTrack => ({ nodeId: '', prop: 'x', keyframes: kfs });
const kf = (t: number, value: number): Keyframe => ({ t, value });

/** Dense noisy ramp: 61 keys along value=t*100 with ±3 hash jitter. */
function noisyRamp(): Keyframe[] {
  const out: Keyframe[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 30;
    const jitter = i === 0 || i === 60 ? 0 : ((i * 2654435761) % 601) / 100 - 3;
    out.push(kf(t, t * 100 + jitter));
  }
  return out;
}

describe('smoothTrackKeyframes (The Smoother)', () => {
  it('collapses a noisy ramp to a handful of keys within tolerance', () => {
    const dense = noisyRamp();
    const out = smoothTrackKeyframes(dense, 5);
    expect(out.length).toBeLessThan(dense.length / 4);
    expect(out[0]!.t).toBe(0);
    expect(out[out.length - 1]!.t).toBe(2);
    // The simplified curve stays near the underlying ramp (tolerance + jitter).
    const tr = track(out);
    for (let i = 0; i <= 20; i++) {
      const t = (i / 20) * 2;
      expect(Math.abs(sampleTrack(tr, t)! - t * 100)).toBeLessThan(12);
    }
  });

  it('keeps a genuine corner the tolerance cannot explain away', () => {
    // Flat, then a sharp dip to -100 at t=1, then flat: the dip's keyframe
    // must survive any sane tolerance.
    const kfs = [kf(0, 0), kf(0.5, 0), kf(1, -100), kf(1.5, 0), kf(2, 0)];
    const out = smoothTrackKeyframes(kfs, 5);
    expect(out.some((k) => k.t === 1 && k.value === -100)).toBe(true);
  });

  it('gives survivors smooth tangents (C1, not zig-zag)', () => {
    // A curved signal — a linear ramp collapses to its endpoints (correctly),
    // which would leave no interior keyframes to inspect.
    const arch: Keyframe[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 30;
      arch.push(kf(t, 100 * Math.sin((Math.PI * t) / 2)));
    }
    const out = smoothTrackKeyframes(arch, 5);
    const interior = out.slice(1, -1);
    expect(interior.length).toBeGreaterThan(0);
    expect(interior.every((k) => k.si !== undefined && k.so !== undefined)).toBe(true);
  });

  it('returns copies untouched below 3 keyframes or non-positive tolerance', () => {
    const two = [kf(0, 0), kf(1, 50)];
    expect(smoothTrackKeyframes(two, 5).map((k) => k.t)).toEqual([0, 1]);
    const dense = noisyRamp();
    expect(smoothTrackKeyframes(dense, 0).length).toBe(dense.length);
  });
});

describe('wiggleTrackKeyframes (The Wiggler)', () => {
  const base = [kf(0, 0), kf(2, 200)];

  it('inserts keys at the requested frequency, endpoints untouched', () => {
    const out = wiggleTrackKeyframes(base, { frequency: 5, amplitude: 25, seed: 7 });
    // 2s at 5/s ⇒ 9 interior wobble keys (t=0.2 … 1.8).
    expect(out.length).toBe(11);
    expect(out[0]).toMatchObject({ t: 0, value: 0 });
    expect(out[out.length - 1]).toMatchObject({ t: 2, value: 200 });
  });

  it('offsets from the CURRENT curve and stays within amplitude of it', () => {
    const out = wiggleTrackKeyframes(base, { frequency: 5, amplitude: 25, seed: 7 });
    const baseTrack = track(base);
    let deviated = false;
    for (const k of out.slice(1, -1)) {
      const d = Math.abs(k.value - sampleTrack(baseTrack, k.t)!);
      expect(d).toBeLessThanOrEqual(25 + 1e-9);
      if (d > 1) deviated = true;
    }
    expect(deviated).toBe(true);
  });

  it('is deterministic per seed and different across seeds', () => {
    const a1 = wiggleTrackKeyframes(base, { frequency: 5, amplitude: 25, seed: 7 });
    const a2 = wiggleTrackKeyframes(base, { frequency: 5, amplitude: 25, seed: 7 });
    const b = wiggleTrackKeyframes(base, { frequency: 5, amplitude: 25, seed: 8 });
    expect(a1).toEqual(a2);
    expect(b.map((k) => k.value)).not.toEqual(a1.map((k) => k.value));
  });

  it('skips generated keys that would collide with authored ones', () => {
    const authored = [kf(0, 0), kf(1, 100), kf(2, 200)];
    const out = wiggleTrackKeyframes(authored, { frequency: 1, amplitude: 25, seed: 7 });
    // Generated times would be exactly t=1 — the authored key wins, unchanged.
    const at1 = out.filter((k) => Math.abs(k.t - 1) < 0.26);
    expect(at1.length).toBe(1);
    expect(at1[0]!.value).toBe(100);
  });
});
