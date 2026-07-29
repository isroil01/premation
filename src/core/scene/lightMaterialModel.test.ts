/**
 * AE-parity light + material property models.
 *
 * The single most important property of this whole batch: every addition
 * DEFAULTS TO A NO-OP. Existing projects carry none of these props, so they
 * must resolve to exactly the behaviour that shipped before — falloff `none`
 * keeps the legacy radius ramp, a null POI keeps the legacy 2D aim, and the
 * boolean-era shadow switches keep meaning what they meant.
 */

import { lightFalloffAt, readNodeLight, LIGHT_DEFAULTS } from './light';
import { lightAim3D, shadeLayer, type SceneLight } from './lightShading';
import { readNodeMaterial } from './material';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

function node(props: Record<string, unknown>): SceneNode {
  return {
    id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'n_t', type: 'Transform', props }],
  } as unknown as SceneNode;
}

const light = (p: Record<string, unknown> = {}): SceneLight => ({
  type: 'point', color: '#ffffff', intensity: 100, radius: 500, angle: 0, cone: 45,
  shadows: false, x: 0, y: 0, z: 0, ...p,
});

describe('light falloff', () => {
  it("'none' is a no-op at every distance (the legacy curve)", () => {
    const l = { falloff: 'none' as const, radius: 100, falloffDistance: 200 };
    for (const d of [0, 50, 100, 500, 100000]) expect(lightFalloffAt(d, l)).toBe(1);
    // Absent falloff behaves the same — that is what old projects carry.
    expect(lightFalloffAt(9999, { radius: 100 })).toBe(1);
  });

  it("'smooth' holds full inside the radius then ramps linearly to zero", () => {
    const l = { falloff: 'smooth' as const, radius: 100, falloffDistance: 200 };
    expect(lightFalloffAt(0, l)).toBe(1);
    expect(lightFalloffAt(100, l)).toBe(1);
    expect(lightFalloffAt(200, l)).toBeCloseTo(0.5, 6);
    expect(lightFalloffAt(300, l)).toBeCloseTo(0, 6);
    expect(lightFalloffAt(9999, l)).toBe(0); // clamped, never negative
  });

  it("'inverse-square' is the physical curve, CLAMPED so it can't blow up", () => {
    const l = { falloff: 'inverse-square' as const, radius: 100 };
    expect(lightFalloffAt(0, l)).toBe(1); // clamped inside the radius
    expect(lightFalloffAt(100, l)).toBe(1);
    expect(lightFalloffAt(200, l)).toBeCloseTo(0.25, 6);
    expect(lightFalloffAt(400, l)).toBeCloseTo(0.0625, 6);
  });
});

describe('light aim', () => {
  it('is null without a POI, so each type keeps its own legacy 2D behaviour', () => {
    expect(lightAim3D(light())).toBeNull();
    expect(lightAim3D(light({ poi: null }))).toBeNull();
  });

  it('points at the POI when present', () => {
    const a = lightAim3D(light({ x: 0, y: 0, z: 0, poi: { x: 0, y: 0, z: 10 } }))!;
    expect(a).toEqual([0, 0, 1]);
  });

  it('a degenerate POI (on the light) falls back to null rather than NaN', () => {
    expect(lightAim3D(light({ poi: { x: 0, y: 0, z: 0 } }))).toBeNull();
  });
});

