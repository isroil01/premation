/**
 * The two text draw paths must land on the same pixels.
 *
 * ## The bug
 *
 * `Canvas2DVectorRasterizer` has two paths. Static text draws as one `fillText`
 * per line, which is kerned by the browser. Text with any animator draws glyph
 * by glyph, and `layoutText` was summing per-character widths — which discards
 * kerning entirely, because kerning is a property of a PAIR and there is no pair
 * in a one-character measurement.
 *
 * Measured on `JOIN THE REVOLUTION` at 129px/900: whole-string 1676px, per-glyph
 * sum 1684px. Eight pixels, accumulating left to right, independent of
 * letter-spacing.
 *
 * That is not a rounding complaint. Any frame that composites both paths —
 * a cached texture crossfading into a freshly drawn one when an animator turns
 * on — superimposes the same string at two spacings. Rendered and counted, that
 * produces 71 ink runs of 1px against 17 runs at 29px minimum for a single clean
 * draw: a picket fence of vertical bars through the letterforms, densest on the
 * right where the drift has accumulated most.
 *
 * The fix is `LayoutOptions.measureRun`: measure cumulative prefixes and take
 * differences, which recovers the true advances with kerning intact.
 *
 * ## Why these tests use a synthetic measurer
 *
 * jsdom has no font metrics — `measureText` returns 0 for everything, so a real
 * kerning check is impossible here. Instead the fake measurer MODELS kerning:
 * specific pairs are narrower than the sum of their parts, exactly as a real
 * font behaves. If `layoutText` ignores the run measurer, that modelled kerning
 * vanishes and the assertions fail — which is the property under test.
 */

import { layoutText, type ParagraphStyle, type TextStyle } from './textLayout';

const base: TextStyle & ParagraphStyle = {
  fontSize: 100,
  fontFamily: 'Test',
  fontWeight: '900',
  letterSpacing: 0,
  lineHeight: 1.2,
  fill: '#fff',
  align: 'center',
};

/** Every glyph is 50 wide. */
const GLYPH_W = 50;
/** These pairs tuck by 8px, the way a real display face kerns. */
const KERN_PAIRS: Record<string, number> = { AV: -8, VA: -8, To: -8, EV: -8, LT: -8 };

const measureGlyph = (): number => GLYPH_W;

/** Whole-string width WITH kerning — what a real browser would return. */
const measureRun = (text: string): number => {
  let w = text.length * GLYPH_W;
  for (let i = 1; i < text.length; i++) w += KERN_PAIRS[text.slice(i - 1, i + 1)] ?? 0;
  return w;
};

/** Sum of the laid-out advances — what the per-glyph path actually produces. */
function laidWidth(text: string, opts: Parameters<typeof layoutText>[3]): number {
  return layoutText(text, base, measureGlyph, opts).glyphs.reduce((s, g) => s + g.advance, 0);
}

describe('kerning agreement between the two text paths', () => {
  it('the fake measurer actually models kerning (guards the test itself)', () => {
    // Without this, every assertion below could pass on a measurer that has no
    // kerning to lose — which is exactly how the real bug went unnoticed.
    expect(measureRun('AV')).toBe(2 * GLYPH_W - 8);
    expect(measureRun('AB')).toBe(2 * GLYPH_W);
  });

  it('per-glyph advances sum to the kerned whole-string width', () => {
    const text = 'AVATAR';
    expect(laidWidth(text, { boxWidth: 1000, measureRun })).toBeCloseTo(measureRun(text), 4);
  });

  it('reproduces the original 8px-class drift when measureRun is absent', () => {
    // The old behaviour, pinned so the regression is legible rather than folklore.
    const text = 'AVATAR';
    const unkerned = laidWidth(text, { boxWidth: 1000 });
    expect(unkerned).toBeGreaterThan(measureRun(text));
    // AVATAR kerns twice — 'AV' at 0-1 and 'VA' at 1-2 — so the drift is 16px,
    // not 8. The overlapping-pair case is the one worth pinning: drift
    // accumulates per PAIR, which is why a long headline diverges far more than
    // a short one and why the artifact was worst on the right of the string.
    expect(unkerned - measureRun(text)).toBe(16);
  });

  it('holds for a string with several kern pairs', () => {
    const text = 'LTAVTo';
    expect(laidWidth(text, { boxWidth: 1000, measureRun })).toBeCloseTo(measureRun(text), 4);
  });

  it('letter-spacing is not double-counted', () => {
    // The kerned advance already carries the style's spacing, because the run is
    // measured with spacing applied. Adding it again would widen every glyph.
    const spaced = { ...base, letterSpacing: 5 };
    const runWithSpacing = (t: string): number => measureRun(t) + t.length * 5;
    const laid = layoutText('AVATAR', spaced, measureGlyph, {
      boxWidth: 1000,
      measureRun: runWithSpacing,
    });
    const total = laid.glyphs.reduce((s, g) => s + g.advance, 0);
    expect(total).toBeCloseTo(runWithSpacing('AVATAR'), 4);
  });

  it('kerns each line independently — a newline breaks the pair', () => {
    // 'V\nA' must NOT kern across the break: they are not adjacent on screen.
    const laid = layoutText('AV\nVA', base, measureGlyph, { boxWidth: 1000, measureRun });
    const line0 = laid.glyphs.filter((g) => g.line === 0).reduce((s, g) => s + g.advance, 0);
    const line1 = laid.glyphs.filter((g) => g.line === 1).reduce((s, g) => s + g.advance, 0);
    expect(line0).toBeCloseTo(measureRun('AV'), 4);
    expect(line1).toBeCloseTo(measureRun('VA'), 4);
  });

  it('still lays out when no run measurer is given', () => {
    // Headless backends and jsdom have no real metrics; they must degrade to the
    // per-glyph sum rather than throw or produce NaN.
    const laid = layoutText('AVATAR', base, measureGlyph, { boxWidth: 1000 });
    expect(laid.glyphs).toHaveLength(6);
    for (const g of laid.glyphs) expect(Number.isFinite(g.advance)).toBe(true);
  });

  it('a substituted glyph is measured as the glyph that will be DRAWN', () => {
    // Character Offset swaps 'l' for 'W'. Measuring the original would leave the
    // line short by the difference and everything after it creeping left.
    const transforms = [
      undefined,
      { displayChar: 'W' } as never,
    ] as never as Parameters<typeof layoutText>[3]['transforms'];
    const seen: string[] = [];
    layoutText('AB', base, measureGlyph, {
      boxWidth: 1000,
      transforms,
      measureRun: (t) => {
        seen.push(t);
        return measureRun(t);
      },
    });
    // The prefix for index 1 must be built from the DRAWN characters.
    expect(seen).toContain('AW');
    expect(seen).not.toContain('AB');
  });

  it('advances stay positive, so glyphs never render back-to-front', () => {
    const laid = layoutText('AVAVAV', base, measureGlyph, { boxWidth: 1000, measureRun });
    for (const g of laid.glyphs) expect(g.advance).toBeGreaterThan(0);
    const xs = laid.glyphs.map((g) => g.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
  });
});
