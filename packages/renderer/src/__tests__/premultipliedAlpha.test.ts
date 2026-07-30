/**
 * Premultiplied-source shader variants.
 *
 * Every textured shader assumes STRAIGHT input: it grades `c.rgb` and returns
 * `graded * c.a`. Footage whose RGB is already multiplied by its alpha is
 * therefore multiplied twice, and soft edges darken into a fringe.
 *
 * The variants divide the premultiplication back out at the sample. They are
 * DERIVED by substitution rather than hand-written, so what needs guarding is
 * mostly the derivation: that every family got one, that the substitution
 * actually happened, and that the straight path is untouched.
 *
 * The derivation throws at module load if a substitution site goes missing —
 * these tests would not even reach their bodies in that case, which is the
 * point. A silent no-op would yield a variant identical to its base: plausible
 * pixels, doubly multiplied, and nothing in the type system to catch it.
 */

import { BUILTIN_SHADERS, PREMUL_SUFFIX } from '../shaders/builtin';
import {
  TEXTURED_MATERIAL, TEXTURED_PREMUL_MATERIAL,
  MASKED_TEXTURED_MATERIAL, MASKED_TEXTURED_PREMUL_MATERIAL,
  LUT_TEXTURED_MATERIAL, LUT_TEXTURED_PREMUL_MATERIAL,
  DEFORMED_MESH_MATERIAL, DEFORMED_MESH_PREMUL_MATERIAL,
  TEXTURED3D_MATERIAL, TEXTURED3D_PREMUL_MATERIAL,
  MASKED_TEXTURED3D_MATERIAL, MASKED_TEXTURED3D_PREMUL_MATERIAL,
} from '../shaders/Material';

const byName = (n: string) => BUILTIN_SHADERS.find((s) => s.name === n);

/** Every shader that samples the layer texture and premultiplies on output. */
const FAMILIES = ['textured', 'masked-textured', 'lut-textured', 'deformed-mesh', 'textured3d', 'masked-textured3d'];

describe('every textured family has a premultiplied twin', () => {
  it.each(FAMILIES)('%s', (base) => {
    expect(byName(base)).toBeDefined();
    expect(byName(`${base}${PREMUL_SUFFIX}`)).toBeDefined();
  });

  it('registers exactly one twin per family — no strays', () => {
    const twins = BUILTIN_SHADERS.filter((s) => s.name.endsWith(PREMUL_SUFFIX));
    expect(twins).toHaveLength(FAMILIES.length);
  });

  it('shader names are unique, so the registry cannot silently shadow one', () => {
    const names = BUILTIN_SHADERS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the substitution actually happened', () => {
  it.each(FAMILIES)('%s divides by alpha and its base does not', (base) => {
    const straight = byName(base)!;
    const premul = byName(`${base}${PREMUL_SUFFIX}`)!;

    for (const code of [premul.wgsl, premul.glsl.fragment]) {
      // The helper is defined…
      expect(code).toContain('unpremul');
      // …and actually wraps the sample rather than merely being declared.
      expect(code).toMatch(/unpremul\((textureSample|texture)\(/);
      // …with the divide in it.
      expect(code).toMatch(/t\.rgb \/ t\.a/);
    }
    // The straight base is untouched — the regression guard for every existing
    // project, which is the overwhelming majority of footage.
    expect(straight.wgsl).not.toContain('unpremul');
    expect(straight.glsl.fragment).not.toContain('unpremul');
  });

  it('leaves the vertex stage alone — this is a fragment-only concern', () => {
    for (const base of FAMILIES) {
      const premul = byName(`${base}${PREMUL_SUFFIX}`)!;
      expect(premul.glsl.vertex).toBe(byName(base)!.glsl.vertex);
    }
  });
});

describe('the guard is a THRESHOLD, not just an epsilon', () => {
  /**
   * `max(a, eps)` bounds the divide but not the amplification: at alpha 1/255
   * the divide multiplies RGB by 255, so quantisation noise in nearly
   * transparent texels becomes visible specks along feathered masks and glow
   * falloff. Below one alpha quantum the texel must resolve to empty.
   */
  it('resolves sub-quantum alpha to zero rather than to amplified noise', () => {
    const premul = byName(`textured${PREMUL_SUFFIX}`)!;
    for (const code of [premul.wgsl, premul.glsl.fragment]) {
      // One 8-bit quantum, stated as a literal so the value is reviewable.
      expect(code).toContain('0.00392156862745098');
      // A comparison, i.e. a branch to zero — not a clamped denominator.
      expect(code).toMatch(/t\.a\s*<\s*0\.00392156862745098/);
    }
  });

  it('clamps the quotient, so invalid premultiplied data cannot make specks', () => {
    // In valid premultiplied colour every channel is <= alpha. A quotient above
    // 1 means the source was not really premultiplied; clamping stops it
    // entering the colour matrix as a wild value.
    const premul = byName(`textured${PREMUL_SUFFIX}`)!;
    expect(premul.wgsl).toContain('min(t.rgb / t.a, vec3<f32>(1.0))');
    expect(premul.glsl.fragment).toContain('min(t.rgb / t.a, vec3(1.0))');
  });
});

describe('materials point at the twins', () => {
  const PAIRS: Array<[string, { shader: string }, { shader: string }]> = [
    ['textured', TEXTURED_MATERIAL, TEXTURED_PREMUL_MATERIAL],
    ['masked', MASKED_TEXTURED_MATERIAL, MASKED_TEXTURED_PREMUL_MATERIAL],
    ['lut', LUT_TEXTURED_MATERIAL, LUT_TEXTURED_PREMUL_MATERIAL],
    ['mesh', DEFORMED_MESH_MATERIAL, DEFORMED_MESH_PREMUL_MATERIAL],
    ['3d', TEXTURED3D_MATERIAL, TEXTURED3D_PREMUL_MATERIAL],
    ['masked3d', MASKED_TEXTURED3D_MATERIAL, MASKED_TEXTURED3D_PREMUL_MATERIAL],
  ];

  it.each(PAIRS)('%s names a registered premul shader', (_label, base, premul) => {
    expect(premul.shader).toBe(`${base.shader}${PREMUL_SUFFIX}`);
    expect(byName(premul.shader)).toBeDefined();
  });

  it('differs from its base ONLY in the shader name', () => {
    // Anything else diverging (layout, topology, depth state) would be a second
    // difference to keep in sync by hand.
    for (const [, base, premul] of PAIRS) {
      expect({ ...premul, shader: base.shader }).toEqual(base);
    }
  });
});
