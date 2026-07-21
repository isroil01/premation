/**
 * Vector expression returns — AE's `[x, y]` idiom on decomposed tracks.
 *
 * An expression may return a 1–4 element numeric array; the engine picks the
 * component matching the track it runs on (x→0, y→1, z→2). Also pins the
 * per-(node, prop) wiggle seed: x and y wiggle independently (AE), while the
 * same prop stays deterministic run to run.
 */

import { AnimationEngine } from '../AnimationEngine';
import { compileExpression } from '../expressions';

describe('array-returning expressions', () => {
  it('compile-level: arrays of finite numbers are accepted', () => {
    const r = compileExpression('[time * 100, 50]').run({ time: 2, value: 0 });
    expect(r.error).toBeNull();
    expect(r.value).toEqual([200, 50]);
  });

  it('rejects non-numeric arrays', () => {
    const r = compileExpression('[1, "two"]').run({ time: 0, value: 0 });
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/number/i);
  });

  it('x reads component 0, y reads component 1, z reads component 2', () => {
    const engine = new AnimationEngine();
    engine.setExpression('n1', 'x', '[10 + time, 20 + time, 30 + time]');
    engine.setExpression('n1', 'y', '[10 + time, 20 + time, 30 + time]');
    engine.setExpression('n1', 'z', '[10 + time, 20 + time, 30 + time]');
    expect(engine.sample('n1', 'x', 1)).toBe(11);
    expect(engine.sample('n1', 'y', 1)).toBe(21);
    expect(engine.sample('n1', 'z', 1)).toBe(31);
  });

  it('a 2-element array clamps the z read to the last component', () => {
    const engine = new AnimationEngine();
    engine.setExpression('n1', 'z', '[5, 7]');
    expect(engine.sample('n1', 'z', 0)).toBe(7);
  });

  it('scalar returns are unchanged', () => {
    const engine = new AnimationEngine();
    engine.setExpression('n1', 'x', 'time * 2');
    expect(engine.sample('n1', 'x', 3)).toBe(6);
  });
});

describe('per-prop wiggle seeding', () => {
  it('x and y wiggle independently; each is deterministic', () => {
    const engine = new AnimationEngine();
    engine.setExpression('n1', 'x', 'wiggle(2, 30)');
    engine.setExpression('n1', 'y', 'wiggle(2, 30)');
    const xs = [0.1, 0.35, 0.6, 0.85].map((t) => engine.sample('n1', 'x', t));
    const ys = [0.1, 0.35, 0.6, 0.85].map((t) => engine.sample('n1', 'y', t));
    // Independent: not the same sequence.
    expect(xs).not.toEqual(ys);
    // Deterministic: sampling again gives identical values.
    expect([0.1, 0.35, 0.6, 0.85].map((t) => engine.sample('n1', 'x', t))).toEqual(xs);
  });

  it('different layers wiggle differently on the same prop', () => {
    const engine = new AnimationEngine();
    engine.setExpression('a', 'x', 'wiggle(2, 30)');
    engine.setExpression('b', 'x', 'wiggle(2, 30)');
    const va = [0.2, 0.4, 0.6].map((t) => engine.sample('a', 'x', t));
    const vb = [0.2, 0.4, 0.6].map((t) => engine.sample('b', 'x', t));
    expect(va).not.toEqual(vb);
  });
});
