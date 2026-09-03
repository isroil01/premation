/**
 * Environment light — the probe math and, crucially, the SIGN of the derived
 * rig: "light arrives from above" must actually brighten upward-facing
 * surfaces through the real shading path, or the whole feature is a lamp
 * wired backwards. The shading test goes through shadeLayer itself, so the
 * rig encoding is pinned against the engine's own convention rather than
 * against what a comment claims it is.
 */

import {
  shProject,
  shProjectEquirect,
  shIrradiance,
  environmentRig,
  environmentRigFor,
  environmentSh,
  environmentSkyAssetId,
  environmentSkyForAsset,
  isEnvironmentSky,
  setEnvironmentAssetSh,
  clearEnvironmentAssetSh,
  presetSh,
  ENV_PROJECT_MAX_WIDTH,
  ENV_PROJECT_MAX_HEIGHT,
  type EnvPixels,
} from './environmentLight';
import { shadeLayer, type SceneLight } from './lightShading';

function uniformEnv(value: number): EnvPixels {
  const width = 16, height = 8;
  const data = new Float32Array(width * height * 3).fill(value);
  return { width, height, data };
}

/** Encode a rig light the way buildSnapshot's expansion does. */
function rigToSceneLights(rig: ReturnType<typeof environmentRig>): SceneLight[] {
  const centre = { x: 960, y: 540, z: 0 };
  const FAR = 100000;
  return rig.map((rl) => rl.kind === 'ambient'
    ? {
        type: 'ambient' as const, color: rl.color, intensity: rl.intensity,
        radius: 500, angle: 0, cone: 45, shadows: false,
        falloff: 'none' as const, x: centre.x, y: centre.y, z: 0,
      }
    : {
        type: 'parallel' as const, color: rl.color, intensity: rl.intensity,
        radius: 500, angle: 0, cone: 45, shadows: false, falloff: 'none' as const,
        x: centre.x - rl.from!.x * FAR,
        y: centre.y - rl.from!.y * FAR,
        z: 0 - rl.from!.z * FAR,
        poi: centre,
      });
}

describe('SH probe', () => {
  it('a uniform environment integrates to ~constant irradiance everywhere', () => {
    const sh = shProject(uniformEnv(1));
    for (const d of [
      { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 },
      { x: 0.577, y: 0.577, z: 0.577 },
    ]) {
      const e = shIrradiance(sh, d);
      expect(e[0]).toBeCloseTo(1, 1);
      expect(e[1]).toBeCloseTo(1, 1);
      expect(e[2]).toBeCloseTo(1, 1);
    }
  });

  it('the day-sky preset is bluer looking up than looking down', () => {
    const sh = presetSh('sky');
    const up = shIrradiance(sh, { x: 0, y: -1, z: 0 });
    const down = shIrradiance(sh, { x: 0, y: 1, z: 0 });
    expect(up[2]).toBeGreaterThan(down[2]); // more blue from the sky
    expect(up[2]).toBeGreaterThan(up[0]); // and blue beats red up there
  });
});

describe('environmentRig', () => {
  it('a uniform environment collapses to ONE ambient light — no faceting', () => {
    const rig = environmentRig(shProject(uniformEnv(0.8)), 100, 0);
    expect(rig).toHaveLength(1);
    expect(rig[0]!.kind).toBe('ambient');
  });

  it('the day sky yields an ambient floor plus a blue light from above', () => {
    const rig = environmentRig(presetSh('sky'), 100, 0);
    expect(rig.some((l) => l.kind === 'ambient')).toBe(true);
    const above = rig.find((l) => l.kind === 'parallel' && l.from!.y === -1);
    expect(above).toBeDefined();
  });

  it('zero intensity yields no lights at all', () => {
    expect(environmentRig(presetSh('sky'), 0, 0)).toHaveLength(0);
  });

  it('rotation swings the horizontal axes and leaves the vertical alone', () => {
    const sh = presetSh('sunset'); // strongly directional at the horizon
    const horiz = (rot: number): number[] =>
      environmentRig(sh, 100, rot)
        .filter((l) => l.kind === 'parallel' && l.from!.y === 0)
        .map((l) => l.intensity);
    const a = horiz(0);
    const b = horiz(90);
    expect(a.length).toBeGreaterThan(0);
    // The energy distribution across horizontal axes must CHANGE under a 90°
    // spin (the warm band faces a different axis)…
    expect(b).not.toEqual(a);
    // …while the vertical axes stay put.
    const vertical = (rot: number): number[] =>
      environmentRig(sh, 100, rot)
        .filter((l) => l.kind === 'parallel' && l.from!.y !== 0)
        .map((l) => Math.round(l.intensity * 100) / 100);
    expect(vertical(90)).toEqual(vertical(0));
  });
});