describe('shadeLayer regression — the new knobs must not move old scenes', () => {
  const normal = [0, 0, 1] as const;
  const pos = { x: 0, y: 0, z: 0 };

  it('omitting the material response reproduces the previous gain exactly', () => {
    const lights = [light({ type: 'ambient', intensity: 50 }), light({ x: 0, y: 0, z: -100, radius: 500 })];
    const withDefaults = shadeLayer(normal, pos, lights, { ambient: 100, diffuse: 50 });
    expect(shadeLayer(normal, pos, lights)).toEqual(withDefaults);
  });

  it('a spot with no POI and no feather value keeps the old 20% soft edge', () => {
    const spot = light({ type: 'spot', x: 0, y: 0, z: -100, radius: 500, cone: 60 });
    // Explicit 20 must equal the absent case.
    expect(shadeLayer(normal, pos, [spot])).toEqual(shadeLayer(normal, pos, [{ ...spot, coneFeather: 20 }]));
  });

  it('Ambient scales an ambient light and leaves a point light alone', () => {
    const amb = [light({ type: 'ambient', intensity: 100 })];
    const full = shadeLayer(normal, pos, amb, { ambient: 100 })!;
    const half = shadeLayer(normal, pos, amb, { ambient: 50 })!;
    expect(half[0]).toBeCloseTo(full[0] / 2, 6);
  });

  it('Diffuse scales a directional light and leaves an ambient light alone', () => {
    const pt = [light({ x: 0, y: 0, z: -100, radius: 500 })];
    const base = shadeLayer(normal, pos, pt, { diffuse: 50 })!;
    const twice = shadeLayer(normal, pos, pt, { diffuse: 100 })!;
    expect(twice[0]).toBeCloseTo(base[0] * 2, 6);

    const amb = [light({ type: 'ambient' })];
    expect(shadeLayer(normal, pos, amb, { diffuse: 100 })).toEqual(shadeLayer(normal, pos, amb, { diffuse: 50 }));
  });

  it('inverse-square falloff reaches PAST the radius, where the legacy ramp cut off', () => {
    const far = { x: 0, y: 0, z: -600 };
    const legacy = light({ ...far, radius: 500 });
    const curved = light({ ...far, radius: 500, falloff: 'inverse-square' });
    // Legacy: beyond the radius ⇒ no contribution at all.
    expect(shadeLayer(normal, pos, [legacy])).toEqual([0, 0, 0]);
    expect(shadeLayer(normal, pos, [curved])![0]).toBeGreaterThan(0);
  });
});

describe('readNodeLight defaults', () => {
  it('resolves every AE addition to its no-op default', () => {
    const l = readNodeLight(node({ [SCENE_KIND_PROP]: 'light' }));
    expect(l.falloff).toBe('none');
    expect(l.poi).toBeNull();
    expect(l.coneFeather).toBe(LIGHT_DEFAULTS.coneFeather);
    expect(l.shadowDarkness).toBe(LIGHT_DEFAULTS.shadowDarkness);
    expect(l.shadowDiffusion).toBe(LIGHT_DEFAULTS.shadowDiffusion);
  });

  it('one POI component is enough to make the light targeted', () => {
    expect(readNodeLight(node({ poiZ: 400 })).poi).toEqual({ x: 0, y: 0, z: 400 });
  });
});

describe('material shadow tri-states', () => {
  it('reads the boolean era exactly as before', () => {
    // Absent ⇒ on; `false` ⇒ off. These are what existing projects contain.
    expect(readNodeMaterial(node({})).castsShadowsMode).toBe('on');
    expect(readNodeMaterial(node({})).castsShadows).toBe(true);
    expect(readNodeMaterial(node({ castsShadows: false })).castsShadowsMode).toBe('off');
    expect(readNodeMaterial(node({ castsShadows: false })).castsShadows).toBe(false);
    expect(readNodeMaterial(node({ acceptsShadows: false })).acceptsShadows).toBe(false);
  });

  it("'only' still counts as ON for every boolean reader", () => {
    // The layer must stay a caster/receiver — `only` hides it, it does not
    // remove it from the shadow pass. Getting this backwards would silently
    // delete the shadow the user turned the mode on to get.
    const m = readNodeMaterial(node({ castsShadows: 'only', acceptsShadows: 'only' }));
    expect(m.castsShadows).toBe(true);
    expect(m.acceptsShadows).toBe(true);
    expect(m.shadowOnly).toBe(true);
  });

  it('shadowOnly is false unless one of the modes is `only`', () => {
    expect(readNodeMaterial(node({})).shadowOnly).toBe(false);
    expect(readNodeMaterial(node({ castsShadows: false })).shadowOnly).toBe(false);
  });

  it('the 0–100 responses default to AE values and clamp', () => {
    const m = readNodeMaterial(node({}));
    expect(m.lightTransmission).toBe(0);
    expect(m.ambient).toBe(100);
    expect(m.diffuse).toBe(50);
    expect(m.metal).toBe(0);
    expect(readNodeMaterial(node({ ambient: 999 })).ambient).toBe(100);
    expect(readNodeMaterial(node({ diffuse: -5 })).diffuse).toBe(0);
  });
});
