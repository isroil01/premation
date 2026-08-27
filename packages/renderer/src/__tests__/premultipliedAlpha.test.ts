/**
 * The alpha invariant, at the shader boundary.
 *
 * **Every texture this renderer samples holds PREMULTIPLIED alpha** (stated in
 * full on `TextureSource`, ../gpu/types.ts). So every textured shader divides the
 * premultiplication back out at the sample, grades straight colour, and
 * re-multiplies on the way out — and there is no second behaviour, no per-draw
 * flag, and no `-premul` twin.
 *
 * ## What this file used to guard, and why it changed
 *
 * It used to guard six DERIVED TWINS and the flag that chose between them, under
 * a STRAIGHT invariant. That invariant was measured and found wanting: on a
 * magnified hard alpha edge the half-covered column read red 181 where correct
 * filtering predicts 243.8 — a 63-of-255-level dark halo, because straight is the
 * wrong space for a bilinear sampler to average in. Flipping the invariant made
 * the divide unconditional, which DELETED the twins rather than doubling them.
 *
 * So what needs guarding now is the opposite property: that the divide is in
 * EVERY family and that no twin has crept back. The derivation throws at module
 * load if a substitution site goes missing — these tests would not reach their
 * bodies in that case, which is the point.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';
import {
  TEXTURED_MATERIAL,
  MASKED_TEXTURED_MATERIAL,
  LUT_TEXTURED_MATERIAL,
  DEFORMED_MESH_MATERIAL,
  TEXTURED3D_MATERIAL,
  TEXTURED3D_NO_DEPTH_WRITE_MATERIAL,
  MASKED_TEXTURED3D_MATERIAL,
} from '../shaders/Material';
import { sourcePassesThrough } from '../gpu/types';

const byName = (n: string) => BUILTIN_SHADERS.find((s) => s.name === n);

/** Every shader that samples a layer texture and premultiplies on output. */
const FAMILIES = [
  'textured', 'masked-textured', 'lut-textured', 'deformed-mesh', 'textured3d', 'masked-textured3d',
  'textured-linear', 'masked-textured-linear', 'lut-textured-linear',
  'deformed-mesh-linear', 'textured3d-linear', 'masked-textured3d-linear',
];

describe('every textured family un-premultiplies at the sample', () => {
  it.each(FAMILIES)('%s is registered', (name) => {
    expect(byName(name)).toBeDefined();
  });

  it.each(FAMILIES)('%s divides at the sample in BOTH languages', (name) => {
    // Both languages, because a substitution that missed one would render
    // correctly on one backend and keep the double multiply on the other — the
    // exact cross-backend divergence this invariant exists to prevent.
    const s = byName(name)!;
    expect(s.wgsl).toContain('unpremul(textureSample(tex, smp, uv))');
    expect(s.glsl.fragment).toContain('unpremul(texture(uTex, vUv))');
  });

  it.each(FAMILIES)('%s defines the guarded helper it calls', (name) => {
    const s = byName(name)!;
    expect(s.wgsl).toContain('fn unpremul(');
    expect(s.glsl.fragment).toContain('vec4 unpremul(');
  });

  it.each(FAMILIES)('%s still premultiplies on the way OUT', (name) => {
    // The divide converts for the grade only. Dropping the output multiply would
    // emit straight colour into a premultiplied compositor.
    //
    // The families SPELL it differently — `graded * c.a`, `graded * a` for the
    // masked ones (which bind mask alpha into `a`), `lit * c.a` / `lit * a` for
    // the 3D ones (whose shading stage renames the graded value). That spread is
    // exactly why the original grep for this fix found three families instead of
    // six, so the assertion matches the SHAPE rather than one literal.
    const s = byName(name)!;
    // After linear RT storage, most families write working-space premul
    // (`graded * c.a`). LUT still encodes into the table then multiplies.
    // Match either shape.
    const multipliesOut =
      /(linearToSrgbRgb\((?:graded|lit)\)|(?:graded|lit|outColor|rgb)) \* (c\.a|a)\b/;
    expect(s.wgsl).toMatch(multipliesOut);
    expect(s.glsl.fragment).toMatch(multipliesOut);
  });

  it.each(FAMILIES)('%s leaves the vertex stage alone — a fragment-only concern', (name) => {
    // The substitution rewrites the fragment sample; a vertex-stage difference
    // would mean it had matched something it should not have.
    expect(byName(name)!.glsl.vertex).toContain('gl_Position');
  });

  it('no raw multiply-by-tint sample survives in any family', () => {
    for (const name of FAMILIES) {
      const s = byName(name)!;
      expect(s.wgsl).not.toContain('textureSample(tex, smp, uv) * obj.tint');
      expect(s.glsl.fragment).not.toContain('texture(uTex, vUv) * tint');
    }
  });
});

