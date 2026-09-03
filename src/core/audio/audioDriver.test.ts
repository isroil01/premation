/**
 * Audio drivers — the pure half.
 *
 * Everything here runs on synthesised samples with no scene, no engine and no
 * Web Audio, which is the whole point of keeping `analyseAudioEnvelope` and
 * `mapEnvelope` free of them: the detector is the part that is hard to eyeball
 * in the UI, so it is the part that has to be provable from a tone.
 */

import {
  analyseAudioEnvelope,
  mapEnvelope,
  applyCurve,
  bandRange,
  alignSamplesToRange,
  mixToMono,
  audioDriverExpression,
  canExpressDriver,
  expressionBlocker,
  defaultAudioDriver,
  MIX_SOURCE,
  type AudioDriver,
} from './audioDriver';

const SR = 44100;

/** `seconds` of a sine at `hz`, amplitude `amp`. */
function tone(hz: number, seconds: number, amp = 1, sampleRate = SR): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function mean(env: Float32Array, from = 0, to = env.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += env[i] ?? 0;
  return to > from ? sum / (to - from) : 0;
}

describe('analyseAudioEnvelope', () => {
  it('one value per frame, all within 0..1', () => {
    const env = analyseAudioEnvelope(tone(440, 1), SR, 30);
    expect(env.length).toBe(30);
    for (const v of env) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('a burst rises to a peak and then decays', () => {
    // 0.3s silence, 0.2s tone, 0.5s silence, at 30 fps → 30 frames.
    const samples = concat(
      new Float32Array(Math.round(0.3 * SR)),
      tone(440, 0.2),
      new Float32Array(Math.round(0.5 * SR)),
    );
    const env = analyseAudioEnvelope(samples, SR, 30, { attackMs: 10, releaseMs: 200 });

    // Silent lead-in.
    expect(env[0]).toBeCloseTo(0, 5);
    expect(env[5]).toBeCloseTo(0, 5);

    // Peaks inside (or just after) the burst — frames 9..16 at 30 fps.
    let peakAt = 0;
    for (let i = 1; i < env.length; i++) if ((env[i] ?? 0) > (env[peakAt] ?? 0)) peakAt = i;
    expect(peakAt).toBeGreaterThanOrEqual(9);
    expect(peakAt).toBeLessThanOrEqual(16);
    expect(env[peakAt]).toBeGreaterThan(0.9); // normalised to its own peak

    // Rising through the burst, decaying after it.
    expect(env[12] ?? 0).toBeGreaterThan(env[9] ?? 0);
    expect(env[22] ?? 0).toBeLessThan(env[peakAt] ?? 0);
    expect(env[29] ?? 0).toBeLessThan(env[22] ?? 0);
  });

  it('release, not a cliff: a longer release decays more slowly', () => {
    const samples = concat(tone(440, 0.2), new Float32Array(Math.round(0.8 * SR)));
    const fast = analyseAudioEnvelope(samples, SR, 30, { releaseMs: 50, normalize: false });
    const slow = analyseAudioEnvelope(samples, SR, 30, { releaseMs: 400, normalize: false });
    expect(slow[20] ?? 0).toBeGreaterThan(fast[20] ?? 0);
  });

  it('band selection separates a 60 Hz tone from a 5 kHz tone', () => {
    const low = tone(60, 1);
    const high = tone(5000, 1);

    const lowInLow = analyseAudioEnvelope(low, SR, 30, { band: 'low', normalize: false });
    const lowInHigh = analyseAudioEnvelope(low, SR, 30, { band: 'high', normalize: false });
    const highInLow = analyseAudioEnvelope(high, SR, 30, { band: 'low', normalize: false });
    const highInHigh = analyseAudioEnvelope(high, SR, 30, { band: 'high', normalize: false });

    expect(mean(lowInLow)).toBeGreaterThan(0.8);
    expect(mean(lowInHigh)).toBeLessThan(0.2);
    expect(mean(highInHigh)).toBeGreaterThan(0.8);
    expect(mean(highInLow)).toBeLessThan(0.2);
  });

  it('an explicit Hz range picks out its own tone', () => {
    const mix = new Float32Array(SR);
    const a = tone(200, 1, 0.5);
    const b = tone(8000, 1, 0.5);
    for (let i = 0; i < mix.length; i++) mix[i] = (a[i] ?? 0) + (b[i] ?? 0);

    const around200 = analyseAudioEnvelope(mix, SR, 30, { band: { lo: 150, hi: 300 }, normalize: false });
    const around1k = analyseAudioEnvelope(mix, SR, 30, { band: { lo: 800, hi: 1500 }, normalize: false });
    expect(mean(around200)).toBeGreaterThan(mean(around1k) + 0.3);
  });

  it('the gate floors quiet passages to zero', () => {
    const quiet = tone(440, 1, 0.02); // ≈ −34 dB
    const open = analyseAudioEnvelope(quiet, SR, 30, { normalize: false });
    const gated = analyseAudioEnvelope(quiet, SR, 30, { gate: 0.8, normalize: false });
    expect(mean(open)).toBeGreaterThan(0.2);
    expect(mean(gated)).toBe(0);
  });

  it('silence and degenerate inputs never divide by zero', () => {
    expect(analyseAudioEnvelope(new Float32Array(0), SR, 30).length).toBe(0);
    expect(analyseAudioEnvelope(tone(440, 1), SR, 0).length).toBe(0);
    const silent = analyseAudioEnvelope(new Float32Array(SR), SR, 30);
    expect(silent.length).toBe(30);
    expect([...silent].every((v) => v === 0)).toBe(true);
  });
});

describe('bandRange', () => {
  it('names resolve, and an explicit range is kept ascending', () => {
    expect(bandRange('low')).toEqual({ lo: 20, hi: 250 });
    expect(bandRange({ lo: 100, hi: 400 })).toEqual({ lo: 100, hi: 400 });
    // A collapsed range still spans at least one Hz rather than dividing by 0.
    expect(bandRange({ lo: 500, hi: 500 }).hi).toBeGreaterThan(bandRange({ lo: 500, hi: 500 }).lo);
  });
});

describe('mapEnvelope', () => {
  const ramp = Float32Array.from([0, 0.25, 0.5, 0.75, 1]);

  it('respects the bounds it is given', () => {
    const out = mapEnvelope(ramp, { min: 100, max: 160 });
    expect(out[0]).toBeCloseTo(100, 6);
    expect(out[4]).toBeCloseTo(160, 6);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThanOrEqual(160);
    }
  });

  it('an inverted range (min > max) stays inside it, louder meaning smaller', () => {
    const out = mapEnvelope(ramp, { min: 200, max: 50 });
    expect(out[0]).toBeCloseTo(200, 6);
    expect(out[4]).toBeCloseTo(50, 6);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(50);
      expect(v).toBeLessThanOrEqual(200);
    }
  });

  it('bounds hold for every curve', () => {
    for (const curve of ['linear', 'easeIn', 'easeOut', 'sCurve', 'invert'] as const) {
      const out = mapEnvelope(ramp, { min: -20, max: 20, curve });
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(-20);
        expect(v).toBeLessThanOrEqual(20);
      }
    }
  });

  it('invert flips the shape, not the range', () => {
    const out = mapEnvelope(ramp, { min: 0, max: 100, curve: 'invert' });
    expect(out[0]).toBeCloseTo(100, 6);
    expect(out[4]).toBeCloseTo(0, 6);
  });

  it('smoothFrames averages neighbours without leaving the range', () => {
    const spike = Float32Array.from([0, 0, 1, 0, 0]);
    const out = mapEnvelope(spike, { min: 0, max: 10, smoothFrames: 3 });
    expect(out[2]).toBeLessThan(10);
    expect(out[1]).toBeGreaterThan(0);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
    }
  });

  it('an empty envelope maps to an empty result', () => {
    expect(mapEnvelope(new Float32Array(0), { min: 0, max: 1 }).length).toBe(0);
  });
});

