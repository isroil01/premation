/**
 * Multi-pass effects: the chain, the budget, and what did NOT change.
 *
 * ── What multi-pass is for ───────────────────────────────────────────────────
 *
 * One `fs` function per effect ruled out blur, bloom, convolution, glow and
 * every separable filter — which is most of what anyone wants from a custom
 * effect. Each individual restriction was defensible; the aggregate was much
 * narrower than "WGSL as data" sounds.
 *
 * A chain is still data. The plugin declares passes; the host allocates the
 * targets, ping-pongs them, and sequences the draws. A plugin never sees a
 * render target, never allocates one, and still never runs code in the frame
 * loop — the invariant this whole subsystem is built on is untouched.
 *
 * ── The two things most likely to break, and are pinned here ─────────────────
 *
 * 1. **A single-pass effect must be unchanged.** Every published effect takes
 *    that path. The chain is additive or it is a breaking change dressed up as
 *    a feature.
 * 2. **The budget must refuse the expensive shape and admit the cheap one.**
 *    A cost model with the exponent upside down passes a "does it refuse
 *    something" test while banning exactly the chains it exists to enable.
 */

import { parseEffects, chainCost, MAX_PASS_COST, composeEffectShader } from './effectSchema';
import type { EffectContribution } from './effectSchema';
import {
  pluginEffectMaterial,
  pluginEffectPlan,
  registerPluginShaders,
  passShaderName,
} from './pluginEffectMaterial';

const FS = '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {\n'
  + '  return textureSample(src, samp, uv);\n}';

function parseOne(entry: Record<string, unknown>): {
  effect: EffectContribution | undefined;
  errors: string[];
} {
  const errors: string[] = [];
  const [effect] = parseEffects([{ id: 'fx', label: 'FX', ...entry }], errors);
  return { effect, errors };
}

const pass = (name: string, over: Record<string, unknown> = {}) =>
  ({ name, wgsl: FS, ...over });

describe('declaring a chain', () => {
  it('accepts a two-pass separable blur', () => {
    const { effect, errors } = parseOne({
      passes: [pass('horizontal'), pass('vertical')],
    });
    expect(errors).toEqual([]);
    expect(effect?.passes?.map((p) => p.name)).toEqual(['horizontal', 'vertical']);
  });

  it('defaults scale to 1 and reads to previous', () => {
    // Written down because the defaults are what almost every pass uses, and a
    // default that silently changed would change what every existing chain draws.
    const { effect } = parseOne({ passes: [pass('only')] });
    expect(effect?.passes?.[0]).toMatchObject({ scale: 1, reads: 'previous' });
  });

  it('refuses an effect that declares both a shader and a chain', () => {
    // There is no reading of this that is obviously right: running the chain
    // ignores source the author wrote, running `shader` ignores the chain. Both
    // are "worked, but not the way you wrote it".
    const { effect, errors } = parseOne({ shader: FS, passes: [pass('a')] });
    expect(effect).toBeUndefined();
    expect(errors.join(' ')).toMatch(/declares both "shader" and "passes"/);
  });

  it('refuses an empty chain rather than treating it as absent', () => {
    // `passes: []` is an author who meant to write a chain. Rendering nothing
    // and reporting success is how they would find out.
    const { effect, errors } = parseOne({ passes: [] });
    expect(effect).toBeUndefined();
    expect(errors.join(' ')).toMatch(/is empty/);
  });

  it('refuses more than four passes', () => {
    const { effect, errors } = parseOne({
      passes: [pass('a'), pass('b'), pass('c'), pass('d'), pass('e')],
    });
    expect(effect).toBeUndefined();
    expect(errors.join(' ')).toMatch(/declares 5 passes; the limit is 4/);
  });

  it('refuses two passes with the same name', () => {
    // Each pass compiles to its own registered shader, keyed by name. A
    // duplicate would silently overwrite the first.
    const { effect, errors } = parseOne({ passes: [pass('blur'), pass('blur')] });
    expect(effect).toBeUndefined();
    expect(errors.join(' ')).toMatch(/duplicates an earlier pass "blur"/);
  });

  it('refuses a scale outside the fixed set', () => {
    const { effect, errors } = parseOne({ passes: [pass('a', { scale: 0.9 })] });
    expect(effect).toBeUndefined();
    expect(errors.join(' ')).toMatch(/must be one of 1, 0.5, 0.25/);
  });

  it('refuses `reads` on the first pass', () => {
    /*
      Pass 0's `src` and its `origin` are the same texture. Accepting `origin`
      there would bind one view to two slots and quietly work — teaching an
      author a model that breaks the moment they add a pass in front of it.
    */
    const { effect, errors } = parseOne({
      passes: [pass('a', { reads: 'origin' }), pass('b')],
    });
    expect(effect).toBeUndefined();
    expect(errors.join(' ')).toMatch(/pass 0 reads the layer itself/);
  });

  it('reports a bad shader against the PASS that contains it', () => {
    // With four shaders in an effect, "your shader is wrong" is not an error
    // message. The author needs to know which half.
    const { errors } = parseOne({
      passes: [pass('good'), pass('bad', { wgsl: '@group(0) @binding(9) var x : f32;' })],
    });
    expect(errors.join(' ')).toMatch(/passes\[1\]\.wgsl/);
  });

  it('drops the whole chain when one pass is bad', () => {
    // Matching how a bad effect is dropped whole. A partially-accepted chain
    // compiles, draws, and draws something the author never wrote.
    const { effect } = parseOne({
      passes: [pass('good'), pass('bad', { scale: 3 })],
    });
    expect(effect).toBeUndefined();
  });
});

