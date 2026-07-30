/**
 * The silhouette-fill shader variant, and the arithmetic it exists to correct.
 *
 * Outer Glow and Drop Shadow are a blurred SILHOUETTE filled with the style's
 * colour. Both used to composite the blurred layer through `textured` with the
 * style colour as the TINT — and a tint multiplies, so the output was
 * `layerRGB × styleRGB`. That is the style's colour only when the layer is
 * white, and black whenever the two share no channel.
 *
 * Drop shadow appeared to work because the DEFAULT shadow colour is black, and
 * black is the absorbing element of a multiply: `anything × 0 = 0`. So the one
 * configuration anybody looked at was a fixed point, and every non-black shadow
 * colour was broken in exactly the same way as the glow.
 *
 * Pixel-level proof lives in packages/render-tests
 * (`scripts/verify-3d-styles.mjs`, scenes `three-d-outer-glow-green-on-blue` and
 * `three-d-drop-shadow-red-on-blue`). What is guarded HERE is the derivation and
 * the algebra that made the bug invisible — the two things a rendering test
 * cannot state in words.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';
import { TEXTURED_MATERIAL, TEXTURED_SILHOUETTE_MATERIAL } from '../shaders/Material';

const byName = (n: string) => BUILTIN_SHADERS.find((s) => s.name === n);

describe('the silhouette variant is registered and distinct', () => {
  it('exists alongside the textured base', () => {
    expect(byName('textured')).toBeDefined();
    expect(byName('textured-silhouette')).toBeDefined();
  });

  it('the material names the variant, not the base', () => {
    expect(TEXTURED_SILHOUETTE_MATERIAL.shader).toBe('textured-silhouette');
    expect(TEXTURED_SILHOUETTE_MATERIAL.shader).not.toBe(TEXTURED_MATERIAL.shader);
  });

  it('differs from its base in BOTH language backends', () => {
    // A substitution that silently missed one language would render correctly on
    // one backend and keep the defect on the other — the exact divergence class
    // this project has been digging out of.
    const base = byName('textured')!;
    const sil = byName('textured-silhouette')!;
    expect(sil.wgsl).not.toBe(base.wgsl);
    expect(sil.glsl.fragment).not.toBe(base.glsl.fragment);
  });

  it('leaves the vertex stage alone — only the sample changes', () => {
    expect(byName('textured-silhouette')!.glsl.vertex).toBe(byName('textured')!.glsl.vertex);
  });

  it('no longer multiplies the sampled texel by the tint', () => {
    const sil = byName('textured-silhouette')!;
    expect(sil.wgsl).not.toContain('textureSample(tex, smp, uv) * obj.tint');
    expect(sil.glsl.fragment).not.toContain('texture(uTex, vUv) * tint');
  });

  it('takes RGB from the tint and alpha from the texture', () => {
    const sil = byName('textured-silhouette')!;
    expect(sil.wgsl).toContain('obj.tint.rgb');
    expect(sil.wgsl).toContain('textureSample(tex, smp, uv).a * obj.tint.a');
    expect(sil.glsl.fragment).toContain('tint.rgb');
    expect(sil.glsl.fragment).toContain('texture(uTex, vUv).a * tint.a');
  });

  it('still premultiplies on the way out, like every other draw', () => {
    // The fill has to composite identically to the rest of the pipeline; if the
    // output line were dropped in the substitution the glow would blow out.
    const sil = byName('textured-silhouette')!;
    expect(sil.wgsl).toContain('graded * c.a');
    expect(sil.glsl.fragment).toContain('graded * c.a');
  });

  it('needs NO premultiplied twin, and must not have grown one', () => {
    // It reads only alpha, which is the same value in straight and premultiplied
    // space — so the variant is invariant-agnostic. A `-silhouette-premul` would
    // be dead weight, and would signal someone had misread why it is exempt.
    expect(byName('textured-silhouette-premul')).toBeUndefined();
    expect(BUILTIN_SHADERS.filter((s) => s.name.endsWith('-silhouette'))).toHaveLength(1);
  });
});

describe('why the tint bug hid behind black shadows', () => {
  // Not a renderer test — a statement of the algebra, so the next person to read
  // "drop shadow works, glow does not" has the reason in front of them rather
  // than having to re-derive it from two shader call sites.
  const tint = (layer: readonly number[], style: readonly number[]) =>
    layer.map((c, i) => (c / 255) * (style[i] / 255) * 255);
  const fill = (_layer: readonly number[], style: readonly number[]) => [...style];

  const BLUE = [0, 0, 255];
  const ORANGE = [255, 138, 61];

  it('black is a fixed point of the tint, so black shadows looked correct', () => {
    expect(tint(BLUE, [0, 0, 0])).toEqual([0, 0, 0]);
    expect(tint(ORANGE, [0, 0, 0])).toEqual([0, 0, 0]);
    // …and the fill agrees with it, which is why no black-shadow golden moved
    // when the fix landed (measured: three-d-drop-shadow and
    // svg-filter-drop-shadow both 0.000%).
    expect(fill(BLUE, [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('a non-black shadow on a disjoint layer colour tinted to black', () => {
    expect(tint(BLUE, [255, 0, 0])).toEqual([0, 0, 0]); // red shadow, blue layer
    expect(fill(BLUE, [255, 0, 0])).toEqual([255, 0, 0]);
  });

  it('a white glow tinted to the LAYER’s colour — the reported symptom', () => {
    expect(tint(ORANGE, [255, 255, 255])).toEqual(ORANGE);
    expect(fill(ORANGE, [255, 255, 255])).toEqual([255, 255, 255]);
  });

  it('which is why a WHITE glow cannot test the fix', () => {
    // White is the identity of a multiply, so on a white layer the broken and
    // fixed paths agree exactly. The colour scenes use disjoint channels for
    // this reason.
    const WHITE = [255, 255, 255];
    expect(tint(WHITE, WHITE)).toEqual(fill(WHITE, WHITE));
  });
});
