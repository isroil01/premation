/**
 * CSS / GPU blur-kernel contract — the exit criterion for soft-edge
 * `known-divergent` scenes (`mask-feather`, `layer-styles`, `effect-blur`).
 *
 * History: an older GPU kernel used σ = r/2 truncated at ±r, visibly tighter
 * than Canvas2D's `filter: blur(r)`. The shipped shader now follows CSS
 * semantics (radius IS sigma, taps to ±2.5σ). This file pins that contract on
 * a 1D hard edge — one variable, no compositing — so those scenes can be
 * re-blessed from the GPU without guessing which kernel was "right".
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';

const blurShader = BUILTIN_SHADERS.find((s) => s.name === 'blur');

/** Discrete 1D Gaussian matching the GPU blur fragment (σ = radius, ±2.5σ). */
function cssGaussian1d(sigma: number, steps = 30): { offsets: number[]; weights: number[] } {
  const spacing = Math.max(1, (sigma * 2.5) / steps);
  const offsets: number[] = [];
  const weights: number[] = [];
  let total = 0;
  for (let i = -steps; i <= steps; i++) {
    const off = i * spacing;
    const w = Math.exp(-0.5 * (off * off) / (sigma * sigma));
    offsets.push(off);
    weights.push(w);
    total += w;
  }
  return { offsets, weights: weights.map((w) => w / total) };
}

/** Convolve a hard step (0 left of 0, 1 at/after) with the CSS kernel. */
function hardEdgeProfile(sigma: number): number[] {
  const { offsets, weights } = cssGaussian1d(sigma);
  const half = Math.ceil(sigma * 3);
  const out: number[] = [];
  for (let x = -half; x <= half; x++) {
    let acc = 0;
    for (let i = 0; i < offsets.length; i++) {
      // Sample the step at (x + offset): opaque when ≥ 0.
      if (x + offsets[i]! >= 0) acc += weights[i]!;
    }
    out.push(acc);
  }
  return out;
}

describe('CSS blur kernel (GPU contract)', () => {
  it('ships the blur material with CSS sigma semantics in both dialects', () => {
    expect(blurShader).toBeDefined();
    for (const src of [blurShader!.wgsl, blurShader!.glsl.fragment]) {
      expect(src).toContain('sigma = r');
      expect(src).toMatch(/2\.5/);
      expect(src).toMatch(/steps\s*=\s*30/);
    }
  });

  it('uses radius as sigma — not the old σ = r/2 truncation', () => {
    // At σ = 8 the CSS kernel still has meaningful weight near ±20 (±2.5σ).
    // The retired kernel died by ±8. That gap is what soft-edge goldens saw.
    const { offsets, weights } = cssGaussian1d(8);
    const nearTail = offsets.findIndex((o) => Math.abs(o - 20) < 0.6);
    expect(nearTail).toBeGreaterThanOrEqual(0);
    expect(weights[nearTail]!).toBeGreaterThan(1e-4);

    const beyondOldCap = offsets.findIndex((o) => Math.abs(o - 8) < 0.6);
    expect(beyondOldCap).toBeGreaterThanOrEqual(0);
    // Weight at ±σ is still substantial for a true Gaussian (≈ 0.24 of peak).
    const peak = Math.max(...weights);
    expect(weights[beyondOldCap]!).toBeGreaterThan(peak * 0.2);
  });

  it('blurs a hard edge into a monotonic soft ramp (one variable, no compositing)', () => {
    const profile = hardEdgeProfile(6);
    // Far left transparent, far right opaque.
    expect(profile[0]!).toBeLessThan(0.02);
    expect(profile[profile.length - 1]!).toBeGreaterThan(0.98);
    // Strictly non-decreasing across the discontinuity.
    for (let i = 1; i < profile.length; i++) {
      expect(profile[i]!).toBeGreaterThanOrEqual(profile[i - 1]! - 1e-9);
    }
    // Mid-ramp is neither hard (0/1) nor a step — soft coverage exists.
    const mid = profile.filter((v) => v > 0.15 && v < 0.85);
    expect(mid.length).toBeGreaterThan(2);
  });

  it('weights sum to 1 (energy conserved on a constant field)', () => {
    const { weights } = cssGaussian1d(10);
    const sum = weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});
