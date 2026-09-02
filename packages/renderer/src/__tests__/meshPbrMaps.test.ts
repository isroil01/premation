/**
 * The glTF map set on the mesh path: the contracts that are TEXT, not pixels.
 *
 * Four decisions in `mesh3d-pbr` are invisible to `tsc`, invisible to every
 * test that does not execute a shader, and — because three of the four maps
 * have WHITE as their identity — invisible in a rendered frame too. A map that
 * never arrives simply looks like a material that did not have one.
 *
 *   1. The goldens gate. `mesh3d-textured` must stay exactly the shader it was:
 *      every extrusion in every project draws through it, and widening it
 *      rather than adding a variant would have moved reference pixels for
 *      scenes that have no glTF material anywhere near them.
 *
 *   2. The WebGL2 sampler contract. GL has no binding numbers for samplers, so
 *      the backend walks the bind group's TEXTURE entries in order and points
 *      the material's Nth declared sampler NAME at unit N. If the names and the
 *      shader's declarations drift apart, every map reads unit 0 — the base
 *      colour — which is a plausible-looking picture and a silent lie.
 *
 *   3. Uniform control flow. WGSL polices `textureSample` and the derivative
 *      builtins for uniformity, so every map is sampled unconditionally and the
 *      choice is made afterwards with `select`. A future edit that "optimises"
 *      a sample into an `if` would be rejected by the WGSL compiler at runtime,
 *      long after this suite went green.
 *
 *   4. No tangent attribute. The tangent frame is reconstructed per fragment
 *      from screen-space derivatives, precisely so the mesh vertex layout does
 *      not change — it is shared with the morph and skinning deformers, which
 *      interleave at a fixed 8-float stride, and the WebGL2 backend binds one
 *      vertex buffer per draw so a parallel tangent buffer is not available
 *      either. Growing the layout here would break skinned models silently.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';
import { MESH3D_PBR_MATERIAL, MESH3D_TEXTURED_MATERIAL, MESH3D_LAYOUT } from '../shaders/Material';

const byName = new Map(BUILTIN_SHADERS.map((s) => [s.name, s]));
const pbr = byName.get('mesh3d-pbr')!;

describe('mesh3d-pbr — the map set is declared in both dialects', () => {
  it('is registered', () => {
    expect(pbr).toBeDefined();
    expect(pbr.glsl.vertex).toBeTruthy();
    expect(pbr.glsl.fragment).toBeTruthy();
  });

  it('binds base colour + the four maps at the numbers the material declares', () => {
    // WGSL binds by number, so the shader text and the layout must agree.
    const declared = MESH3D_PBR_MATERIAL.layout
      .filter((e) => e.type === 'texture')
      .map((e) => e.binding)
      .sort((a, b) => a - b);
    for (const binding of declared) {
      expect(pbr.wgsl).toMatch(new RegExp(`@group\\(0\\) @binding\\(${binding}\\) var \\w+ : texture_2d<f32>`));
    }
    // 1 base colour + normal/MR/AO/emissive + the environment atlas.
    expect(declared).toEqual([1, 3, 4, 5, 6, 7]);
  });

  it('★ declares its GLSL samplers in the same ORDER the bind group binds them', () => {
    // The WebGL2 backend has nothing but this ordering to go on. Entries are
    // pushed base-colour → normal → MR → AO → emissive → env, so the names must
    // appear in the fragment source in that order too.
    const names = MESH3D_PBR_MATERIAL.glslSamplers!;
    expect(names).toEqual(['uTex', 'uNormalTex', 'uMRTex', 'uAOTex', 'uEmissiveTex', 'uEnvTex']);
    const at = names.map((n) => {
      const i = pbr.glsl.fragment.indexOf(`uniform sampler2D ${n};`);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    });
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('samples glTF’s fixed channels: G = roughness, B = metallic', () => {
    // Swapping these is the single most likely edit-time mistake here, and it
    // produces a picture that is merely "a bit off" rather than broken.
    expect(pbr.wgsl).toContain('shade3dNMR(world, N, graded, mrSample.b, mrSample.g, ao)');
    expect(pbr.glsl.fragment).toContain('shade3dNMR(vWorld, N, graded, mrSample.b, mrSample.g, ao)');
  });

  it('lerps occlusion by its strength and multiplies emissive by its factor', () => {
    expect(pbr.wgsl).toContain('let ao = 1.0 + obj.pbrParams.y * (aoSample - 1.0);');
    expect(pbr.glsl.fragment).toContain('float ao = 1.0 + pbrParams.y * (aoSample - 1.0);');
    expect(pbr.wgsl).toContain('obj.pbrEmissive.rgb * workingFromSample(eSample, 0.0)');
    expect(pbr.glsl.fragment).toContain('pbrEmissive.rgb * workingFromSample(eSample, 0.0)');
  });

  it('carries the widened uniform block in BOTH shader stages', () => {
    // GLSL links the two stages as one program: a uniform block whose members
    // differ between them is a link error, not a warning.
    for (const stage of [pbr.glsl.vertex, pbr.glsl.fragment]) {
      expect(stage).toContain('vec4 pbrParams; vec4 pbrEmissive; };');
    }
    expect(pbr.wgsl).toContain('pbrParams : vec4<f32>,');
    expect(pbr.wgsl).toContain('pbrEmissive : vec4<f32>,');
  });
});

describe('mesh3d-pbr — uniform control flow', () => {
  /** Lines that sample a texture or take a derivative. */
  const sampleLines = (src: string): string[] =>
    src.split('\n').filter((l) => /textureSample\(|texture\(u\w+,|dpdx\(|dpdy\(|dFdx\(|dFdy\(/.test(l));

  it('★ takes every map sample and every derivative at top level, never inside a branch', () => {
    // WGSL rejects a derivative or an implicit-LOD sample reached through
    // non-uniform control flow. Both dialects are checked because the two must
    // stay term-for-term twins.
    for (const src of [pbr.wgsl, pbr.glsl.fragment]) {
      const lines = sampleLines(src);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toMatch(/^\s*(if|for|while)\b/);
        expect(line).not.toContain('? texture');
      }
    }
  });

  it('chooses the perturbed normal AFTER the samples, not around them', () => {
    expect(pbr.wgsl).toContain('let N = select(Ng, perturbNormal(');
    expect(pbr.glsl.fragment).toContain('vec3 N = pbrParams.z > 0.5 ? perturbNormal(');
  });
});

describe('the tangent frame is derived, so the vertex layout never grew', () => {
  it('reconstructs T and B from d(position)/d(uv) in both dialects', () => {
    expect(pbr.wgsl).toContain('fn perturbNormal(');
    expect(pbr.glsl.fragment).toContain('vec3 perturbNormal(');
    // The cotangent construction: the two cross products are what make this a
    // per-triangle frame rather than a guess, and they must match across
    // dialects term for term.
    for (const src of [pbr.wgsl, pbr.glsl.fragment]) {
      expect(src).toContain('cross(dp2, N)');
      expect(src).toContain('cross(N, dp1)');
      expect(src).toContain('dp2perp * duv1.x + dp1perp * duv2.x');
      expect(src).toContain('dp2perp * duv1.y + dp1perp * duv2.y');
    }
    // Degenerate UVs must not divide by zero — a seam vertex has none.
    expect(pbr.wgsl).toContain('1e-20');
    expect(pbr.glsl.fragment).toContain('1e-20');
  });

  it('★ leaves MESH3D_LAYOUT at position + normal + uv, 32 bytes', () => {
    // Adding a tangent attribute here would desynchronise `modelMorph.ts` and
    // `modelSkinning.ts`, which write deformed vertices at a hardcoded 8-float
    // stride — a skinned model would render as noise.
    expect(MESH3D_LAYOUT.strideBytes).toBe(32);
    expect(MESH3D_LAYOUT.attributes.map((a) => a.format)).toEqual(['float32x3', 'float32x3', 'float32x2']);
    // …and the PBR material draws the SAME buffers, so a mapped model and an
    // unmapped one share one upload.
    expect(MESH3D_PBR_MATERIAL.buffers).toEqual([MESH3D_LAYOUT]);
  });
});

describe('★ the narrow mesh shader is untouched — the goldens gate', () => {
  it('mesh3d-textured declares no map beyond base colour', () => {
    const narrow = byName.get('mesh3d-textured')!;
    for (const name of ['uNormalTex', 'uMRTex', 'uAOTex', 'uEmissiveTex']) {
      expect(narrow.glsl.fragment).not.toContain(name);
    }
    for (const sym of ['normalTex', 'mrTex', 'aoTex', 'emissiveTex', 'pbrParams', 'pbrEmissive', 'shade3dNMR']) {
      expect(narrow.wgsl).not.toContain(sym);
    }
  });

  it('and keeps its own bind-group layout at base colour + sampler (+ the env atlas)', () => {
    const textures = MESH3D_TEXTURED_MATERIAL.layout.filter((e) => e.type === 'texture').map((e) => e.binding);
    expect(textures).toEqual([1, 7]);
    // The PBR set is what claims 3-6; nothing else on this path may.
    expect(textures).not.toContain(3);
  });

  it('the two materials are genuinely different pipelines', () => {
    // Same shader name would mean one pipeline and one bind-group layout, which
    // is the arrangement this whole variant exists to avoid.
    expect(MESH3D_PBR_MATERIAL.shader).not.toBe(MESH3D_TEXTURED_MATERIAL.shader);
    expect(MESH3D_PBR_MATERIAL.depth).toEqual(MESH3D_TEXTURED_MATERIAL.depth);
  });
});
