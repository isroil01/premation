import { layoutText, resolveGlyphStyle } from './textLayout';
import type { TextStyle } from './textLayout';
import { identityGlyphTransform, type GlyphTransform } from './textAnimators';

/**
 * A measure that makes arithmetic checkable by hand: every glyph is exactly as
 * wide as its font size. Real metrics are the canvas's job; layout's job is the
 * pen arithmetic, and that is what these tests pin.
 */
const measure = (_char: string, style: TextStyle): number => style.fontSize;

const base = { fontSize: 10, fill: '#ffffff' };

const glyph = (over: Partial<GlyphTransform> = {}): GlyphTransform =>
  identityGlyphTransform('x', over);

describe('resolveGlyphStyle', () => {
  it('returns the base style untouched when there are no runs', () => {
    expect(resolveGlyphStyle(base, undefined, 0)).toBe(base);
    expect(resolveGlyphStyle(base, [], 3)).toBe(base);
  });

  it('applies a run only within its half-open range', () => {
    const runs = [{ start: 1, end: 3, style: { fill: '#ff0000' } }];
    expect(resolveGlyphStyle(base, runs, 0).fill).toBe('#ffffff');
    expect(resolveGlyphStyle(base, runs, 1).fill).toBe('#ff0000');
    expect(resolveGlyphStyle(base, runs, 2).fill).toBe('#ff0000');
    // `end` is exclusive.
    expect(resolveGlyphStyle(base, runs, 3).fill).toBe('#ffffff');
  });

  it('layers overlapping runs last-wins per field, not wholesale', () => {
    const runs = [
      { start: 0, end: 4, style: { fill: '#ff0000' } },
      { start: 2, end: 4, style: { fontWeight: '700' } },
    ];
    // The bold run must not drop the red it sits on top of.
    expect(resolveGlyphStyle(base, runs, 3)).toMatchObject({
      fill: '#ff0000',
      fontWeight: '700',
    });
  });
});

