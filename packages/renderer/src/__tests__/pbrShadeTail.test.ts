/**
 * The PBR selector rides in the shininess slot as a NEGATIVE number, so the
 * std140 shade tail keeps its layout. Both ends of that contract are pinned:
 * the packer writes −roughness, and all four shade blocks read the sign.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { packShade3D, SHADE3D_FLOATS } from '../pipeline/uniforms';

const base = {
  model: new Array(16).fill(0), eye: [0, 0, -100] as const, specular: 0.5, shininess: 32,
  lights: [{ type: 'point' as const, color: { r: 1, g: 1, b: 1 }, gain: 1, x: 0, y: 0, z: -10, radius: 0, aimX: 0, aimY: 0, aimZ: 1, halfConeRad: 0, coneFeather: 0, falloff: 0, falloffDistance: 0 }],
};

it('packs shininess when no roughness, and −roughness when PBR', () => {
  const a = new Float32Array(SHADE3D_FLOATS);
  packShade3D(a, 0, base as never);
  expect(a[16 + 4 + 2]).toBe(32);
  const b = new Float32Array(SHADE3D_FLOATS);
  packShade3D(b, 0, { ...base, roughness: 0.25 } as never);
  expect(b[16 + 4 + 2]).toBeCloseTo(-0.25);
  // Roughness 0 must still carry the sign, or the shader would read Phong.
  const c = new Float32Array(SHADE3D_FLOATS);
  packShade3D(c, 0, { ...base, roughness: 0 } as never);
  expect(c[16 + 4 + 2]).toBeLessThan(0);
});

it('every shade block branches on the sign and uses the GGX terms', () => {
  const src = readFileSync(resolve(__dirname, '../shaders/builtin.ts'), 'utf8');
  expect((src.match(/pbr = obj\.shadeParams\.z < 0\.0/g) ?? []).length).toBe(2);
  expect((src.match(/bool pbr = shadeParams\.z < 0\.0/g) ?? []).length).toBe(2);
  // D, G, F all present in each of the four blocks.
  expect((src.match(/alpha2 \/ \(3\.14159265 \* dd \* dd\)/g) ?? []).length).toBe(4);
  expect((src.match(/pow\(1\.0 - VdotH, 5\.0\)/g) ?? []).length).toBe(4);
});