describe('the twins and their flag are gone, not hidden', () => {
  it('registers NO -premul shader', () => {
    expect(BUILTIN_SHADERS.filter((s) => s.name.endsWith('-premul'))).toHaveLength(0);
  });

  it('every textured material names the plain family shader', () => {
    const materials = [
      TEXTURED_MATERIAL, MASKED_TEXTURED_MATERIAL, LUT_TEXTURED_MATERIAL,
      DEFORMED_MESH_MATERIAL, TEXTURED3D_MATERIAL,
      TEXTURED3D_NO_DEPTH_WRITE_MATERIAL, MASKED_TEXTURED3D_MATERIAL,
    ];
    for (const m of materials) expect(m.shader.endsWith('-premul')).toBe(false);
  });

  it('shader names are unique, so the registry cannot silently shadow one', () => {
    const names = BUILTIN_SHADERS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the sub-quantum threshold, which is why the divide is safe', () => {
  // At alpha 1/255 an unguarded divide multiplies RGB by 255, turning
  // quantisation noise in nearly-transparent texels into visible specks along
  // feathered masks, motion-blurred edges and glow falloff. Below one alpha
  // quantum there is no recoverable colour, so the texel must resolve to empty.
  //
  // This matters MORE than it did: the divide now runs on every textured draw
  // rather than on opt-in footage, so the guard protects every layer in the app.
  it.each(FAMILIES)('%s thresholds at one 8-bit alpha quantum', (name) => {
    const s = byName(name)!;
    expect(s.wgsl).toContain('0.00392156862745098');
    expect(s.glsl.fragment).toContain('0.00392156862745098');
  });

  it.each(FAMILIES)('%s does not clamp unpremul to 1 (32-bpc HDR)', (name) => {
    // Linear intermediates may hold scene-referred values > 1. Clamping the
    // quotient made bitDepth:32 a no-op through every textured draw.
    const s = byName(name)!;
    expect(s.wgsl).toContain('t.rgb / t.a');
    expect(s.wgsl).not.toContain('min(t.rgb / t.a, vec3<f32>(1.0))');
    expect(s.glsl.fragment).toContain('t.rgb / t.a');
    expect(s.glsl.fragment).not.toContain('min(t.rgb / t.a, vec3(1.0))');
  });
});

describe('sourcePassesThrough decides whether the upload converts', () => {
  const bitmap = {} as ImageBitmap;
  const canvas = {} as HTMLCanvasElement;
  const video = {} as HTMLVideoElement;

  // Both upload flags mean "the DESTINATION shall be premultiplied", and the
  // browser converts from whatever the source declares. So the answer here is
  // "convert" for every honest source, and "pass through" only for the one that
  // misdeclares itself.

  it('an honest bitmap is converted', () => {
    expect(sourcePassesThrough({ type: 'bitmap', bitmap })).toBe(false);
  });

  it('a bitmap whose bytes are premultiplied but says otherwise is passed through', () => {
    // A premultiplied FILE decoded with `premultiplyAlpha: 'none'`: the bytes are
    // already multiplied, the ImageBitmap reports itself straight, and asking for
    // a premultiplied destination would multiply it a second time.
    expect(sourcePassesThrough({ type: 'bitmap', bitmap, alreadyPremultiplied: true })).toBe(true);
  });

  it('a canvas is CONVERTED, not passed through', () => {
    // The regression this pins. A canvas store is premultiplied and the browser
    // knows it, so requesting a premultiplied destination is a no-op. Treating
    // canvas as "pass through" instead inverts the request and makes the upload
    // un-premultiply it, handing the shader a straight texture that it then
    // divides as though premultiplied — measured as 50% fill opacity rendering at
    // 97.3% of full instead of 50%.
    expect(sourcePassesThrough({ type: 'canvas', canvas })).toBe(false);
  });

  it('video is converted like any other declared-straight source', () => {
    expect(sourcePassesThrough({ type: 'video', video })).toBe(false);
    expect(sourcePassesThrough({ type: 'video', video, alreadyPremultiplied: true })).toBe(true);
  });

  it('raw buffers are taken as already in the invariant’s space', () => {
    // Bytes we authored ourselves; there is no decode step to reinterpret, and
    // both backends' buffer paths ignore the unpack flags anyway.
    const data = new Uint8Array(4);
    expect(sourcePassesThrough({ type: 'buffer', data, width: 1, height: 1 })).toBe(false);
  });
});
