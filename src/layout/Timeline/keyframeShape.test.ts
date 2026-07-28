import { shapeOfEasing, keyframeShapes, keyframePaths, describeShapes } from './keyframeShape';

describe('shapeOfEasing — every easing maps to a family', () => {
  it('linear and absent easing are the diamond', () => {
    expect(shapeOfEasing('linear')).toBe('linear');
    expect(shapeOfEasing(undefined)).toBe('linear');
  });

  it('hold and step are the square', () => {
    expect(shapeOfEasing('hold')).toBe('hold');
    expect(shapeOfEasing('step')).toBe('hold');
  });

  it('auto and continuous bezier are the circle', () => {
    expect(shapeOfEasing('autoBezier')).toBe('auto');
    expect(shapeOfEasing('continuousBezier')).toBe('auto');
  });

  it('every eased kind is the hourglass', () => {
    for (const k of ['ease', 'easeIn', 'easeOut', 'easeInOut', 'bezier'] as const) {
      expect(shapeOfEasing(k)).toBe('ease');
    }
  });

  it('distinguishes the states the old three-shape glyph could not', () => {
    // The regression this fixes: linear, bezier and auto-bezier were all the
    // same diamond, so the timeline could not tell you what a keyframe did.
    const seen = new Set([
      shapeOfEasing('linear'),
      shapeOfEasing('bezier'),
      shapeOfEasing('autoBezier'),
      shapeOfEasing('hold'),
    ]);
    expect(seen.size).toBe(4);
  });
});

describe('keyframeShapes — the two sides are independent', () => {
  it('takes incoming from the previous segment and outgoing from its own', () => {
    expect(keyframeShapes('easeIn', 'hold')).toEqual({ left: 'ease', right: 'hold' });
  });

  it('a symmetric keyframe gets matching halves', () => {
    expect(keyframeShapes('linear', 'linear')).toEqual({ left: 'linear', right: 'linear' });
  });

  it('the first keyframe mirrors its outgoing side — it has no incoming segment', () => {
    // Otherwise every track's first key would falsely read as "linear in".
    expect(keyframeShapes(undefined, 'ease', { isFirst: true })).toEqual({ left: 'ease', right: 'ease' });
  });

  it('the last keyframe mirrors its incoming side', () => {
    expect(keyframeShapes('hold', undefined, { isLast: true })).toEqual({ left: 'hold', right: 'hold' });
  });

  it('a single-keyframe track is symmetric, not half-and-half', () => {
    expect(keyframeShapes(undefined, undefined, { isFirst: true, isLast: true })).toEqual({
      left: 'linear',
      right: 'linear',
    });
  });
});

describe('keyframePaths — geometry', () => {
  it('gives a distinct path per family, per side', () => {
    const families = ['linear', 'ease', 'auto', 'hold'] as const;
    const lefts = new Set(families.map((f) => keyframePaths(f, 'linear').left));
    const rights = new Set(families.map((f) => keyframePaths('linear', f).right));
    expect(lefts.size).toBe(4);
    expect(rights.size).toBe(4);
  });

  it('both halves meet on the vertical centre line, so any pair composes', () => {
    // Every path starts or ends at x=6 (the centre of the 12-wide viewBox).
    for (const f of ['linear', 'ease', 'auto', 'hold'] as const) {
      const { left, right } = keyframePaths(f, f);
      expect(left).toMatch(/6/);
      expect(right).toMatch(/6/);
    }
  });
});

describe('describeShapes — the tooltip', () => {
  it('names a symmetric keyframe once', () => {
    expect(describeShapes('linear', 'linear')).toBe('Linear');
    expect(describeShapes('hold', 'hold')).toBe('Hold');
  });

  it('spells out a split keyframe', () => {
    expect(describeShapes('ease', 'hold')).toBe('Eased in · Hold out');
  });
});