/**
 * Real images. The projector is the same integral `shProject` runs — what is
 * new is everything AROUND it: an arbitrary size, an interleaved RGB/RGBA
 * buffer, and 8-bit samples that are sRGB-ENCODED rather than linear. Getting
 * that last one wrong does not crash anything; it just makes every imported sky
 * quietly too bright, which is exactly the class of bug a golden image cannot
 * catch on its own.
 */
describe('shProjectEquirect', () => {
  /** An `w×h` equirect filled with one linear grey. */
  function greyFloat(value: number, w = 64, h = 32): Float32Array {
    return new Float32Array(w * h * 3).fill(value);
  }

  it('a uniform grey equirect yields SH with ONLY the L0 term', () => {
    const sh = shProjectEquirect(greyFloat(0.5), 64, 32, { isLinear: true });
    // L0 is the whole signal: ∫Y00 dΩ = 0.282095·4π, scaled by the radiance.
    expect(sh[0]).toBeCloseTo(0.5 * 0.282095 * 4 * Math.PI, 3);
    expect(sh[1]).toBeCloseTo(sh[0]!, 6); // grey ⇒ the three channels agree
    expect(sh[2]).toBeCloseTo(sh[0]!, 6);
    // Every higher band is zero: a constant field has no direction in it.
    // The bar is a RELATIVE one — the residual is the quadrature error of a
    // finite grid, ~0.1% of L0 here, not a real directional component. It has
    // to be small enough that `environmentRig`'s deviation cutoff rejects it,
    // which is the property the "uniform sky ⇒ one ambient" test then pins.
    for (let k = 3; k < 27; k++) expect(Math.abs(sh[k]!) / sh[0]!).toBeLessThan(0.01);
  });

  it('a top-bright sky yields a Y-direction L1 term, signed so UP is lit', () => {
    const w = 64, h = 32;
    const data = new Float32Array(w * h * 3);
    for (let j = 0; j < h; j++) {
      // Bright upper hemisphere, dark lower one. Row 0 is "up".
      const v = j < h / 2 ? 1 : 0.02;
      for (let i = 0; i < w; i++) {
        const o = (j * w + i) * 3;
        data[o] = v; data[o + 1] = v; data[o + 2] = v;
      }
    }
    const sh = shProjectEquirect(data, w, h, { isLinear: true });
    // The y coefficient is the L1 band's vertical term. Compositor space puts
    // "up" at −y, so a sky brighter above is a NEGATIVE y coefficient — the
    // sign that a naive "positive means up" reading gets backwards, and the
    // reason this asserts the irradiance it produces rather than the raw sign
    // alone.
    expect(sh[3]).toBeLessThan(-0.1);
    const up = shIrradiance(sh, { x: 0, y: -1, z: 0 });
    const down = shIrradiance(sh, { x: 0, y: 1, z: 0 });
    expect(up[0]).toBeGreaterThan(down[0] * 2);
    // …and the horizontal L1 terms stay put: nothing about this sky is lopsided
    // east-west.
    expect(Math.abs(sh[6]!)).toBeLessThan(1e-3); // z
    expect(Math.abs(sh[9]!)).toBeLessThan(1e-3); // x
  });

  it('treats 8-bit input as sRGB and linearises it', () => {
    const w = 16, h = 8;
    // Mid-grey 128/255 is ~0.502 ENCODED and ~0.2159 in LINEAR light.
    const px = new Uint8ClampedArray(w * h * 4).fill(128);
    for (let i = 0; i < w * h; i++) px[i * 4 + 3] = 255; // opaque; alpha ignored
    const sh = shProjectEquirect(px, w, h);
    const scale = 0.282095 * 4 * Math.PI;
    expect(sh[0]! / scale).toBeCloseTo(0.2159, 3);
    // The un-linearised reading is the bug this pins: it would land on ~0.502.
    expect(sh[0]! / scale).toBeLessThan(0.4);
  });

  it('an explicitly LINEAR 8-bit buffer is not double-decoded', () => {
    const w = 16, h = 8;
    const px = new Uint8ClampedArray(w * h * 3).fill(128);
    const sh = shProjectEquirect(px, w, h, { isLinear: true });
    expect(sh[0]! / (0.282095 * 4 * Math.PI)).toBeCloseTo(128 / 255, 3);
  });

  it('downsamples a large image rather than walking all of it', () => {
    // A 4K HDRI is ~8M samples for 27 floats. Box-averaging first is the same
    // integral, so a big uniform image and a small one must agree exactly.
    const big = shProjectEquirect(greyFloat(0.5, 1024, 512), 1024, 512, { isLinear: true });
    const small = shProjectEquirect(greyFloat(0.5, 64, 32), 64, 32, { isLinear: true });
    // A RELATIVE bar: the accumulator is a Float32Array, so 500k extra
    // additions cost a few ULPs regardless of the maths being right. What is
    // being asserted is that the two agree to five significant figures, i.e.
    // the downsample changed the integral by nothing that matters.
    expect(Math.abs(big[0]! - small[0]!) / small[0]!).toBeLessThan(1e-4);
    expect(ENV_PROJECT_MAX_WIDTH).toBeLessThanOrEqual(256);
    expect(ENV_PROJECT_MAX_HEIGHT).toBeLessThanOrEqual(128);
  });

  it('reads RGB and RGBA buffers the same', () => {
    const w = 8, h = 4;
    const rgb = new Float32Array(w * h * 3).fill(0.3);
    const rgba = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 0.3; rgba[i * 4 + 1] = 0.3; rgba[i * 4 + 2] = 0.3; rgba[i * 4 + 3] = 1;
    }
    expect([...shProjectEquirect(rgba, w, h, { isLinear: true })])
      .toEqual([...shProjectEquirect(rgb, w, h, { isLinear: true })]);
  });
});

