/**
 * An expression can be DISABLED without being deleted.
 *
 * ── WHAT THIS FILE ASSERTS, AND WHY IT IS PHRASED THIS WAY ──────────────────
 *
 * The claim is not "a disabled expression does not throw" — that is satisfied
 * by an expression that still runs and happens to succeed, by one that is
 * deleted, and by one that never existed. The claim is that the property falls
 * back to a SPECIFIC value: the one its keyframes interpolate to, derived on
 * paper before any of this was written. Every disabled-case assertion below
 * names a number.
 *
 * ── RULE 3a: WHAT THE CLEAN FIXTURE EXCLUDES ────────────────────────────────
 *
 * The obvious fixture is a keyframed property with an expression on it, and it
 * cannot reach three things this file therefore reaches deliberately:
 *
 *   1. A property with NO KEYFRAMES. Its fallback is the base-value provider,
 *      a different branch of `sampleInternal`'s final line, and the keyframed
 *      fixture never touches it.
 *   2. An expression that AGREES with the keyframes. Enabled and disabled then
 *      return the same number by coincidence, and a fixture in that class
 *      cannot fail however the bit is read. The main fixture's discriminating
 *      power is asserted rather than assumed, so it cannot rot into that class
 *      later.
 *   3. A CROSS-LAYER read. `layer('X','p')` re-enters `sampleInternal` for a
 *      different node, so enablement is consulted on a node the fixture never
 *      names. A one-node fixture leaves that call site unwatched.
 *
 * ── WHAT THIS MEDIUM CANNOT SEE (rule 5·0) ──────────────────────────────────
 *
 * That any UI or command wires the bit. These tests call the engine directly.
 * The undo shape is guarded in `src/core/animation/expressionEnabled.test.ts`
 * and the persisted shape in the migration test; the toggle itself was checked
 * in the running app.
 */

import { AnimationEngine } from '../AnimationEngine';

/**
 * x: 0 → 100 over 0..2s, linear, so x@1 = 50 by inspection.
 *
 * The expression adds 200, which is deliberately NOT 0: see boundary (2). At
 * t=1 the enabled answer is 50 + 200 = 250 and the disabled answer is 50.
 */
function keyframed(): AnimationEngine {
  const a = new AnimationEngine();
  a.setKeyframe('n1', 'x', 0, 0);
  a.setKeyframe('n1', 'x', 2, 100);
  a.setExpression('n1', 'x', 'value + 200');
  return a;
}

describe('a disabled expression falls back to the keyframes', () => {
  test('enabled by default — the expression drives the value', () => {
    const a = keyframed();
    expect(a.isExpressionEnabled('n1', 'x')).toBe(true);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(250);
  });

  test('disabled — the property reads its KEYFRAMED value, 50', () => {
    const a = keyframed();
    a.setExpressionEnabled('n1', 'x', false);
    // Not "does not throw", not "is not 250" — the interpolated number.
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(50);
    expect(a.sample('n1', 'x', 0)).toBeCloseTo(0);
    expect(a.sample('n1', 'x', 2)).toBeCloseTo(100);
  });

  test('re-enabling restores the expression exactly, from the retained source', () => {
    const a = keyframed();
    a.setExpressionEnabled('n1', 'x', false);
    a.setExpressionEnabled('n1', 'x', true);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(250);
    expect(a.getExpressionSrc('n1', 'x')).toBe('value + 200');
  });

  test('disabled is NOT deleted — the source survives for the editor to show', () => {
    const a = keyframed();
    a.setExpressionEnabled('n1', 'x', false);
    expect(a.getExpressionSrc('n1', 'x')).toBe('value + 200');
    expect(a.hasExpression('n1', 'x')).toBe(true);
    expect(a.isExpressionEnabled('n1', 'x')).toBe(false);
  });

  test('deleted IS deleted — both questions go false together', () => {
    const a = keyframed();
    a.removeExpression('n1', 'x');
    expect(a.hasExpression('n1', 'x')).toBe(false);
    expect(a.isExpressionEnabled('n1', 'x')).toBe(false);
    expect(a.getExpressionSrc('n1', 'x')).toBeUndefined();
  });

  test('a property with no expression at all reports neither', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 7);
    expect(a.hasExpression('n1', 'x')).toBe(false);
    expect(a.isExpressionEnabled('n1', 'x')).toBe(false);
  });
});

