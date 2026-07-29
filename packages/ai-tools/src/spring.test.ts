/**
 * The spring solver is the one genuinely new motion primitive, and everything in
 * `@motion/product-motion` is built on it — so its physics is tested as physics,
 * not just as "returns an array".
 */

import {
  bakeSpring,
  dampingRatio,
  resolveSpring,
  sampleSpring,
  SPRING_PRESETS,
  thinSamples,
} from './spring';

const bake = (over: Partial<Parameters<typeof bakeSpring>[0]> = {}) =>
  bakeSpring({ from: 0, to: 1, spring: { ...SPRING_PRESETS.snappy }, fps: 60, ...over });

describe('sampleSpring', () => {
  it('starts at `from` and converges to `to`', () => {
    const o = { from: 0, to: 100, spring: { ...SPRING_PRESETS.snappy }, fps: 60 };
    expect(sampleSpring(o, 0)).toBeCloseTo(0, 6);
    expect(sampleSpring(o, 5)).toBeCloseTo(100, 4);
  });

  it('is frame-rate independent — the closed form is exact at every t', () => {
    // Numerically integrating would make these disagree; that divergence would
    // break "same seed → identical output" across composition frame rates.
    const o = { from: 0, to: 1, spring: { ...SPRING_PRESETS.bouncy }, fps: 60 };
    for (const t of [0.05, 0.13, 0.29, 0.5]) {
      expect(sampleSpring({ ...o, fps: 24 }, t)).toBeCloseTo(sampleSpring({ ...o, fps: 120 }, t), 12);
    }
  });

  it('honours initial velocity — a spring handed off from a gesture', () => {
    const still = { from: 0, to: 1, spring: { ...SPRING_PRESETS.gentle }, fps: 60 };
    const flung = { ...still, spring: { ...SPRING_PRESETS.gentle, velocity: 8 } };
    expect(sampleSpring(flung, 0.05)).toBeGreaterThan(sampleSpring(still, 0.05));
  });
});

describe('damping regimes', () => {
  it('under-damped springs cross the target more than once', () => {
    // This is the property a bezier structurally cannot express, and the reason
    // this file exists. A bezier reaches its target exactly once.
    const { samples } = bake({ spring: { ...SPRING_PRESETS.bouncy } });
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!.value - 1;
      const b = samples[i]!.value - 1;
      if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) crossings++;
    }
    expect(dampingRatio(SPRING_PRESETS.bouncy)).toBeLessThan(1);
    expect(crossings).toBeGreaterThanOrEqual(2);
  });

  it('gentle is over-damped and never overshoots — correct for shadows and colour', () => {
    expect(dampingRatio(SPRING_PRESETS.gentle)).toBeGreaterThan(1);
    expect(bake({ spring: { ...SPRING_PRESETS.gentle } }).overshoot).toBeLessThanOrEqual(1e-9);
  });

  it('snappy overshoots a little; bouncy overshoots a lot', () => {
    const snappy = bake({ spring: { ...SPRING_PRESETS.snappy } }).overshoot;
    const bouncy = bake({ spring: { ...SPRING_PRESETS.bouncy } }).overshoot;
    expect(snappy).toBeGreaterThan(0);
    // The UI motion linter rejects UI overshoot above 4%; `snappy` must sit
    // under that or the default preset would fail its own lint rule.
    expect(snappy).toBeLessThan(0.04);
    expect(bouncy).toBeGreaterThan(snappy * 2);
  });

  it('a critically damped spring is monotone', () => {
    const k = 200, m = 1;
    const critical = { stiffness: k, damping: 2 * Math.sqrt(k * m), mass: m };
    expect(dampingRatio(critical)).toBeCloseTo(1, 6);
    const { samples, overshoot } = bake({ spring: critical });
    expect(overshoot).toBeLessThanOrEqual(1e-9);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.value).toBeGreaterThanOrEqual(samples[i - 1]!.value - 1e-9);
    }
  });
});

