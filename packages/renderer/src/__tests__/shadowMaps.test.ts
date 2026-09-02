/**
 * Geometry-aware shadows: the GATE, the two contracts that make the map reach
 * the shader, and the one piece of arithmetic that decides whether a shadow
 * lands where its caster is.
 *
 * ── Why tests and not goldens ───────────────────────────────────────────────
 *
 * `shadow-map-spot` proves the feature renders for one scene. It cannot prove
 * that every OTHER scene is untouched, and that is the claim the whole render
 * suite rests on: a shadow map widens the shade tail of every lit-3d material
 * and adds two bindings to every lit-3d pipeline, in comps that have no
 * shadow-mapped light and never will. If a future edit moves the shadow term
 * out from behind `shadowParams.x`, every committed golden with a 3D light in
 * it changes at once — and the failure would read as "lighting regressed",
 * with nothing pointing at the cause.
 *
 * ── Why the camera is tested numerically ────────────────────────────────────
 *
 * A shadow map is correct only while the caster pass and the receiving shader
 * measure depth the same way, and `shadowCameraFor` is the single producer of
 * both measures. Every classic shadow artefact is those two disagreeing, and
 * none of them is visible in a unit test of either half alone — so what is
 * asserted here is the property that makes them agree: a point inside the box
 * the camera was fitted to must land inside the map's uv square AND inside the
 * stored depth range. Outside either, the shader answers "lit", and a feature
 * that silently answers "lit" everywhere looks exactly like one that was never
 * built.
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
  SHADOW_DEPTH_MATERIAL,
  SHADOW_DEPTH_MESH_MATERIAL,
  type MaterialDescriptor,
} from '../shaders/Material';
import { SHADOW_SAMPLER_BINDING, SHADOW_TEXTURE_BINDING, ENV_TEXTURE_BINDING } from '../gpu/types';
import { packTextured3D, packSolid3D, SHADOW3D_FLOATS, type Shade3D, type Shade3DLight } from '../pipeline/uniforms';
import { addTransformedBox, emptyBox, shadowCameraFor, shadowMapSizeOf } from '../rendergraph/passes/shadowMap';
import { Mat4 } from '../core/math/Mat4';
import type { Rect } from '../core/math/geometry';
import type { Color } from '../core/math/Color';

const MVP4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as unknown as Mat4;
const RECT = { x: 0, y: 0, width: 1, height: 1 } as unknown as Rect;
const COLOR = { r: 1, g: 1, b: 1, a: 1 } as unknown as Color;

const spot = (over: Partial<Shade3DLight> = {}): Shade3DLight => ({
  type: 'spot', color: { r: 1, g: 1, b: 1 }, gain: 1,
  x: 0, y: 0, z: -400, radius: 1000,
  aimX: 0, aimY: 0, aimZ: 1,
  halfConeRad: 0.9, coneFeatherRad: 0.1, falloffMode: 0, falloffDistance: 500,
  ...over,
});

const SHADOW: NonNullable<Shade3D['shadow']> = {
  matrix: MVP4 as unknown as number[],
  axis: [0, 0, 1], invFar: 0.001, origin: [0, 0, -400],
  darkness: 1, bias: 0.003, step: 1 / 1024, flipV: false,
};

const LIT = (over: Partial<Shade3D> = {}): Shade3D => ({
  model: MVP4 as unknown as number[],
  eye: [0, 0, -1000], specular: 0.5, shininess: 20,
  lights: [spot()],
  ...over,
});

/** The lit-3d materials — every one carries the map, whether it uses it or not. */
const LIT_3D: Array<{ name: string; material: MaterialDescriptor }> = [
  { name: 'solid3d', material: SOLID3D_MATERIAL },
  { name: 'textured3d', material: TEXTURED3D_MATERIAL },
  { name: 'textured3d (no depth write)', material: TEXTURED3D_NO_DEPTH_WRITE_MATERIAL },
  { name: 'masked-textured3d', material: MASKED_TEXTURED3D_MATERIAL },
  { name: 'mesh3d-solid', material: MESH3D_SOLID_MATERIAL },
  { name: 'mesh3d-textured', material: MESH3D_TEXTURED_MATERIAL },
  { name: 'mesh3d-pbr', material: MESH3D_PBR_MATERIAL },
];