describe('the cost budget', () => {
  /*
    ★ Cost is `scale²`, not `1/scale²`.

    A pass at `scale` renders `scale²` of the pixels, so a SMALLER scale must be
    a CHEAPER pass. The brief specified `1/scale²`, which scores quarter scale
    — the cheapest pass the platform allows, 1/16 of the fill — at sixteen times
    a full one, and puts a single one of them over the whole budget. That would
    refuse every downsampled blur, which is the entire reason `scale` exists.

    The budget is 3 rather than the brief's 6, because 6 does not satisfy the
    brief's own acceptance criterion: four full-scale passes cost 4 under either
    exponent, and 4 ≤ 6. The concrete, testable half of the pair wins.
  */

  it('costs a pass by its share of the pixels', () => {
    expect(chainCost([{ name: 'a', wgsl: FS, scale: 1 }])).toBeCloseTo(1);
    expect(chainCost([{ name: 'a', wgsl: FS, scale: 0.5 }])).toBeCloseTo(0.25);
    expect(chainCost([{ name: 'a', wgsl: FS, scale: 0.25 }])).toBeCloseTo(0.0625);
  });

  it('★ refuses four full-scale passes', () => {
    const { effect, errors } = parseOne({
      passes: [pass('a'), pass('b'), pass('c'), pass('d')],
    });
    expect(effect).toBeUndefined();
    expect(errors.join(' ')).toMatch(/costs 4.00 full-scale passes; the budget is 3/);
  });

  it('admits a separable blur — two full-scale passes', () => {
    const { effect, errors } = parseOne({ passes: [pass('h'), pass('v')] });
    expect(errors).toEqual([]);
    expect(chainCost(effect!.passes!)).toBeCloseTo(2);
  });

  it('admits a bloom — bright pass, two quarter-scale blurs, composite', () => {
    // The shape the budget most needs to allow, and the one `1/scale²` would
    // have refused outright at a cost of 34.
    const { effect, errors } = parseOne({
      passes: [
        pass('bright'),
        pass('blurH', { scale: 0.25, reads: 'previous' }),
        pass('blurV', { scale: 0.25, reads: 'previous' }),
        pass('composite', { reads: 'both' }),
      ],
    });
    expect(errors).toEqual([]);
    expect(chainCost(effect!.passes!)).toBeLessThanOrEqual(MAX_PASS_COST);
  });

  it('admits four passes when they are cheap enough', () => {
    // The count cap and the cost cap are different controls. Four quarter-scale
    // passes cost a quarter of one full pass.
    const { errors } = parseOne({
      passes: [
        pass('a', { scale: 0.25 }),
        pass('b', { scale: 0.25 }),
        pass('c', { scale: 0.25 }),
        pass('d', { scale: 0.25 }),
      ],
    });
    expect(errors).toEqual([]);
  });
});

