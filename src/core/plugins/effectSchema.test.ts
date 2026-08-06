/**
 * Effect contributions, and the uniform block generated for them.
 *
 * The parameter-block tests are the ones that earn their place. Every other
 * failure in this file is loud — a bad manifest is refused, a bad shader is
 * refused. A misaligned uniform member is **silent**: it compiles, it runs, and
 * the shader reads the wrong bytes, so the effect renders wrong colours and the
 * author concludes their maths is broken. That is the defect this file exists
 * to make impossible, and it is why the CPU-side packing walks the same layout
 * the WGSL struct was generated from rather than recomputing it.
 */

import {
  parseEffects,
  parameterBlock,
  packParameters,
  composeEffectShader,
  MAX_EFFECTS_PER_PLUGIN,
  MAX_PARAMS_PER_EFFECT,
  type EffectContribution,
} from './effectSchema';

const SHADER = `
@fragment
fn fs_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(src, samp, uv) * params.amount;
}`;

const effect = (over: Record<string, unknown> = {}) => ({
  id: 'tint',
  label: 'Tint',
  shader: SHADER,
  params: { amount: { type: 'number', default: 1, min: 0, max: 2, animatable: true } },
  ...over,
});

const parse = (entries: unknown[]) => {
  const errors: string[] = [];
  const out = parseEffects(entries, errors);
  return { out, errors };
};