/**
 * The sky VALUE — one prop holding either a preset id or `asset:<id>`. The
 * alternative (a second `envAssetId` prop) can express a state that means two
 * things at once, so the parsing here is what keeps that impossible.
 */
describe('environment sky values', () => {
  afterEach(() => clearEnvironmentAssetSh());

  it('parses presets and asset references apart', () => {
    expect(environmentSkyAssetId('sky')).toBeNull();
    expect(environmentSkyAssetId('asset:img_1')).toBe('img_1');
    // "Image chosen, nothing picked yet" is an EMPTY id, not a null one — a
    // distinct state the inspector has to be able to sit in.
    expect(environmentSkyAssetId('asset:')).toBe('');
    expect(environmentSkyForAsset('img_1')).toBe('asset:img_1');
    expect(isEnvironmentSky('studio')).toBe(true);
    expect(isEnvironmentSky('asset:img_1')).toBe(true);
    expect(isEnvironmentSky('nonsense')).toBe(false);
  });

  it('an unresolved image sky falls back to a preset instead of going dark', () => {
    // No loader is registered in this unit test, so the asset can never arrive.
    // The scene must still be lit.
    expect([...environmentSh('asset:not_loaded')]).toEqual([...presetSh('studio')]);
    expect([...environmentSh('asset:')]).toEqual([...presetSh('studio')]);
    expect([...environmentSh(undefined)]).toEqual([...presetSh('studio')]);
    expect([...environmentSh('sunset')]).toEqual([...presetSh('sunset')]);
  });

  it('a registered projection is used, and REPLACES the fallback rig', () => {
    const before = environmentRigFor('asset:img_1', 100, 0);
    expect([...before]).toEqual([...environmentRig(presetSh('studio'), 100, 0)]);

    // A bright uniform sky: one ambient, no parallels (see the uniform case).
    const w = 32, h = 16;
    setEnvironmentAssetSh('img_1', shProjectEquirect(new Float32Array(w * h * 3).fill(0.9), w, h, { isLinear: true }));

    const after = environmentRigFor('asset:img_1', 100, 0);
    expect(after).toHaveLength(1);
    expect(after[0]!.kind).toBe('ambient');
    // The memo did not serve the stale fallback — registering an image has to
    // invalidate it, or the sky never appears until something else changes.
    expect(after[0]!.intensity).not.toBeCloseTo(before[0]?.intensity ?? -1, 6);
  });

  it('the rig memo returns the same value the uncached call would', () => {
    const sky = presetSh('sunset');
    for (const rot of [0, 37, 180]) {
      expect([...environmentRigFor('sunset', 80, rot)]).toEqual([...environmentRig(sky, 80, rot)]);
    }
    // …and hands back the identical object on a repeat, i.e. it is a cache.
    expect(environmentRigFor('sunset', 80, 37)).toBe(environmentRigFor('sunset', 80, 37));
  });
});

describe('rig → shadeLayer sign convention', () => {
  it('light "from above" brightens an up-facing surface more than a down-facing one', () => {
    const rig = environmentRig(presetSh('sky'), 100, 0)
      .filter((l) => l.kind === 'parallel' && l.from!.y === -1);
    expect(rig.length).toBe(1);
    const lights = rigToSceneLights(rig);
    const at = { x: 960, y: 540, z: 0 };
    const up = shadeLayer([0, -1, 0], at, lights, undefined, true);
    const down = shadeLayer([0, 1, 0], at, lights, undefined, true);
    const lum = (g: readonly number[] | null): number => (g ? g[0]! + g[1]! + g[2]! : 0);
    expect(lum(up)).toBeGreaterThan(lum(down));
    expect(lum(up)).toBeGreaterThan(0.01);
  });
});
