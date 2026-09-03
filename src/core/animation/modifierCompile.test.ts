/**
 * Compiled stacks, PARSED AND EVALUATED by the real engine.
 *
 * Asserting on the compiled string alone would be the cheap version of this
 * test and would prove almost nothing: the string is only worth anything if the
 * interpreter in `exprLang.ts` accepts it and produces the number the rows
 * describe. So almost every case here goes through
 * `defaultAnimation.setExpression` + `sample` — the same two calls the editor
 * makes — and checks a VALUE. Where the text is asserted as well it is because
 * the text is the user-facing artefact (they can open it, read it, and take it
 * over), not as a proxy for behaviour.
 *
 * `AnimationEngine` is instantiated directly rather than reaching for the
 * singleton: these are claims about compilation, and a shared engine would make
 * them depend on whatever another suite left behind.
 */

import { AnimationEngine } from '@motion/animation';
import {
  compileModifier,
  compileModifierStack,
  modifierCompileError,
  modifierWarning,
  substituteValue,
  num,
} from './modifierCompile';
import { defaultModifier, type Modifier } from './modifierStack';

/** A modifier of `kind` with `params` overridden — `enabled`, fresh id. */
function mod<K extends Modifier['kind']>(kind: K, params: Record<string, unknown> = {}): Modifier {
  return { ...defaultModifier(kind), ...params } as Modifier;
}

/**
 * An engine with `x` keyframed 0 → 100 over 0..2s, so x@1s = 50.
 *
 * LINEAR is stated rather than left to the default: every expectation below
 * that names a number off this ramp (25 at 0.5s, 37.5 at 0.75s) is only true
 * for a straight segment, and a later change to the engine's default easing
 * would otherwise turn these into silently wrong assertions.
 */
function engine(): AnimationEngine {
  const a = new AnimationEngine();
  a.setKeyframe('n1', 'x', 0, 0, 'linear');
  a.setKeyframe('n1', 'x', 2, 100, 'linear');
  return a;
}

/** Attach a stack's compiled text and sample it. */
function run(a: AnimationEngine, modifiers: Modifier[], t: number): number | undefined {
  const src = compileModifierStack(modifiers);
  a.setExpression('n1', 'x', src);
  expect(a.getExpressionError('n1', 'x')).toBeNull();
  return a.sample('n1', 'x', t);
}

describe('the empty stack', () => {
  test('compiles to the identity, not to nothing', () => {
    // Not '': `setExpression('')` REMOVES the expression, which would delete
    // the very thing the stack record claims to own.
    expect(compileModifierStack([])).toBe('value');
    const a = engine();
    expect(run(a, [], 1)).toBeCloseTo(50);
  });

  test('a stack of only disabled rows is also the identity', () => {
    const a = engine();
    const rows = [mod('offset', { amount: 10, enabled: false }), mod('multiply', { factor: 4, enabled: false })];
    expect(compileModifierStack(rows)).toBe('value');
    expect(run(a, rows, 1)).toBeCloseTo(50);
  });
});

describe('ORDER MATTERS — offset then multiply', () => {
  const offset = mod('offset', { amount: 10 });
  const multiply = mod('multiply', { factor: 2 });

  test('offset → multiply nests the multiply outside', () => {
    expect(compileModifierStack([offset, multiply])).toBe('((value + 10) * 2)');
    // x@1s = 50 → (50 + 10) * 2 = 120
    expect(run(engine(), [offset, multiply], 1)).toBeCloseTo(120);
  });

  test('multiply → offset is a DIFFERENT number, not just different text', () => {
    expect(compileModifierStack([multiply, offset])).toBe('((value * 2) + 10)');
    // 50 * 2 + 10 = 110. The two orders differ by 10 — the point of the stack.
    expect(run(engine(), [multiply, offset], 1)).toBeCloseTo(110);
  });

  test('disabling the middle row drops it from the chain', () => {
    const rows = [offset, { ...multiply, enabled: false }, mod('offset', { amount: 5 })];
    expect(compileModifierStack(rows)).toBe('((value + 10) + 5)');
    expect(run(engine(), rows, 1)).toBeCloseTo(65);
  });
});