describe('applyCurve', () => {
  it('every curve maps 0..1 onto 0..1', () => {
    for (const curve of ['linear', 'easeIn', 'easeOut', 'sCurve', 'invert'] as const) {
      for (const t of [-1, 0, 0.3, 0.7, 1, 2]) {
        const v = applyCurve(t, curve);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('alignSamplesToRange', () => {
  it('places a trimmed, offset clip where the bar puts it', () => {
    const src = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 10 Hz "audio": the clip starts at comp 0.5s and plays source 0.2s–0.6s.
    const out = alignSamplesToRange(src, 10, [{ startSec: 0.5, inSec: 0.2, outSec: 0.6 }], 0, 1.2);
    expect(out.length).toBe(12);
    expect([...out.slice(0, 5)]).toEqual([0, 0, 0, 0, 0]); // before the bar
    expect([...out.slice(5, 9)]).toEqual([3, 4, 5, 6]); // source samples 2..5
    expect([...out.slice(9)]).toEqual([0, 0, 0]); // after the bar
  });

  it('with no clip bars, the file is read from comp time 0', () => {
    const src = Float32Array.from([1, 2, 3, 4]);
    const out = alignSamplesToRange(src, 10, [], 0, 0.4);
    expect([...out]).toEqual([1, 2, 3, 4]);
  });

  it('a range that starts inside the clip reads from the right offset', () => {
    const src = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const out = alignSamplesToRange(src, 10, [{ startSec: 0, inSec: 0, outSec: 0.6 }], 0.2, 0.5);
    expect([...out]).toEqual([3, 4, 5]);
  });
});

describe('mixToMono', () => {
  it('averages the channels', () => {
    const l = Float32Array.from([1, 1, 1]);
    const r = Float32Array.from([0, 0, 0]);
    const buf = {
      sampleRate: 10,
      length: 3,
      duration: 0.3,
      numberOfChannels: 2,
      getChannelData: (c: number) => (c === 0 ? l : r),
    };
    expect([...mixToMono(buf)]).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('expression mode', () => {
  const base = (patch: Partial<AudioDriver> = {}): AudioDriver => ({
    ...defaultAudioDriver('scale'),
    sourceLayerId: MIX_SOURCE,
    band: 'full',
    attackMs: 0,
    releaseMs: 0,
    gate: 0,
    smoothFrames: 1,
    normalize: false,
    mode: 'expression',
    ...patch,
  });

  it('the plain case becomes an expression over the existing `audio` identifier', () => {
    const src = audioDriverExpression(base({ min: 100, max: 160 }));
    expect(src).toBe('100 + 60 * (clamp(audio, 0, 1))');
    expect(canExpressDriver(base())).toBe(true);
  });

  it('the gate and the curve survive the translation', () => {
    expect(audioDriverExpression(base({ gate: 0.25, min: 0, max: 1 })))
      .toContain('clamp((audio - 0.25) / 0.75, 0, 1)');
    expect(audioDriverExpression(base({ curve: 'sCurve' }))).toContain('3 - 2 *');
    expect(audioDriverExpression(base({ curve: 'invert' }))).toContain('1 - clamp(audio');
  });

  it('a negative minimum is parenthesised so the source stays valid', () => {
    expect(audioDriverExpression(base({ min: -50, max: 50 }))).toBe('(-50) + 100 * (clamp(audio, 0, 1))');
  });

  // The four things the `audio` identifier cannot do. Each one has to REFUSE
  // rather than silently produce an expression that means something else —
  // that fallback is the whole reason baked mode exists.
  it.each([
    ['a band', { band: 'low' } as Partial<AudioDriver>],
    ['attack', { attackMs: 20 } as Partial<AudioDriver>],
    ['release', { releaseMs: 200 } as Partial<AudioDriver>],
    ['smoothing', { smoothFrames: 5 } as Partial<AudioDriver>],
    ['normalising', { normalize: true } as Partial<AudioDriver>],
    ['one source layer', { sourceLayerId: 'node_7' } as Partial<AudioDriver>],
  ])('refuses %s', (_label, patch) => {
    const d = base(patch);
    expect(audioDriverExpression(d)).toBeNull();
    expect(canExpressDriver(d)).toBe(false);
    expect(expressionBlocker(d)).toBeTruthy();
  });

  it('the default driver is a baked one — attack/release are on out of the box', () => {
    const d = defaultAudioDriver('opacity');
    expect(d.mode).toBe('baked');
    expect(canExpressDriver(d)).toBe(false);
  });
});