describe('boundaries — what the keyframed fixture excludes', () => {
  /**
   * (1) No keyframes: the fallback is the BASE VALUE provider, a different
   * branch. With no track, `value` inside the expression is 0 (there is nothing
   * to sample), so enabled gives 0 + 200 = 200 and disabled gives the static
   * 12 the provider reports. Two distinct numbers, neither of them the other
   * branch's answer.
   */
  test('no keyframes — disabled falls back to the STATIC value, not to 0', () => {
    const a = new AnimationEngine();
    a.setBaseValueProvider((_id, prop) => (prop === 'rotation' ? 12 : undefined));
    a.setExpression('n1', 'rotation', 'value + 200');

    expect(a.sample('n1', 'rotation', 1)).toBeCloseTo(200);
    a.setExpressionEnabled('n1', 'rotation', false);
    expect(a.sample('n1', 'rotation', 1)).toBeCloseTo(12);
  });

  /**
   * (2) An expression that agrees with the keyframes.
   *
   * `value * 0 + 50` is 50 everywhere, and the track is 50 at t=1 — so enabled
   * and disabled both answer 50 and the fixture is blind to the bit however it
   * is read. Asserted rather than described, so the main fixture cannot drift
   * into this class unnoticed: the second half pins that `value + 200` is
   * discriminating at the same instant.
   */
  test('a coincidentally-agreeing expression proves NOTHING — and the main fixture is not one', () => {
    const blind = new AnimationEngine();
    blind.setKeyframe('n1', 'x', 0, 0);
    blind.setKeyframe('n1', 'x', 2, 100);
    blind.setExpression('n1', 'x', 'value * 0 + 50');
    const on = blind.sample('n1', 'x', 1);
    blind.setExpressionEnabled('n1', 'x', false);
    expect(blind.sample('n1', 'x', 1)).toBeCloseTo(on!); // agree — no signal

    const real = keyframed();
    const realOn = real.sample('n1', 'x', 1);
    real.setExpressionEnabled('n1', 'x', false);
    expect(real.sample('n1', 'x', 1)).not.toBeCloseTo(realOn!);
  });

  /**
   * (3) Cross-layer. `layer('Title','x')` re-enters `sampleInternal` for the
   * TITLE node, so it is Title's enablement that decides — on a node the
   * follower's own fixture never mentions. Title's keyframes give x@1 = 100;
   * its expression adds 1000. The follower reads 1100 while Title's expression
   * is enabled and 100 once it is not, and the follower's own expression is
   * untouched throughout.
   */
  test("a disabled expression on ANOTHER layer changes what layer() reads", () => {
    const a = new AnimationEngine();
    a.setLayerResolver((name) => (name === 'Title' ? 'title' : null));
    a.setKeyframe('title', 'x', 0, 0);
    a.setKeyframe('title', 'x', 2, 200);
    a.setExpression('title', 'x', 'value + 1000');
    a.setKeyframe('follower', 'y', 0, 0);
    a.setExpression('follower', 'y', "layer('Title', 'x')");

    expect(a.sample('follower', 'y', 1)).toBeCloseTo(1100);

    a.setExpressionEnabled('title', 'x', false);
    expect(a.sample('follower', 'y', 1)).toBeCloseTo(100);
    // The follower's own expression is still enabled and still doing its job.
    expect(a.isExpressionEnabled('follower', 'y')).toBe(true);
  });

  /**
   * (4) An expression that ERRORS. Recorded because it is a case where the two
   * states agree for a reason unrelated to enablement: `sample` catches a cycle
   * and falls back to track/base itself, so a cyclic expression answers 50
   * whether or not it is enabled. A fixture built on one would look like a
   * passing enablement test and be measuring the catch block.
   */
  test('a self-cycling expression answers the same either way — NOT evidence about the bit', () => {
    const a = new AnimationEngine();
    a.setLayerResolver((name) => (name === 'Self' ? 'n1' : null));
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 2, 100);
    a.setExpression('n1', 'x', "layer('Self', 'x') + 10");

    expect(a.sample('n1', 'x', 1)).toBeCloseTo(50); // caught, fell back
    a.setExpressionEnabled('n1', 'x', false);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(50); // same number, other reason
  });
});

