/**
 * Apply Color LUT now has TWO implementations, and they must agree.
 *
 * ## Why there are two at all
 *
 * The effect gained a GPU shader (a strip texture plus a manual walk along the
 * blue axis) and KEPT its Canvas2D pass. That is not indecision — it is the
 * same two-list arrangement Fill, Stroke, Sharpen and Noise live under: a layer
 * baked for some other reason has its GPU effect list dropped wholesale, so the
 * bake is the only route those effects have on such a layer.
 *
 * The cost of keeping both is that they can drift. This file is the check that
 * they do not, and it is deliberately arithmetic rather than pixels: a render
 * comparison needs the GPU harness, and by the time a golden disagrees the
 * question "which one is right?" is already expensive to answer.
 *
 * ## What is actually compared
 *
 * The GPU shader's lookup is reproduced here in TypeScript — the strip layout,
 * the half-texel clamp, the manual blue interpolation — and checked against
 * `sampleCubeLut`, which is what the CPU pass uses. If the strip packing order
 * were transposed (`.cube` varies RED fastest, and getting that backwards
 * produces a grade that looks plausible), or the blue axis walked the wrong
 * slices, these would part company immediately.
 *
 * It does NOT prove the shader compiles or that its output reaches a pixel —
 * `effect-apply-color-lut`'s golden covers that. It proves the two definitions
 * of "what this LUT means" are one definition.
 */

import { parseCubeLut, sampleCubeLut, type CubeLut } from './cubeLut';

/**
 * A LUT that is not symmetric in any axis.
 *
 * An identity or a channel-swap would pass even with the strip packed
 * backwards, because both are invariant under the transposition being guarded
 * against. Each channel here is a different non-linear function of a different
 * input channel, so red, green and blue all disagree about what the entry at a
 * given index should be.
 */
