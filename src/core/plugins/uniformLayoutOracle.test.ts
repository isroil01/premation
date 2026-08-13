/**
 * An INDEPENDENT check on the generated uniform layout.
 *
 * ── Why `effectSchema.test.ts` is not enough ─────────────────────────────────
 *
 * That file asserts that `packParameters` writes where `parameterBlock` says.
 * Both come from the same function, so it is close to a tautology: it proves
 * the two halves of one implementation agree with each other, which they would
 * even if the shared assumption underneath were wrong.
 *
 * And the shared assumption WAS wrong. The first version of `parameterBlock`
 * omitted the renderer's 64-byte `mvp`/`uvRect` header, so every parameter sat
 * 64 bytes early. `effectSchema.test.ts` passed the whole time, because the
 * packer was early by exactly the same amount.
 *
 * So this file computes the layout a second time, from the EMITTED WGSL TEXT,
 * using WGSL's alignment rules written out from first principles — and compares.
 * The two derivations share nothing but the struct they disagree or agree
 * about. A wrong entry in `WGSL_SIZE`, a wrong header constant, or a member the
 * struct declares and the layout forgets all show up here as a mismatch.
 *
 * This is what stands in for a GPU. The real oracle is a device reading the
 * block and reporting what it saw; short of that, an independent derivation of
 * the same numbers is the strongest available check — and it runs everywhere,
 * which the GPU probe does not.
 */

import {
  parameterBlock,
  UNIFORM_HEADER_BYTES,
  UNIFORM_PASS_BLOCK_BYTES,
  UNIFORM_RENDERER_HEADER_BYTES,
} from './effectSchema';
import type { LayerPropSchema } from './layerKindSchema';

/**
 * WGSL's host-shareable alignment and size rules, written out rather than
 * imported. Importing the module's own table would reintroduce exactly the
 * shared assumption this file exists to break.
 *
 * From the spec's address-space layout constraints: a `vec4<f32>` aligns to 16,
 * an `f32` to 4, and a `mat3x3<f32>` is three `vec4`-aligned columns — which is
 * why it occupies 48 bytes and not 36.
 */
const RULES: Record<string, { align: number; size: number }> = {
  'f32': { align: 4, size: 4 },
  'vec2<f32>': { align: 8, size: 8 },
  'vec4<f32>': { align: 16, size: 16 },
  'mat3x3<f32>': { align: 16, size: 48 },
};

interface OracleMember { name: string; type: string; offset: number }

/**
 * Lay out a WGSL struct the way a compiler would.
 *
 * Deliberately a separate implementation: each member is advanced to its own
 * alignment, then its size is added. That is the whole rule, and writing it
 * here means the module under test cannot be wrong in a way this agrees with.
 */
function layOutStruct(wgsl: string): { members: OracleMember[]; size: number } {
  const body = /struct\s+\w+\s*\{([\s\S]*?)\}/.exec(wgsl)?.[1] ?? '';
  const members: OracleMember[] = [];
  let offset = 0;
  let maxAlign = 1;

  for (const line of body.split('\n')) {
    const m = /^\s*(\w+)\s*:\s*([\w<>0-9x]+)\s*,?\s*$/.exec(line);
    if (!m) continue;
    const [, name, type] = m;
    const rule = RULES[type!];
    if (!rule) throw new Error(`The oracle does not know the WGSL type "${type}".`);

    offset = Math.ceil(offset / rule.align) * rule.align;
    members.push({ name: name!, type: type!, offset });
    offset += rule.size;
    maxAlign = Math.max(maxAlign, rule.align);
  }

  // A struct's size rounds up to its own strictest member alignment.
  return { members, size: Math.ceil(offset / maxAlign) * maxAlign };
}

const p = (type: LayerPropSchema['type']): LayerPropSchema => ({ type, default: 0 });

/** Every shape worth laying out, including the awkward orderings. */
const CASES: Array<{ name: string; params: Record<string, LayerPropSchema> }> = [
  { name: 'no parameters at all', params: {} },
  { name: 'one scalar', params: { amount: p('number') } },
  { name: 'one colour', params: { tint: p('color') } },
  {
    name: 'a scalar declared BEFORE a colour',
    params: { amount: p('number'), tint: p('color') },
  },
  {
    name: 'several scalars around a colour',
    params: { a: p('number'), b: p('number'), tint: p('color'), c: p('number') },
  },
  {
    name: 'two colours and a boolean',
    params: { one: p('color'), two: p('color'), on: p('boolean') },
  },
  {
    name: 'an odd number of scalars, so the tail needs padding',
    params: { a: p('number'), b: p('number'), c: p('number') },
  },
  /*
    `point` is a `vec2<f32>`: 8 bytes, aligned to 8 — the only member whose
    alignment is neither 4 nor 16, and therefore the only one that can land
    mid-way through the descending sort and leave padding on BOTH sides.

    A scalar before it forces 4 bytes of pad; a colour after it forces 8. Both
    are cases the sort is supposed to prevent from mattering, and both are
    checked here against an oracle that re-derives every offset from the WGSL
    text rather than from the same code that produced it.
  */
  { name: 'one point', params: { centre: p('point') } },
  {
    name: 'a point between a colour and a scalar',
    params: { tint: p('color'), centre: p('point'), amount: p('number') },
  },
  {
    name: 'a scalar declared BEFORE a point',
    params: { amount: p('number'), centre: p('point') },
  },
  {
    name: 'two points, which pack without a gap between them',
    params: { from: p('point'), to: p('point') },
  },
  {
    name: 'a point among colours and scalars, declared worst-first',
    params: {
      a: p('number'), centre: p('point'), tint: p('color'), on: p('boolean'), b: p('number'),
    },
  },
];

