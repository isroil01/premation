import {
  unitPositions,
  evaluateTextAnimators,
  animatorPropPath,
  selectorPropPath,
  normalizeAnimator,
  offsetCharacter,
  defaultRangeSelector,
  defaultWigglySelector,
  defaultExpressionSelector,
  mixHex,
  type ResolvedAnimator,
  type TextAnimatorData,
} from './textAnimators';
import {
  rangeSelectorAt,
  wigglySelectorAt,
  shapeFalloff,
  applyEase,
  combineWeights,
  orderPermutation,
  softWindow,
  type RangeSelectorData,
  type SelectorData,
} from './textSelectors';

/** A range selector with hard edges — the old inline selector's behaviour, and
 *  the easiest thing to assert exact numbers against. */
function range(patch: Partial<RangeSelectorData> = {}): RangeSelectorData {
  return { ...defaultRangeSelector(), smoothness: 0, ...patch };
}

/** A no-op animator (covers everything, changes nothing) to spread onto. */
function anim(patch: Partial<ResolvedAnimator> = {}): ResolvedAnimator {
  return {
    enabled: true,
    selectors: [range()],
    x: 0,
    y: 0,
    z: 0,
    scale: 100,
    scaleY: 100,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    opacity: 100,
    fillOpacity: 100,
    tracking: 0,
    lineSpacing: 0,
    characterOffset: 0,
    blur: 0,
    skew: 0,
    strokeWidth: 0,
    ...patch,
  };
}

/** `rangeSelectorAt` takes a unit index; the old helper took a 0..1 position.
 *  This bridges the two so the window assertions stay readable. */
function weightAt(u: number, count: number, patch: Partial<RangeSelectorData>): number {
  return rangeSelectorAt(range(patch), u, count);
}

