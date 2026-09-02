/**
 * The specular environment map — the REFLECTION half of an environment light.
 *
 * The SH rig beside it (environmentLight.test.ts) is an irradiance probe and
 * says nothing about what a mirror sees. These pin the four things that can
 * silently break the map without breaking a type:
 *
 *   1. the atlas LAYOUT the shader has baked into its text as literals,
 *   2. the encode/decode round trip, including its HDR scale,
 *   3. that blurring is monotone in roughness and preserves total energy,
 *   4. that the SH probe did NOT move — a preset's probe grid is 32x16 and
 *      the specular base is 256x128, and confusing the two would relight
 *      every existing scene.
 */

import { ENV_SPEC_LEVELS as RENDERER_ENV_SPEC_LEVELS, ENV_SPEC_BAND_HEIGHT } from '@motion/renderer';
import {
  ENV_SPEC_HEIGHT,
  ENV_SPEC_LEVELS,
  ENV_SPEC_WIDTH,
  blurEquirectAngular,
  buildEnvSpecularAtlas,
  environmentEquirect,
  environmentSpecularMap,
  envSpecularLevelRoughness,
  presetPixels,
  shProject,
  type EnvPixels,
} from './environmentLight';

/** Mean of one channel over an equirect, area-weighted by sin(theta). */
function solidAngleMean(px: EnvPixels, channel = 0): number {
  let acc = 0;
  let w = 0;
  for (let j = 0; j < px.height; j++) {
    const s = Math.sin(((j + 0.5) / px.height) * Math.PI);
    for (let i = 0; i < px.width; i++) {
      acc += px.data[(j * px.width + i) * 3 + channel]! * s;
      w += s;
    }
  }
  return acc / w;
}

describe('the atlas layout the shader has hardcoded', () => {
  it('agrees with the renderer about the level count', () => {
    // The shader interpolates the renderer's constant into its text as a
    // literal (WGSL cannot fold a uniform into the band height without a
    // dynamic loop), so a mismatch here would slice every reflection.
    expect(ENV_SPEC_LEVELS).toBe(RENDERER_ENV_SPEC_LEVELS);
  });

  it('agrees with the renderer about the band height', () => {
    // Only used for the half-texel inset, but getting it wrong bleeds one
    // roughness level into the next at the poles.
    expect(ENV_SPEC_HEIGHT).toBe(ENV_SPEC_BAND_HEIGHT);
  });

  it('stacks the levels vertically, all the same size', () => {
    const map = environmentSpecularMap('studio');
    expect(map.width).toBe(ENV_SPEC_WIDTH);
    expect(map.height).toBe(ENV_SPEC_HEIGHT * ENV_SPEC_LEVELS);
    expect(map.levels).toBe(ENV_SPEC_LEVELS);
    expect(map.data.length).toBe(map.width * map.height * 4);
  });

  it('maps level 0 to a mirror and the last level to full roughness', () => {
    expect(envSpecularLevelRoughness(0)).toBe(0);
    expect(envSpecularLevelRoughness(ENV_SPEC_LEVELS - 1)).toBe(1);
  });
});

describe('the sqrt-plus-scale encoding', () => {
  const decode = (byte: number, scale: number): number => (byte / 255) ** 2 * scale;

  it('round-trips a mid value to well under a percent', () => {
    const base: EnvPixels = { width: 4, height: 2, data: new Float32Array(24).fill(0.25) };
    const map = buildEnvSpecularAtlas(base, 'test');
    expect(decode(map.data[0]!, map.scale)).toBeCloseTo(0.25, 3);
  });

  it('carries HDR past 1.0 rather than clipping it — at a stated cost', () => {
    // A sun is the whole reason an EXR sky is worth importing; a plain 0..1
    // store would have flattened this to the same byte as a white cloud.
    const data = new Float32Array(24).fill(0.5);
    data[0] = 40;
    const map = buildEnvSpecularAtlas({ width: 4, height: 2, data }, 'hdr');
    expect(map.scale).toBeCloseTo(40, 5);
    expect(decode(map.data[0]!, map.scale)).toBeCloseTo(40, 1);
    // THE COST, pinned rather than hidden: one `scale` for the whole map means
    // an 80x dynamic range spends its 8 bits across all of it, so a mid value
    // comes back ~3% off. The sqrt transfer is what keeps that to 3% instead
    // of 30%, and a percentile scale would buy it back only by clipping the
    // sun's core — which is the one thing a reflection needs a sun to keep.
    expect(decode(map.data[1]!, map.scale)).toBeCloseTo(0.5, 1);
    expect(Math.abs(decode(map.data[1]!, map.scale) - 0.5)).toBeLessThan(0.5 * 0.05);
  });

  it('never divides by zero on a pitch-black sky', () => {
    const map = buildEnvSpecularAtlas({ width: 4, height: 2, data: new Float32Array(24) }, 'black');
    expect(Number.isFinite(map.scale)).toBe(true);
    expect(map.scale).toBeGreaterThan(0);
    expect([...map.data.slice(0, 3)]).toEqual([0, 0, 0]);
  });

  it('writes opaque alpha, so a bilinear tap is never premultiplied down', () => {
    const map = environmentSpecularMap('sky');
    expect(map.data[3]).toBe(255);
  });
});

