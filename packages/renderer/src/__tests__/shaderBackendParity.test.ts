/**
 * A shader's two backends must agree about the SPACE they work in.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 *
 * `bend` shipped with:
 *
 *     WGSL   let p = uv - vec2<f32>(0.5, 0.5);
 *     GLSL   vec2 p = (vUv - uvRect.xy) / uvRect.zw - vec2(0.5);
 *
 * `uv` addresses the layer's SUB-RECT of the render target, so subtracting 0.5
 * from it directly bends around the target's centre rather than the layer's.
 * Every source coordinate then fell outside the layer, the shader's own bounds
 * check returned transparent for all of them, and the layer VANISHED — reported
 * as "I applied Bend to a triangle and the object disappeared".
 *
 * It was invisible three ways at once: `tsc` does not read shader strings, the
 * whole suite was green because nothing executes a shader, and the GLSL half
 * was correct — so anyone testing on WebGL2 would have seen it work.
 *
 * ── Why this shape of test ──────────────────────────────────────────────────
 *
 * The backends cannot be compared by running them (no GPU here) or by parsing
 * two different languages properly. But the specific divergence that bit — one
 * side converting target UV to layer-local and the other not — is visible as
 * TEXT, because each language has exactly one idiom for it. That is narrow
 * enough to be checkable and broad enough to catch the whole class.
 *
 * A shader that needs layer-local coordinates in one language needs them in
 * both. Which shaders those are is derived, not listed, so this needs no
 * maintenance as shaders are added.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';

/** `(uv - obj.uvRect.xy) / obj.uvRect.zw` — target UV → layer-local, WGSL. */
const WGSL_LOCAL = /\(\s*uv\s*-\s*obj\.uvRect\.xy\s*\)\s*\/\s*obj\.uvRect\.zw/;
/** The same conversion in GLSL. */
const GLSL_LOCAL = /\(\s*vUv\s*-\s*uvRect\.xy\s*\)\s*\/\s*uvRect\.zw/;

/** Shaders that ship both backends — the only ones that can disagree. */
const DUAL = BUILTIN_SHADERS.filter((s) => s.wgsl && s.glsl?.fragment);

describe('WGSL ⇄ GLSL parity', () => {
  it('there are dual-backend shaders, so the rules below are not vacuous', () => {
    expect(DUAL.length).toBeGreaterThan(5);
  });

  it('a shader deriving layer-local coordinates does so on BOTH backends', () => {
    const mismatched = DUAL.filter((s) => {
      const w = WGSL_LOCAL.test(s.wgsl);
      const g = GLSL_LOCAL.test(s.glsl!.fragment);
      return w !== g;
    }).map((s) => s.name);

    // A name here means one backend bends/lights/maps around the LAYER and the
    // other around the render target. On a full-frame layer the two coincide,
    // which is why this survives casual testing.
    expect(mismatched).toEqual([]);
  });

  it('neither backend centres on a raw target coordinate', () => {
    /*
      The precise mistake, in the form it took: subtracting 0.5 from the target
      UV. `uv - vec2<f32>(0.5, 0.5)` is only correct for a layer that fills the
      target exactly, and silently wrong for every other layer.
    */
    const raw = DUAL.filter((s) =>
      /\buv\s*-\s*vec2<f32>\(\s*0\.5\s*,\s*0\.5\s*\)/.test(s.wgsl)
      || /\bvUv\s*-\s*vec2\(\s*0\.5\s*\)/.test(s.glsl!.fragment),
    ).map((s) => s.name);

    expect(raw).toEqual([]);
  });
});