describe('shapeFalloff', () => {
  it('square is flat across the window', () => {
    expect(shapeFalloff(0, 'square')).toBe(1);
    expect(shapeFalloff(1, 'square')).toBe(1);
  });

  it('rampUp goes 0→1; rampDown is its mirror', () => {
    expect(shapeFalloff(0, 'rampUp')).toBeCloseTo(0);
    expect(shapeFalloff(0.5, 'rampUp')).toBeCloseTo(0.5);
    expect(shapeFalloff(1, 'rampUp')).toBeCloseTo(1);
    expect(shapeFalloff(0.25, 'rampDown')).toBeCloseTo(0.75);
  });

  it('triangle peaks at the centre', () => {
    expect(shapeFalloff(0.5, 'triangle')).toBeCloseTo(1);
    expect(shapeFalloff(0, 'triangle')).toBeCloseTo(0);
    expect(shapeFalloff(0.25, 'triangle')).toBeCloseTo(0.5);
  });

  it('round/smooth stay within [0,1] and peak in the middle', () => {
    for (const shape of ['round', 'smooth'] as const) {
      const mid = shapeFalloff(0.5, shape);
      const edge = shapeFalloff(0.02, shape);
      expect(mid).toBeGreaterThan(edge);
      expect(mid).toBeLessThanOrEqual(1);
      expect(edge).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('range selector window', () => {
  it('square covers the whole window and nothing outside', () => {
    // 10 units: centres are 0.5, 1.5 … 9.5, i.e. 5%, 15% … 95%.
    expect(weightAt(5, 10, {})).toBe(1);
    expect(weightAt(5, 10, { end: 40 })).toBe(0); // centre 55% > 40%
    expect(weightAt(2, 10, { end: 40 })).toBe(1); // centre 25% < 40%
  });

  it('returns 0 for an empty selection (start === end)', () => {
    expect(weightAt(5, 10, { start: 50, end: 50 })).toBe(0);
  });

  it('offset shifts the window — the parameter you keyframe', () => {
    expect(weightAt(7, 10, { end: 40, offset: 50 })).toBe(1); // → [50,90]
    expect(weightAt(2, 10, { end: 40, offset: 50 })).toBe(0);
  });

  it('index units address units directly instead of percentages', () => {
    const sel = range({ units: 'index', start: 1, end: 3 });
    expect(rangeSelectorAt(sel, 0, 10)).toBe(0);
    expect(rangeSelectorAt(sel, 1, 10)).toBe(1);
    expect(rangeSelectorAt(sel, 2, 10)).toBe(1);
    expect(rangeSelectorAt(sel, 3, 10)).toBe(0); // centre 3.5 > 3
  });

  it('amount scales the whole selector output', () => {
    expect(weightAt(5, 10, { amount: 50 })).toBeCloseTo(0.5);
    expect(weightAt(5, 10, { amount: 0 })).toBe(0);
  });

  it('smoothness softens a square edge instead of cutting it', () => {
    // Unit 5 of 10 has its centre at 5.5, so a window ending at 55% lands the
    // edge exactly on it: hard includes it whole, a one-unit-wide soft edge
    // leaves it half covered.
    const hard = rangeSelectorAt(range({ end: 55, smoothness: 0 }), 5, 10);
    const soft = rangeSelectorAt(
      { ...defaultRangeSelector(), end: 55, smoothness: 100 },
      5,
      10,
    );
    expect(hard).toBe(1);
    expect(soft).toBeCloseTo(0.5, 5);
    // …and the unit past the edge is fully out either way.
    expect(rangeSelectorAt(range({ end: 55, smoothness: 0 }), 7, 10)).toBe(0);
    expect(
      rangeSelectorAt({ ...defaultRangeSelector(), end: 55, smoothness: 100 }, 7, 10),
    ).toBe(0);
  });

  it('randomizeOrder scrambles which unit lands where without changing coverage', () => {
    const plain = range({ end: 50 });
    const shuffled = range({ end: 50, randomizeOrder: true, randomSeed: 7 });
    const cover = (s: RangeSelectorData): number =>
      Array.from({ length: 10 }, (_, i) => rangeSelectorAt(s, i, 10)).reduce((a, b) => a + b, 0);
    expect(cover(shuffled)).toBeCloseTo(cover(plain));
    const a = Array.from({ length: 10 }, (_, i) => rangeSelectorAt(plain, i, 10));
    const b = Array.from({ length: 10 }, (_, i) => rangeSelectorAt(shuffled, i, 10));
    expect(b).not.toEqual(a);
  });
});

describe('softWindow', () => {
  it('is a hard cut at edge 0', () => {
    expect(softWindow(1.5, 0, 3, 0)).toBe(1);
    expect(softWindow(3.5, 0, 3, 0)).toBe(0);
  });

  it('is half covered exactly on the edge when soft', () => {
    expect(softWindow(3, 0, 3, 1)).toBeCloseTo(0.5);
  });
});

describe('applyEase', () => {
  it('is the identity at 0/0 so untouched selectors are unchanged', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      expect(applyEase(v, 0, 0)).toBeCloseTo(v, 4);
    }
  });

  it('easeLow flattens the start of the falloff', () => {
    expect(applyEase(0.25, 0, 100)).toBeLessThan(0.25);
  });

  it('easeHigh flattens the end of the falloff', () => {
    expect(applyEase(0.75, 100, 0)).toBeGreaterThan(0.75);
  });

  it('stays inside [0,1]', () => {
    for (const eh of [-100, 0, 100]) {
      for (const el of [-100, 0, 100]) {
        for (const v of [0, 0.5, 1]) {
          const r = applyEase(v, eh, el);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('orderPermutation', () => {
  it('is a permutation and stable for a seed', () => {
    const p = orderPermutation(8, 3);
    expect([...p].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(orderPermutation(8, 3)).toEqual(p);
  });

  it('different seeds give different orders', () => {
    expect(orderPermutation(16, 1)).not.toEqual(orderPermutation(16, 2));
  });
});

describe('combineWeights', () => {
  it('implements every AE combine mode', () => {
    expect(combineWeights(0.5, 0.25, 'add')).toBeCloseTo(0.75);
    expect(combineWeights(0.5, 0.25, 'subtract')).toBeCloseTo(0.25);
    expect(combineWeights(0.5, 0.5, 'intersect')).toBeCloseTo(0.25);
    expect(combineWeights(0.5, 0.25, 'min')).toBeCloseTo(0.25);
    expect(combineWeights(0.5, 0.25, 'max')).toBeCloseTo(0.5);
    expect(combineWeights(0.25, 0.5, 'difference')).toBeCloseTo(0.25);
  });
});

describe('unitPositions', () => {
  it('characters map one-to-one', () => {
    expect(unitPositions('abc', 'characters')).toEqual({ count: 3, unitOfChar: [0, 1, 2] });
  });

  it('charactersExcludingSpaces skips spaces entirely', () => {
    const r = unitPositions('ab cd', 'charactersExcludingSpaces');
    expect(r.count).toBe(4);
    expect(r.unitOfChar).toEqual([0, 1, -1, 2, 3]);
  });

  it('words group runs of non-space, spaces stay with the prior word', () => {
    const r = unitPositions('ab cd', 'words');
    expect(r.count).toBe(2);
    expect(r.unitOfChar).toEqual([0, 0, 0, 1, 1]);
  });

  it('lines split on newline', () => {
    const r = unitPositions('a\nbc', 'lines');
    expect(r.count).toBe(2);
    expect(r.unitOfChar).toEqual([0, 0, 1, 1]);
  });
});

describe('evaluateTextAnimators', () => {
  it('with no animators every glyph is identity', () => {
    const g = evaluateTextAnimators('Hi', []);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ char: 'H', dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1 });
  });

  it('a full-coverage square offset moves every glyph equally', () => {
    const g = evaluateTextAnimators('AB', [anim({ x: 10, y: -5 })]);
    expect(g[0]!.dx).toBe(10);
    expect(g[1]!.dx).toBe(10);
    expect(g[0]!.dy).toBe(-5);
  });

  it('scale and opacity are lerped by the selector weight', () => {
    // rampUp over 2 chars: centres 0.5/2 and 1.5/2 → weights 0.25, 0.75
    const g = evaluateTextAnimators('AB', [
      anim({ selectors: [range({ shape: 'rampUp' })], scale: 200, scaleY: 200, opacity: 0 }),
    ]);
    expect(g[0]!.scale).toBeCloseTo(1.25);
    expect(g[1]!.scale).toBeCloseTo(1.75);
    expect(g[0]!.opacity).toBeCloseTo(0.75);
    expect(g[1]!.opacity).toBeCloseTo(0.25);
  });

  it('a narrowed window leaves out-of-range glyphs untouched', () => {
    const g = evaluateTextAnimators('ABCDE', [anim({ selectors: [range({ end: 40 })], x: 100 })]);
    expect(g[0]!.dx).toBe(100);
    expect(g[1]!.dx).toBe(100);
    expect(g[2]!.dx).toBe(0);
    expect(g[4]!.dx).toBe(0);
  });

  it('multiple animators accumulate (add offsets, multiply scale)', () => {
    const g = evaluateTextAnimators('A', [
      anim({ x: 10, scale: 200, scaleY: 200 }),
      anim({ x: 5, scale: 150, scaleY: 150 }),
    ]);
    expect(g[0]!.dx).toBe(15);
    expect(g[0]!.scale).toBeCloseTo(3);
  });

  it('a disabled animator contributes nothing', () => {
    const g = evaluateTextAnimators('A', [anim({ x: 10, enabled: false })]);
    expect(g[0]!.dx).toBe(0);
  });

  it('word-based selector animates whole words together', () => {
    const g = evaluateTextAnimators('ab cd', [
      anim({ selectors: [range({ basedOn: 'words', end: 50 })], y: 20 }),
    ]);
    expect(g[0]!.dy).toBe(20);
    expect(g[1]!.dy).toBe(20);
    expect(g[3]!.dy).toBe(0);
    expect(g[4]!.dy).toBe(0);
  });

  it('carries a colour + mix when a colour offset is set', () => {
    const g = evaluateTextAnimators('A', [anim({ color: '#ff0000' })]);
    expect(g[0]!.color).toBe('#ff0000');
    expect(g[0]!.colorMix).toBeCloseTo(1);
  });

  it('two selectors combine by the second selector mode', () => {
    // Left half AND right-of-30% → units whose centre is in [30,50].
    const g = evaluateTextAnimators('ABCDEFGHIJ', [
      anim({
        selectors: [range({ end: 50 }), range({ start: 30, end: 100, mode: 'intersect' })],
        x: 100,
      }),
    ]);
    const dx = g.map((t) => t.dx);
    expect(dx).toEqual([0, 0, 0, 100, 100, 0, 0, 0, 0, 0]);
  });

  it('subtract carves a hole out of a wider selection', () => {
    const g = evaluateTextAnimators('ABCD', [
      anim({
        selectors: [range({}), range({ start: 25, end: 75, mode: 'subtract' })],
        x: 100,
      }),
    ]);
    expect(g.map((t) => t.dx)).toEqual([100, 0, 0, 100]);
  });

  it('character offset walks a glyph through its own alphabet', () => {
    const g = evaluateTextAnimators('aZ9', [anim({ characterOffset: 1 })]);
    expect(g.map((t) => t.displayChar)).toEqual(['b', 'A', '0']);
  });

  it('stroke width and blur accumulate weighted', () => {
    const g = evaluateTextAnimators('ab', [anim({ strokeWidth: 4, blur: 6, strokeColor: '#0f0' })]);
    expect(g[0]!.strokeWidth).toBeCloseTo(4);
    expect(g[0]!.blur).toBeCloseTo(6);
    expect(g[0]!.strokeColor).toBe('#0f0');
  });

  it('fill opacity is independent of opacity', () => {
    const g = evaluateTextAnimators('a', [anim({ fillOpacity: 0 })]);
    expect(g[0]!.fillOpacity).toBeCloseTo(0);
    expect(g[0]!.opacity).toBeCloseTo(1);
  });
});

describe('wiggly selector', () => {
  const sel = { ...defaultWigglySelector(), correlation: 0, randomSeed: 1 };

  it('is deterministic and inside [min,max]', () => {
    for (let u = 0; u < 5; u++) {
      for (const t of [0, 0.33, 1.5, 7.2]) {
        const a = wigglySelectorAt(sel, u, t);
        expect(a).toBe(wigglySelectorAt(sel, u, t));
        expect(a).toBeGreaterThanOrEqual(-1);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
  });

  it('different units wiggle differently when uncorrelated', () => {
    const vals = [0, 1, 2, 3, 4].map((u) => wigglySelectorAt(sel, u, 0.4));
    expect(new Set(vals.map((v) => v.toFixed(6))).size).toBeGreaterThan(2);
  });

  it('full correlation makes every unit move as one', () => {
    const locked = { ...sel, correlation: 100 };
    const vals = [0, 1, 2, 3, 4].map((u) => wigglySelectorAt(locked, u, 0.4));
    expect(new Set(vals.map((v) => v.toFixed(6))).size).toBe(1);
  });

  it('temporal phase shifts the noise in time', () => {
    const shifted = { ...sel, temporalPhase: 180 };
    expect(wigglySelectorAt(shifted, 0, 0.4)).not.toBeCloseTo(wigglySelectorAt(sel, 0, 0.4));
  });

  it('drives glyphs differently over time; a range selector does not', () => {
    const wiggly = anim({ selectors: [{ ...sel, mode: 'add' } as SelectorData], x: 100 });
    const a = evaluateTextAnimators('abcdef', [wiggly], 0.1);
    const b = evaluateTextAnimators('abcdef', [wiggly], 0.4);
    expect(a.map((g) => g.dx)).not.toEqual(b.map((g) => g.dx));
    const ranged = anim({ x: 100 });
    expect(evaluateTextAnimators('abcdef', [ranged], 0.1).map((g) => g.dx)).toEqual(
      evaluateTextAnimators('abcdef', [ranged], 0.4).map((g) => g.dx),
    );
  });

  it('unlocked dimensions wiggle X and Y independently', () => {
    const free = anim({
      selectors: [{ ...sel, lockDimensions: false, mode: 'add' } as SelectorData],
      x: 100,
      y: 100,
    });
    const g = evaluateTextAnimators('abcd', [free], 0.3);
    expect(g.some((t) => Math.abs(t.dx - t.dy) > 1e-6)).toBe(true);
  });
});

describe('expression selector', () => {
  it('drives the amount from a per-character function', () => {
    const sel: SelectorData = {
      ...defaultExpressionSelector(),
      mode: 'add',
      expression: 'textIndex / textTotal * 100',
    };
    const g = evaluateTextAnimators('ABCD', [anim({ selectors: [sel], x: 100 })]);
    expect(g.map((t) => Math.round(t.dx))).toEqual([0, 25, 50, 75]);
  });

  it('sees the incoming stack value as selectorValue', () => {
    const g = evaluateTextAnimators('ABCD', [
      anim({
        selectors: [
          range({ end: 50 }),
          { ...defaultExpressionSelector(), mode: 'intersect', expression: 'selectorValue * 0.5' },
        ],
        x: 100,
      }),
    ]);
    // First two covered at 1.0, halved by the expression, then intersected.
    expect(g[0]!.dx).toBeCloseTo(50);
    expect(g[2]!.dx).toBeCloseTo(0);
  });

  it('a broken expression contributes nothing rather than throwing', () => {
    const sel: SelectorData = {
      ...defaultExpressionSelector(),
      mode: 'add',
      expression: 'this is not an expression',
    };
    expect(() => evaluateTextAnimators('AB', [anim({ selectors: [sel], x: 100 })])).not.toThrow();
  });
});

describe('offsetCharacter', () => {
  it('wraps within an alphabet and leaves punctuation alone', () => {
    expect(offsetCharacter('a', 1)).toBe('b');
    expect(offsetCharacter('z', 1)).toBe('a');
    expect(offsetCharacter('Z', 1)).toBe('A');
    expect(offsetCharacter('9', 1)).toBe('0');
    expect(offsetCharacter('!', 5)).toBe('!');
    expect(offsetCharacter(' ', 5)).toBe(' ');
  });

  it('is the identity at 0', () => {
    expect(offsetCharacter('m', 0)).toBe('m');
  });
});

describe('legacy migration', () => {
  it('rebuilds a selector from the old inline fields', () => {
    const old = {
      id: 'a1',
      basedOn: 'words',
      shape: 'rampUp',
      start: 10,
      end: 60,
      offset: 5,
      x: 0,
      y: 0,
      scale: 100,
      rotation: 0,
      opacity: 100,
      tracking: 0,
    } as TextAnimatorData;
    const sel = normalizeAnimator(old).selectors![0] as RangeSelectorData;
    expect(sel.kind).toBe('range');
    expect(sel.basedOn).toBe('words');
    expect(sel.shape).toBe('rampUp');
    expect(sel.start).toBe(10);
    expect(sel.end).toBe(60);
    expect(sel.offset).toBe(5);
    // The old selector had no edge softening; keeping it at 0 means an existing
    // project renders exactly as it did.
    expect(sel.smoothness).toBe(0);
  });

  it('maps the old wiggly mode onto a wiggly selector', () => {
    const old = {
      id: 'a2', mode: 'wiggly', wiggleFreq: 5,
      x: 0, y: 0, scale: 100, rotation: 0, opacity: 100, tracking: 0,
    } as TextAnimatorData;
    const sel = normalizeAnimator(old).selectors![0]!;
    expect(sel.kind).toBe('wiggly');
    expect((sel as { wigglesPerSecond: number }).wigglesPerSecond).toBe(5);
  });

  it('fills in properties added after the animator was written', () => {
    const a = normalizeAnimator({ id: 'a3', x: 1, y: 2, scale: 100, rotation: 0, opacity: 100, tracking: 0 });
    expect(a.fillOpacity).toBe(100);
    expect(a.scaleY).toBe(100);
    expect(a.characterOffset).toBe(0);
    expect(a.enabled).toBe(true);
  });
});

describe('prop paths', () => {
  it('builds a stable per-index animator path', () => {
    expect(animatorPropPath(0, 'x')).toBe('ta.0.x');
    expect(animatorPropPath(2, 'rotation')).toBe('ta.2.rotation');
  });

  it('keeps selector 0 on its legacy paths so old projects keep animating', () => {
    expect(selectorPropPath(0, 0, 'offset')).toBe('ta.0.offset');
    expect(selectorPropPath(3, 0, 'start')).toBe('ta.3.start');
    expect(selectorPropPath(1, 0, 'wigglesPerSecond')).toBe('ta.1.wiggleFreq');
  });

  it('namespaces later selectors', () => {
    expect(selectorPropPath(0, 1, 'offset')).toBe('ta.0.s1.offset');
    expect(selectorPropPath(2, 3, 'amount')).toBe('ta.2.s3.amount');
  });

  it('gives selector-0 params with no legacy alias a namespaced path', () => {
    expect(selectorPropPath(0, 0, 'amount')).toBe('ta.0.s0.amount');
  });
});

describe('mixHex', () => {
  it('blends two colours by amount', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('falls back to the target when a colour is unparseable', () => {
    expect(mixHex(undefined, '#123456', 0.5)).toBe('#123456');
  });
});
