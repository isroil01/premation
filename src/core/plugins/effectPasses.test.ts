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

      A DIFFERENT refusal from the not-yet-rendered one below, and it stays
      correct after `origin` becomes renderable.
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

  it('would admit a bloom on cost — the budget is not what stops it', () => {
    /*
      Cost checked directly rather than through the parser, because a
      downsampled pass is refused earlier for a different reason (see the
      not-yet-rendered block below). Keeping the arithmetic asserted matters:
      it is the number that will decide whether this shape fits on the day
      `scale` becomes renderable, and it is the case `1/scale²` would have
      refused outright at a cost of 34.
    */
    const bloom = [
      { name: 'bright', wgsl: FS, scale: 1 as const },
      { name: 'blurH', wgsl: FS, scale: 0.25 as const },
      { name: 'blurV', wgsl: FS, scale: 0.25 as const },
      { name: 'composite', wgsl: FS, scale: 1 as const },
    ];
    expect(chainCost(bloom)).toBeLessThanOrEqual(MAX_PASS_COST);
    expect(chainCost(bloom)).toBeCloseTo(2.125);
  });

  it('counts four quarter-scale passes as a quarter of one full pass', () => {
    // The count cap and the cost cap are different controls, and this is the
    // arithmetic that separates them.
    const cheap = Array.from({ length: 4 }, (_, i) => ({
      name: `p${i}`, wgsl: FS, scale: 0.25 as const,
    }));
    expect(chainCost(cheap)).toBeCloseTo(0.25);
  });
});

describe('declared in the format, not rendered by this build', () => {
  /*
    ★ `scale` and `reads` are parsed, budgeted and documented — and refused,
    because the renderer cannot execute them.

    The renderer's offscreen targets are a fixed, statically-declared set and
    every one is viewport-sized, so a downsampled pass has nowhere to draw. The
    chain ping-pongs between a small pool, so the pass-0 input is overwritten
    before a later pass could sample it as `origin`.

    Accepting either and rendering at full size / binding a reused texture would
    be wrong output with no error — a bloom four times the cost the author
    budgeted, or a composite against whatever was last drawn there. So they are
    refused, loudly, with the reason.

    Widening later is backward-compatible in both directions: manifests that
    publish today keep working, and ones refused today start working. The
    reverse — shipping a field that silently does nothing, then making it real —
    breaks every plugin that guessed around it.
  */

  it.each([0.5, 0.25])('refuses scale %p, naming the reason', (scale) => {
    const { effect, errors } = parseOne({ passes: [pass('a', { scale })] });
    expect(effect).toBeUndefined();
    expect(errors.join(' ')).toMatch(/cannot render/);
    expect(errors.join(' ')).toMatch(/smaller than the viewport/);
  });

  it.each(['origin', 'both'])('refuses reads %p on a later pass', (reads) => {
    const { effect, errors } = parseOne({ passes: [pass('a'), pass('b', { reads })] });
    expect(effect).toBeUndefined();
    expect(errors.join(' ')).toMatch(/cannot render/);
    expect(errors.join(' ')).toMatch(/reserved across the whole chain/);
  });

  it('still accepts the values it CAN render, written explicitly', () => {
    // The refusal must be about the value, not about the key being present. An
    // author who spells out the default should not be punished for it.
    const { errors } = parseOne({
      passes: [pass('a', { scale: 1 }), pass('b', { scale: 1, reads: 'previous' })],
    });
    expect(errors).toEqual([]);
  });
});

describe('what the host generates per pass', () => {
  const chain = () => parseOne({ passes: [pass('down'), pass('up')] }).effect!;

  it('composes each pass with the same generated bindings', () => {
    const effect = chain();
    for (const i of [0, 1]) {
      const { wgsl } = composeEffectShader(effect, i);
      expect(wgsl).toContain('@group(0) @binding(0) var<uniform> params : Object;');
      expect(wgsl).toContain('@group(0) @binding(1) var src : texture_2d<f32>;');
      expect(wgsl).toContain('@group(0) @binding(2) var samp : sampler;');
    }
  });

  it('gives every pass the same three bindings when no layer param is declared', () => {
    for (const i of [0, 1]) {
      expect(pluginEffectMaterial('acme.tool', chain(), i).layout.map((b) => b.binding))
        .toEqual([0, 1, 2]);
    }
  });

  it('registers one shader per pass, named for the pass', () => {
    const registered: string[] = [];
    const registry = { register: (s: { name: string }) => registered.push(s.name), has: () => false };
    registerPluginShaders(registry, 'acme.tool', [chain()]);
    expect(registered).toEqual(['acme.tool.fx#down', 'acme.tool.fx#up']);
  });
});

describe('the origin binding, which the manifest cannot reach yet', () => {
  /*
    `reads: 'origin'` is refused at parse until the renderer can keep the pass-0
    input alive — so these drive `composeEffectShader` / `pluginEffectMaterial`
    with a contribution built by hand.

    Kept, rather than deleted with the parse-time refusal, because the two sides
    of the binding have to agree the day the refusal is lifted: the generator
    emits `@binding(4)` and the material declares it, and a mismatch between
    them is an invalid pipeline — a dead viewport, not a missing feature. That
    agreement is worth holding down now, while both halves are fresh.
  */
  const withOrigin = (): EffectContribution => ({
    id: 'fx',
    label: 'FX',
    shader: FS,
    params: {},
    passes: [
      { name: 'first', wgsl: FS, scale: 1, reads: 'previous' },
      { name: 'second', wgsl: FS, scale: 1, reads: 'both' },
    ],
  });

  it('emits binding 4 only for the pass that reads it', () => {
    expect(composeEffectShader(withOrigin(), 0).wgsl).not.toContain('var origin');
    expect(composeEffectShader(withOrigin(), 1).wgsl)
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
    const material = pluginEffectMaterial('acme.tool', withOrigin(), 1);
    expect(material.layout.map((b) => b.binding)).toEqual([0, 1, 2, 4]);
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

  it('registers under one shader, not a chain of one', () => {
    const registered: string[] = [];
    const registry = { register: (s: { name: string }) => registered.push(s.name), has: () => false };
    registerPluginShaders(registry, 'acme.tool', [single()]);
    expect(registered).toEqual(['acme.tool.fx']);
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
