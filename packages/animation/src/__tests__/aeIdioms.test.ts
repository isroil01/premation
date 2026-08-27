/**
 * AE classic expression idioms — composed goldens, not single-builtin unit tests.
 *
 * EDITOR_REFERENCE claims bounce / inertia / delayed-follow / wiggle / loopOut
 * ports without rewrite because velocityAtTime + key/numKeys + layerAt +
 * selfSpan exist. These tests pin that claim with fixed numbers so a regression
 * in any piece of the chain fails loudly.
 */

import { compileExpression, suggestExpression, type ExprContext } from '../expressions';
import { AnimationEngine } from '../AnimationEngine';

function evalNum(src: string, ctx: ExprContext): number {
  const r = compileExpression(src).run(ctx);
  if (r.error) throw new Error(`${src} → ${r.error}`);
  if (typeof r.value !== 'number') throw new Error(`${src} → not a number`);
  return r.value;
}

/** Linear 0→100 over t=0..1, then hold — shared by bounce / inertia. */
function rampSelfAt(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 100;
  return t * 100;
}

function rampBase(time: number): ExprContext {
  return {
    time,
    value: rampSelfAt(time),
    selfAt: rampSelfAt,
    keyTimes: [0, 1],
  };
}

describe('AE bounce idiom (post-key velocity decay)', () => {
  // Same shape suggestExpression('bounce') ships — single ternary expression.
  const BOUNCE =
    'time <= key(numKeys).time ? value : value + velocityAtTime(key(numKeys).time - 0.001) * 0.05 * Math.sin((time - key(numKeys).time) * 12) / Math.exp((time - key(numKeys).time) * 4)';

  it('compiles and passes through before / on the last key', () => {
    expect(compileExpression(BOUNCE).compileError).toBeNull();
    expect(evalNum(BOUNCE, rampBase(0.5))).toBeCloseTo(50, 5);
    expect(evalNum(BOUNCE, rampBase(1))).toBeCloseTo(100, 5);
  });

  it('decays after the last key with a known amplitude at t = last + π/(2·12)', () => {
    // sin((t)*12) = 1 when t = π/24 ≈ 0.1309; exp(4t) ≈ 1.688
    const t = 1 + Math.PI / 24;
    const vTip = (rampSelfAt(1) - rampSelfAt(1 - 0.002)) / 0.002; // ≈ velocityAtTime(0.999)
    const expected = 100 + vTip * 0.05 * 1 / Math.exp(4 * (Math.PI / 24));
    expect(evalNum(BOUNCE, rampBase(t))).toBeCloseTo(expected, 1);
    // Must differ from a hold — otherwise the idiom is a no-op.
    expect(Math.abs(evalNum(BOUNCE, rampBase(t)) - 100)).toBeGreaterThan(1);
  });

  it('suggestExpression("bounce") returns that idiom, not a sine wave', () => {
    const s = suggestExpression('add a bounce');
    expect(s).toContain('velocityAtTime');
    expect(s).toContain('key(numKeys)');
    expect(s).not.toMatch(/Math\.sin\(time/);
    expect(compileExpression(s).compileError).toBeNull();
  });
});

describe('AE inertia idiom (exponential coast after last key)', () => {
  // No sine — pure velocity * exp(-decay·t). Distinct from bounce.
  const INERTIA =
    'time <= key(numKeys).time ? value : value + velocityAtTime(key(numKeys).time - 0.001) * Math.exp(-(time - key(numKeys).time) * 5)';

  it('passes through before the last key', () => {
    expect(compileExpression(INERTIA).compileError).toBeNull();
    expect(evalNum(INERTIA, rampBase(0.5))).toBeCloseTo(50, 5);
  });

  it('coasts past the last key then settles toward the hold', () => {
    const t = 1.2;
    const tip = 1 - 0.001;
    const vTip = (rampSelfAt(tip + 0.001) - rampSelfAt(tip - 0.001)) / 0.002;
    const expected = 100 + vTip * Math.exp(-(t - 1) * 5);
    expect(evalNum(INERTIA, rampBase(t))).toBeCloseTo(expected, 1);
    expect(evalNum(INERTIA, rampBase(t))).toBeGreaterThan(100);
    // Far later, decay has killed the tip — near the hold.
    expect(Math.abs(evalNum(INERTIA, rampBase(3)) - 100)).toBeLessThan(1);
  });

  it('suggestExpression("inertia") is the coast idiom, not bounce or sine', () => {
    const s = suggestExpression('add inertia after the keys');
    expect(s).toContain('velocityAtTime');
    expect(s).toContain('Math.exp');
    expect(s).not.toContain('Math.sin');
    expect(compileExpression(s).compileError).toBeNull();
    expect(suggestExpression('coast past the end')).toBe(s);
  });
});

describe('AE delayed follow idiom (layerAt)', () => {
  it('follower lags leader by Δ through layerAt', () => {
    const DELAY = 0.2;
    const leader = (t: number): number => t * 50; // 50 units/sec
    const layerAt = (name: string, prop: string, t: number): number | undefined =>
      name === 'Leader' && prop === 'x' ? leader(t) : undefined;

    const FOLLOW = "layerAt('Leader', 'x', time - 0.2)";
    expect(evalNum(FOLLOW, { time: 1, value: 0, layerAt })).toBeCloseTo(leader(1 - DELAY), 9);
    expect(evalNum(FOLLOW, { time: 2.4, value: 0, layerAt })).toBeCloseTo(leader(2.4 - DELAY), 9);
  });

  it('engine sample wires the same delay across two nodes', () => {
    const a = new AnimationEngine();
    a.setLayerResolver((name) => (name === 'Leader' ? 'lead' : null));
    a.setKeyframe('lead', 'x', 0, 0);
    a.setKeyframe('lead', 'x', 2, 200); // 100/sec
    a.setKeyframe('follow', 'x', 0, 0); // needs a track so sample() runs the expression
    a.setExpression('follow', 'x', "layerAt('Leader', 'x', time - 0.5)");

    // At t=1.5 the leader keyframed value is 150; follower reads t=1.0 → 100.
    expect(a.sample('lead', 'x', 1.5)).toBeCloseTo(150, 5);
    expect(a.sample('follow', 'x', 1.5)).toBeCloseTo(100, 5);
  });

  it('suggestExpression("follow") points at layerAt, not a sine', () => {
    const s = suggestExpression('follow the leader with delay');
    expect(s).toContain('layerAt');
    expect(compileExpression(s).compileError).toBeNull();
  });
});

describe('AE wiggle idiom (deterministic + independent axes)', () => {
  it('same seed + time is reproducible; x and y differ under engine prop seeds', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n', 'x', 0, 0);
    a.setKeyframe('n', 'y', 0, 0);
    a.setExpression('n', 'x', 'wiggle(3, 40)');
    a.setExpression('n', 'y', 'wiggle(3, 40)');
    const x = a.sample('n', 'x', 0.7)!;
    const y = a.sample('n', 'y', 0.7)!;
    expect(a.sample('n', 'x', 0.7)).toBe(x);
    expect(a.sample('n', 'y', 0.7)).toBe(y);
    // AE: x and y wiggle independently — same expression, different phase.
    expect(x).not.toBe(y);
  });

  it('posterizeTime freezes wiggle inside a step (stop-motion shake)', () => {
    const src = 'wiggle(3, 40, 1, 0.5, posterizeTime(6, time))';
    const a = evalNum(src, { time: 1.0, value: 0, propSeed: 2 });
    const b = evalNum(src, { time: 1.1, value: 0, propSeed: 2 });
    expect(a).toBe(b);
  });

  it('suggestExpression("wiggle") returns the builtin, not a Math.random hack', () => {
    expect(suggestExpression('add a wiggle shake')).toBe('wiggle(2, 30)');
  });
});

