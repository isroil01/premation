/**
 * The 'vert' alias probe: an alias counts only when it really turns 「.
 */

import { probeVerticalAlternates,  withVerticalAlternates } from './fontFaceVariants';

/** A context whose 「 ink box is wide (vertical form) in `vertFamily`, tall otherwise. */
const ctxFor = (vertFamily: string | null, metrics = true) => {
  const c = {
    font: '',
    measureText: (): TextMetrics => {
      const wide = vertFamily !== null && c.font.includes(`"${vertFamily}"`);
      if (!metrics) return { width: 100 } as TextMetrics;
      return {
        width: 100,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: wide ? 60 : 30,
        actualBoundingBoxAscent: wide ? 20 : 40,
        actualBoundingBoxDescent: wide ? 10 : 20,
      } as TextMetrics;
    },
  };
  return c;
};

describe('vertical alternates alias', () => {
  it('adds vert (not vrt2) to the layer features', () => {
    expect(withVerticalAlternates(undefined)).toBe(`'vert' 1`);
    expect(withVerticalAlternates(`'liga' 0`)).toBe(`'liga' 0, 'vert' 1`);
  });

  it('passes an alias that turns the bracket', () => {
    expect(probeVerticalAlternates('alias', 'Yu Gothic', {}, ctxFor('alias'))).toBe(true);
  });

  it('fails an alias that changes nothing (the font has no vert, or CJK came from fallback)', () => {
    expect(probeVerticalAlternates('alias', 'Inter', {}, ctxFor(null))).toBe(false);
  });

  it('fails without ink metrics or a canvas', () => {
    expect(probeVerticalAlternates('alias', 'Yu Gothic', {}, ctxFor('alias', false))).toBe(false);
    expect(probeVerticalAlternates('alias', 'Yu Gothic', {}, null)).toBe(false);
  });
});
