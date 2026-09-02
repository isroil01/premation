/**
 * Image-based reflections: the GATE, and the two contracts that make the
 * environment map reach the shader at all.
 *
 * ── Why a test and not a golden ─────────────────────────────────────────────
 *
 * The render-test suite proves the gate holds for the scenes that exist. It
 * cannot prove WHY, and it cannot fail for the reason that would actually
 * hurt: a future edit that moves the reflection term out from behind
 * `envParams.x`, or renumbers a binding, breaks scenes that have no
 * environment light in them — which is every committed golden but two. These
 * assert the mechanism directly, in the two places it can silently rot.
 *
 * ── The WebGL2 sampler contract ─────────────────────────────────────────────
 *
 * WebGL2 has no binding numbers for samplers: the backend points a named
 * uniform at a texture UNIT, and it hands out units in bind-group ENTRY order.
 * So a material's `glslSamplers` is a positional list that must line up,
 * one-to-one and in order, with its texture bindings. Get it wrong by one and
 * a shader samples the wrong image — silently, and only on one backend. That
 * is exactly the bug `tex1Uniform` was added to fix once already.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';
import {
  SOLID3D_MATERIAL,
  TEXTURED3D_MATERIAL,
  TEXTURED3D_NO_DEPTH_WRITE_MATERIAL,
  MASKED_TEXTURED3D_MATERIAL,
  MESH3D_SOLID_MATERIAL,
  MESH3D_TEXTURED_MATERIAL,
  MESH3D_PBR_MATERIAL,
  type MaterialDescriptor,
} from '../shaders/Material';
import { ENV_SAMPLER_BINDING, ENV_TEXTURE_BINDING } from '../gpu/types';
import { packSolid3D, packTextured3D, SHADE3D_FLOATS, type Shade3D } from '../pipeline/uniforms';
import type { Mat4 } from '../core/math/Mat4';
import type { Rect } from '../core/math/geometry';
import type { Color } from '../core/math/Color';

const MVP4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as unknown as Mat4;
const RECT = { x: 0, y: 0, width: 1, height: 1 } as unknown as Rect;
const COLOR = { r: 1, g: 1, b: 1, a: 1 } as unknown as Color;

const LIT: Shade3D = {
  model: MVP4 as unknown as number[],
  eye: [0, 0, -1000],
  specular: 0.5,
  shininess: 20,
  roughness: 0.3,
  metal: 1,
  lights: [{
    type: 'parallel', color: { r: 1, g: 1, b: 1 }, gain: 1,
    x: 0, y: 0, z: 0, radius: 0,
    aimX: 0, aimY: 0, aimZ: 1,
    halfConeRad: 0, coneFeatherRad: 0, falloffMode: 0, falloffDistance: 0,
  }],
};

/** The lit-3d materials — every one that binds the environment map. */
const LIT_3D: ReadonlyArray<{ name: string; material: MaterialDescriptor }> = [
  { name: 'solid3d', material: SOLID3D_MATERIAL },
  { name: 'textured3d', material: TEXTURED3D_MATERIAL },
  { name: 'textured3d (no depth write)', material: TEXTURED3D_NO_DEPTH_WRITE_MATERIAL },
  { name: 'masked-textured3d', material: MASKED_TEXTURED3D_MATERIAL },
  { name: 'mesh3d-solid', material: MESH3D_SOLID_MATERIAL },
  { name: 'mesh3d-textured', material: MESH3D_TEXTURED_MATERIAL },
  { name: 'mesh3d-pbr', material: MESH3D_PBR_MATERIAL },
];

/** Every shader carrying the shared shade tail, in both dialects. */
const SHADE_SHADERS = BUILTIN_SHADERS.filter((s) => s.wgsl.includes('envParams : vec4<f32>'));

