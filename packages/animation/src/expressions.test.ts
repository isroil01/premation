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

describe('expression API v2', () => {
  // A linear 0→100 track over t=0..1, clamped like sampleTrack clamps.
  const selfAt = (t: number): number => Math.min(1, Math.max(0, t)) * 100;
  const selfSpan = { start: 0, end: 1 };
  const ctx = (time: number): { time: number; value: number; selfAt: typeof selfAt; selfSpan: typeof selfSpan } => ({
    time,
    value: selfAt(time), // "value" is the keyframed value at the playhead
    selfAt,
    selfSpan,
  });

  it('valueAtTime(t) samples own keyframes at an arbitrary time', () => {
    const e = compileExpression('valueAtTime(0.25)');
    expect(e.run(ctx(0)).value).toBeCloseTo(25);
    expect(e.run(ctx(5)).value).toBeCloseTo(25); // playhead-independent
  });

  it('valueAtTime falls back to value when the host provides no sampler', () => {
    const e = compileExpression('valueAtTime(0.25)');
    expect(e.run({ time: 0, value: 7 }).value).toBe(7);
  });

  it('layer() reads another layer at the playhead; layerAt() at an explicit time', () => {
    const layerAt = (name: string, prop: string, t: number): number | undefined =>
      name === 'Title' && prop === 'x' ? t * 10 : undefined;
    expect(compileExpression("layer('Title', 'x')").run({ time: 2, value: 0, layerAt }).value).toBe(20);
    expect(compileExpression("layerAt('Title', 'x', 5)").run({ time: 2, value: 0, layerAt }).value).toBe(50);
  });

  it('unknown layer or prop resolves to 0 (graceful, documented)', () => {
    const layerAt = (): number | undefined => undefined;
    expect(compileExpression("layer('Ghost', 'x') + 5").run({ time: 0, value: 0, layerAt }).value).toBe(5);
    // …and with no provider at all:
    expect(compileExpression("layer('Ghost', 'x') + 5").run({ time: 0, value: 0 }).value).toBe(5);
  });

  it("loopOut('cycle') repeats the span after the last keyframe", () => {
    const e = compileExpression("loopOut('cycle')");
    expect(e.run(ctx(0.5)).value).toBeCloseTo(50); // inside span → keyframed value
    expect(e.run(ctx(1.25)).value).toBeCloseTo(25); // 1.25 → phase 0.25
    expect(e.run(ctx(2.0)).value).toBeCloseTo(0); // exact multiple → first keyframe
  });

  it("loopOut() defaults to 'cycle'", () => {
    expect(compileExpression('loopOut()').run(ctx(1.25)).value).toBeCloseTo(25);
  });

  it("loopOut('pingpong') reflects each alternate loop", () => {
    const e = compileExpression("loopOut('pingpong')");
    expect(e.run(ctx(1.25)).value).toBeCloseTo(75); // bouncing back down
    expect(e.run(ctx(1.75)).value).toBeCloseTo(25);
    expect(e.run(ctx(2.5)).value).toBeCloseTo(50); // forward again
  });

  it("loopOut('offset') accumulates the per-loop delta", () => {
    const e = compileExpression("loopOut('offset')");
    expect(e.run(ctx(1.5)).value).toBeCloseTo(150); // 50 + 1×100
    expect(e.run(ctx(2.0)).value).toBeCloseTo(200); // 0 + 2×100
    expect(e.run(ctx(2.75)).value).toBeCloseTo(275); // 75 + 2×100
  });

  it("loopOut('continue') keeps the last segment's speed", () => {
    const e = compileExpression("loopOut('continue')");
    // Linear 0→100 over 0..1 → ~100/s; at t=1.5 expect ≈150.
    expect(e.run(ctx(1.5)).value).toBeCloseTo(150, 0);
    expect(e.run(ctx(0.5)).value).toBeCloseTo(50); // inside span unchanged
  });

  it("loopIn('continue') extrapolates before the first key", () => {
    const e = compileExpression("loopIn('continue')");
    expect(e.run(ctx(-0.5)).value).toBeCloseTo(-50, 0);
  });

  it("loopIn('cycle'/'pingpong'/'offset') maps time before the first keyframe", () => {
    expect(compileExpression("loopIn('cycle')").run(ctx(-0.5)).value).toBeCloseTo(50);
    expect(compileExpression("loopIn('cycle')").run(ctx(-1.25)).value).toBeCloseTo(75);
    expect(compileExpression("loopIn('pingpong')").run(ctx(-0.5)).value).toBeCloseTo(50);
    expect(compileExpression("loopIn('pingpong')").run(ctx(-1.5)).value).toBeCloseTo(50);
    expect(compileExpression("loopIn('offset')").run(ctx(-0.5)).value).toBeCloseTo(-50); // 50 − 1×100
    expect(compileExpression("loopIn('offset')").run(ctx(-1.0)).value).toBeCloseTo(-100);
    // At/after the first keyframe loopIn is a pass-through.
    expect(compileExpression("loopIn('cycle')").run(ctx(0.5)).value).toBeCloseTo(50);
  });

  it('loopOut/loopIn without a keyframe span return value unchanged', () => {
    expect(compileExpression("loopOut('cycle')").run({ time: 9, value: 42 }).value).toBe(42);
    expect(compileExpression("loopIn('offset')").run({ time: -9, value: 42 }).value).toBe(42);
  });

  it('is deterministic: identical context → identical result', () => {
    const e = compileExpression("loopOut('offset') + valueAtTime(0.5) + wiggle(2, 30)");
    const a = e.run(ctx(3.3)).value;
    const b = e.run(ctx(3.3)).value;
    expect(a).toBe(b);
    expect(typeof a).toBe('number');
  });
});

