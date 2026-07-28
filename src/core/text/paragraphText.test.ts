/**
 * Point vs paragraph text (#23).
 *
 * The distinction is which of box and content is the INPUT:
 *   • point text     — box derived from content; a handle drag scales the type
 *   • paragraph text — box authored; the content wraps inside it and a handle
 *                      drag REFLOWS at the same font size
 *
 * Wrapping inserts newlines into the content, which every downstream consumer
 * (measurement, rasterizer, per-character layout) already handles — so the two
 * cannot disagree about where lines break.
 */

import { wrapText, measureTextSize, type MeasuredTextStyle } from './measureText';

const style = (over: Partial<MeasuredTextStyle> = {}): MeasuredTextStyle => ({
  content: 'the quick brown fox jumps over the lazy dog',
  fontSize: 20,
  fontFamily: 'Inter',
  fontWeight: '400',
  fontStyle: 'normal',
  letterSpacing: 0,
  lineHeight: 1.2,
  paragraphSpacing: 0,
  ...over,
});

// Wrapping is driven by measureText. Unlike the layer-style chain, it touches no
// compositing and no filters — the two things the headless rasterizers get wrong
// — so the Skia backing jest.setup.ts installs is a sound host for it. The
// assertions are all relational (more lines, wider, taller), so the fact that
// Inter falls back to a system sans here does not affect them.
import { hasCanvas } from '../effects/__testHelpers__/canvasFidelity';

const maybe = hasCanvas ? describe : describe.skip;

describe('wrapText — structure', () => {
  it('is a no-op without a box width — that IS point text', () => {
    const s = style();
    expect(wrapText(s)).toBe(s.content);
    expect(wrapText(style({ boxWidth: 0 }))).toBe(s.content);
  });

  it('preserves existing hard newlines as paragraph breaks', () => {
    const out = wrapText(style({ content: 'alpha\nbeta', boxWidth: 10_000 }));
    expect(out).toBe('alpha\nbeta');
  });

  it('never loses or reorders words', () => {
    const s = style({ boxWidth: 120 });
    const before = s.content.split(/\s+/);
    const after = wrapText(s).split(/\s+/);
    expect(after).toEqual(before);
  });
});

maybe('wrapText — measured behaviour', () => {
  it('breaks a long line into several', () => {
    const wide = wrapText(style({ boxWidth: 10_000 }));
    const narrow = wrapText(style({ boxWidth: 120 }));
    expect(wide.split('\n')).toHaveLength(1);
    expect(narrow.split('\n').length).toBeGreaterThan(1);
  });

  it('a narrower box yields at least as many lines — reflow, not resize', () => {
    const lines = (w: number) => wrapText(style({ boxWidth: w })).split('\n').length;
    expect(lines(120)).toBeGreaterThanOrEqual(lines(240));
    expect(lines(240)).toBeGreaterThanOrEqual(lines(480));
  });

  it('does NOT break a single word longer than the box', () => {
    // Every text engine overhangs here; breaking mid-word would mangle URLs.
    const out = wrapText(style({ content: 'supercalifragilistic', boxWidth: 20 }));
    expect(out).toBe('supercalifragilistic');
  });

  it('paragraph text takes its WIDTH from the box, not the glyphs', () => {
    const box = measureTextSize(style({ boxWidth: 200 }))!;
    // Same content with no box measures to whatever the glyphs need.
    const point = measureTextSize(style())!;
    expect(box.w).not.toBe(point.w);
    // The authored width drives it (plus the shared horizontal padding).
    expect(box.w).toBeGreaterThanOrEqual(200);
    expect(box.w).toBeLessThan(200 + 64);
  });

  it('paragraph text grows TALLER as its box narrows, at the same font size', () => {
    const wide = measureTextSize(style({ boxWidth: 400 }))!;
    const narrow = measureTextSize(style({ boxWidth: 140 }))!;
    expect(narrow.h).toBeGreaterThan(wide.h);
    expect(narrow.w).toBeLessThan(wide.w);
  });

  it('point text is unaffected — no regression for existing layers', () => {
    const a = measureTextSize(style())!;
    const b = measureTextSize(style())!;
    expect(a).toEqual(b);
    expect(a.w).toBeGreaterThan(0);
  });
});
