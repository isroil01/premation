import { compileExpression, tokenizeExpression, matchBracket } from './expressions';

describe('tokenizeExpression', () => {
  it('classifies api names, numbers and operators', () => {
    const toks = tokenizeExpression('wiggle(2, 30) + time');
    const kinds = toks.filter((t) => t.kind !== 'ws').map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toContain('api:wiggle');
    expect(kinds).toContain('num:2');
    expect(kinds).toContain('op:+');
    expect(kinds).toContain('api:time');
  });
  it('reassembles to the original source', () => {
    const src = 'clamp(value, 0, 100) * 1.5';
    expect(tokenizeExpression(src).map((t) => t.text).join('')).toBe(src);
  });
});

describe('matchBracket', () => {
  it('matches an opening bracket at the caret', () => {
    expect(matchBracket('wiggle(2, 30)', 6)).toEqual([6, 12]);
  });
  it('matches a closing bracket before the caret', () => {
    expect(matchBracket('(1 + 2)', 7)).toEqual([0, 6]);
  });
  it('returns null when there is no bracket', () => {
    expect(matchBracket('time * 2', 2)).toBeNull();
  });
});

describe('compileExpression', () => {
  it('evaluates time/value math', () => {
    const e = compileExpression('time * 50');
    expect(e.compileError).toBeNull();
    expect(e.run({ time: 2, value: 0 }).value).toBe(100);
  });

  it('exposes value and clamp', () => {
    const e = compileExpression('clamp(value + 10, 0, 100)');
    expect(e.run({ time: 0, value: 95 }).value).toBe(100);
    expect(e.run({ time: 0, value: 20 }).value).toBe(30);
  });

  it('wiggle is deterministic around value', () => {
    const e = compileExpression('wiggle(2, 30)');
    const a = e.run({ time: 1.5, value: 100 }).value;
    const b = e.run({ time: 1.5, value: 100 }).value;
    expect(a).toBe(b);
    expect(typeof a).toBe('number');
  });

  it('reports syntax errors as plain language', () => {
    const e = compileExpression('time *');
    expect(e.compileError).not.toBeNull();
  });

  it('reports unknown names at runtime', () => {
    const e = compileExpression('foo + 1');
    const r = e.run({ time: 0, value: 0 });
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/Unknown name/);
  });

  it('rejects non-numeric results', () => {
    const e = compileExpression('"hello"');
    expect(e.run({ time: 0, value: 0 }).error).toMatch(/must return a number/);
  });

  it('empty expression is a no-op', () => {
    const e = compileExpression('   ');
    expect(e.run({ time: 0, value: 0 })).toEqual({ value: null, error: null });
  });

  it('audio accessor reads the context amplitude (0 when absent)', () => {
    const e = compileExpression('value + audio * 100');
    expect(e.run({ time: 0, value: 10, audio: 0.5 }).value).toBe(60);
    expect(e.run({ time: 0, value: 10 }).value).toBe(10);
  });

  it('ctrl() reads named slider controls (0 when no provider)', () => {
    const e = compileExpression("value + ctrl('Speed') * 2");
    const ctrl = (name: string): number => (name === 'Speed' ? 25 : 0);
    expect(e.run({ time: 0, value: 10, ctrl }).value).toBe(60);
    expect(e.run({ time: 0, value: 10 }).value).toBe(10);
  });
});
