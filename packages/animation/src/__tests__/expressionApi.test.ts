/**
 * The expression API surface, round two.
 *
 * Two things are under test and the second matters as much as the first:
 *
 *   1. Each function returns the value it claims to.
 *   2. Each function is DISCOVERABLE. A function bound in `scope` but absent
 *      from the autocomplete table works perfectly and is invisible — no
 *      highlight, no completion, nothing to find it by. That is a model with no
 *      UI, which the project standard exists to prevent, and it was a live §2·0
 *      here: three independent lists (the `scope` Map, `API_NAMES` for
 *      highlighting, `EXPRESSION_API` for autocomplete) with nothing forcing
 *      agreement. `API_NAMES` is now derived; this file closes the third edge.
 */

import { compileExpression, tokenizeExpression, EXPRESSION_API, type ExprContext } from '../expressions';

const base: ExprContext = { time: 0, value: 0 };

/** Evaluate and return the numeric result, failing loudly on an error. */
function evalNum(src: string, ctx: Partial<ExprContext> = {}): number {
  const r = compileExpression(src).run({ ...base, ...ctx });
  if (r.error) throw new Error(`${src} → ${r.error}`);
  if (typeof r.value !== 'number') throw new Error(`${src} → not a number: ${JSON.stringify(r.value)}`);
  return r.value;
}

describe('sourceRectAtTime', () => {
  const rectCtx: Partial<ExprContext> = {
    sourceRectAt: (t, extents) => ({
      top: extents ? -20 : -10,
      left: extents ? -50 : -40,
      width: extents ? 100 : 80 + t * 10,
      height: extents ? 40 : 20,
    }),
  };

  it('returns an object whose fields read naturally', () => {
    expect(evalNum('sourceRectAtTime().width', rectCtx)).toBe(80);
    expect(evalNum('sourceRectAtTime().height', rectCtx)).toBe(20);
    expect(evalNum('sourceRectAtTime().left', rectCtx)).toBe(-40);
    expect(evalNum('sourceRectAtTime().top', rectCtx)).toBe(-10);
  });

  it('the TIME argument is honoured, not ignored', () => {
    // The commonest real rig — a plate sized from text that animates — is wrong
    // by a frame if `t` is dropped, and looks almost right, which is worse.
    expect(evalNum('sourceRectAtTime(0).width', rectCtx)).toBe(80);
    expect(evalNum('sourceRectAtTime(4).width', rectCtx)).toBe(120);
  });

  it('includeExtents selects the looser box', () => {
    expect(evalNum('sourceRectAtTime(0, true).width', rectCtx)).toBe(100);
    expect(evalNum('sourceRectAtTime(0, false).width', rectCtx)).toBe(80);
  });

  it('falls back to the layer box when no provider is wired', () => {
    // Never undefined: a missing rect mid-expression surfaces as a confusing
    // NaN rather than a useful error.
    expect(evalNum('sourceRectAtTime().width', { layerInfo: { name: 'L', width: 640, height: 360 } }))
      .toBe(640);
  });

  it('the auto-sizing plate idiom evaluates end to end', () => {
    expect(evalNum('sourceRectAtTime().width + 40', rectCtx)).toBe(120);
  });
});

describe('randomness', () => {
  it('random() ADVANCES — two calls in one expression differ', () => {
    // The property that makes `[random(), random()]` a random point rather than
    // the same number twice. The previous implementation was a pure hash of the
    // time and returned identical values, which quietly broke the common use.
    const r = compileExpression('random() - random()').run({ ...base, propSeed: 3 });
    expect(r.error).toBeNull();
    expect(r.value).not.toBe(0);
  });

  it('but is REPRODUCIBLE — the same frame evaluates identically twice', () => {
    // Scrubbing back to a frame must not shimmer, and export must match preview.
    const once = evalNum('random() + random()', { propSeed: 9 });
    const twice = evalNum('random() + random()', { propSeed: 9 });
    expect(once).toBe(twice);
  });

  it('seedRandom re-bases the sequence', () => {
    expect(evalNum('seedRandom(1) + random()')).not.toBe(evalNum('seedRandom(2) + random()'));
    expect(evalNum('seedRandom(5) + random()')).toBe(evalNum('seedRandom(5) + random()'));
  });

  it('random(max) and random(min, max) scale into range', () => {
    for (let i = 0; i < 20; i++) {
      const v = evalNum('random(10)', { propSeed: i });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
      const w = evalNum('random(100, 110)', { propSeed: i });
      expect(w).toBeGreaterThanOrEqual(100);
      expect(w).toBeLessThanOrEqual(110);
    }
  });

  it('gaussRandom is centred and spread, unlike a uniform draw', () => {
    let sum = 0; let extremes = 0;
    for (let i = 0; i < 400; i++) {
      const v = evalNum('gaussRandom()', { propSeed: i });
      sum += v;
      if (Math.abs(v) > 1) extremes++;
    }
    expect(Math.abs(sum / 400)).toBeLessThan(0.35);
    // A uniform −1..1 would never exceed 1; a normal distribution does ~32%.
    expect(extremes).toBeGreaterThan(40);
  });

  it('noise() is COHERENT — nearby inputs give nearby outputs', () => {
    // The distinction from random(), and the whole reason both exist.
    const a = evalNum('noise(3)');
    const b = evalNum('noise(3.001)');
    expect(Math.abs(a - b)).toBeLessThan(0.05);
    expect(Math.abs(a - evalNum('noise(40)'))).toBeGreaterThan(0.001);
    expect(a).toBeGreaterThanOrEqual(-1);
    expect(a).toBeLessThanOrEqual(1);
  });
});

