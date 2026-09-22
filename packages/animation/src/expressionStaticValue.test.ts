import { AnimationEngine } from './AnimationEngine';

/**
 * `value` on a property with no keyframes is the node's static value, not 0.
 * `value + Math.sin(time) * 40` is the most common expression there is, and on
 * an un-keyframed Position it used to evaluate around 0 — every layer it was
 * applied to piled up in the comp's top-left corner.
 */
describe('expression `value` on an un-keyframed property', () => {
  const engine = (): AnimationEngine => {
    const a = new AnimationEngine();
    a.setBaseValueProvider((_id, prop) => (prop === 'x' ? 1250 : undefined));
    return a;
  };

  it('is the static value the host reports', () => {
    const a = engine();
    a.setExpression('n1', 'x', 'value + 10');
    expect(a.sample('n1', 'x', 0)).toBeCloseTo(1260);
  });

  it('valueAtTime() agrees — a static property is the same at every time', () => {
    const a = engine();
    a.setExpression('n1', 'x', 'valueAtTime(3)');
    expect(a.sample('n1', 'x', 0)).toBeCloseTo(1250);
  });

  it('keyframes still win over the static value', () => {
    const a = engine();
    a.setKeyframe('n1', 'x', 0, 100);
    a.setExpression('n1', 'x', 'value');
    expect(a.sample('n1', 'x', 0)).toBeCloseTo(100);
  });

  it('stays 0 when the host knows no value either', () => {
    const a = engine();
    a.setExpression('n1', 'y', 'value + 1');
    expect(a.sample('n1', 'y', 0)).toBeCloseTo(1);
  });
});