describe('editing a disabled expression does not re-enable it', () => {
  test('setExpression preserves the enabled bit when one is already attached', () => {
    const a = keyframed();
    a.setExpressionEnabled('n1', 'x', false);
    a.setExpression('n1', 'x', 'value + 300');

    expect(a.getExpressionSrc('n1', 'x')).toBe('value + 300');
    expect(a.isExpressionEnabled('n1', 'x')).toBe(false);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(50); // still the keyframes
  });

  test('a NEWLY attached expression is enabled', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 2, 100);
    a.setExpression('n1', 'x', 'value + 200');
    expect(a.isExpressionEnabled('n1', 'x')).toBe(true);
  });

  test('removing then re-adding starts enabled again — remove clears the state', () => {
    const a = keyframed();
    a.setExpressionEnabled('n1', 'x', false);
    a.removeExpression('n1', 'x');
    a.setExpression('n1', 'x', 'value + 200');
    expect(a.isExpressionEnabled('n1', 'x')).toBe(true);
  });

  test('setExpressionEnabled on a property with no expression is a no-op', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 7);
    a.setExpressionEnabled('n1', 'x', true);
    // Must not have conjured an expression-shaped hole into the snapshot.
    expect(a.hasExpression('n1', 'x')).toBe(false);
    expect(a.snapshot().expressions.n1).toBeUndefined();
  });
});

describe('the enabled bit survives snapshot → restore', () => {
  test('a disabled expression restores DISABLED, and still does not drive', () => {
    const a = keyframed();
    a.setExpressionEnabled('n1', 'x', false);
    const snap = structuredClone(a.snapshot());

    expect(snap.expressions.n1?.x).toEqual({ src: 'value + 200', enabled: false });

    const b = new AnimationEngine();
    b.restore(snap);
    expect(b.getExpressionSrc('n1', 'x')).toBe('value + 200');
    expect(b.isExpressionEnabled('n1', 'x')).toBe(false);
    expect(b.sample('n1', 'x', 1)).toBeCloseTo(50);
  });

  test('an enabled expression restores ENABLED, and drives', () => {
    const a = keyframed();
    const b = new AnimationEngine();
    b.restore(structuredClone(a.snapshot()));
    expect(b.isExpressionEnabled('n1', 'x')).toBe(true);
    expect(b.sample('n1', 'x', 1)).toBeCloseTo(250);
  });

  test('getExpressionState / setExpressionState round-trip both fields', () => {
    const a = keyframed();
    a.setExpressionEnabled('n1', 'x', false);
    const state = a.getExpressionState('n1', 'x');
    expect(state).toEqual({ src: 'value + 200', enabled: false });

    const b = new AnimationEngine();
    b.setKeyframe('n1', 'x', 0, 0);
    b.setKeyframe('n1', 'x', 2, 100);
    b.setExpressionState('n1', 'x', state);
    expect(b.sample('n1', 'x', 1)).toBeCloseTo(50);

    b.setExpressionState('n1', 'x', null);
    expect(b.hasExpression('n1', 'x')).toBe(false);
    expect(a.getExpressionState('n2', 'x')).toBeNull();
  });
});