describe('clamp', () => {
  test('holds the running value between the limits at both ends', () => {
    const a = engine();
    const rows = [mod('multiply', { factor: 10 }), mod('clamp', { min: 0, max: 120 })];
    expect(compileModifierStack(rows)).toBe('clamp((value * 10), 0, 120)');
    // 50 * 10 = 500 → clamped to 120.
    expect(run(a, rows, 1)).toBeCloseTo(120);
    // At t = 0 the base is 0 → 0 * 10 = 0, inside the range, untouched.
    expect(run(a, rows, 0)).toBeCloseTo(0);
  });

  test('clamps the RUNNING value, so a later offset can leave the range again', () => {
    const rows = [mod('clamp', { min: 0, max: 20 }), mod('offset', { amount: 100 })];
    expect(run(engine(), rows, 1)).toBeCloseTo(120);
  });
});

describe('delay', () => {
  test('reads the base value from earlier in time', () => {
    const a = engine();
    const rows = [mod('delay', { seconds: 0.5 })];
    expect(compileModifierStack(rows)).toBe('valueAtTime(time - 0.5)');
    // At t = 1 the delayed read is the base at 0.5s = 25.
    expect(run(a, rows, 1)).toBeCloseTo(25);
  });

  test('mid-stack it shifts the CHAIN, via the base-relative delta form', () => {
    const a = engine();
    const rows = [mod('offset', { amount: 1000 }), mod('delay', { seconds: 0.5 })];
    // The running value cannot be handed to `valueAtTime`, so the delay
    // contributes its own displacement: (value + 1000) + (25 - 50) = 1025.
    expect(compileModifierStack(rows)).toBe('((value + 1000) + (valueAtTime(time - 0.5) - value))');
    expect(run(a, rows, 1)).toBeCloseTo(1025);
  });
});

describe('loop', () => {
  test('cycle repeats the keyframed span past the last key', () => {
    const a = engine();
    const rows = [mod('loop', { mode: 'cycle' })];
    expect(compileModifierStack(rows)).toBe("loopOut('cycle')");
    // The span is 0..2s. At t = 3 a cycle is back at the 1s value, 50.
    expect(run(a, rows, 3)).toBeCloseTo(50);
    // Inside the span the loop is inert.
    expect(run(a, rows, 1)).toBeCloseTo(50);
  });

  test('pingpong reverses instead of jumping', () => {
    const a = engine();
    const rows = [mod('loop', { mode: 'pingpong' })];
    expect(compileModifierStack(rows)).toBe("loopOut('pingpong')");
    // At t = 3 the ping-pong is 1s back INTO the span: base at 1s = 50 either
    // way, so check t = 3.5 where the two modes differ (cycle → 75, pp → 25).
    expect(run(a, rows, 3.5)).toBeCloseTo(25);
  });

  test('offset mode stacks the span’s travel on each repeat', () => {
    const a = engine();
    expect(run(a, [mod('loop', { mode: 'offset' })], 3)).toBeCloseTo(150);
  });
});

describe('wiggle', () => {
  test('is DETERMINISTIC — the same stack samples the same twice', () => {
    const a = engine();
    const rows = [mod('wiggle', { freq: 2, amp: 30 })];
    const first = run(a, rows, 1);
    const second = run(a, rows, 1);
    expect(first).toBe(second);
    // And on a freshly built engine, which is what "identical on every run"
    // means for a render: no hidden per-session state.
    expect(run(engine(), rows, 1)).toBe(first);
  });

  test('displaces the base rather than replacing it', () => {
    const a = engine();
    const v = run(a, [mod('wiggle', { freq: 2, amp: 30 })], 1)!;
    expect(v).not.toBeCloseTo(50, 6);
    expect(Math.abs(v - 50)).toBeLessThanOrEqual(30 + 1e-9);
  });

  test('the seed is a phase offset, and it CHANGES the motion', () => {
    const a = engine();
    const plain = run(a, [mod('wiggle', { freq: 2, amp: 30, seed: 0 })], 1);
    const seeded = run(a, [mod('wiggle', { freq: 2, amp: 30, seed: 13 })], 1);
    expect(compileModifierStack([mod('wiggle', { freq: 2, amp: 30, seed: 13 })]))
      .toBe('wiggle(2, 30, 1, 0.5, time + 13)');
    expect(seeded).not.toBe(plain);
  });

  test('mid-stack it wiggles AROUND the running value', () => {
    const a = engine();
    const rows = [mod('offset', { amount: 1000 }), mod('wiggle', { freq: 2, amp: 30 })];
    expect(compileModifierStack(rows)).toBe('((value + 1000) + (wiggle(2, 30) - value))');
    const v = run(a, rows, 1)!;
    // Centred on 1050, not on 50 — the failure the delta form exists to stop.
    expect(Math.abs(v - 1050)).toBeLessThanOrEqual(30 + 1e-9);
  });

  test('octaves are emitted only when they are not 1', () => {
    expect(compileModifierStack([mod('wiggle', { freq: 2, amp: 30, octaves: 1 })])).toBe('wiggle(2, 30)');
    expect(compileModifierStack([mod('wiggle', { freq: 2, amp: 30, octaves: 3 })])).toBe('wiggle(2, 30, 3)');
  });
});

