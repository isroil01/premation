/**
 * Every unpremultiply divide in shader source must be guarded against alpha 0.
 *
 * WHY THIS IS A TEST AND NOT A CODE REVIEW ITEM. `c.rgb / c.a` on a fully
 * transparent pixel is a divide by zero, and what that produces is
 * DRIVER-DEPENDENT: NaN, Inf, or a flushed zero depending on the hardware and
 * the compiler's fast-math posture. NaN survives `clamp` on some drivers, and
 * `NaN * 0.0` is still NaN, so re-premultiplying cannot rescue it. The result is
 * a defect that is invisible on the machine you wrote it on and shows up as
 * black fringing or transparent holes on someone else's GPU.
 *
 * It is also invisible to the render-test gate, which runs one backend on one
 * machine. A source-level invariant is the only cheap way to hold this.
 *
 * The bug this locks down: FRACTAL_NOISE unpremultiplied with a bare divide
 * while GRADIENT_RAMP, three lines away in the same file, guarded with
 * `select()`. Both were added in the same change.
 *
 * Two shapes of guard are accepted, because both are correct:
 *   - inline — `select(x / a, 0, a == 0)` (WGSL) or `(a > 0.0) ? x / a : 0` (GLSL)
 *   - an early return above the divide — `if (t.a < ALPHA_FLOOR) return 0`,
 *     which is what `unpremul()` uses. That one is deliberately a THRESHOLD
 *     rather than an epsilon: at alpha 1/255 the divide amplifies RGB by 255,
 *     so quantisation noise in nearly-transparent texels would become visible
 *     specks. See the comment on UNPREMUL_WGSL.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';

/** `/ <ident>.a` — an unpremultiply divide, in either dialect. */
const ALPHA_DIVIDE = /\/\s*([A-Za-z_][A-Za-z0-9_]*)\.a\b/;

/** Inline guards: WGSL `select(...)`, GLSL ternary, or an explicit comparison. */
function guardedInline(line: string, ident: string): boolean {
  if (line.includes('select(')) return true;
  if (line.includes('?') && line.includes(':')) return true;
  return new RegExp(`${ident}\\.a\\s*[><=!]`).test(line);
}

/** An early return / branch on alpha within the preceding few lines. */
function guardedAbove(lines: string[], i: number, ident: string): boolean {
  for (let k = Math.max(0, i - 4); k < i; k++) {
    const l = lines[k]!;
    if (!l.includes('if')) continue;
    if (new RegExp(`${ident}\\.a\\s*[><=!]`).test(l)) return true;
  }
  return false;
}

interface Site {
  shader: string;
  dialect: string;
  line: string;
  guarded: boolean;
}

function scan(source: string, shader: string, dialect: string): Site[] {
  const lines = source.split('\n');
  const out: Site[] = [];
  lines.forEach((line, i) => {
    // Skip comments — the prose explains the divide, it does not perform one.
    const code = line.replace(/\/\/.*$/, '');
    const m = ALPHA_DIVIDE.exec(code);
    if (!m) return;
    const ident = m[1]!;
    out.push({
      shader,
      dialect,
      line: line.trim(),
      guarded: guardedInline(code, ident) || guardedAbove(lines, i, ident),
    });
  });
  return out;
}

function allSites(): Site[] {
  const sites: Site[] = [];
  for (const s of BUILTIN_SHADERS) {
    if (s.wgsl) sites.push(...scan(s.wgsl, s.name, 'wgsl'));
    if (s.glsl?.fragment) sites.push(...scan(s.glsl.fragment, s.name, 'glsl'));
    if (s.glsl?.vertex) sites.push(...scan(s.glsl.vertex, s.name, 'glsl-vert'));
  }
  return sites;
}

describe('unpremultiply divides are guarded against alpha 0', () => {
  it('finds unpremultiply sites at all — the scan is not vacuous', () => {
    // A regex that silently matches nothing would make every assertion below
    // pass while checking exactly zero shaders.
    expect(allSites().length).toBeGreaterThan(0);
  });

  it('every site is guarded, in every shader and both dialects', () => {
    const unguarded = allSites().filter((s) => !s.guarded);
    expect(unguarded.map((s) => `${s.shader} [${s.dialect}]: ${s.line}`)).toEqual([]);
  });

  it('guards the same sites in WGSL and GLSL — dialect parity', () => {
    // A guard added to one dialect and missed in the other passes on a WebGPU
    // machine and diverges on WebGL2, which is the failure mode hardest to read.
    const perShader = new Map<string, { wgsl: number; glsl: number }>();
    for (const s of allSites()) {
      const e = perShader.get(s.shader) ?? { wgsl: 0, glsl: 0 };
      if (s.dialect === 'wgsl') e.wgsl++;
      else e.glsl++;
      perShader.set(s.shader, e);
    }
    const mismatched = [...perShader.entries()]
      .filter(([, v]) => v.wgsl > 0 && v.glsl > 0 && v.wgsl !== v.glsl)
      .map(([name, v]) => `${name}: ${v.wgsl} wgsl vs ${v.glsl} glsl`);
    expect(mismatched).toEqual([]);
  });
});