/** The shaders that carry the shared shade block. */
const SHADE_SHADERS = ['solid3d', 'textured3d', 'masked-textured3d', 'mesh3d-solid', 'mesh3d-textured', 'mesh3d-pbr']
  .map((n) => BUILTIN_SHADERS.find((s) => s.name === n)!);

describe('the gate: no shadow-mapped light ⇒ the arithmetic that shipped before', () => {
  it('a lit draw with no shadow packs the whole block as zeros', () => {
    const out = packTextured3D(MVP4, RECT, COLOR, 1, undefined, LIT());
    expect([...out.slice(out.length - SHADOW3D_FLOATS)]).toEqual(new Array(SHADOW3D_FLOATS).fill(0));
  });

  it('an UNLIT draw packs them as zeros too', () => {
    const out = packSolid3D(MVP4, COLOR, 1);
    expect([...out.slice(out.length - SHADOW3D_FLOATS)]).toEqual(new Array(SHADOW3D_FLOATS).fill(0));
  });

  it('★ adding a shadow changes ONLY that block — every other float is untouched', () => {
    // The claim the whole render-test suite rests on. A shadow-mapped light in
    // one comp must not be able to move a byte of the model matrix, the eye,
    // the shade params, the light array or envParams anywhere.
    const without = packTextured3D(MVP4, RECT, COLOR, 1, undefined, LIT());
    const withShadow = packTextured3D(MVP4, RECT, COLOR, 1, undefined, LIT({
      lights: [spot({ shadowed: true })],
      shadow: SHADOW,
    }));
    expect(withShadow.length).toBe(without.length);
    const head = without.length - SHADOW3D_FLOATS;
    expect([...withShadow.slice(0, head)]).toEqual([...without.slice(0, head)]);
    expect([...withShadow.slice(head)]).not.toEqual(new Array(SHADOW3D_FLOATS).fill(0));
  });

  it('a shadow whose light did not survive the filter stays OFF', () => {
    /*
      The failure this closes: `packShade3D` drops zero-gain lights and truncates
      past MAX_LIGHTS3D, so the index the shader needs is a position in a list
      the caller never sees. If the shadow block were packed regardless, it would
      carry an index into a light that is not there and darken whichever light
      happened to land in that slot — a shadow attached to the wrong lamp, which
      is worse than no shadow because it looks plausible.
    */
    const out = packTextured3D(MVP4, RECT, COLOR, 1, undefined, LIT({
      lights: [spot({ gain: 0, shadowed: true }), spot()],
      shadow: SHADOW,
    }));
    expect([...out.slice(out.length - SHADOW3D_FLOATS)]).toEqual(new Array(SHADOW3D_FLOATS).fill(0));
  });

  it('★ the light index is resolved AFTER the filter, not before', () => {
    // A zero-gain light ahead of the shadowed one is dropped, so the shadowed
    // light is index 0 in the packed array even though it was second in.
    const out = packTextured3D(MVP4, RECT, COLOR, 1, undefined, LIT({
      lights: [spot({ gain: 0 }), spot({ shadowed: true }), spot()],
      shadow: SHADOW,
    }));
    // shadowOrigin.w is the last float of the origin vec4: 8 back from the end.
    expect(out[out.length - 5]).toBe(0);
  });

  it('darkness IS the enable flag — a shadow that blocks nothing packs as off', () => {
    const out = packTextured3D(MVP4, RECT, COLOR, 1, undefined, LIT({
      lights: [spot({ shadowed: true })],
      shadow: { ...SHADOW, darkness: 0 },
    }));
    // shadowParams.x, the last vec4's first float.
    expect(out[out.length - 4]).toBe(0);
  });
});