describe('keyframe access', () => {
  const keyed: Partial<ExprContext> = {
    keyTimes: [0, 1.5, 4],
    selfAt: (t) => t * 100,
  };

  it('numKeys counts the track', () => {
    expect(evalNum('numKeys', keyed)).toBe(3);
    expect(evalNum('numKeys')).toBe(0);
  });

  it('key(n) is ONE-BASED, as AE numbers them', () => {
    expect(evalNum('key(1).time', keyed)).toBe(0);
    expect(evalNum('key(2).time', keyed)).toBe(1.5);
    expect(evalNum('key(3).time', keyed)).toBe(4);
    expect(evalNum('key(2).value', keyed)).toBe(150);
    expect(evalNum('key(2).index', keyed)).toBe(2);
  });

  it('key(n) clamps rather than throwing', () => {
    // `key(numKeys)` is the commonest call; an off-by-one must degrade, not
    // take the whole property down.
    expect(evalNum('key(0).time', keyed)).toBe(0);
    expect(evalNum('key(99).time', keyed)).toBe(4);
  });

  it('nearestKey picks by distance, not by index', () => {
    expect(evalNum('nearestKey(1.4).time', keyed)).toBe(1.5);
    expect(evalNum('nearestKey(0.2).time', keyed)).toBe(0);
    expect(evalNum('nearestKey(10).time', keyed)).toBe(4);
    // Exactly between 1.5 and 4 → 2.75; nearer 1.5 at 2.7.
    expect(evalNum('nearestKey(2.7).time', keyed)).toBe(1.5);
  });
});

describe('posterizeTime', () => {
  it('steps the clock', () => {
    expect(evalNum('posterizeTime(4, 1.9)')).toBeCloseTo(1.75, 6);
    expect(evalNum('posterizeTime(2, 1.9)')).toBeCloseTo(1.5, 6);
  });

  it('zero or negative fps is a pass-through, not a division by zero', () => {
    expect(evalNum('posterizeTime(0, 2.3)')).toBe(2.3);
  });

  it('composes with wiggle, the idiomatic use', () => {
    const a = evalNum('wiggle(3, 40, 1, 0.5, posterizeTime(6, 1.0))', { time: 1.0, propSeed: 2 });
    const b = evalNum('wiggle(3, 40, 1, 0.5, posterizeTime(6, 1.1))', { time: 1.1, propSeed: 2 });
    // 1.0 and 1.1 fall in the same 1/6s step, so the wiggle must not move.
    expect(a).toBe(b);
  });
});

