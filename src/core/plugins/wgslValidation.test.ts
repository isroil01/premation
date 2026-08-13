/**
 * The WGSL gate.
 *
 * Two things are asserted, and as with the package scanner the second matters
 * more than the first:
 *
 *  1. That the unbounded shapes are refused.
 *  2. **That a real effect passes.** A gate that refuses ordinary shaders is a
 *     render path nobody can ship to — and unlike the package scanner, where a
 *     false positive costs a publisher a wait, a false positive here means the
 *     effect cannot exist at all.
 *
 * The distinction from `plugin-scan.ts` is worth keeping in mind while reading:
 * that one reasons about intent and is therefore advisory. This one refuses
 * SYNTAX. A loop whose bound is not a literal has no bounded cost regardless of
 * who wrote it or why, so refusing it is a decision, not a guess.
 */

import {
  validateWgsl,
  literalLoopBound,
  MAX_LOOP_ITERATIONS,
  MAX_SOURCE_BYTES,
  MAX_STATEMENTS,
  MAX_LOOP_NESTING,
} from './wgslValidation';

const rules = (src: string) => validateWgsl(src).problems.map((p) => p.rule).sort();

/** A plausible effect: a small separable blur with a colour tint. */
const REAL_EFFECT = /* wgsl */ `
// The host prepends the parameter block, the input texture and the sampler.
// An author writes only their entry point and reads params.<name>, src, samp.

@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var sum : vec4<f32> = vec4<f32>(0.0);
  var weight : f32 = 0.0;
  // A fixed 9-tap kernel — the shape most real effects have.
  for (var i : i32 = -4; i < 5; i = i + 1) {
    let offset = vec2<f32>(f32(i) * params.radius * 0.001, 0.0);
    sum = sum + textureSample(src, samp, uv + offset);
    weight = weight + 1.0;
  }
  let blurred = sum / weight;
  return blurred * params.tint;
}
`;

describe('a real effect', () => {
  it('★ passes', () => {
    /*
      The load-bearing assertion. Every rule below is one regex away from
      refusing ordinary shaders, and a gate that does that is a render path with
      no plugins on it.
    */
    const result = validateWgsl(REAL_EFFECT);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is not penalised for being documented', () => {
    // Comments are stripped before the statement count, so an author who
    // explains their shader is not closer to the ceiling than one who does not.
    const documented = REAL_EFFECT.replace(
      '@fragment',
      `// ${'a very long explanatory comment. '.repeat(200)}\n@fragment`,
    );
    expect(validateWgsl(documented).ok).toBe(true);
  });

  it('is not tripped by a forbidden word inside a comment', () => {
    // `// we deliberately avoid discard here` must not read as a `discard`.
    const src = REAL_EFFECT.replace('@fragment', '// no discard, no while loops here\n@fragment');
    expect(rules(src)).toEqual([]);
  });
});

describe('unbounded cost', () => {
  it('★ refuses a loop whose bound is not literal', () => {
    /*
      The rule that matters most. `i < params.count` is a loop the USER controls
      by dragging a slider whose range the plugin declared — so the plugin
      chooses how long the GPU spends, per pixel, and a GPU cannot be
      interrupted once it starts.
    */
    const src = REAL_EFFECT.replace('i < 5', 'i < params.count');
    expect(rules(src)).toContain('dynamic-loop-bound');
  });

  it('refuses a literal bound that is too large', () => {
    const src = REAL_EFFECT.replace('i < 5', `i < ${MAX_LOOP_ITERATIONS + 1}`);
    expect(rules(src)).toContain('loop-too-long');
  });

  it('accepts a literal bound at the limit', () => {
    // The boundary, asserted in the permissive direction too — an off-by-one
    // here silently costs authors a whole class of kernel.
    const src = REAL_EFFECT.replace('i < 5', `i < ${MAX_LOOP_ITERATIONS}`);
    expect(rules(src)).not.toContain('loop-too-long');
  });

  it('refuses while', () => {
    // No syntactic bound at all. "It exits eventually" is a claim only the
    // author can make and only the GPU can disprove.
    expect(rules('@fragment fn f() { while (x < y) { a = a + 1; } }')).toContain('while-loop');
  });

  it('refuses a bare loop block', () => {
    expect(rules('@fragment fn f() { loop { a = a + 1; } }')).toContain('loop-statement');
  });

  it('★ refuses loops nested past the limit', () => {
    // Bounds MULTIPLY. Three nested loops at the per-loop maximum is already
    // 16 million iterations per pixel.
    const body = 'x = x + 1.0;';
    let src = body;
    for (let i = 0; i < MAX_LOOP_NESTING + 1; i++) {
      src = `for (var i${i} : i32 = 0; i${i} < 8; i${i} = i${i} + 1) {\n${src}\n}`;
    }
    expect(rules(`@fragment fn f() {\n${src}\n}`)).toContain('loops-too-deep');
  });

  it('allows nesting up to the limit', () => {
    let src = 'x = x + 1.0;';
    for (let i = 0; i < MAX_LOOP_NESTING; i++) {
      src = `for (var i${i} : i32 = 0; i${i} < 8; i${i} = i${i} + 1) {\n${src}\n}`;
    }
    expect(rules(`@fragment fn f() {\n${src}\n}`)).not.toContain('loops-too-deep');
  });

  it('★ counts sibling loops as depth ONE, not two', () => {
    /*
      Two loops one after another cost the SUM of their bounds; two nested loops
      cost the PRODUCT. A depth tracker that never popped would conflate them
      and refuse the shape every blur in existence uses — a horizontal pass
      followed by a vertical one.
    */
    const src = `
@fragment
fn f() {
  for (var i : i32 = 0; i < 8; i = i + 1) { x = x + 1.0; }
  for (var j : i32 = 0; j < 8; j = j + 1) { y = y + 1.0; }
  for (var k : i32 = 0; k < 8; k = k + 1) { z = z + 1.0; }
  for (var l : i32 = 0; l < 8; l = l + 1) { w = w + 1.0; }
}`;
    expect(rules(src)).not.toContain('loops-too-deep');
  });
});