function asymmetricCube(n: number): CubeLut {
  const lines = [`LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const rf = r / (n - 1);
        const gf = g / (n - 1);
        const bf = b / (n - 1);
        lines.push(`${(rf * rf).toFixed(6)} ${(gf * 0.5 + bf * 0.25).toFixed(6)} ${(1 - bf).toFixed(6)}`);
      }
    }
  }
  return parseCubeLut(lines.join('\n'))!;
}

/**
 * The strip the provider uploads, as bytes — mirroring `setCubeLut` exactly.
 *
 * Quantised to 8 bits here too. Comparing a float mirror against an 8-bit
 * upload would attribute the quantisation to a disagreement between the paths,
 * which is the opposite of what this file is for.
 */
function packStrip(lut: CubeLut): { data: Uint8Array; width: number; height: number } {
  const n = lut.size;
  const width = n * n;
  const height = n;
  const data = new Uint8Array(width * height * 4);
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const px = g * width + b * n + r;
        const i = r + g * n + b * n * n;
        data[px * 4] = q(lut.data[i * 3]!);
        data[px * 4 + 1] = q(lut.data[i * 3 + 1]!);
        data[px * 4 + 2] = q(lut.data[i * 3 + 2]!);
        data[px * 4 + 3] = 255;
      }
    }
  }
  return { data, width, height };
}

/** Bilinear fetch from the strip, as the hardware sampler would do it. */
function sampleStrip(
  strip: { data: Uint8Array; width: number; height: number },
  u: number,
  v: number,
): [number, number, number] {
  const x = u * strip.width - 0.5;
  const y = v * strip.height - 0.5;
  const x0 = Math.floor(x); const y0 = Math.floor(y);
  const fx = x - x0; const fy = y - y0;
  const at = (px: number, py: number, c: number): number => {
    const cx = Math.max(0, Math.min(strip.width - 1, px));
    const cy = Math.max(0, Math.min(strip.height - 1, py));
    return strip.data[(cy * strip.width + cx) * 4 + c]! / 255;
  };
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx;
    const bot = at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

/** The shader's `sliceSample`, in TypeScript. */
function sliceSample(
  strip: { data: Uint8Array; width: number; height: number },
  rg: [number, number],
  slice: number,
  n: number,
): [number, number, number] {
  // Half a texel in from each end of THIS slice — the clamp that stops the
  // linear filter reaching the neighbouring slice's very different blue.
  const xIn = Math.min(Math.max(rg[0] * (n - 1) + 0.5, 0.5), n - 0.5);
  const u = (slice * n + xIn) / (n * n);
  const v = Math.min(Math.max(rg[1] * (n - 1) + 0.5, 0.5), n - 0.5) / n;
  return sampleStrip(strip, u, v);
}

/** The whole fragment path, minus premultiplication and intensity. */
function gpuLookup(lut: CubeLut, r: number, g: number, b: number): [number, number, number] {
  const strip = packStrip(lut);
  const n = lut.size;
  const bz = b * (n - 1);
  const z0 = Math.floor(bz);
  const z1 = Math.min(z0 + 1, n - 1);
  const f = bz - z0;
  const c0 = sliceSample(strip, [r, g], z0, n);
  const c1 = sliceSample(strip, [r, g], z1, n);
  return [
    c0[0] + (c1[0] - c0[0]) * f,
    c0[1] + (c1[1] - c0[1]) * f,
    c0[2] + (c1[2] - c0[2]) * f,
  ];
}

describe('the GPU strip lookup agrees with the CPU sampler', () => {
  const lut = asymmetricCube(9);

  it('built a LUT that could actually catch a transposition', () => {
    // The premise. A symmetric table would pass this whole file with the strip
    // packed backwards, so the fixture's asymmetry is itself worth asserting.
    const a = sampleCubeLut(lut, 1, 0, 0);
    const b = sampleCubeLut(lut, 0, 0, 1);
    expect(a).not.toEqual(b);
  });

  it('matches at the eight corners of the cube', () => {
    // Corners are where a transposed or off-by-one strip diverges hardest, and
    // where the half-texel clamp is actually load-bearing.
    for (const r of [0, 1]) {
      for (const g of [0, 1]) {
        for (const b of [0, 1]) {
          const cpu = sampleCubeLut(lut, r, g, b);
          const gpu = gpuLookup(lut, r, g, b);
          for (let c = 0; c < 3; c++) {
            expect(gpu[c]).toBeCloseTo(cpu[c]!, 2);
          }
        }
      }
    }
  });

  it('matches across the interior, where interpolation is doing the work', () => {
    let worst = 0;
    for (let i = 0; i <= 6; i++) {
      for (let j = 0; j <= 6; j++) {
        for (let k = 0; k <= 6; k++) {
          const r = i / 6; const g = j / 6; const b = k / 6;
          const cpu = sampleCubeLut(lut, r, g, b);
          const gpu = gpuLookup(lut, r, g, b);
          for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(gpu[c]! - cpu[c]!));
        }
      }
    }
    // 8-bit table quantisation is ±1/255 ≈ 0.004 on each of two interpolated
    // endpoints. A packing or axis error moves this by tenths, not thousandths.
    expect(worst).toBeLessThan(0.02);
  });

  it('would NOTICE a transposed strip', () => {
    // The guard on the guard. Swapping red and blue in the packing must break
    // the comparison — otherwise every assertion above is decoration.
    const n = lut.size;
    const strip = packStrip(lut);
    const swapped = { ...strip, data: new Uint8Array(strip.data) };
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          const from = (g * strip.width + b * n + r) * 4;
          const to = (g * strip.width + r * n + b) * 4;
          for (let c = 0; c < 4; c++) swapped.data[to + c] = strip.data[from + c]!;
        }
      }
    }
    const probe: [number, number] = [0.8, 0.3];
    const good = sliceSample(strip, probe, 1, n);
    const bad = sliceSample(swapped, probe, 1, n);
    expect(good).not.toEqual(bad);
  });
});
