import { evalMath, applyValueExpression } from './evalMath';

describe('evalMath', () => {
  it('evaluates basic arithmetic', () => {
    expect(evalMath('960/2')).toBe(480);
    expect(evalMath('1+2*3')).toBe(7);
    expect(evalMath('(1+2)*3')).toBe(9);
    expect(evalMath('10 % 3')).toBe(1);
    expect(evalMath('2^10')).toBe(1024);
  });

  it('handles decimals and unary minus', () => {
    expect(evalMath('1920*0.5')).toBe(960);
    expect(evalMath('-45')).toBe(-45);
    expect(evalMath('-(3+2)')).toBe(-5);
    expect(evalMath('.5+.5')).toBe(1);
  });

  it('returns null on malformed input', () => {
    expect(evalMath('')).toBeNull();
    expect(evalMath('1+')).toBeNull();
    expect(evalMath('(1+2')).toBeNull();
    expect(evalMath('1+2)')).toBeNull();
    expect(evalMath('abc')).toBeNull();
    expect(evalMath('5/0')).toBeNull();
  });
});

describe('applyValueExpression', () => {
  it('treats leading + * / as relative to current', () => {
    expect(applyValueExpression(100, '+15')).toBe(115);
    expect(applyValueExpression(100, '*1.5')).toBe(150);
    expect(applyValueExpression(100, '/2')).toBe(50);
    expect(applyValueExpression(100, '+ 10 * 2')).toBe(120);
  });

  it('treats leading - and bare numbers as absolute', () => {
    expect(applyValueExpression(100, '-45')).toBe(-45);
    expect(applyValueExpression(100, '960/2')).toBe(480);
    expect(applyValueExpression(100, '0')).toBe(0);
  });

  it('returns null on invalid entries', () => {
    expect(applyValueExpression(100, '')).toBeNull();
    expect(applyValueExpression(100, '/0')).toBeNull();
    expect(applyValueExpression(100, 'xyz')).toBeNull();
  });
});
