/**
 * A shader's GLSL vertex and fragment stages must declare the SAME uniform
 * block, member for member.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 *
 * Bend's fragment stage gained `vec4 fxBox` and its vertex stage did not. In
 * GLSL ES 300 two stages declaring the same uniform block name with different
 * members is a LINK error, so this does not fail at the stale stage — the whole
 * PROGRAM fails to build. The effect then does nothing at all on the WebGL2
 * backend while WebGPU, which has no equivalent rule, renders it perfectly.
 *
 * That is the fifth distinct way a shader in this codebase has failed on
 * exactly one backend, and like the others it is invisible to `tsc` (the source
 * is a string), to lint, and to every behavioural test.
 *
 * ── Why compare text rather than parse ──────────────────────────────────────
 *
 * The requirement really is textual identity: GLSL matches block members by
 * declaration order, type and name. Two blocks that differ only in whitespace
 * would link, but writing them differently is how they drift, so the stricter
 * rule is also the more useful one to enforce.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';

const BLOCK = /layout\(std140\)\s*uniform\s+Object\s*\{[^}]*\}/g;

/** Normalised uniform-block declarations found in one GLSL stage. */
function blocksIn(src: string): string[] {
  return [...src.matchAll(BLOCK)].map((m) => m[0].replace(/\s+/g, ' ').trim());
}

describe('GLSL uniform block parity across stages', () => {
  const withGlsl = BUILTIN_SHADERS.filter(
    (s): s is typeof s & { glsl: { vertex: string; fragment: string } } =>
      typeof s.glsl?.vertex === 'string' && typeof s.glsl?.fragment === 'string',
  );

  it('there are GLSL shaders to check, so this is not vacuous', () => {
    expect(withGlsl.length).toBeGreaterThan(10);
  });

  it('every shader declares one identical Object block in both stages', () => {
    const mismatched = withGlsl
      .filter((s) => {
        const v = blocksIn(s.glsl.vertex);
        const f = blocksIn(s.glsl.fragment);
        // A stage may legitimately declare none (nothing to disagree about).
        if (v.length === 0 || f.length === 0) return false;
        return v[0] !== f[0];
      })
      .map((s) => s.name);
    // A name here links nowhere on WebGL2 — the effect vanishes on that backend
    // only, which is the hardest kind of failure to attribute.
    expect(mismatched).toEqual([]);
  });

  it('★ detects the exact drift that shipped, so the rule has teeth', () => {
    // Guards the guard: if `blocksIn` stopped matching, the sweep above would
    // compare empty arrays and pass for every shader forever.
    const vertex = 'layout(std140) uniform Object { mat3 mvp; vec4 p0; };';
    const fragment = 'layout(std140) uniform Object { mat3 mvp; vec4 p0; vec4 fxBox; };';
    expect(blocksIn(vertex)[0]).not.toBe(blocksIn(fragment)[0]);
    expect(blocksIn(vertex)).toHaveLength(1);
  });

  it('ignores whitespace, so reformatting one stage is not a false alarm', () => {
    const a = 'layout(std140) uniform Object { mat3 mvp; vec4 p0; };';
    const b = 'layout(std140)  uniform   Object {\n  mat3 mvp;\n  vec4 p0;\n};';
    expect(blocksIn(a)[0]).toBe(blocksIn(b)[0]);
  });
});