describe('smooth', () => {
  test('averages the value with its own past and future', () => {
    const a = engine();
    const rows = [mod('smooth', { windowSec: 0.25 })];
    expect(compileModifierStack(rows))
      .toBe('((valueAtTime(time - 0.25) + value + valueAtTime(time + 0.25)) / 3)');
    // The ramp is linear, so the three-tap average of a linear function is the
    // function itself — the honest check that it is an average and not a shift.
    expect(run(a, rows, 1)).toBeCloseTo(50);
  });

  test('flattens a step the raw track holds', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0, 'hold');
    a.setKeyframe('n1', 'x', 1, 90, 'hold');
    a.setKeyframe('n1', 'x', 2, 90, 'hold');
    const raw = a.sample('n1', 'x', 1);
    const smoothed = run(a, [mod('smooth', { windowSec: 0.25 })], 1);
    expect(raw).toBeCloseTo(90);
    // Past sample is 0, present and future are 90 → 60.
    expect(smoothed).toBeCloseTo(60);
  });
});

describe('overshoot (spring)', () => {
  test('is inert before the last keyframe and rings after it', () => {
    const a = engine();
    const rows = [mod('spring', { frequency: 3, decay: 6 })];
    // Before/at the last key the property is untouched — the ternary's first
    // branch. This is what keeps the stack from disturbing the keyframed part.
    expect(run(a, rows, 1)).toBeCloseTo(50);
    expect(run(a, rows, 2)).toBeCloseTo(100);
    // Just after, the arrival velocity (50/s over 0..2s) drives an excursion.
    const after = run(a, rows, 2.05)!;
    expect(after).toBeGreaterThan(100);
  });

  test('decays: each later sample of the first lobe is smaller in envelope', () => {
    const a = engine();
    const fast = run(a, [mod('spring', { frequency: 3, decay: 20 })], 2.08)!;
    const slow = run(a, [mod('spring', { frequency: 3, decay: 1 })], 2.08)!;
    // Same drive, same phase, more damping ⇒ less excursion.
    expect(Math.abs(fast - 100)).toBeLessThan(Math.abs(slow - 100));
  });

  test('the compiled text is the closed form, not a numeric integration', () => {
    const src = compileModifierStack([mod('spring', { frequency: 3, decay: 6 })]);
    expect(src).toContain('velocityAtTime(key(numKeys).time - 0.001)');
    expect(src).toContain('Math.exp(');
    expect(src).toContain('Math.sin(');
  });
});

describe('audio', () => {
  test('remaps the broadband level into the row’s range and ADDS it', () => {
    const a = engine();
    a.setAudioLevelProvider(() => 1);
    const rows = [mod('audio', { min: 0, max: 40 })];
    expect(compileModifierStack(rows)).toBe('(value + linear(clamp(audio, 0, 1), 0, 1, 0, 40))');
    expect(run(a, rows, 1)).toBeCloseTo(90);
    a.setAudioLevelProvider(() => 0);
    expect(run(a, rows, 1)).toBeCloseTo(50);
  });

  test('a band is NOT expressible, and the row says so', () => {
    expect(modifierWarning(mod('audio', { band: 'full' }))).toBeNull();
    expect(modifierWarning(mod('audio', { band: 'low' }))).toMatch(/broadband/);
    // It still compiles — as the broadband form, which is what it will do.
    expect(compileModifierStack([mod('audio', { band: 'low', min: 0, max: 40 })]))
      .toBe('(value + linear(clamp(audio, 0, 1), 0, 1, 0, 40))');
  });
});