describe('bakeSpring', () => {
  it('lands EXACTLY on the target — no residual drift', () => {
    // A hair off target forever is invisible once and obvious after five
    // animations chained off the same property.
    for (const name of Object.keys(SPRING_PRESETS) as (keyof typeof SPRING_PRESETS)[]) {
      const { samples } = bake({ from: 20, to: 380, spring: { ...SPRING_PRESETS[name] } });
      expect(samples[samples.length - 1]!.value).toBe(380);
    }
  });

  it('bakes frame-aligned samples at the composition fps', () => {
    const { samples } = bake({ fps: 24 });
    for (const [i, s] of samples.entries()) expect(s.t).toBeCloseTo(i / 24, 10);
  });

  it('settles rather than running to the cap', () => {
    const r = bake({ spring: { ...SPRING_PRESETS.stiff } });
    expect(r.truncated).toBe(false);
    expect(r.durationSec).toBeLessThan(1);
  });

  it('truncates a spring that would never settle instead of baking forever', () => {
    const r = bake({ spring: { stiffness: 40, damping: 0.4, mass: 3 }, maxDurationSec: 0.5 });
    expect(r.truncated).toBe(true);
    expect(r.durationSec).toBeCloseTo(0.5, 2);
  });

  it('is deterministic — byte-identical for identical input', () => {
    expect(JSON.stringify(bake().samples)).toBe(JSON.stringify(bake().samples));
  });

  it('handles a zero-travel spring without dividing by zero', () => {
    const r = bake({ from: 5, to: 5 });
    expect(r.samples.every((s) => s.value === 5)).toBe(true);
  });
});

describe('thinSamples', () => {
  it('drops collinear samples and keeps the endpoints', () => {
    const { samples } = bake({ from: 0, to: 100 });
    const thin = thinSamples(samples, 0.25);
    expect(thin.length).toBeLessThan(samples.length);
    expect(thin[0]).toEqual(samples[0]);
    expect(thin[thin.length - 1]).toEqual(samples[samples.length - 1]);
  });

  it('keeps the launch frames, where the initial velocity lives', () => {
    const { samples } = bake({ from: 0, to: 100 });
    const thin = thinSamples(samples, 99);
    expect(thin[1]).toEqual(samples[1]);
  });

  it('holds the tolerance as a RECONSTRUCTION bound, not a per-sample one', () => {
    // The bound must be `tolerance`, not some multiple of it. An earlier greedy
    // version compared each candidate against its immediate neighbours, so error
    // compounded across a run of drops and reached 4.7× tolerance — visibly
    // flattened motion for a caller who asked for half a pixel.
    const TOL = 0.5;
    const { samples } = bake({ from: 0, to: 100, spring: { ...SPRING_PRESETS.bouncy } });
    const thin = thinSamples(samples, TOL);

    for (const s of samples) {
      let i = 0;
      while (i < thin.length - 1 && thin[i + 1]!.t < s.t) i++;
      const a = thin[i]!, b = thin[Math.min(i + 1, thin.length - 1)]!;
      const span = b.t - a.t;
      const lerp = span <= 0 ? a.value : a.value + ((b.value - a.value) * (s.t - a.t)) / span;
      expect(Math.abs(lerp - s.value)).toBeLessThanOrEqual(TOL + 1e-9);
    }
  });
});

describe('resolveSpring', () => {
  it('defaults to snappy — the right default for UI', () => {
    expect(resolveSpring(undefined)).toEqual(SPRING_PRESETS.snappy);
  });
  it('accepts a preset name or explicit physics', () => {
    expect(resolveSpring('bouncy')).toEqual(SPRING_PRESETS.bouncy);
    expect(resolveSpring({ stiffness: 1, damping: 2, mass: 3 })).toEqual({ stiffness: 1, damping: 2, mass: 3 });
  });
});