describe('vector maths', () => {
  it('dot and cross', () => {
    expect(evalNum('dot([1, 2, 3], [4, 5, 6])')).toBe(32);
    expect(evalNum('cross([1, 0, 0], [0, 1, 0])[2]')).toBe(1);
    // 2-vectors take z=0, so this is defined rather than an error.
    expect(evalNum('cross([1, 0], [0, 1])[2]')).toBe(1);
  });

  it('length, in both AE forms', () => {
    expect(evalNum('length([3, 4])')).toBe(5);
    expect(evalNum('length([0, 0], [3, 4])')).toBe(5);
  });

  it('normalize returns a unit vector, and zero does not divide by zero', () => {
    expect(evalNum('length(normalize([3, 4]))')).toBeCloseTo(1, 9);
    expect(evalNum('length(normalize([0, 0]))')).toBe(0);
  });

  it('add/sub/mul/div work componentwise', () => {
    expect(evalNum('add([10, 20], [1, 2])[1]')).toBe(22);
    expect(evalNum('sub([10, 20], [1, 2])[0]')).toBe(9);
    expect(evalNum('mul([10, 20], [2, 3])[1]')).toBe(60);
    expect(evalNum('div([10, 20], [2, 4])[1]')).toBe(5);
  });

  it('a scalar BROADCASTS across the vector rather than padding with zero', () => {
    // `add([10,20], 5)` means "add 5 to both". Padding the short operand with 0
    // would silently leave the second component untouched — a wrong answer that
    // looks like a right one on the first component.
    expect(evalNum('add([10, 20], 5)[0]')).toBe(15);
    expect(evalNum('add([10, 20], 5)[1]')).toBe(25);
    expect(evalNum('mul([10, 20], 2)[1]')).toBe(40);
  });

  it('division by zero yields 0 rather than Infinity', () => {
    // Infinity propagates into a transform and produces an invisible layer with
    // no error anywhere.
    expect(evalNum('div([10, 20], 0)[0]')).toBe(0);
  });
});

describe('errors surface per property rather than returning zero silently', () => {
  it('an unknown name is an error, not 0', () => {
    const r = compileExpression('nosuchfunction(1)').run(base);
    expect(r.value).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('calling a non-function is an error, not 0', () => {
    const r = compileExpression('numKeys(3)').run(base);
    expect(r.value).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('a syntax error is reported at compile time', () => {
    expect(compileExpression('add([1,2], ').compileError).toBeTruthy();
  });

  it('a non-numeric result is rejected rather than coerced', () => {
    const r = compileExpression('sourceRectAtTime()').run({
      ...base,
      sourceRectAt: () => ({ top: 0, left: 0, width: 5, height: 5 }),
    });
    // An object is not a valid property value; returning 0 here would make a
    // typo'd `.width` look like a working expression pinned at zero.
    expect(r.value).toBeNull();
    expect(r.error).toBeTruthy();
  });
});

describe('§2·0 — every function is discoverable', () => {
  /**
   * The names actually bound in `run`'s scope, recovered by probing: a name in
   * scope resolves, a name outside it raises "Unknown name".
   *
   * Probing rather than exporting the Map keeps the authority where it belongs
   * (inside `run`, where the closures live) instead of adding a fourth list to
   * keep in sync — which is the very defect under test.
   */
  function isBound(name: string): boolean {
    const r = compileExpression(name).run(base);
    return !(r.error && /Unknown name/.test(r.error));
  }

  const ROUND_TWO = [
    'sourceRectAtTime', 'seedRandom', 'gaussRandom', 'noise',
    'numKeys', 'key', 'nearestKey', 'posterizeTime',
    'add', 'sub', 'mul', 'div', 'dot', 'cross', 'length', 'normalize',
  ];

  it.each(ROUND_TWO)('%s is bound in scope', (name) => {
    expect(isBound(name)).toBe(true);
  });

  it.each(ROUND_TWO)('%s appears in the autocomplete table', (name) => {
    const labels = EXPRESSION_API.map((a) => a.label.replace(/\(\)$/, ''));
    expect(labels).toContain(name);
  });

  it('every autocomplete entry names something that really exists', () => {
    // The other direction: an entry for a function that was renamed or removed
    // offers the user a completion that errors the moment they accept it.
    for (const entry of EXPRESSION_API) {
      const name = entry.label.replace(/\(\)$/, '');
      expect({ name, bound: isBound(name) }).toEqual({ name, bound: true });
    }
  });

  it('the tokenizer highlights every documented name', () => {
    // API_NAMES is derived from EXPRESSION_API, so this is mostly structural —
    // it catches a future edit that reintroduces a hand-written list.
    for (const entry of EXPRESSION_API) {
      const name = entry.label.replace(/\(\)$/, '');
      const tokens = tokenizeExpression(name);
      expect({ name, kind: tokens[0]?.kind }).toEqual({ name, kind: 'api' });
    }
  });

  it('every autocomplete snippet actually compiles', () => {
    // A completion that inserts a syntax error is worse than no completion.
    for (const entry of EXPRESSION_API) {
      expect({ insert: entry.insert, err: compileExpression(entry.insert).compileError })
        .toEqual({ insert: entry.insert, err: null });
    }
  });
});