describe('constructs an effect may not use', () => {
  it.each([
    ['var<storage, read_write> buf : array<f32>;', 'storage-binding'],
    ['var counter : atomic<u32>;', 'atomic'],
    ['@compute @workgroup_size(8) fn c() {}', 'compute-shader'],
    ['@fragment fn f() { discard; }', 'discard'],
  ])('refuses %s', (snippet, rule) => {
    expect(rules(`@fragment fn f() {}\n${snippet}`)).toContain(rule);
  });

  it('explains discard in terms of what the user would see', () => {
    // A refusal an author cannot act on is a refusal they work around badly.
    const problem = validateWgsl('@fragment fn f() { discard; }').problems
      .find((p) => p.rule === 'discard');
    expect(problem?.detail).toMatch(/alpha = 0/);
  });
});

describe('size and shape', () => {
  it('refuses an oversized source without scanning it', () => {
    // The bound exists to cap work, so it must be the FIRST thing that answers.
    const huge = `@fragment fn f() {}\n${'// x\n'.repeat(MAX_SOURCE_BYTES)}`;
    const result = validateWgsl(huge);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.rule).toBe('too-large');
  });

  it('measures BYTES, not characters', () => {
    /*
      A source of astral-plane characters is four bytes each. Counting
      characters would let a shader four times the limit through the one check
      whose entire job is to bound how much there is to read.
    */
    const emoji = '🙂';
    const src = `@fragment fn f() {}\n// ${emoji.repeat(MAX_SOURCE_BYTES / 4)}`;
    expect(src.length).toBeLessThan(MAX_SOURCE_BYTES);
    expect(rules(src)).toContain('too-large');
  });

  it('refuses a shader with too many statements', () => {
    const src = `@fragment fn f() {\n${'x = x + 1.0;\n'.repeat(MAX_STATEMENTS + 1)}}`;
    expect(rules(src)).toContain('too-complex');
  });

  it('refuses a shader with no fragment entry point', () => {
    // Not a cost rule. Without it the compile fails with a driver message the
    // author cannot map back to anything they wrote.
    expect(rules('fn helper() -> f32 { return 1.0; }')).toContain('no-fragment-entry');
  });

  it('refuses empty source', () => {
    expect(validateWgsl('   ').ok).toBe(false);
  });
});

describe('reading a loop bound', () => {
  it.each([
    ['var i = 0; i < 16; i++', 16],
    ['var i = 0; i <= 8; i++', 8],
    ['var i : i32 = 0; i < 32i; i = i + 1', 32],
    ['var i : u32 = 0u; i < 4u; i = i + 1u', 4],
  ])('reads %s as %i', (header, expected) => {
    expect(literalLoopBound(header)).toBe(expected);
  });

  it.each([
    'var i = 0; i < n; i++',
    'var i = 0; i < params.count; i++',
    'var i = 0; i < COUNT; i++',
    'var i = 0; i < n * 2; i++',
    'nonsense',
  ])('★ returns null rather than guessing at %s', (header) => {
    /*
      Null means REFUSED. A cleverer reader that evaluated expressions would be
      guessing about the one number that decides whether the GPU survives — and
      it would be guessing from source the author controls precisely.
    */
    expect(literalLoopBound(header)).toBeNull();
  });
});

describe('the entry-point contract', () => {
  it('★ requires the fragment entry to be called fs', () => {
    /*
      That is the name the render pipeline looks for
      (`entryPoint: desc.fragmentEntry ?? 'fs'`) and what every built-in shader
      in this renderer uses. A differently-named entry compiles fine and then
      fails to bind, with a driver error naming nothing the author wrote.
    */
    const src = REAL_EFFECT.replace('fn fs(', 'fn main(');
    expect(rules(src)).toContain('fragment-entry-name');
  });

  it('★ refuses an author-written vertex shader', () => {
    /*
      The host generates it — the same full-screen quad transform for every
      effect. An author's own would collide with it, and writing one means
      knowing about `mvp` and `uvRect`, which is exactly the knowledge the
      generated parameter block exists to spare them.
    */
    const src = `@vertex fn vs() {}\n${REAL_EFFECT}`;
    expect(rules(src)).toContain('author-vertex');
  });

  it('says what to rename it to', () => {
    const problem = validateWgsl(REAL_EFFECT.replace('fn fs(', 'fn main('))
      .problems.find((p) => p.rule === 'fragment-entry-name');
    expect(problem?.detail).toMatch(/`fs`/);
  });
});