describe('the gate: no environment light ⇒ the arithmetic that shipped before', () => {
  it('packs envParams as four zeros when the shade carries no env', () => {
    const out = packSolid3D(MVP4, COLOR, 1, undefined, LIT);
    // The tail's LAST vec4. Zero x is what the shader tests, so this IS the gate.
    expect([...out.slice(out.length - 4)]).toEqual([0, 0, 0, 0]);
  });

  it('★ adding env changes ONLY that vec4 — every other float is untouched', () => {
    // The claim the render-test gate rests on, made structural: an environment
    // light must not be able to move a single byte of the model matrix, the
    // eye, the shade params or the light array.
    const without = packTextured3D(MVP4, RECT, COLOR, 1, undefined, LIT);
    const withEnv = packTextured3D(MVP4, RECT, COLOR, 1, undefined, {
      ...LIT,
      env: { intensity: 0.75, rotationRad: 0.5, scale: 2.5 },
    });
    expect(withEnv.length).toBe(without.length);
    const head = without.length - 4;
    expect([...withEnv.slice(0, head)]).toEqual([...without.slice(0, head)]);
    expect([...withEnv.slice(head)]).toEqual([1, 0.75, 0.5, 2.5]);
  });

  it('reserves exactly one vec4 for it in the shade tail', () => {
    // SHADE3D_FLOATS is what every 3d packer sizes its buffer by; the shader
    // struct is checked against those sizes in uniformPackerSize.test.ts, so
    // this pins the third side of the triangle — the field COUNT.
    expect(SHADE3D_FLOATS % 4).toBe(0);
    const noShade = packSolid3D(MVP4, COLOR, 1);
    // No shade at all ⇒ a zero-filled tail ⇒ the lit flag AND the env flag off.
    expect([...noShade.slice(noShade.length - 4)]).toEqual([0, 0, 0, 0]);
  });

  it.each(SHADE_SHADERS.map((s) => s.name))('%s gates its reflection on envParams.x', (name) => {
    const src = BUILTIN_SHADERS.find((s) => s.name === name)!;
    expect(src.wgsl).toContain('if (obj.envParams.x > 0.5 && !toonFlag) {');
    expect(src.glsl!.fragment).toContain('if (envParams.x > 0.5 && !toonFlag) {');
  });

  it.each(SHADE_SHADERS.map((s) => s.name))('%s samples the map ONLY inside that gate', (name) => {
    const src = BUILTIN_SHADERS.find((s) => s.name === name)!;
    // One tap site per dialect (envFetch), reached only from envSpecular,
    // reached only from the gated block. More than one means someone added a
    // second sampling path that the gate may not cover.
    expect(src.wgsl.split('textureSampleLevel(envTex').length - 1).toBe(1);
    expect(src.glsl!.fragment.split('textureLod(uEnvTex').length - 1).toBe(1);
    for (const dialect of [src.wgsl, src.glsl!.fragment]) {
      const calls = dialect.split('envSpecular(').length - 1;
      // Its definition, plus the two branches of the gated block.
      expect(calls).toBe(3);
    }
  });

  it('leaves TOON alone — cel banding is the point of that model', () => {
    for (const src of SHADE_SHADERS) {
      // The quantization must come BEFORE the reflection, or a mirrored room
      // would be stepped into bands (or, worse, escape them).
      expect(src.wgsl.indexOf('let bands = max(2.0, obj.shadeParams.z);'))
        .toBeLessThan(src.wgsl.indexOf('if (obj.envParams.x > 0.5'));
      expect(src.glsl!.fragment.indexOf('float bands = max(2.0, shadeParams.z);'))
        .toBeLessThan(src.glsl!.fragment.indexOf('if (envParams.x > 0.5'));
    }
  });
});

