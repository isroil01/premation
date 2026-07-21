/**
 * Expression language — parser, evaluator, sandbox, and the CSP regression.
 *
 * The last test in this file is the important one. Expressions were dead in the
 * real product for as long as they have existed, and the suite never noticed,
 * because `new Function` works fine under jsdom (which enforces no CSP) and
 * fails in the renderer (`script-src 'self'`). A test that only checks the
 * OUTPUT of compileExpression cannot tell the two apart — so we sabotage the
 * Function constructor to make the test environment behave like the renderer.
 */

import { parseExpression, evaluateExpression, ExprSyntaxError, ExprRuntimeError } from './exprLang';
import { compileExpression } from './expressions';

const evalWith = (src: string, scope: Record<string, unknown> = {}): unknown =>
  evaluateExpression(parseExpression(src), new Map(Object.entries(scope)));

describe('parser', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 * 3 + 1', 7],
    ['10 - 2 - 3', 5], // left-associative
    ['10 / 2 / 5', 1],
    ['7 % 4', 3],
    ['-3 + 1', -2],
    ['- -3', 3],
    ['2 * -3', -6],
  ])('respects precedence and associativity: %s', (src, expected) => {
    expect(evalWith(src)).toBe(expected);
  });

  it.each([
    ['.5', 0.5],
    ['1.25', 1.25],
    ['1e3', 1000],
    ['1e-3', 0.001],
    ['1E2', 100],
  ])('lexes number literal %s', (src, expected) => {
    expect(evalWith(src)).toBe(expected);
  });

  it('parses comparison and equality', () => {
    expect(evalWith('1 < 2')).toBe(true);
    expect(evalWith('2 <= 2')).toBe(true);
    expect(evalWith('3 > 4')).toBe(false);
    expect(evalWith('1 === 1')).toBe(true);
    expect(evalWith('1 !== 2')).toBe(true);
    // Comparison binds tighter than equality.
    expect(evalWith('1 < 2 === true')).toBe(true);
  });

  it('parses ternaries, including nested', () => {
    expect(evalWith('1 > 0 ? 10 : 20')).toBe(10);
    expect(evalWith('0 > 1 ? 10 : 20')).toBe(20);
    expect(evalWith('1 ? 2 ? 3 : 4 : 5')).toBe(3);
  });

  it('short-circuits logical operators', () => {
    const boom = (): never => {
      throw new Error('should not evaluate');
    };
    expect(() => evalWith('false && boom()', { boom })).not.toThrow();
    expect(evalWith('false && boom()', { boom })).toBe(false);
    expect(evalWith('true || boom()', { boom })).toBe(true);
  });

  it('parses strings with quotes and escapes', () => {
    expect(evalWith('"a"')).toBe('a');
    expect(evalWith("'a'")).toBe('a');
    expect(evalWith('"it\'s"')).toBe("it's");
    expect(evalWith('"a\\nb"')).toBe('a\nb');
  });

  it('parses member access, calls, and arrays', () => {
    expect(evalWith('Math.max(1, 5, 3)', { Math })).toBe(5);
    expect(evalWith('o.a.b', { o: { a: { b: 42 } } })).toBe(42);
    expect(evalWith('o["a"]', { o: { a: 1 } })).toBe(1);
    expect(evalWith('[1, 2, 3][1]')).toBe(2);
    expect(evalWith('f(1)(2)', { f: (a: number) => (b: number) => a + b })).toBe(3);
  });

  it('keeps `this` bound on member calls', () => {
    // Math.sin has no receiver if the callee is evaluated in isolation.
    expect(evalWith('Math.sin(0)', { Math })).toBe(0);
    expect(evalWith('Math.round(1.6)', { Math })).toBe(2);
  });

  it.each([
    ['1 +', 'incomplete binary'],
    ['(1', 'unclosed paren'],
    ['1; 2', 'statements'],
    ['"abc', 'unterminated string'],
    ['@', 'stray character'],
    ['', 'empty'],
    ['f(1,', 'unclosed call'],
  ])('rejects malformed input (%s)', (src) => {
    expect(() => parseExpression(src)).toThrow(ExprSyntaxError);
  });
});

describe('sandbox', () => {
  it('cannot see names outside the scope', () => {
    expect(() => evalWith('window')).toThrow(ExprRuntimeError);
    expect(() => evalWith('fetch("http://x")')).toThrow(ExprRuntimeError);
    expect(() => evalWith('globalThis')).toThrow(ExprRuntimeError);
  });

  it('blocks the prototype-chain escape to arbitrary code', () => {
    // The classic sandbox break: reach Function via constructor, then eval.
    expect(() => evalWith('value.constructor', { value: 1 })).toThrow(/isn’t allowed/);
    expect(() => evalWith('value["constructor"]', { value: 1 })).toThrow(/isn’t allowed/);
    expect(() => evalWith('o.__proto__', { o: {} })).toThrow(/isn’t allowed/);
    expect(() => evalWith('o.prototype', { o: {} })).toThrow(/isn’t allowed/);
  });

  it('reports a helpful error for unknown names', () => {
    expect(() => evalWith('speeed')).toThrow(/speeed is not defined/);
  });

  it('reports a helpful error for calling a non-function', () => {
    expect(() => evalWith('value(1)', { value: 3 })).toThrow(/is not a function/);
    expect(() => evalWith('Math.nope(1)', { Math })).toThrow(/is not a function/);
  });
});

describe('compileExpression under CSP', () => {
  /**
   * Simulate the renderer: make `new Function(...)` throw exactly as a CSP
   * refusal does. If compilation ever regresses to eval, these fail.
   */
  const withoutEval = <T>(fn: () => T): T => {
    const RealFunction = global.Function;
    const Trap = function (): never {
      throw new EvalError(
        "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script",
      );
    } as unknown as FunctionConstructor;
    Trap.prototype = RealFunction.prototype;
    global.Function = Trap;
    try {
      return fn();
    } finally {
      global.Function = RealFunction;
    }
  };

  it('compiles and evaluates without the Function constructor', () => {
    withoutEval(() => {
      const c = compileExpression('value + Math.sin(0) * 10');
      expect(c.compileError).toBeNull();
      expect(c.run({ time: 0, value: 5 })).toEqual({ value: 5, error: null });
    });
  });

  it('evaluates the documented API without eval', () => {
    withoutEval(() => {
      expect(compileExpression('time * 90').run({ time: 2, value: 0 }).value).toBe(180);
      expect(compileExpression('clamp(value, 0, 10)').run({ time: 0, value: 50 }).value).toBe(10);
      expect(compileExpression('linear(time, 0, 2, 0, 100)').run({ time: 1, value: 0 }).value).toBe(50);
      expect(compileExpression('thisComp.width').run({
        time: 0,
        value: 0,
        comp: { width: 800, height: 600, duration: 5, fps: 24, numLayers: 2 },
      }).value).toBe(800);
    });
  });

  it('still reports syntax errors as compile errors, not crashes', () => {
    withoutEval(() => {
      const c = compileExpression('value +');
      expect(c.compileError).not.toBeNull();
      expect(c.run({ time: 0, value: 1 })).toEqual({ value: null, error: c.compileError });
    });
  });

  it('rejects a non-numeric result', () => {
    withoutEval(() => {
      expect(compileExpression('"hello"').run({ time: 0, value: 0 })).toEqual({
        value: null,
        error: 'Expression must return a number (or a [x, y] array).',
      });
    });
  });
});