describe('oscillate', () => {
  test('adds a sine of the given frequency and amplitude', () => {
    const a = engine();
    // Read the base BEFORE attaching anything — after `run` the same call would
    // return the expression's own output.
    const base = a.sample('n1', 'x', 0.25)!;
    expect(base).toBeCloseTo(12.5);
    // A quarter period of a 1 Hz sine is 0.25s, where sin = 1.
    expect(run(a, [mod('oscillate', { freq: 1, amp: 20, phase: 0 })], 0.25))
      .toBeCloseTo(base + 20, 3);
  });

  test('phase is omitted from the text when it is zero', () => {
    expect(compileModifierStack([mod('oscillate', { freq: 1, amp: 20, phase: 0 })]))
      .toBe('(value + Math.sin(time * 6.283185) * 20)');
    expect(compileModifierStack([mod('oscillate', { freq: 1, amp: 20, phase: 1.5 })]))
      .toBe('(value + Math.sin(time * 6.283185 + 1.5) * 20)');
  });
});

describe('the raw expression row', () => {
  test('`value` inside the fragment means the RUNNING value', () => {
    const a = engine();
    const rows = [mod('offset', { amount: 10 }), mod('expression', { src: 'value * 2' })];
    expect(compileModifierStack(rows)).toBe('((value + 10) * 2)');
    expect(run(a, rows, 1)).toBeCloseTo(120);
  });

  test('the substituted running value carries its own brackets', () => {
    // PRECEDENCE. Every kind emits an atom — a call, or a parenthesised
    // expression — so dropping it into `value * 2` cannot re-associate. The
    // check is on a fragment where a bare `value + 10` WOULD bind wrongly.
    const rows = [mod('offset', { amount: 10 }), mod('expression', { src: 'value * value' })];
    expect(compileModifierStack(rows)).toBe('((value + 10) * (value + 10))');
    // 60 * 60 = 3600, not 50 + 10 * 50 + 10.
    expect(run(engine(), rows, 1)).toBeCloseTo(3600);
  });

  test('a fragment that never says `value` REPLACES the chain, as written', () => {
    const a = engine();
    const rows = [mod('offset', { amount: 10 }), mod('expression', { src: 'time * 90' })];
    expect(run(a, rows, 1)).toBeCloseTo(90);
  });

  test('substitution is token-level: strings and member chains are untouched', () => {
    // A regex over the raw text would corrupt both of these.
    expect(substituteValue("layer('value', 'x')", 'V')).toBe("layer('value', 'x')");
    expect(substituteValue('thisProperty.value + value', 'V')).toBe('thisProperty.value + V');
    // Whitespace and punctuation survive re-joining exactly.
    expect(substituteValue('value  +   1', 'V')).toBe('V  +   1');
  });

  test('a broken fragment surfaces as a compile error instead of silence', () => {
    const rows = [mod('expression', { src: 'value + (' })];
    expect(modifierCompileError(rows)).not.toBeNull();
    // And every built-in kind, in every order, compiles clean.
    expect(modifierCompileError([
      mod('offset'), mod('multiply'), mod('clamp'), mod('wiggle'), mod('oscillate'),
      mod('spring'), mod('smooth'), mod('delay'), mod('loop'), mod('audio'),
    ])).toBeNull();
  });

  test('an empty fragment is a pass-through, not a syntax error', () => {
    expect(compileModifierStack([mod('offset', { amount: 3 }), mod('expression', { src: '  ' })]))
      .toBe('(value + 3)');
  });
});

describe('number formatting', () => {
  test('negatives are parenthesised and floats are rounded to 1e-6', () => {
    expect(num(-5)).toBe('(-5)');
    expect(num(0.1 + 0.2)).toBe('0.3');
    expect(num(Number.NaN)).toBe('0');
    expect(compileModifierStack([mod('offset', { amount: -5 })])).toBe('(value + (-5))');
  });
});

describe('compileModifier on its own', () => {
  test('is the unit the stack is built from — same text, given the same input', () => {
    const m = mod('offset', { amount: 4 });
    expect(compileModifier(m, 'value')).toBe('(value + 4)');
    expect(compileModifier(m, '(value * 2)')).toBe('((value * 2) + 4)');
  });
});