describe('the binding contract', () => {
  it.each(LIT_3D)('$name declares the env texture and its own sampler', ({ material }) => {
    const tex = material.layout.find((e) => e.binding === ENV_TEXTURE_BINDING);
    const smp = material.layout.find((e) => e.binding === ENV_SAMPLER_BINDING);
    expect(tex?.type).toBe('texture');
    // Its OWN sampler, not the layer's: the equirect wraps in u, and sharing
    // the layer sampler would either lose the seam blend or switch every layer
    // texture to repeat.
    expect(smp?.type).toBe('sampler');
  });

  it.each(LIT_3D)('$name names every sampler, in texture-binding order, ending in uEnvTex', ({ material }) => {
    const textures = material.layout.filter((e) => e.type === 'texture').map((e) => e.binding);
    // QuadRenderer pushes texture entries in ascending binding order, and the
    // WebGL2 backend assigns units in that order — so the names must be the
    // same list, same order.
    expect(material.glslSamplers).toBeDefined();
    expect(material.glslSamplers!.length).toBe(textures.length);
    expect(material.glslSamplers![material.glslSamplers!.length - 1]).toBe('uEnvTex');
    expect([...textures].sort((a, b) => a - b)).toEqual(textures);
  });

  it('sits clear of every slot the mask, the plugin origin and the PBR maps use', () => {
    // 3 is the mask, 4 a plugin effect's origin, 3–6 the mesh PBR set. A
    // reflection belongs to the SCENE and must not be renumbered by a
    // per-layer texture landing later.
    expect(ENV_TEXTURE_BINDING).toBeGreaterThan(6);
    expect(ENV_SAMPLER_BINDING).toBeGreaterThan(ENV_TEXTURE_BINDING);
    const pbrSlots = MESH3D_PBR_MATERIAL.layout
      .filter((e) => e.binding <= 6)
      .map((e) => e.binding);
    expect(pbrSlots).not.toContain(ENV_TEXTURE_BINDING);
  });

  it('declares the bindings in the shader too, or the pipeline layout is a lie', () => {
    for (const src of SHADE_SHADERS) {
      expect(src.wgsl).toContain(`@group(0) @binding(${ENV_TEXTURE_BINDING}) var envTex : texture_2d<f32>;`);
      expect(src.wgsl).toContain(`@group(0) @binding(${ENV_SAMPLER_BINDING}) var envSmp : sampler;`);
      expect(src.glsl!.fragment).toContain('uniform sampler2D uEnvTex;');
      // And NOT in the vertex stage: a sampler there is legal and pointless,
      // and on some drivers it consumes a vertex texture unit.
      expect(src.glsl!.vertex).not.toContain('uEnvTex');
    }
  });
});

describe('the equirect mapping matches the projector it shares a sky with', () => {
  it('inverts equirectDir the same way in both dialects', () => {
    for (const src of SHADE_SHADERS) {
      // phi = atan2(x, z) − rotation; v = acos(−y)/pi. The SH projector's
      // `equirectDir` is x = sin(theta)sin(phi), y = −cos(theta),
      // z = sin(theta)cos(phi) — so these two lines ARE its inverse, and the
      // reflection turns with the light rig instead of against it.
      expect(src.wgsl).toContain('let phi = atan2(dir.x, dir.z) - obj.envParams.z;');
      expect(src.glsl!.fragment).toContain('float phi = atan(dir.x, dir.z) - envParams.z;');
      expect(src.wgsl).toContain('acos(clamp(-dir.y, -1.0, 1.0)) * 0.31830988618379069');
      expect(src.glsl!.fragment).toContain('acos(clamp(-dir.y, -1.0, 1.0)) * 0.31830988618379069');
    }
  });

  it('does not wrap u itself — that is the repeat sampler\'s job', () => {
    // A fract() here would clamp the bilinear tap at the seam and leave a
    // one-texel scar down the reflection of every mirror.
    for (const src of SHADE_SHADERS) {
      expect(src.wgsl).toContain('let u = phi * 0.15915494309189535;');
      expect(src.glsl!.fragment).toContain('float u = phi * 0.15915494309189535;');
    }
  });
});
