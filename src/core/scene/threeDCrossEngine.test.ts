/**
 * Cross-engine parity for the snapshot's pure 3D readers and shading (plan D2w,
 * the 3D family). The fixture records what the editor's own modules return for
 * a spread of inputs; the C++ ports (native/engine/src/scene/camera3d_port.cpp,
 * lights3d.cpp — tests/test_threed_parity.cpp) must return the same doubles,
 * bit for bit:
 *
 *   camera3d.ts    dofBlurPx, dofIrisParams, readNodeDof
 *   dofStrips.ts   planDofCocCorners
 *   material.ts    readNodeMaterial
 *   light.ts       readNodeLight, lightFalloffAt, lightAttenuationAt, lightReach
 *   lightShading.ts shadeLayer, toShaderLights, lightAim3D, aimToCompAngleDeg, planeNormalOf
 *
 * `GEN_NATIVE_THREED=1 npx jest threeDCrossEngine` rewrites the fixture;
 * without it this test fails when the fixture is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SceneNode } from '@core/types';
import { dofBlurPx, dofIrisParams, readNodeDof, type DofConfig } from './camera3d';
import { planDofCocCorners } from '@core/rendering/dofStrips';
import { readNodeMaterial } from './material';
import { readNodeLight, lightFalloffAt, lightAttenuationAt, lightReach } from './light';
import { presetSh, environmentRigFor, environmentSpecularMap } from './environmentLight';
import { shadeLayer, toShaderLights, lightAim3D, aimToCompAngleDeg, planeNormalOf, type SceneLight } from './lightShading';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/threed_parity.json');

function node(kind: string, props: Record<string, unknown>, style?: Record<string, unknown>): SceneNode {
  const components: Array<{ id: string; type: string; props: Record<string, unknown> }> = [
    { id: 't', type: 'Transform', props: { __kind: kind, ...props } },
  ];
  if (style) components.push({ id: 's', type: 'Style', props: style });
  return { id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false, components } as unknown as SceneNode;
}

const DOFS: DofConfig[] = [
  { strength: 24, focus: 1000, aperture: 40, focalLength: 1000 },
  { strength: 24, focus: 1250, aperture: 150, focalLength: 1000 },
  { strength: 12.5, focus: 0.5, aperture: 3 },
  { strength: 30, focus: 1400, aperture: 30, focalLength: 900, fStop: 2.8 },
  { strength: 30, focus: 800, aperture: 30, focalLength: 900, fStop: 1.4 }, // focus inside the lens
  { strength: 18, focus: 2000, aperture: 18, focalLength: 1777.7777777777778, fStop: 0.7, irisBlades: 6.6, irisRoundness: 0.3, highlightGain: 2 },
  { strength: 18, focus: 2000, aperture: 18, irisBlades: 9, irisRotation: 15, irisAspect: 1.8, highlightThreshold: 0.4, highlightSaturation: 0.5, diffractionFringe: 1.7 },
  { strength: 18, focus: 2000, aperture: 18, irisBlades: 2 },
];
const DEPTHS = [0, 1, 250.5, 999.9999, 1000, 1000.0001, 1333.3333333333333, 1700, 5000, 123456.789, -40];

const PLANAR: Array<[number, number, number, number]> = [[900, 950, 1500, 1400], [1000, 1000, 1000, 1000], [400, 3000, 2500, 800.123]];

const DOF_NODES: Array<Record<string, unknown>> = [
  { focalLength: 1000, dofStrength: 24, focusDistance: 1000, dofAperture: 40 },
  { focalLength: 1000, dofStrength: 24 },
  { dofStrength: 10 },
  { dofStrength: 0, focusDistance: 500 },
  { focalLength: 850, dofStrength: 12, fStop: 2, irisBlades: 7, irisRoundness: 0.1, highlightGain: 0, irisRotation: 0, irisAspect: 1, highlightThreshold: 0.2 },
  { focalLength: 850, dofStrength: 12, fStop: -1, irisBlades: 2.5, irisAspect: 0.5, highlightSaturation: 0.25, diffractionFringe: 0.4 },
];

const MATERIALS: Array<Record<string, unknown>> = [
  {},
  { castsShadows: false, acceptsShadows: 'only', acceptsLights: true, diffuse: 100, ambient: 40 },
  { castsShadows: 'only', acceptsShadows: 0.2, acceptsLights: 0.7, specular: 150, shininess: 0.5, metal: 33, lightTransmission: -4 },
  { castsShadows: 1.6, acceptsShadows: 1, shadingModel: 'pbr', roughness: 12, toonBands: 5.5, ior: 9, displacement: 3000, displacementSubdiv: 2.4 },
  { shadingModel: 'toon', toonBands: 1, reflectionIntensity: 50, reflectionSharpness: 20, reflectionRolloff: 30, transparency: 70, transparencyRolloff: 10, ior: 1.33 },
];

const LIGHT_NODES: Array<[Record<string, unknown>, Record<string, unknown> | undefined]> = [
  [{ lightType: 'point', intensity: 90, radius: 320, z: -200, lightGlow: true }, { fill: '#ffcc55' }],
  [{ lightType: 'spot', intensity: 100, radius: 400, lightAngle: 90, lightCone: 32 }, { fill: '#88d0ff' }],
  [{ lightType: 'spot', lightCone: 100, radius: 1600, poiX: 240, poiY: 180, poiZ: 400, castShadows: true, shadowDiffusion: 0, shadowDarkness: 70, shadowMap: true }, undefined],
  [{ lightType: 'parallel', intensity: 35, poiZ: 300, falloff: 'smooth', falloffDistance: 900, lightConeFeather: 80 }, undefined],
  [{ lightType: 'environment', envPreset: 'sunset', envRotation: 45, envReflections: 60 }, undefined],
  [{ lightType: 'bogus', falloff: 'weird', castShadows: 1, shadowMap: 1, shadowMapSize: 2048, shadowBias: 1.5, shadowSoftness: 2 }, undefined],
];

const FALLOFF_LIGHTS: Array<{ falloff?: 'none' | 'legacy' | 'smooth' | 'inverse-square'; radius: number; falloffDistance?: number }> = [
  { radius: 500 },
  { falloff: 'none', radius: 320 },
  { falloff: 'legacy', radius: 320 },
  { falloff: 'legacy', radius: 0 },
  { falloff: 'smooth', radius: 200, falloffDistance: 300 },
  { falloff: 'smooth', radius: 0.5 },
  { falloff: 'inverse-square', radius: 150 },
];
const DISTANCES = [0, 12.5, 150, 199.99, 200, 320, 499, 777.25, 5000, -3];

const L = (o: Partial<SceneLight> & Pick<SceneLight, 'type'>): SceneLight => ({
  color: '#ffffff', intensity: 100, radius: 500, angle: 0, cone: 45, shadows: false, x: 240, y: 180, z: -300, ...o,
});
const LIGHT_SETS: SceneLight[][] = [
  [],
  [L({ type: 'ambient', intensity: 30, color: '#ff8040' })],
  [L({ type: 'point', intensity: 90, radius: 320, color: '#ffcc55' })],
  [L({ type: 'point', falloff: 'smooth', radius: 100, falloffDistance: 400, z: -900 })],
  [L({ type: 'spot', angle: 90, cone: 32, coneFeather: 50 }), L({ type: 'ambient', intensity: 20 })],
  [L({ type: 'spot', cone: 100, poi: { x: 240, y: 180, z: 400 }, coneFeather: 0 })],
  [L({ type: 'spot', cone: 60, poi: { x: 300, y: 250, z: 200 } })],
  [L({ type: 'parallel', intensity: 35, poi: { x: 240, y: 260, z: 300 }, z: -600 })],
  [L({ type: 'parallel', angle: 30, intensity: 64 }), L({ type: 'parallel', angle: 200, intensity: 14, color: '#abc' })],
  [L({ type: 'point', intensity: 400, radius: 10, falloff: 'inverse-square', x: 240, y: 180, z: 1 })],
  [L({ type: 'spot', angle: 45, cone: 170, coneFeather: 100, falloff: 'legacy', radius: 2000, shadowMap: true, shadows: true, shadowMapSize: 512, shadowBias: 2, shadowSoftness: 1.5, shadowDarkness: 70 })],
  [L({ type: 'environment' }), L({ type: 'point', intensity: 0 }), L({ type: 'spot', intensity: -5 })],
];
const SURFACES: Array<{ normal: readonly [number, number, number]; pos: { x: number; y: number; z: number } }> = [
  { normal: [0, 0, 1], pos: { x: 240, y: 180, z: 0 } },
  { normal: planeNormalOf([1, 0, 0, 0, 0, 0.9396926207859084, 0.3420201433256687, 0, 0, -0.3420201433256687, 0.9396926207859084, 0, 0, 0, 0, 1]), pos: { x: 200, y: 155, z: 120 } },
  { normal: [0, -1, 0], pos: { x: 240, y: 300, z: 150 } },
  { normal: [0.6, 0, 0.8], pos: { x: 100, y: 100, z: 400 } },
];
const MATERIAL_RESPONSES: Array<{ ambient?: number; diffuse?: number } | undefined> = [undefined, { ambient: 40, diffuse: 100 }, { diffuse: 0 }];

function generate() {
  const dof = DOFS.map((d) => ({
    dof: d,
    blur: DEPTHS.map((z) => dofBlurPx(z, d)),
    iris: dofIrisParams(d),
    planar: PLANAR.map((c) => planDofCocCorners(c, d)),
  }));
  const dofNodes = DOF_NODES.map((p) => ({ props: p, width: 480, height: 360, dof: readNodeDof(node('camera', p), 480, 360) }));
  const materials = MATERIALS.map((p) => ({ props: p, material: readNodeMaterial(node('shape', p)) }));
  const lights = LIGHT_NODES.map(([p, s]) => ({ props: p, style: s ?? null, light: readNodeLight(node('light', p, s)) }));
  const falloff = FALLOFF_LIGHTS.map((l) => ({
    light: l,
    falloffAt: DISTANCES.map((d) => lightFalloffAt(d, l)),
    attenuationAt: DISTANCES.map((d) => lightAttenuationAt(d, l)),
    reach: lightReach(l),
  }));
  const shading = LIGHT_SETS.map((set) => ({
    lights: set,
    shade: SURFACES.flatMap((s) => MATERIAL_RESPONSES.flatMap((m) => [false, true].map((one) => shadeLayer(s.normal, s.pos, set, m, one)))),
    shader: toShaderLights(set),
    aims: set.map((l) => {
      const a = lightAim3D(l);
      return { aim: a, compDeg: a ? aimToCompAngleDeg(a) : null };
    }),
  }));
  const env = (['studio', 'sky', 'sunset', 'bogus'] as const).flatMap((sky) => [[100, 0], [85, 35], [240, -90], [0, 10]].map(([i, r]) => ({ sky, intensity: i, rotation: r, rig: environmentRigFor(sky, i!, r!) })));
  const sh = (['studio', 'sky', 'sunset'] as const).map((id) => ({ id, sh: Array.from(presetSh(id)) }));
  const specular = (['studio', 'sky', 'sunset'] as const).map((sky) => {
    const m = environmentSpecularMap(sky);
    let h = 0xcbf29ce484222325n;
    for (const b of m.data) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return { sky, id: m.id, width: m.width, height: m.height, levels: m.levels, scale: m.scale, dataFnv: h.toString(16).padStart(16, '0') };
  });
  return { env, sh, specular, depths: DEPTHS, distances: DISTANCES, planarInputs: PLANAR, dof, dofNodes, materials, lights, falloff, shading, surfaces: SURFACES, responses: MATERIAL_RESPONSES.map((m) => m ?? null) };
}

test('the C++ 3D parity fixture matches the editor readers and shading', () => {
  const data = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/scene/threeDCrossEngine.test.ts (GEN_NATIVE_THREED=1). Do not edit.', ...data })}\n`;
  if (process.env.GEN_NATIVE_THREED === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
});
