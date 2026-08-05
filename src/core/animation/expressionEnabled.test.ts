/**
 * Undo across the expression enabled-state.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM THE ENGINE'S ───────────────────────
 *
 * `packages/animation/.../expressionEnabled.test.ts` proves the ENGINE honours
 * the bit. It builds its own engine and calls the setter directly, so it cannot
 * see anything about undo — which is rule 5·0's medium question, and F29's
 * shape exactly. This file is the other half: it drives the same states through
 * `captureAnimEdit` / `AnimEditCommand`, which is what the app actually uses.
 *
 * ── THE SPECIFIC TRAP ───────────────────────────────────────────────────────
 *
 * `TrackChange.expressionBefore/After` used to be `string | null`, where the
 * string WAS the presence bit. That representation has no room for "present but
 * off", so an undo across a disable had only two things it could do and both
 * are wrong: restore the string (re-running a formula the user switched off) or
 * treat it as absent (deleting one they wanted kept). The tests below assert
 * the state that comes back, never merely that something came back.
 *
 * `runAnimEdit` is deliberately not used — it reaches for the global
 * CommandSystem. `captureAnimEdit` with an explicit engine is the same capture
 * path with the history singleton left out.
 */

import { AnimationEngine } from '@motion/animation';
import { captureAnimEdit, diffTracks } from './animationCommands';

/** x: 0 → 100 over 0..2s (x@1 = 50) with `value + 200` attached. */
function fixture(): AnimationEngine {
  const a = new AnimationEngine();
  a.setKeyframe('n1', 'x', 0, 0);
  a.setKeyframe('n1', 'x', 2, 100);
  a.setExpression('n1', 'x', 'value + 200');
  return a;
}

describe('undo across a DISABLE', () => {
  test('undo re-enables; redo re-disables; the source never moves', () => {
    const a = fixture();
    const cmd = captureAnimEdit('Disable Expression', () => {
      a.setExpressionEnabled('n1', 'x', false);
    }, { engine: a })!;

    expect(cmd).not.toBeNull();
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(50);

    cmd.undo();
    expect(a.isExpressionEnabled('n1', 'x')).toBe(true);
    expect(a.getExpressionSrc('n1', 'x')).toBe('value + 200');
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(250);

    cmd.execute();
    expect(a.isExpressionEnabled('n1', 'x')).toBe(false);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(50);
  });

  test('a toggle DIFFS — same source, different bit, still one recorded change', () => {
    const a = fixture();
    const before = a.snapshot();
    a.setExpressionEnabled('n1', 'x', false);
    const changes = diffTracks(before, a.snapshot());

    // If `exprEqual` compared only `src` this array would be empty,
    // `captureAnimEdit` would return null, and the toggle would apply to the
    // engine with no command behind it — visible, and unundoable.
    expect(changes).toHaveLength(1);
    expect(changes[0]!.expressionBefore).toEqual({ src: 'value + 200', enabled: true });
    expect(changes[0]!.expressionAfter).toEqual({ src: 'value + 200', enabled: false });
  });

  test('an unchanged expression diffs to nothing — objects are compared by VALUE', () => {
    const a = fixture();
    const before = a.snapshot();
    a.setKeyframe('n1', 'x', 1, 60); // an unrelated edit on the same property
    const changes = diffTracks(before, a.snapshot());

    // Every snapshot allocates fresh expression objects, so a reference
    // comparison would report the expression as changed on every edit and
    // write a spurious expression rewrite into the undo step.
    expect(changes).toHaveLength(1);
    expect(changes[0]!.expressionBefore).toEqual(changes[0]!.expressionAfter);
  });
});

describe('undo across a DELETE resurrects the state it had', () => {
  /**
   * The rule-3a case, and the one the old `string | null` shape got wrong: the
   * clean fixture deletes an ENABLED expression, where "restore the source" and
   * "restore the state" are the same answer. Only deleting a DISABLED one tells
   * them apart.
   */
  test('deleting a DISABLED expression and undoing brings it back DISABLED', () => {
    const a = fixture();
    a.setExpressionEnabled('n1', 'x', false);

    const cmd = captureAnimEdit('Remove Expression', () => {
      a.removeExpression('n1', 'x');
    }, { engine: a })!;
    expect(a.hasExpression('n1', 'x')).toBe(false);

    cmd.undo();
    expect(a.hasExpression('n1', 'x')).toBe(true);
    expect(a.getExpressionSrc('n1', 'x')).toBe('value + 200');
    // The whole point: not merely present, and not silently switched back on.
    expect(a.isExpressionEnabled('n1', 'x')).toBe(false);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(50);
  });

  test('deleting an ENABLED expression and undoing brings it back ENABLED', () => {
    const a = fixture();
    const cmd = captureAnimEdit('Remove Expression', () => {
      a.removeExpression('n1', 'x');
    }, { engine: a })!;

    cmd.undo();
    expect(a.isExpressionEnabled('n1', 'x')).toBe(true);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(250);
  });
});

describe('undo across an ADD', () => {
  test('undoing the first attachment removes it entirely', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 2, 100);

    const cmd = captureAnimEdit('Set Expression', () => {
      a.setExpression('n1', 'x', 'value + 200');
    }, { engine: a })!;
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(250);

    cmd.undo();
    expect(a.hasExpression('n1', 'x')).toBe(false);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(50);
  });

  test('rewriting a DISABLED expression and undoing keeps it disabled at both ends', () => {
    const a = fixture();
    a.setExpressionEnabled('n1', 'x', false);

    const cmd = captureAnimEdit('Set Expression', () => {
      a.setExpression('n1', 'x', 'value + 300');
    }, { engine: a })!;
    expect(a.isExpressionEnabled('n1', 'x')).toBe(false);

    cmd.undo();
    expect(a.getExpressionSrc('n1', 'x')).toBe('value + 200');
    expect(a.isExpressionEnabled('n1', 'x')).toBe(false);
  });
});
