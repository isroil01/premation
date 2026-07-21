import {
  rangeSelectorWeight,
  unitPositions,
  evaluateTextAnimators,
  animatorPropPath,
  mixHex,
  type ResolvedAnimator,
} from './textAnimators';

/** A no-op animator (covers everything, changes nothing) to spread onto. */
function anim(patch: Partial<ResolvedAnimator>): ResolvedAnimator {
  return {
    basedOn: 'characters',
    shape: 'square',
    mode: 'range',
    start: 0,
    end: 100,
    offset: 0,
    x: 0,
    y: 0,
    scale: 100,
    rotation: 0,
    opacity: 100,
    tracking: 0,
    skew: 0,
    wiggleFreq: 2,
    ...patch,
  };
}

describe('rangeSelectorWeight', () => {
  it('square covers the whole window and nothing outside', () => {
    expect(rangeSelectorWeight(0.5, 0, 100, 0, 'square')).toBe(1);
    expect(rangeSelectorWeight(0.5, 0, 40, 0, 'square')).toBe(0); // 0.5 > 0.4
    expect(rangeSelectorWeight(0.2, 0, 40, 0, 'square')).toBe(1);
  });

  it('returns 0 for an empty selection (start === end)', () => {
    expect(rangeSelectorWeight(0.5, 50, 50, 0, 'square')).toBe(0);
  });

  it('offset shifts the window', () => {
    // window [0,40] shifted +50 → [50,90]; u=0.7 now inside, u=0.2 now outside
    expect(rangeSelectorWeight(0.7, 0, 40, 50, 'square')).toBe(1);
    expect(rangeSelectorWeight(0.2, 0, 40, 50, 'square')).toBe(0);
  });

  it('rampUp goes 0→1 across the window; rampDown is its mirror', () => {
    expect(rangeSelectorWeight(0.0, 0, 100, 0, 'rampUp')).toBeCloseTo(0);
    expect(rangeSelectorWeight(0.5, 0, 100, 0, 'rampUp')).toBeCloseTo(0.5);
    expect(rangeSelectorWeight(1.0, 0, 100, 0, 'rampUp')).toBeCloseTo(1);
    expect(rangeSelectorWeight(0.25, 0, 100, 0, 'rampDown')).toBeCloseTo(0.75);
  });

  it('triangle peaks at the window centre', () => {
    expect(rangeSelectorWeight(0.5, 0, 100, 0, 'triangle')).toBeCloseTo(1);
    expect(rangeSelectorWeight(0.0, 0, 100, 0, 'triangle')).toBeCloseTo(0);
    expect(rangeSelectorWeight(0.25, 0, 100, 0, 'triangle')).toBeCloseTo(0.5);
  });

  it('round/smooth stay within [0,1] and peak in the middle', () => {
    for (const shape of ['round', 'smooth'] as const) {
      const mid = rangeSelectorWeight(0.5, 0, 100, 0, shape);
      const edge = rangeSelectorWeight(0.02, 0, 100, 0, shape);
      expect(mid).toBeGreaterThan(edge);
      expect(mid).toBeLessThanOrEqual(1);
      expect(edge).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('unitPositions', () => {
  it('characters map one-to-one', () => {
    expect(unitPositions('abc', 'characters')).toEqual({ count: 3, unitOfChar: [0, 1, 2] });
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
    // rampUp over 2 chars: positions 0.25 and 0.75 → weights 0.25, 0.75
    const g = evaluateTextAnimators('AB', [anim({ shape: 'rampUp', scale: 200, opacity: 0 })]);
    expect(g[0]!.scale).toBeCloseTo(1 + (2 - 1) * 0.25); // 1.25
    expect(g[1]!.scale).toBeCloseTo(1 + (2 - 1) * 0.75); // 1.75
    expect(g[0]!.opacity).toBeCloseTo(1 + (0 - 1) * 0.25); // 0.75
    expect(g[1]!.opacity).toBeCloseTo(0.25);
  });

  it('a narrowed window leaves out-of-range glyphs untouched', () => {
    // window [0,40]: only unit positions <= 0.4 are covered. For 5 chars the
    // cell centres are 0.1,0.3,0.5,0.7,0.9 → first two covered.
    const g = evaluateTextAnimators('ABCDE', [anim({ end: 40, x: 100 })]);
    expect(g[0]!.dx).toBe(100);
    expect(g[1]!.dx).toBe(100);
    expect(g[2]!.dx).toBe(0);
    expect(g[4]!.dx).toBe(0);
  });

  it('multiple animators accumulate (add offsets, multiply scale)', () => {
    const g = evaluateTextAnimators('A', [anim({ x: 10, scale: 200 }), anim({ x: 5, scale: 150 })]);
    expect(g[0]!.dx).toBe(15);
    expect(g[0]!.scale).toBeCloseTo(2 * 1.5); // 3
  });

  it('word-based selector animates whole words together', () => {
    // 'ab cd', window [0,50] over 2 words → word 0 (u=0.25) covered, word 1 (u=0.75) not
    const g = evaluateTextAnimators('ab cd', [anim({ basedOn: 'words', end: 50, y: 20 })]);
    expect(g[0]!.dy).toBe(20); // 'a'
    expect(g[1]!.dy).toBe(20); // 'b'
    expect(g[3]!.dy).toBe(0); // 'c'
    expect(g[4]!.dy).toBe(0); // 'd'
  });

  it('carries a colour + mix when a colour offset is set', () => {
    const g = evaluateTextAnimators('A', [anim({ color: '#ff0000' })]);
    expect(g[0]!.color).toBe('#ff0000');
    expect(g[0]!.colorMix).toBeCloseTo(1);
  });
});

describe('animatorPropPath', () => {
  it('builds a stable per-index prop path', () => {
    expect(animatorPropPath(0, 'x')).toBe('ta.0.x');
    expect(animatorPropPath(2, 'rotation')).toBe('ta.2.rotation');
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

describe('wiggly selector + skew', () => {
  const { wigglyWeight } = require('./textAnimators');

  it('wigglyWeight is deterministic and in [0,1]', () => {
    for (let u = 0; u < 5; u++) {
      for (const t of [0, 0.33, 1.5, 7.2]) {
        const a = wigglyWeight(u, t, 2);
        expect(a).toBe(wigglyWeight(u, t, 2));
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
  });

  it('different units wiggle differently at the same time', () => {
    const vals = [0, 1, 2, 3, 4].map((u) => wigglyWeight(u, 0.4, 2));
    expect(new Set(vals.map((v: number) => v.toFixed(6))).size).toBeGreaterThan(2);
  });

  it('wiggly mode varies glyph weights over time; range mode does not', () => {
    const wiggly = anim({ mode: 'wiggly', x: 100, wiggleFreq: 3 });
    const a = evaluateTextAnimators('abcdef', [wiggly], 0.1);
    const b = evaluateTextAnimators('abcdef', [wiggly], 0.4);
    expect(a.map((g) => g.dx)).not.toEqual(b.map((g) => g.dx));
    const ranged = anim({ x: 100 });
    expect(evaluateTextAnimators('abcdef', [ranged], 0.1).map((g) => g.dx))
      .toEqual(evaluateTextAnimators('abcdef', [ranged], 0.4).map((g) => g.dx));
  });

  it('skew accumulates weighted like rotation', () => {
    const g = evaluateTextAnimators('ab', [anim({ skew: 30 })], 0);
    expect(g[0]!.skew).toBeCloseTo(30);
    expect(g[1]!.skew).toBeCloseTo(30);
  });
});