describe('the binding contract', () => {
  it.each(LIT_3D)('$name declares the shadow texture and its own NEAREST sampler', ({ material }) => {
    expect(material.layout.find((e) => e.binding === SHADOW_TEXTURE_BINDING)?.type).toBe('texture');
    // Its OWN sampler, not the layer's: the map's texels are a packed depth and
    // the layer sampler filters linearly, which would decode two neighbouring
    // depths into a third that is neither.
    expect(material.layout.find((e) => e.binding === SHADOW_SAMPLER_BINDING)?.type).toBe('sampler');
  });

  it.each(LIT_3D)('$name names uShadowTex after uEnvTex, at the SCENE-level tail', ({ material }) => {
    // QuadRenderer pushes texture entries in ascending binding order and the
    // WebGL2 backend assigns units in that order, so `glslSamplers` is a
    // positional list that must line up one-to-one.
    //
    // The tail is three long, not two, since SSAO took 11/12 (see
    // AO_TEXTURE_BINDING). The claim is unchanged and is the one that matters:
    // the SCENE-level samplers come last, in binding order, after every
    // per-layer slot — so adding a per-layer texture can never renumber them.
    const textures = material.layout.filter((e) => e.type === 'texture').map((e) => e.binding);
    expect(material.glslSamplers!.length).toBe(textures.length);
    expect(material.glslSamplers!.slice(-3)).toEqual(['uEnvTex', 'uShadowTex', 'uSsaoTex']);
    expect([...textures].sort((a, b) => a - b)).toEqual(textures);
  });

  it('sits past the environment atlas, which sits past every per-layer slot', () => {
    expect(SHADOW_TEXTURE_BINDING).toBeGreaterThan(ENV_TEXTURE_BINDING);
    expect(SHADOW_SAMPLER_BINDING).toBeGreaterThan(SHADOW_TEXTURE_BINDING);
  });

  it('declares the bindings in the shader too, or the pipeline layout is a lie', () => {
    for (const src of SHADE_SHADERS) {
      expect(src.wgsl).toContain(`@group(0) @binding(${SHADOW_TEXTURE_BINDING}) var shadowTex : texture_2d<f32>;`);
      expect(src.wgsl).toContain(`@group(0) @binding(${SHADOW_SAMPLER_BINDING}) var shadowSmp : sampler;`);
      expect(src.glsl!.fragment).toContain('uniform sampler2D uShadowTex;');
      // And NOT in the vertex stage: a sampler there is legal, pointless, and
      // on some drivers consumes a vertex texture unit.
      expect(src.glsl!.vertex).not.toContain('uShadowTex');
    }
  });

  it('the CASTER materials carry no texture at all', () => {
    // A caster contributes a silhouette and a distance, never a colour. Binding
    // anything else would mean a second material set for the shadow pass.
    for (const m of [SHADOW_DEPTH_MATERIAL, SHADOW_DEPTH_MESH_MATERIAL]) {
      expect(m.layout.filter((e) => e.type !== 'uniform-buffer')).toEqual([]);
      // Depth test AND write: the map records the NEAREST caster per texel.
      expect(m.depth).toEqual({ test: true, write: true });
    }
  });
});

