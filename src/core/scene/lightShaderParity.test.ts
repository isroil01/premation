/**
 * Every light field the CPU shading path reads must also reach the shader.
 *
 * WHY THIS EXISTS. `shadeLayer` (CPU, per-quad) and `toShaderLights` (the DTO
 * feeding the per-fragment GPU path) both read a `SceneLight`, and the file's
 * own docstring says they "read the SAME numbers". They did not. `ShaderLight`
 * silently omitted `coneFeather`, `falloff`, `falloffDistance` and `poi`, so
 * three shipped inspector controls did nothing on the depth-tested path: cone
 * feather was hardcoded to 20 % in the shader, AE's falloff curves degraded to
 * linear, and a light's Point of Interest was ignored in favour of the legacy
 * 2D angle. The same layer shaded differently depending on which path it took —
 * a divergence, not merely a missing feature.
 *
 * Nothing failed, which is why it survived: both paths compiled, both rendered,
 * and only a side-by-side of the same light on two layers would show it.
 *
 * WHY IT COMPARES READS, NOT FIELD NAMES. `ShaderLight` deliberately renames as
 * it packs — `intensity` → `gain`, `angle` → `aimX`/`aimY`, `cone` →
 * `halfConeRad`. Comparing declared field names would therefore report drift
 * that isn't there and miss drift that is. What actually matters is whether
 * `toShaderLights` *consumes* each source field, because a field it never reads
 * cannot possibly reach a uniform.
 *
 * IF THIS FAILS: either pack the new field into `ShaderLight` and consume it in
 * both shader dialects, or — if it genuinely has no GPU meaning — add it to
 * `CPU_ONLY` below with the reason. That edit is the signal this test exists to
 * produce.
 */

import { readSource } from '@/__testHelpers__/readSource';
import { shadeLayer } from './lightShading';


const SHADING = 'core/scene/lightShading.ts';
const LIGHT = 'core/scene/light.ts';

/**
 * Fields with a deliberate reason not to cross to the GPU, and that reason.
 *
 * Empty today: every field `shadeLayer` reads is one the shader needs. It is
 * the escape hatch for a field that genuinely has no per-fragment meaning —
 * `shadows`, for instance, would belong here if the shading function read it,
 * since it drives the separate 2.5D projected-shadow pass rather than the light
 * loop. It does not read it, so listing it would be a fiction.
 */
const CPU_ONLY: ReadonlyMap<string, string> = new Map<string, string>([]);

/**
 * The body of a top-level `function name(...)`, by brace matching.
 *
 * The opening brace is found AFTER the parameter list closes, not by taking the
 * first `{` — `shadeLayer`'s own signature contains `pos: { x, y, z }`, and
 * matching that inline type instead of the body silently returned three fields
 * and made the parity assertions test almost nothing.
 */
function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`function ${name}\\b`));
  if (start < 0) throw new Error(`lightShaderParity: no function \`${name}\``);

  // Walk the parameter list to its matching ')', so any braces inside inline
  // parameter types are stepped over rather than mistaken for the body.
  const paren = src.indexOf('(', start);
  let parens = 0;
  let afterParams = -1;
  for (let i = paren; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) { afterParams = i + 1; break; }
  }
  if (afterParams < 0) throw new Error(`lightShaderParity: unbalanced parens in \`${name}\``);

  const open = src.indexOf('{', afterParams);
  if (open < 0) throw new Error(`lightShaderParity: no body for \`${name}\``);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`lightShaderParity: unbalanced braces in \`${name}\``);
}