describe('AE loopOut idiom (all four modes via engine)', () => {
  function keyed(): AnimationEngine {
    const a = new AnimationEngine();
    a.setKeyframe('n', 'x', 0, 0);
    a.setKeyframe('n', 'x', 1, 100);
    return a;
  }

  it('cycle remaps past the last key', () => {
    const a = keyed();
    a.setExpression('n', 'x', "loopOut('cycle')");
    expect(a.sample('n', 'x', 0.5)).toBeCloseTo(50);
    expect(a.sample('n', 'x', 1.25)).toBeCloseTo(25);
  });

  it('pingpong reflects past the last key', () => {
    const a = keyed();
    a.setExpression('n', 'x', "loopOut('pingpong')");
    expect(a.sample('n', 'x', 1.25)).toBeCloseTo(75);
  });

  it('offset accumulates the cycle delta', () => {
    const a = keyed();
    a.setExpression('n', 'x', "loopOut('offset')");
    expect(a.sample('n', 'x', 1.5)).toBeCloseTo(150);
  });

  it('continue keeps the last segment speed', () => {
    const a = keyed();
    a.setExpression('n', 'x', "loopOut('continue')");
    // Linear 0→100 over 1s → 100/s; at t=1.5 → 100 + 100*0.5 = 150.
    expect(a.sample('n', 'x', 1.5)).toBeCloseTo(150, 0);
  });
});

describe('suggestExpression loop intents', () => {
  it('maps loop/cycle to loopOut cycle', () => {
    expect(suggestExpression('loop the keys')).toBe("loopOut('cycle')");
    expect(suggestExpression('repeat cycle')).toBe("loopOut('cycle')");
  });

  it('maps pingpong before the generic loop matcher', () => {
    expect(suggestExpression('pingpong the animation')).toBe("loopOut('pingpong')");
    expect(suggestExpression('ping-pong loop')).toBe("loopOut('pingpong')");
  });
});