describe('the angular prefilter', () => {
  const sky = environmentEquirect('sky');

  it('conserves total energy — a blur redistributes light, it does not eat it', () => {
    const before = solidAngleMean(sky, 2);
    // A modest lobe (roughness 0.5 => sigma = 0.25 rad) holds to well under a
    // percent.
    expect(solidAngleMean(blurEquirectAngular(sky, 0.25), 2)).toBeCloseTo(before, 2);
    // THE APPROXIMATION, pinned: the vertical pass CLAMPS at the poles rather
    // than continuing over them, so a wide lobe pulls a little energy toward
    // the equator — ~2.5% at sigma = 0.6 rad, which is the roughest level.
    // Stated here so a future change that made it 25% would fail rather than
    // pass quietly under a loose tolerance.
    const wide = solidAngleMean(blurEquirectAngular(sky, 0.6), 2);
    expect(Math.abs(wide - before) / before).toBeLessThan(0.04);
    expect(Math.abs(wide - before) / before).toBeGreaterThan(0.005);
  });

  it('is monotone in roughness: each level is flatter than the one before', () => {
    const spread = (px: EnvPixels): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < px.data.length; k += 3) {
        lo = Math.min(lo, px.data[k]!);
        hi = Math.max(hi, px.data[k]!);
      }
      return hi - lo;
    };
    const levels = Array.from({ length: ENV_SPEC_LEVELS }, (_, i) => {
      const r = envSpecularLevelRoughness(i);
      return spread(blurEquirectAngular(sky, r * r));
    });
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeLessThan(levels[i - 1]!);
  });

  it('leaves level 0 untouched — a mirror reflects the room, not a smear', () => {
    const mirror = blurEquirectAngular(sky, 0);
    expect([...mirror.data.slice(0, 12)]).toEqual([...sky.data.slice(0, 12)]);
  });

  it('does not bowtie: a uniform sky stays uniform through the blur', () => {
    // The horizontal kernel widens by 1/sin(theta). Without that the poles
    // blur far less than the equator in ANGLE, and a flat sky develops
    // horizontal banding — the classic equirect blur artifact.
    const flat: EnvPixels = { width: 64, height: 32, data: new Float32Array(64 * 32 * 3).fill(0.5) };
    const out = blurEquirectAngular(flat, 0.5);
    for (let k = 0; k < out.data.length; k++) expect(out.data[k]!).toBeCloseTo(0.5, 5);
  });
});

describe('what the specular map is built FROM', () => {
  it('resamples a preset at the specular size, not the probe size', () => {
    const base = environmentEquirect('studio');
    expect(base.width).toBe(ENV_SPEC_WIDTH);
    expect(base.height).toBe(ENV_SPEC_HEIGHT);
  });

  it('★ leaves the SH probe grid at 32x16, so no existing scene relights', () => {
    // presetPixels grew a size parameter for the prefilter. Its DEFAULT is the
    // probe grid, and every SH caller relies on that default: a preset probed
    // at 256x128 integrates to slightly different coefficients, which would
    // move the derived light rig — and therefore the pixels — of every scene
    // with an environment light in it.
    const probe = presetPixels('studio');
    expect([probe.width, probe.height]).toEqual([32, 16]);
    const big = presetPixels('studio', ENV_SPEC_WIDTH, ENV_SPEC_HEIGHT);
    // Same sky, so the projections agree to a few decimals — but they are NOT
    // the same numbers, which is exactly why the default must not move.
    expect(shProject(big)[0]).toBeCloseTo(shProject(probe)[0]!, 2);
  });

  it('memoises on the sky alone, so a keyframed rotation re-uploads nothing', () => {
    // The renderer keys its GPU texture off `id`; equal ids must mean equal
    // texels, and rotation/intensity are shader uniforms rather than content.
    expect(environmentSpecularMap('sunset')).toBe(environmentSpecularMap('sunset'));
    expect(environmentSpecularMap('sunset').id).not.toBe(environmentSpecularMap('sky').id);
  });

  it('degrades an unloaded image sky to the default preset, not to nothing', () => {
    const map = environmentSpecularMap('asset:not-decoded-yet');
    expect(map.id).toBe(environmentSpecularMap('studio').id);
  });
});