describe('layoutText', () => {
  it('advances the pen by measured width plus letter spacing', () => {
    const l = layoutText('ab', { ...base, letterSpacing: 2 }, measure, { boxWidth: 100 });
    expect(l.glyphs.map((g) => g.advance)).toEqual([12, 12]);
    // Centres sit half an advance in from each glyph's left edge.
    expect(l.glyphs.map((g) => g.x)).toEqual([-44, -32]);
  });

  it('measures each glyph under its own run style', () => {
    // Regression guard: drawGlyphs used to measure the whole string under one
    // font, so everything after a size change landed in the wrong place.
    const l = layoutText('ab', base, measure, {
      boxWidth: 100,
      runs: [{ start: 1, end: 2, style: { fontSize: 30 } }],
    });
    expect(l.glyphs.map((g) => g.advance)).toEqual([10, 30]);
  });

  it('breaks lines on newline without emitting the newline as a glyph', () => {
    const l = layoutText('a\nb', base, measure, { boxWidth: 100 });
    expect(l.glyphs.map((g) => g.char)).toEqual(['a', 'b']);
    expect(l.glyphs.map((g) => g.line)).toEqual([0, 1]);
    expect(l.lines).toHaveLength(2);
  });

  it('keeps the code-point index across a line break', () => {
    // Runs index [...text] including newlines — if layout renumbered, a run
    // would style the wrong character on every line after the first.
    const l = layoutText('a\nb', base, measure, { boxWidth: 100 });
    expect(l.glyphs.map((g) => g.index)).toEqual([0, 2]);
  });

  it('stacks lines about the vertical centre by lineHeight', () => {
    const l = layoutText('a\nb', { ...base, lineHeight: 2 }, measure, { boxWidth: 100 });
    // 10px font x 2 = 20px leading, two lines -> baselines at -10 and +10.
    expect(l.lines.map((b) => b.y)).toEqual([-10, 10]);
  });

  it('adds paragraph spacing between lines', () => {
    const l = layoutText('a\nb', { ...base, lineHeight: 2, paragraphSpacing: 6 }, measure, {
      boxWidth: 100,
    });
    expect(l.lines.map((b) => b.y)).toEqual([-13, 13]);
  });

  it('lets the tallest run on a line set the leading', () => {
    // A mixed-size line must not overlap its neighbour.
    const l = layoutText('ab\nc', { ...base, lineHeight: 1 }, measure, {
      boxWidth: 100,
      runs: [{ start: 1, end: 2, style: { fontSize: 40 } }],
    });
    expect(l.lines.map((b) => b.y)).toEqual([-20, 20]);
  });

  it('single-line text sits on the vertical centre', () => {
    const l = layoutText('abc', base, measure, { boxWidth: 100 });
    expect(l.lines[0]!.y).toBe(0);
  });

  describe('align', () => {
    // These four are the bug drawGlyphs had: it hard-set textAlign 'center' and
    // ignored layer.align entirely, so an animated left-aligned layer drifted.
    it('left anchors the line to the left box edge', () => {
      const l = layoutText('ab', base, measure, { boxWidth: 100 });
      expect(l.glyphs[0]!.x).toBe(-45);
    });

    it('center centres the line on the box', () => {
      const l = layoutText('ab', { ...base, align: 'center' }, measure, { boxWidth: 100 });
      expect(l.glyphs.map((g) => g.x)).toEqual([-5, 5]);
    });

    it('right anchors the line to the right box edge', () => {
      const l = layoutText('ab', { ...base, align: 'right' }, measure, { boxWidth: 100 });
      expect(l.glyphs[1]!.x).toBe(45);
    });

    it('justify aliases to left, as the single-line path always did', () => {
      const j = layoutText('ab', { ...base, align: 'justify' }, measure, { boxWidth: 100 });
      const left = layoutText('ab', { ...base, align: 'left' }, measure, { boxWidth: 100 });
      expect(j.glyphs.map((g) => g.x)).toEqual(left.glyphs.map((g) => g.x));
    });

    it('aligns each line independently', () => {
      const l = layoutText('a\nbbb', { ...base, align: 'center' }, measure, { boxWidth: 100 });
      expect(l.glyphs[0]!.x).toBe(0);
      expect(l.glyphs[1]!.x).toBe(-10);
    });
  });

  it('folds animator tracking into the advance', () => {
    const l = layoutText('ab', base, measure, {
      boxWidth: 100,
      transforms: [glyph({ char: 'a', tracking: 5 }), glyph({ char: 'b' })],
    });
    expect(l.glyphs.map((g) => g.advance)).toEqual([15, 10]);
  });

  it('carries the animator transform through to the glyph', () => {
    const t = glyph({ char: 'a', rotation: 45 });
    const l = layoutText('a', base, measure, { boxWidth: 100, transforms: [t] });
    expect(l.glyphs[0]!.transform).toBe(t);
  });

  it('emits whitespace so it advances the pen', () => {
    // The backend skips painting it; layout must still reserve the space.
    const l = layoutText('a b', base, measure, { boxWidth: 100 });
    expect(l.glyphs.map((g) => g.char)).toEqual(['a', ' ', 'b']);
  });

  it('handles empty text without producing glyphs or NaNs', () => {
    const l = layoutText('', base, measure, { boxWidth: 100 });
    expect(l.glyphs).toEqual([]);
    expect(l.width).toBe(0);
    expect(Number.isFinite(l.height)).toBe(true);
  });

  it('keeps an empty line occupying its leading', () => {
    const l = layoutText('a\n\nb', { ...base, lineHeight: 1 }, measure, { boxWidth: 100 });
    expect(l.lines.map((b) => b.y)).toEqual([-10, 0, 10]);
  });

  it('splits by code point, not UTF-16 unit', () => {
    // '𝐀' is a surrogate pair — a .length-based split would emit two glyphs and
    // desynchronise every run index after it.
    const l = layoutText('𝐀b', base, measure, { boxWidth: 100 });
    expect(l.glyphs.map((g) => g.char)).toEqual(['𝐀', 'b']);
  });

  it('reports the widest line as the layout width', () => {
    const l = layoutText('a\nbbb', base, measure, { boxWidth: 100 });
    expect(l.width).toBe(30);
  });
});