/** Property names read off `light` / `l` in a body: `light.foo`. */
function lightReads(body: string): Set<string> {
  return new Set([...body.matchAll(/\blight\.([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
}

/**
 * Fields `lightFalloffAt` declares it needs.
 *
 * `shadeLayer` hands it the WHOLE light, so everything in that inline parameter
 * type is transitively read by the CPU path. Parsing the declaration rather
 * than listing the fields here keeps the helper self-describing: adding a term
 * to the falloff curve widens this set automatically.
 */
function falloffReads(): Set<string> {
  const src = readSource(LIGHT);
  const sig = /export function lightFalloffAt\([\s\S]*?light: \{([\s\S]*?)\}/.exec(src);
  if (!sig) throw new Error('lightShaderParity: cannot read `lightFalloffAt` parameter type');
  return new Set([...sig[1]!.matchAll(/([A-Za-z][A-Za-z0-9_]*)\??:/g)].map((m) => m[1]!));
}

describe('Light → ShaderLight field parity', () => {
  const shading = readSource(SHADING);

  /**
   * Reads in a function, plus those of every helper it hands the WHOLE light to,
   * transitively.
   *
   * Without this the comparison punishes delegation: `toShaderLights` resolves a
   * Point of Interest through `resolvedAim(light)` → `lightAim3D(light)` rather
   * than touching `light.poi` itself, and a purely textual check would score
   * that as the field never reaching the GPU. Applied to BOTH sides, so neither
   * is rewarded for inlining what the other factored out — and discovered by
   * walking calls rather than from a hardcoded helper list, which would itself
   * be a hand-maintained list inside a test written to kill hand-maintained
   * lists.
   */
  const withHelpers = (fn: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(fn)) return new Set();
    seen.add(fn);
    const body = functionBody(shading, fn);
    const out = lightReads(body);

    for (const [, callee, args] of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g)) {
      // Only calls that pass the light OBJECT — `light.radius` as an argument
      // tells us nothing new, the property read is already counted above.
      if (!/(^|[\s,])light([\s,]|$)/.test(args!)) continue;
      // `lightFalloffAt` lives in light.ts and declares the fields it needs in
      // its own parameter type; everything else is local to this file.
      if (callee === 'lightFalloffAt') {
        for (const f of falloffReads()) out.add(f);
      } else if (new RegExp(`function ${callee}\\b`).test(shading)) {
        for (const f of withHelpers(callee!, seen)) out.add(f);
      }
    }
    return out;
  };

  const cpu = withHelpers('shadeLayer');
  const gpu = withHelpers('toShaderLights');

  it('the extractors actually reached the function bodies', () => {
    // Guards the guard, by NAME rather than by count. A size check passed while
    // `functionBody` was matching `shadeLayer`'s inline `pos: { x, y, z }`
    // parameter type instead of its body: seven fields came back, the threshold
    // was met, and `coneFeather` was never asserted on at all. Naming fields
    // only the real bodies mention is what makes a mis-parse fail loudly.
    for (const field of ['type', 'intensity', 'cone', 'coneFeather']) {
      expect(cpu.has(field)).toBe(true);
    }
    for (const field of ['type', 'intensity', 'cone']) {
      expect(gpu.has(field)).toBe(true);
    }
  });

  it.each([...cpu].filter((f) => !CPU_ONLY.has(f)).sort())(
    '`light.%s` reaches the shader DTO',
    (field) => {
      expect(gpu.has(field)).toBe(true);
    },
  );

  it('every CPU_ONLY exemption is still actually read by the CPU path', () => {
    // An exemption for a field nobody reads any more is dead weight that makes
    // the list look considered when it is stale.
    for (const field of CPU_ONLY.keys()) expect(cpu.has(field)).toBe(true);
  });
});

/**
 * One-sidedness must mean the same thing on both paths.
 *
 * `shadeLayer` is the per-quad CPU fallback for the SAME surface the shader
 * lights per fragment, so a disagreement here is a face that changes brightness
 * depending on which route it took — the exact class of defect this file was
 * written for, and the one the light parameters had.
 *
 * Asserted on BEHAVIOUR rather than on the flag being plumbed, because plumbing
 * a flag that one side ignores is indistinguishable from not plumbing it.
 */
describe('one-sided shading: CPU and GPU agree on what the flag means', () => {
  /** A light straight in FRONT of the surface (−z), the common case. */
  const frontLight = [{
    type: 'point' as const, intensity: 100, color: '#ffffff', radius: 10000,
    x: 0, y: 0, z: -500, shadows: false, darkness: 1, diffusion: 0,
    angle: 0, cone: 45, coneFeather: 20, falloff: 'none' as const,
    falloffDistance: 500, poi: null, shadowDarkness: 100, shadowDiffusion: 0,
  }] as unknown as Parameters<typeof shadeLayer>[2];
  const at = { x: 0, y: 0, z: 0 };

  it('a FRONT-facing normal lights the same either way', () => {
    // dot > 0, so max() and abs() agree — the flag must not change a surface
    // that faces the light.
    const two = shadeLayer([0, 0, -1], at, frontLight, undefined, false);
    const one = shadeLayer([0, 0, -1], at, frontLight, undefined, true);
    expect(one).toEqual(two);
  });

  it('a BACK-facing normal is lit two-sided and dark one-sided', () => {
    const two = shadeLayer([0, 0, 1], at, frontLight, undefined, false);
    const one = shadeLayer([0, 0, 1], at, frontLight, undefined, true);
    expect(two![0]).toBeGreaterThan(0.1);
    // Ambient-free point light behind the surface: one-sided clamps it out.
    expect(one![0]).toBeLessThan(two![0]);
  });

  it('the shader reads the flag from eyeLit.w, and 2 means one-sided', () => {
    // The encoding is load-bearing in two places that cannot see each other:
    // `packShade3D` writes it, four shade blocks read it. Both are pinned so a
    // change to either shows up here rather than as a lighting difference.
    const uniforms = readSource('../packages/renderer/src/pipeline/uniforms.ts');
    expect(uniforms).toMatch(/out\[o \+ 3\] = shade\.oneSided \? 2 : 1;/);
    const shaders = readSource('../packages/renderer/src/shaders/builtin.ts');
    // Every shade block derives it, and every lambert/specular term uses it.
    expect((shaders.match(/twoSided = select\(1\.0, 0\.0, obj\.eyeLit\.w > 1\.5\)/g) ?? []).length).toBe(2);
    expect((shaders.match(/twoSided = eyeLit\.w > 1\.5 \? 0\.0 : 1\.0/g) ?? []).length).toBe(2);
    // 4 blocks x (aim + toLight + specular).
    expect((shaders.match(/, twoSided\)/g) ?? []).length).toBe(12);
  });

  it('only an extrusion FACE asks for it', () => {
    // Slices and the front face must not: their normals are +Z, so clamping
    // would black them out under a front light.
    const build = readSource('core/rendering/buildSnapshot.ts');
    expect((build.match(/oneSided: true/g) ?? []).length).toBe(1);
    expect((build.match(/sceneLights, undefined, true\)/g) ?? []).length).toBe(1);
  });
});
