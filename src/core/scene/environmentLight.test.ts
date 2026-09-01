/**
 * Environment light — the probe math and, crucially, the SIGN of the derived
 * rig: "light arrives from above" must actually brighten upward-facing
 * surfaces through the real shading path, or the whole feature is a lamp
 * wired backwards. The shading test goes through shadeLayer itself, so the
 * rig encoding is pinned against the engine's own convention rather than
 * against what a comment claims it is.
 */

import { shProject, shIrradiance, environmentRig, presetSh, type EnvPixels } from './environmentLight';
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