describe('★ the generated struct, laid out independently', () => {
  it.each(CASES)('agrees about $name', ({ params }) => {
    const block = parameterBlock(params);
    const oracle = layOutStruct(block.wgsl);

    for (const declared of block.layout) {
      const found = oracle.members.find((m) => m.name === declared.name);
      expect({ name: declared.name, offset: found?.offset })
        .toEqual({ name: declared.name, offset: declared.offset });
    }
  });

  it.each(CASES)('agrees about the SIZE of $name', ({ params }) => {
    /*
      Size matters as much as offsets: a buffer the device thinks is smaller
      than the struct is a validation error, and one it thinks is larger wastes
      nothing but hides an off-by-one in the offsets.
    */
    const block = parameterBlock(params);
    expect(block.size).toBe(layOutStruct(block.wgsl).size);
  });

  it('★ would have caught the missing renderer header', () => {
    /*
      The regression this file was written for, stated as a test.

      The first version emitted a struct with no `mvp`/`uvRect`, so the oracle
      would have laid the first parameter out at 0 while `parameterBlock`
      reported 64 — or, in the version that shipped that bug, BOTH said 0 and
      the shader read the transform out of the plugin's parameters.

      Asserting the header is present in the emitted text, and that the layout
      starts after it, pins both halves of that.
    */
    const block = parameterBlock({ amount: p('number') });
    const oracle = layOutStruct(block.wgsl);

    expect(oracle.members.map((m) => m.name).slice(0, 2)).toEqual(['mvp', 'uvRect']);
    expect(oracle.members.find((m) => m.name === 'mvp')!.offset).toBe(0);
    expect(oracle.members.find((m) => m.name === 'uvRect')!.offset).toBe(48);
    expect(block.layout[0]!.offset).toBe(UNIFORM_HEADER_BYTES);
  });

  it('★ puts the host pass block between the header and the parameters', () => {
    /*
      The multi-pass change, pinned the same way.

      A pass needs its own texel size — a separable blur samples `uv ±
      texelSize`, and a pass at `scale: 0.25` renders into a target a quarter
      the size, so the value differs per pass and an author cannot compute it.
      The block carrying it sits at 64, and the parameters moved to 96.

      Asserted through the ORACLE, which re-derives every offset from the WGSL
      text by the spec's alignment rules, so this fails if the emitted struct
      and the offset table drift apart — the failure mode that shipped once
      already when the renderer header was missing entirely.
    */
    const block = parameterBlock({ amount: p('number') });
    const oracle = layOutStruct(block.wgsl);

    const at = (n: string) => oracle.members.find((m) => m.name === n)?.offset;
    expect(at('texelSize')).toBe(64);
    expect(at('passScale')).toBe(72);
    expect(at('passIndex')).toBe(76);
    expect(at('_reserved')).toBe(80);
    expect(block.layout[0]!.offset).toBe(96);
  });

  it('emits the pass block for a SINGLE-pass effect too', () => {
    /*
      One layout, not two.

      A struct that carried the block only for chained effects would make every
      parameter offset depend on a condition — and the CPU packer and the shader
      generator would each have to evaluate that condition and agree. Two
      derivations of one number is exactly the shape of the bug that made the
      64-byte header necessary in the first place.
    */
    const block = parameterBlock({ amount: p('number') });
    expect(block.wgsl).toContain('texelSize : vec2<f32>');
    expect(block.layout[0]!.offset).toBe(96);
  });

  it('confirms the header constant against the rules, not against itself', () => {
    // Derived here rather than read from the module, so a changed constant
    // fails rather than propagates: 48 for the padded mat3, 16 for the vec4,
    // then the host block — vec2 + f32 + f32 packs into 16, and the reserved
    // vec4 is another 16.
    const renderer = RULES['mat3x3<f32>']!.size + RULES['vec4<f32>']!.size;
    const passBlock = RULES['vec2<f32>']!.size + RULES['f32']!.size * 2 + RULES['vec4<f32>']!.size;
    expect(UNIFORM_RENDERER_HEADER_BYTES).toBe(renderer);
    expect(UNIFORM_PASS_BLOCK_BYTES).toBe(passBlock);
    expect(UNIFORM_HEADER_BYTES).toBe(renderer + passBlock);
    // A multiple of 16, or the first `vec4` parameter after it is misaligned.
    expect(UNIFORM_HEADER_BYTES % 16).toBe(0);
  });

  it('★ leaves no member overlapping another', () => {
    /*
      The property an offset table can violate without any single offset looking
      wrong. Two members sharing bytes is silent: the shader reads one and gets
      the other, which is a wrong value rather than an error.
    */
    for (const { params } of CASES) {
      const oracle = layOutStruct(parameterBlock(params).wgsl);
      const sorted = [...oracle.members].sort((a, b) => a.offset - b.offset);

      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const end = prev.offset + RULES[prev.type]!.size;
        expect({ member: sorted[i]!.name, startsAtOrAfter: sorted[i]!.offset >= end })
          .toEqual({ member: sorted[i]!.name, startsAtOrAfter: true });
      }
    }
  });

  it('refuses to pass silently on a type it does not understand', () => {
    // The oracle is only worth something while it knows every type the
    // generator can emit. A new one must break this file, not slip through it.
    expect(() => layOutStruct('struct Object { x : mat2x2<f32>, };')).toThrow(/does not know/);
  });
});
