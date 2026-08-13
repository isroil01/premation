/**
 * WGSL: `textureSample` may only be called in UNIFORM CONTROL FLOW.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 *
 * `bend`, `sphere` and `cylinder` each ended with:
 *
 *     if (outsideTheShape) { return vec4<f32>(0.0); }   // early return
 *     return textureSample(tex, smp, src);              // ← now non-uniform
 *
 * The plain sampling form computes implicit derivatives, which WGSL only
 * permits where every invocation in the quad agrees on reaching the statement.
 * An early return breaks that, so Tint rejects the whole module. Pipeline
 * creation then fails, the effect pass executes with nothing to draw, and —
 * because the effects chain relies on a draw to composite the layer back out —
 * THE LAYER DISAPPEARS. Reported as "I applied Bend to a triangle and the
 * object vanished".
 *
 * It is invisible to everything else we run: `tsc` does not read shader
 * strings, no test executes a shader, and GLSL has no equivalent rule, so the
 * WebGL2 backend renders it correctly. Only WebGPU — the default backend —
 * breaks.
 *
 * The codebase already KNEW this: `apply-color-lut` and `compound-blur` both
 * use `textureSampleLevel` and `compound-blur` explains why in a comment. The
 * rule was written down and then not followed, which is exactly the situation
 * a guard is for.
 *
 * ── The check ───────────────────────────────────────────────────────────────
 *
 * Line-based rather than a parse: an early return is a `return` that does not
 * itself carry the sample. Any `textureSample(` after one is the defect.
 * `textureSampleLevel` takes an explicit LOD, computes no derivatives, and is
 * always legal — so it is the fix and is deliberately not flagged.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';

/** The fragment entry point onwards — the only place this rule applies. */
function fragmentBody(wgsl: string): string | null {
  const at = wgsl.indexOf('@fragment');
  return at < 0 ? null : wgsl.slice(at);
}

/**
 * True when a derivative-computing sample follows an early return.
 *
 * `textureSampleLevel` must not count, and it contains `textureSample` as a
 * prefix — hence the negative lookahead rather than a bare `includes`.
 */
function samplesAfterEarlyReturn(body: string): boolean {
  const SAMPLE = /textureSample(?!Level)\s*\(/;
  const lines = body.split('\n');
  let sawEarlyReturn = false;
  for (const line of lines) {
    if (sawEarlyReturn && SAMPLE.test(line)) return true;
    // An early return is one that does not itself return the sample: a final
    // `return textureSample(...)` is the normal shape and ends the function.
    if (/\breturn\b/.test(line) && !SAMPLE.test(line)) sawEarlyReturn = true;
  }
  return false;
}

describe('WGSL uniform control flow', () => {
  const withFragment = BUILTIN_SHADERS
    .map((s) => ({ name: s.name, body: fragmentBody(s.wgsl) }))
    .filter((s): s is { name: string; body: string } => s.body !== null);

  it('there are fragment shaders to check, so this is not vacuous', () => {
    expect(withFragment.length).toBeGreaterThan(10);
  });

  it('no shader calls textureSample after an early return', () => {
    const offenders = withFragment.filter((s) => samplesAfterEarlyReturn(s.body)).map((s) => s.name);
    // A name here will not fail to compile on WebGL2 and will not fail any
    // other test — it will simply erase the layer it is applied to on WebGPU.
    expect(offenders).toEqual([]);
  });

  it('detects the exact shape that shipped, so the rule above has teeth', () => {
    // Guards the guard: if `samplesAfterEarlyReturn` stopped matching, the
    // assertion above would pass for every shader forever.
    const broken = `@fragment fn fs() -> @location(0) vec4<f32> {
      if (x > 1.0) { return vec4<f32>(0.0); }
      return textureSample(tex, smp, uv);
    }`;
    expect(samplesAfterEarlyReturn(broken)).toBe(true);
  });

  it('accepts textureSampleLevel after an early return — that IS the fix', () => {
    const fixed = `@fragment fn fs() -> @location(0) vec4<f32> {
      if (x > 1.0) { return vec4<f32>(0.0); }
      return textureSampleLevel(tex, smp, uv, 0.0);
    }`;
    expect(samplesAfterEarlyReturn(fixed)).toBe(false);
  });

  it('accepts a plain final `return textureSample(...)` with no early return', () => {
    // The ordinary shape most of these shaders have; flagging it would make
    // the guard unusable.
    const ordinary = `@fragment fn fs() -> @location(0) vec4<f32> {
      return textureSample(tex, smp, uv);
    }`;
    expect(samplesAfterEarlyReturn(ordinary)).toBe(false);
  });
});
