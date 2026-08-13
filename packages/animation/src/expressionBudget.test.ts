/**
 * An expression must not be able to freeze the renderer, and must not be able
 * to reach the prototype chain through a computed key.
 *
 * Both of these matter more than they look, for the same reason: expressions
 * are written by plugins (`animation.setExpression` needs only
 * `animation:write`) and they PERSIST IN SAVED DOCUMENTS. So a bad one is not a
 * bug that shows up while its author is watching — it arrives on the machine of
 * whoever opens the project next, with no plugin installed and nothing naming
 * where it came from. And it runs on the main thread, so none of the plugin
 * sandbox's supervision applies: the worker heartbeat watches workers, and this
 * is not in one.
 */

import { compileExpression, MAX_WIGGLE_OCTAVES } from './expressions';
import { parseExpression, evaluateExpression, MAX_EVAL_STEPS, ExprRuntimeError } from './exprLang';

const run = (src: string, value = 1): { value: number | null; error: string | null } =>
  compileExpression(src).run({ time: 0, value });

describe('the prototype chain is unreachable through a COMPUTED key', () => {
  /**
   * A denylist on property access has to test the RESOLVED key, not the literal
   * the author typed. Checking at parse time is the classic mistake: the
   * denylist looks right, reads right, and `obj["con" + "structor"]` walks
   * straight past it.
   */
  it('blocks a key assembled at runtime, not just a literal one', () => {
    for (const src of [
      'value["con" + "structor"]',
      'value["__pro" + "to__"]',
      'value["proto" + "type"]',
      'Math["con" + "structor"]',
    ]) {
      const { value: v, error } = run(src);
      expect({ src, v, blocked: error !== null }).toEqual({ src, v: null, blocked: true });
    }
  });

  it('blocks a key that arrives through a bound name rather than a literal', () => {
    // `value` is a number here, so this is the same shape one step removed.
    const { error } = compileExpression('Math[value]').run({ time: 0, value: 1 });
    // Either refused as blocked, or resolved to something harmless — what must
    // NOT happen is reaching a function that can construct.
    const fn = compileExpression('Math[value]').run({ time: 0, value: 1 }).value;
    expect(typeof fn === 'function').toBe(false);
    expect(error === null || typeof error === 'string').toBe(true);
  });

  it('refuses a non-string, non-number computed key outright', () => {
    // An array key would otherwise coerce via toString and could spell a
    // blocked name without ever being a string at the point of the check.
    const { error } = run('value[["constructor"]]');
    expect(error).not.toBeNull();
  });
});

describe('execution budget', () => {
  it('clamps wiggle octaves instead of looping as many times as it is told', () => {
    // The concrete denial of service. `octaves` came straight from expression
    // source into a `for` bound, so this was a billion iterations on the main
    // thread, per property, per frame.
    const started = Date.now();
    const { value, error } = run('wiggle(2, 30, 1000000000)');
    const elapsed = Date.now() - started;

    expect(error).toBeNull();
    expect(Number.isFinite(value)).toBe(true);
    // Generous on purpose — the assertion is "returns promptly", not a
    // benchmark. Unclamped this does not finish at all.
    expect(elapsed).toBeLessThan(1000);
  });

  it('gives the same answer for any octave count at or above the clamp', () => {
    // Proves the clamp is what bounded it, rather than the call failing early.
    const at = (o: string): number | null =>
      compileExpression(`wiggle(2, 30, ${o})`).run({ time: 0.7, value: 0 }).value;
    const atClamp = at(String(MAX_WIGGLE_OCTAVES));
    const absurd = at('1000000');
    expect(absurd).toBe(atClamp);
  });

  it('still honours an ordinary octave count', () => {
    // The clamp must not have flattened the feature into one octave.
    //
    // Sampled at t = 0.7, NOT at t = 0: each octave samples `smoothNoise(t * f)`
    // with `f` doubling per octave, so at t = 0 every octave reads the same
    // point and one and four octaves agree by construction. A comparison there
    // would pass whatever the clamp did.
    const one = compileExpression('wiggle(2, 30, 1)').run({ time: 0.7, value: 0 }).value;
    const four = compileExpression('wiggle(2, 30, 4)').run({ time: 0.7, value: 0 }).value;
    expect(one).not.toBe(four);
  });

  it('refuses to keep evaluating a pathologically large expression', () => {
    // Not reachable by hand, entirely reachable by a plugin generating source.
    const huge = `1${'+1'.repeat(MAX_EVAL_STEPS)}`;
    const { value, error } = run(huge);
    expect({ value, refused: error !== null }).toEqual({ value: null, refused: true });
  });

  it('budgets an ordinary expression nowhere near the ceiling', () => {
    // The other failure: a budget so tight it breaks real expressions.
    expect(run('value + Math.sin(time) * 40 + wiggle(3, 10)').error).toBeNull();
  });

  it('shares one budget across a re-entrant evaluation', () => {
    // Cross-layer reads re-enter the evaluator. Resetting the counter on every
    // entry would make the budget meaningless: a chain of individually cheap
    // expressions could still spend unbounded time on a single frame.
    //
    // Built WIDE (an array literal), not deep. A nested `1+1+1+…` chain is one
    // AST level per term and would hit MAX_EVAL_DEPTH long before the step
    // budget — testing the wrong limit and passing for the wrong reason.
    const wide = `[${'1,'.repeat(Math.floor(MAX_EVAL_STEPS * 0.6))}1]`;
    const inner = parseExpression(wide);
    const baseScope = (): Map<string, unknown> => new Map([['time', 0], ['value', 0]]);

    // Stands in for `thisComp.layer(...)`: a bound name that re-enters.
    const scope = baseScope();
    scope.set('nested', () => evaluateExpression(inner, baseScope()));

    // 0.6 of the budget on its own: fine.
    expect(() => evaluateExpression(inner, baseScope())).not.toThrow();

    // Two of them through a re-entrant call: 1.2x the budget, and refused.
    // With a per-call reset this would pass, which is the bug.
    expect(() => evaluateExpression(parseExpression('nested() + nested()'), scope))
      .toThrow(ExprRuntimeError);
  });

  it('reports the refusal as a runtime error, not a crash', () => {
    // It has to arrive as the same kind of failure every other bad expression
    // produces, so the editor's inline error surface shows it rather than the
    // renderer taking an unhandled throw.
    const ast = parseExpression(`1${'+1'.repeat(MAX_EVAL_STEPS)}`);
    expect(() => evaluateExpression(ast, new Map([['time', 0], ['value', 0]])))
      .toThrow(ExprRuntimeError);
  });
});