describe('expression API v3 (thisComp, ease, 5-arg wiggle)', () => {
  it('provides thisComp properties and layer accessors', () => {
    const e = compileExpression('thisComp.width + thisComp.fps');
    expect(e.run({ time: 0, value: 0, comp: { width: 1920, height: 1080, duration: 10, fps: 60, numLayers: 5 } }).value).toBe(1980);
  });

  it('provides timeToFrames and framesToTime helpers', () => {
    const e1 = compileExpression('timeToFrames(1.5)');
    expect(e1.run({ time: 1.5, value: 0, comp: { width: 1920, height: 1080, duration: 10, fps: 60, numLayers: 1 } }).value).toBe(90);

    const e2 = compileExpression('framesToTime(120)');
    expect(e2.run({ time: 0, value: 0, comp: { width: 1920, height: 1080, duration: 10, fps: 60, numLayers: 1 } }).value).toBe(2);
  });

  it('supports ease, easeIn, easeOut with 5 arguments and 3 arguments', () => {
    const e = compileExpression('ease(time, 0, 2, 10, 20)');
    expect(e.run({ time: 1, value: 0 }).value).toBe(15); // middle of smoothstep is 0.5

    const e3 = compileExpression('linear(time, 10, 20)');
    expect(e3.run({ time: 0.5, value: 0 }).value).toBe(15);
  });

  it('supports 5-arg wiggle arity', () => {
    const e = compileExpression('wiggle(2, 30, 3, 0.5, 1.0)');
    const res = e.run({ time: 0, value: 100 });
    expect(res.error).toBeNull();
    expect(typeof res.value).toBe('number');
  });

  it('provides velocity, speed, and velocityAtTime properties', () => {
    // If selfAt returns 100 * t, velocity should be 100
    const selfAt = (t: number) => 100 * t;
    const e = compileExpression('velocity + speed + velocityAtTime(2)');
    const res = e.run({ time: 1, value: 100, selfAt });
    expect(res.value).toBeCloseTo(300);
  });

  it('provides thisLayer and thisProperty properties', () => {
    const e = compileExpression('thisLayer.width + thisProperty.valueAtTime(0)');
    const res = e.run({
      time: 1,
      value: 50,
      layerInfo: { name: 'Title', width: 800, height: 600 },
      selfAt: (t) => (t === 0 ? 20 : 50),
    });
    expect(res.value).toBe(820);
  });
});