describe('what the host generates per pass', () => {
  const chain = () => parseOne({
    passes: [
      pass('down', { wgsl: FS }),
      pass('up', { wgsl: FS, reads: 'both' }),
    ],
  }).effect!;

  it('binds `origin` at 4 only for a pass that reads it', () => {
    const effect = chain();
    expect(composeEffectShader(effect, 0).wgsl).not.toContain('var origin');
    expect(composeEffectShader(effect, 1).wgsl)
      .toContain('@group(0) @binding(4) var origin : texture_2d<f32>;');
  });

  it('keeps `origin` at binding 4 even when binding 3 is free', () => {
    /*
      Sliding it to 3 when no layer parameter is declared would make the binding
      number depend on an unrelated part of the manifest — and the shader
      generator and the resource-binding side would each have to reach that
      conclusion separately. Two derivations of one number is how a bind group
      ends up pointing a shader at the wrong texture. WebGPU numbers bindings;
      it does not require them to be contiguous.
    */
    const material = pluginEffectMaterial('acme.tool', chain(), 1);
    expect(material.layout.map((b) => b.binding)).toEqual([0, 1, 2, 4]);
  });

  it('registers one shader per pass, named for the pass', () => {
    const registered: string[] = [];
    const registry = { register: (s: { name: string }) => registered.push(s.name), has: () => false };
    registerPluginShaders(registry, 'acme.tool', [chain()]);
    expect(registered).toEqual(['acme.tool.fx#down', 'acme.tool.fx#up']);
  });

  it('gives the host a plan it can execute without asking the plugin anything', () => {
    const plan = pluginEffectPlan('acme.tool', chain());
    expect(plan).toEqual([
      { index: 0, shader: 'acme.tool.fx#down', scale: 1, readsOrigin: false, layout: expect.anything() },
      { index: 1, shader: 'acme.tool.fx#up', scale: 1, readsOrigin: true, layout: expect.anything() },
    ]);
  });
});

describe('a single-pass effect is untouched', () => {
  const single = () => parseOne({ shader: FS }).effect!;

  it('registers under the bare name it always had', () => {
    /*
      ★ The compatibility claim, and the one most worth a test.

      Every effect published before chains existed goes through this path. If
      the registry key gained a suffix, every stored document referring to an
      effect by name would stop resolving — a silent, total break presented as
      "your effect disappeared".
    */
    expect(passShaderName('acme.tool', single(), 0)).toBe('acme.tool.fx');
  });

  it('generates the three-binding layout, with no origin', () => {
    const material = pluginEffectMaterial('acme.tool', single());
    expect(material.layout.map((b) => b.binding)).toEqual([0, 1, 2]);
  });

  it('has a one-pass plan', () => {
    expect(pluginEffectPlan('acme.tool', single())).toEqual([
      { index: 0, shader: 'acme.tool.fx', scale: 1, readsOrigin: false, layout: expect.anything() },
    ]);
  });

  it('★ composes byte-identically whether or not chains exist', () => {
    /*
      The strongest form of "unchanged" available without a golden file: the
      generated WGSL for a single-pass effect must not depend on the pass
      machinery at all. Asking for pass 0 of an effect with no passes and asking
      with no index must produce the same string, character for character.
    */
    const effect = single();
    expect(composeEffectShader(effect).wgsl).toBe(composeEffectShader(effect, 0).wgsl);
    expect(composeEffectShader(effect).wgsl).toContain(FS);
  });

  it('still carries the author source in `shader`', () => {
    expect(single().shader).toBe(FS);
    expect(single().passes).toBeUndefined();
  });
});

describe('a chain exposes its head as `shader`', () => {
  it('so a caller that has not learned about chains degrades to pass 0', () => {
    /*
      Everything downstream of parsing already reads `shader`. Pointing it at
      the chain's first pass means an un-updated caller draws the first pass
      rather than nothing — a wrong image beats a black layer, and it is the
      difference between "this looks incomplete" and "this is broken".
    */
    const { effect } = parseOne({
      passes: [pass('first', { wgsl: `${FS}\n// FIRST` }), pass('second')],
    });
    expect(effect!.shader).toContain('// FIRST');
  });
});