describe('declaring an effect', () => {
  it('accepts a plain one', () => {
    const { out, errors } = parse([effect()]);
    expect(errors).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]!.params.amount).toMatchObject({ type: 'number', animatable: true });
  });

  it('refuses a duplicate id', () => {
    const { errors } = parse([effect(), effect()]);
    expect(errors.join()).toMatch(/duplicates an earlier effect/);
  });

  it('refuses more effects than the cap', () => {
    const many = Array.from({ length: MAX_EFFECTS_PER_PLUGIN + 1 }, (_, i) =>
      effect({ id: `e${i}` }));
    expect(parse(many).errors.join()).toMatch(/the limit is/);
  });

  it('refuses more parameters than the cap', () => {
    const params: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_PARAMS_PER_EFFECT; i++) {
      params[`p${i}`] = { type: 'number', default: 0 };
    }
    expect(parse([effect({ params })]).errors.join()).toMatch(/the limit is/);
  });

  it('★ reports EVERY shader problem, not just the first', () => {
    /*
      A round trip here means repackaging, re-signing and reinstalling. A
      compiler that stopped at the first error would make fixing a shader a
      sequence of those.
    */
    const bad = '@fragment fn f() { while (a) { discard; } }';
    const { errors } = parse([effect({ shader: bad })]);

    expect(errors.join()).toMatch(/while/i);
    expect(errors.join()).toMatch(/discard/i);
  });

  it('drops a bad effect WHOLE rather than half-registering it', () => {
    // Half a parameter list renders half an inspector, and the author debugs a
    // missing row instead of reading an error.
    const { out, errors } = parse([
      effect({ params: { good: { type: 'number', default: 0 }, bad: { type: 'nonsense' } } }),
    ]);
    expect(out).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('parameter types', () => {
  it.each(['number', 'color', 'boolean'])('accepts %s', (type) => {
    const defaults: Record<string, unknown> = { number: 1, color: '#ff0000', boolean: true };
    const { errors } = parse([
      effect({ params: { p: { type, default: defaults[type] } } }),
    ]);
    expect(errors).toEqual([]);
  });

  it.each(['string', 'enum', 'asset'])('★ refuses %s, and says why', (type) => {
    /*
      Refused here rather than discovered from a black frame. None of these has
      a representation in a shader parameter block: a string has no bytes, an
      asset is a reference, and an enum would need an index mapping the author
      has to carry in their head and keep in step with the schema.
    */
    const extra = type === 'enum' ? { values: ['a', 'b'], default: 'a' }
      : type === 'asset' ? {}
        : { default: 'x' };
    const { errors } = parse([effect({ params: { p: { type, ...extra } } })]);

    expect(errors.join()).toMatch(/no representation in a shader parameter block|animatable|must be one of/);
  });

  it('lets a number parameter be animatable', () => {
    // The point of reusing the layer-kind prop schema: this becomes an ordinary
    // keyframe track with no new machinery in the animation engine.
    const { out } = parse([effect()]);
    expect(out[0]!.params.amount!.animatable).toBe(true);
  });
});

describe('★ the generated parameter block', () => {
  it('puts vec4 members FIRST, whatever order they were declared in', () => {
    /*
      The silent-corruption test.

      WGSL requires a vec4 at a 16-byte boundary. Emitting in declaration order
      would leave a 12-byte hole after a leading scalar that the struct does not
      describe — so every member after it reads shifted bytes. That compiles,
      runs, and renders wrong colours, which is the worst possible failure here
      because it looks like the author's maths.
    */
    const block = parameterBlock({
      amount: { type: 'number', default: 0 },
      tint: { type: 'color', default: '#ffffff' },
      enabled: { type: 'boolean', default: true },
    });

    expect(block.layout[0]!.name).toBe('tint');
    expect(block.layout[0]!.offset).toBe(0);
    // And every member sits on its own required alignment.
    for (const m of block.layout) {
      const align = m.type === 'color' ? 16 : 4;
      expect(m.offset % align).toBe(0);
    }
  });

  it('is stable across runs for the same effect', () => {
    // An unstable order changes the shader's content hash, which recompiles an
    // unchanged effect on every load.
    const params = {
      b: { type: 'number' as const, default: 0 },
      a: { type: 'number' as const, default: 0 },
      z: { type: 'color' as const, default: '#000' },
    };
    expect(parameterBlock(params).wgsl).toBe(parameterBlock(params).wgsl);
    expect(parameterBlock(params).layout.map((m) => m.name)).toEqual(['z', 'a', 'b']);
  });

  it('rounds the block up to a multiple of 16', () => {
    // A uniform buffer's size must be. One scalar is 4 bytes and would be
    // refused by the device.
    const block = parameterBlock({ amount: { type: 'number', default: 0 } });
    expect(block.size % 16).toBe(0);
  });

  it('★ emits a legal struct for an effect with NO parameters', () => {
    /*
      An empty struct is not legal WGSL, and a fixed colour grade with no knobs
      is a perfectly reasonable effect. Without the padding member the author
      gets a compile error about a struct they never wrote.
    */
    const block = parameterBlock({});
    expect(block.wgsl).toMatch(/struct PluginParams \{[\s\S]*\}/);
    expect(block.wgsl).not.toMatch(/\{\s*\}/);
    expect(block.size).toBe(16);
  });
});

describe('★ packing values', () => {
  const params = {
    amount: { type: 'number' as const, default: 0 },
    tint: { type: 'color' as const, default: '#000' },
    enabled: { type: 'boolean' as const, default: false },
  };

  it('writes each value at the offset the struct declares', () => {
    // Packing walks the SAME layout the struct was generated from, so the two
    // cannot disagree about where anything sits. That is the whole reason
    // `parameterBlock` returns the layout rather than it being recomputed.
    const block = parameterBlock(params);
    const buffer = packParameters(block.layout, block.size, {
      amount: 0.5,
      tint: [1, 0, 0, 1],
      enabled: true,
    });
    const view = new DataView(buffer);

    const at = (name: string) => block.layout.find((m) => m.name === name)!.offset;
    expect(view.getFloat32(at('amount'), true)).toBeCloseTo(0.5);
    expect(view.getFloat32(at('tint'), true)).toBeCloseTo(1);
    expect(view.getFloat32(at('enabled'), true)).toBe(1);
  });

  it('★ writes colour as 0..1, not 0..255', () => {
    /*
      This codebase has had the mirror of this bug: colour readers that assumed
      0..255 against tracks that are 0..1. Getting it wrong here produces an
      effect that is either invisible or fully saturated, with nothing to
      explain why.
    */
    const block = parameterBlock({ tint: { type: 'color', default: '#000' } });
    const buffer = packParameters(block.layout, block.size, { tint: '#ff8000' });
    const view = new DataView(buffer);

    expect(view.getFloat32(0, true)).toBeCloseTo(1);
    expect(view.getFloat32(4, true)).toBeCloseTo(128 / 255, 2);
    expect(view.getFloat32(8, true)).toBeCloseTo(0);
    expect(view.getFloat32(12, true)).toBeCloseTo(1);
  });

  it('writes a boolean as 0.0 / 1.0', () => {
    // WGSL booleans are not host-shareable, so a `bool` in a uniform block is a
    // compile error the author never wrote.
    const block = parameterBlock({ enabled: { type: 'boolean', default: false } });
    const off = packParameters(block.layout, block.size, { enabled: false });
    expect(new DataView(off).getFloat32(0, true)).toBe(0);
  });

  it('substitutes zero for a missing or non-finite value rather than NaN', () => {
    // NaN in a uniform propagates through the whole shader and produces a
    // transparent or black frame with no error anywhere.
    const block = parameterBlock(params);
    const buffer = packParameters(block.layout, block.size, { amount: Number.NaN });
    const at = block.layout.find((m) => m.name === 'amount')!.offset;
    expect(new DataView(buffer).getFloat32(at, true)).toBe(0);
  });

  it('clamps colour channels into range', () => {
    const block = parameterBlock({ tint: { type: 'color', default: '#000' } });
    const buffer = packParameters(block.layout, block.size, { tint: [2, -1, 0.5, 1] });
    const view = new DataView(buffer);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(0);
  });
});

describe('composing the final shader', () => {
  it('prepends the bindings the author is forbidden from writing', () => {
    const composed = composeEffectShader(parse([effect()]).out[0] as EffectContribution);

    expect(composed.wgsl).toMatch(/@group\(0\) @binding\(0\) var<uniform> params/);
    expect(composed.wgsl).toMatch(/@group\(0\) @binding\(1\) var src/);
    expect(composed.wgsl).toMatch(/@group\(0\) @binding\(2\) var samp/);
  });

  it("keeps the author's source last, so their entry point is intact", () => {
    const composed = composeEffectShader(parse([effect()]).out[0] as EffectContribution);
    expect(composed.wgsl.endsWith(SHADER)).toBe(true);
  });
});