describe('both dialects sample the map only inside the gate', () => {
  it.each(SHADE_SHADERS.map((s) => s.name))('%s gates its shadow on shadowParams.x', (name) => {
    const src = BUILTIN_SHADERS.find((s) => s.name === name)!;
    expect(src.wgsl).toContain('if (obj.shadowParams.x < 0.0005) { return 1.0; }');
    expect(src.glsl!.fragment).toContain('if (shadowParams.x < 0.0005) return 1.0;');
  });

  it.each(SHADE_SHADERS.map((s) => s.name))('%s taps the map from ONE site', (name) => {
    const src = BUILTIN_SHADERS.find((s) => s.name === name)!;
    // One tap site per dialect, inside the 3x3 nest, inside the gate. More than
    // one means a second sampling path the gate may not cover.
    expect(src.wgsl.split('textureSampleLevel(shadowTex').length - 1).toBe(1);
    expect(src.glsl!.fragment.split('textureLod(uShadowTex').length - 1).toBe(1);
  });

  it.each(SHADE_SHADERS.map((s) => s.name))('%s samples ONCE per fragment, not once per light', (name) => {
    const src = BUILTIN_SHADERS.find((s) => s.name === name)!;
    // Hoisted above the light loop: the term is a fact about the fragment and
    // the map, and nine taps per light would be eight wasted — quite apart from
    // WGSL's rules about sampling under non-uniform control flow.
    for (const [dialect, call, loop] of [
      [src.wgsl, 'let shTerm = shadowFactor(world);', 'for (var i = 0; i < 8; i = i + 1) {'],
      [src.glsl!.fragment, 'float shTerm = shadowFactor(world);', 'for (int i = 0; i < 8; i++) {'],
    ] as const) {
      expect(dialect.indexOf(call)).toBeGreaterThan(0);
      expect(dialect.indexOf(call)).toBeLessThan(dialect.indexOf(loop));
    }
  });

  it('applies the term to ATTENUATION, which both reflectance branches carry', () => {
    // Multiplying `atten` is what makes a shadowed fragment lose this light's
    // diffuse AND specular under Phong AND under GGX, while keeping every other
    // light and keeping ambient (which takes an early `continue`).
    for (const src of SHADE_SHADERS) {
      expect(src.wgsl).toContain('if (shadowOn && shadowIdx == i) { atten = atten * shTerm; }');
      expect(src.glsl!.fragment).toContain('if (shadowOn && shadowIdx == i) atten *= shTerm;');
    }
  });

  it('stores a LINEAR distance, never a clip-space z', () => {
    // The two backends disagree about clip z (WebGL2 −w..w, WebGPU 0..w), so a
    // bias tuned on one would be wrong on the other. Both the caster and the
    // receiver measure along the light's axis instead — and they must use the
    // SAME expression, which is what these two pairs pin.
    const caster = BUILTIN_SHADERS.find((s) => s.name === 'shadow-depth')!;
    expect(caster.wgsl).toContain('packShadowDepth(dot(world - obj.origin.xyz, obj.axis.xyz) * obj.axis.w)');
    expect(caster.glsl!.fragment).toContain('packShadowDepth(dot(vWorld - origin.xyz, axis.xyz) * axis.w)');
    for (const src of SHADE_SHADERS) {
      expect(src.wgsl).toContain('dot(world - obj.shadowOrigin.xyz, obj.shadowAxis.xyz) * obj.shadowAxis.w');
      expect(src.glsl!.fragment).toContain('dot(world - shadowOrigin.xyz, shadowAxis.xyz) * shadowAxis.w');
    }
  });

  it('the pack and unpack are inverses over the range the map stores', () => {
    // Reproduced in TS from the shader text, because the two halves live in
    // different shaders and nothing else compares them.
    const pack = (d: number): [number, number, number] => {
      const c = Math.max(0, Math.min(0.9999847, d));
      const e = [c * 1, c * 255, c * 65025].map((v) => v - Math.floor(v));
      return [
        Math.round((e[0]! - e[1]! / 255) * 255) / 255,
        Math.round((e[1]! - e[2]! / 255) * 255) / 255,
        Math.round(e[2]! * 255) / 255,
      ];
    };
    const unpack = (c: [number, number, number]): number => c[0] + c[1] / 255 + c[2] / 65025;
    for (const d of [0, 0.001, 0.25, 0.5, 0.75, 0.999]) {
      expect(unpack(pack(d))).toBeCloseTo(d, 4);
    }
    // The one value the clamp exists for: fract(1.0) is 0, so an unclamped 1
    // would pack as the NEAREST possible caster and put everything in shadow.
    expect(unpack(pack(1))).toBeGreaterThan(0.999);
  });
});

describe('the camera the caster pass and the shader share', () => {
  /** A box around the origin, 200 wide and 100 deep, sitting in front of a
   *  light at z = −400 — the `shadow-map-spot` arrangement, in miniature. */
  const box = () => {
    const b = emptyBox();
    const model = [200, 0, 0, 0, 0, 200, 0, 0, 0, 0, 1, 0, -100, -100, 0, 1];
    addTransformedBox(b, model, [0, 0, 0], [1, 1, 0]);
    addTransformedBox(b, [200, 0, 0, 0, 0, 200, 0, 0, 0, 0, 1, 0, -100, -100, 100, 1], [0, 0, 0], [1, 1, 0]);
    return b;
  };

  /** World point → (uv, storedDepth), exactly as the shader derives them. */
  function project(cam: NonNullable<ReturnType<typeof shadowCameraFor>>, p: readonly [number, number, number]) {
    const m = cam.matrix;
    const clip = [0, 1, 2, 3].map((r) => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]!);
    const uv = [clip[0]! / clip[3]! * 0.5 + 0.5, clip[1]! / clip[3]! * 0.5 + 0.5];
    const d = (p[0] - cam.origin[0]) * cam.axis[0]
      + (p[1] - cam.origin[1]) * cam.axis[1]
      + (p[2] - cam.origin[2]) * cam.axis[2];
    return { uv, w: clip[3]!, depth: d * cam.invFar };
  }

  it('refuses an AMBIENT light — it has no position and no silhouette', () => {
    expect(shadowCameraFor({ type: 'ambient', x: 0, y: 0, z: 0, aimX: 0, aimY: 0, aimZ: 1 }, box())).toBeNull();
  });

  it('refuses an empty box rather than fitting a frustum to nothing', () => {
    expect(shadowCameraFor({ type: 'spot', x: 0, y: 0, z: -400, aimX: 0, aimY: 0, aimZ: 1 }, emptyBox())).toBeNull();
  });

  it('refuses a run entirely BEHIND the light', () => {
    // Aimed away from the box: nothing it lights can be in front of it.
    expect(shadowCameraFor({ type: 'spot', x: 0, y: 0, z: -400, aimX: 0, aimY: 0, aimZ: -1 }, box())).toBeNull();
  });

  it.each(['spot', 'point', 'parallel'] as const)('%s: every corner of the box lands inside the map', (type) => {
    /*
      THE property that makes a shadow map work at all.

      Outside the uv square the shader answers "lit"; outside [0, 1] in depth it
      answers "lit" as well. So a frustum that does not contain the run produces
      a feature that computes a map, samples it, and darkens nothing — which is
      indistinguishable from one that was never wired up, and is exactly what a
      far plane fitted to the CASTERS instead of the whole run would give.
    */
    const cam = shadowCameraFor({ type, x: 0, y: 0, z: -400, aimX: 0, aimY: 0, aimZ: 1 }, box())!;
    expect(cam).not.toBeNull();
    const b = box();
    for (let i = 0; i < 8; i++) {
      const p = [
        (i & 1) ? b.maxX : b.minX,
        (i & 2) ? b.maxY : b.minY,
        (i & 4) ? b.maxZ : b.minZ,
      ] as const;
      const { uv, w, depth } = project(cam, p);
      expect(w).toBeGreaterThan(0);
      expect(uv[0]!).toBeGreaterThanOrEqual(0);
      expect(uv[0]!).toBeLessThanOrEqual(1);
      expect(uv[1]!).toBeGreaterThanOrEqual(0);
      expect(uv[1]!).toBeLessThanOrEqual(1);
      expect(depth).toBeGreaterThan(0);
      expect(depth).toBeLessThan(1);
    }
  });

  it('a nearer caster stores a SMALLER depth than the receiver behind it', () => {
    // The comparison the shader makes. If this inverted, every lit surface would
    // shadow itself and every shadow would vanish.
    const cam = shadowCameraFor({ type: 'spot', x: 0, y: 0, z: -400, aimX: 0, aimY: 0, aimZ: 1 }, box())!;
    expect(project(cam, [0, 0, 0]).depth).toBeLessThan(project(cam, [0, 0, 100]).depth);
  });

  it('the projection puts z in 0..1, the range BOTH backends accept', () => {
    // WebGPU clips z < 0; WebGL2 accepts −w..w and merely spends half its depth
    // range on a 0..1 projection. So 0..1 is the one convention that works on
    // both, and the depth buffer here only has to ORDER casters anyway.
    const cam = shadowCameraFor({ type: 'spot', x: 0, y: 0, z: -400, aimX: 0, aimY: 0, aimZ: 1 }, box())!;
    for (const p of [[0, 0, 0], [0, 0, 100], [100, 100, 50]] as const) {
      const m = cam.matrix;
      const z = m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!;
      const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
      expect(z / w).toBeGreaterThanOrEqual(0);
      expect(z / w).toBeLessThanOrEqual(1);
    }
  });

  it('clamps the map size to the three the UI offers', () => {
    expect(shadowMapSizeOf(undefined)).toBe(1024);
    expect(shadowMapSizeOf(512)).toBe(512);
    expect(shadowMapSizeOf(1024)).toBe(1024);
    expect(shadowMapSizeOf(2048)).toBe(2048);
    expect(shadowMapSizeOf(99999)).toBe(2048);
    expect(shadowMapSizeOf(1)).toBe(512);
  });
});
