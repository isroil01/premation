/**
 * Acceptance tests for the text selection box (Phase 1A).
 *
 * jsdom's canvas reports no text metrics at all, so these run against a FAKE 2D
 * context that models a real font's metrics — including the one property that
 * matters here: `measureText` reports ascent/descent relative to the
 * MEASURING context's `textBaseline`. That is the contract the old code got
 * wrong, so the fake enforces it rather than papering over it.
 *
 * The ratios come from a real Chromium measurement of the app's own font stack
 * (Inter 48px/600): fontAscent 52 / fontDescent 12 under 'alphabetic', 38.77 /
 * 25.23 under 'middle' — a 13.23px origin shift, 0.2757 × fontSize.
 *
 * Every position assertion below checks an EDGE, never just a height. A box of
 * the right size in the wrong place is precisely the bug being fixed, and a
 * height-only assertion passes on it.
 */

// Calibrated against a live Chromium measurement of the app's own stack
// (Inter 600 @48px, textBaseline 'middle'): fontAscent 38.766 / fontDescent
// 25.234, cap 20.766, x-height 11.766, ascender ('j','h') 23.766, descender
// 24.234. Converted here to alphabetic-baseline ratios × fontSize.
//
// The important calibrated fact: the descender (0.2292em below the baseline)
// sits INSIDE the font's nominal descent (0.25em). Sweeping the full ASCII
// range plus a stacked-diacritic glyph in that face found ZERO characters whose
// ink escapes the font box — which is why a font-metric selection box can be
// both stable while typing AND glyph-tight, with no conflict between the two.
const A_ASCENT = 1.0833; // font ascent above the alphabetic baseline, × fontSize
const A_DESCENT = 0.25; // font descent below it, × fontSize
const MIDDLE_UP = 0.2757; // how far the 'middle' origin sits above the baseline
const CAP = 0.7083; // cap height, × fontSize
const ASCENDER = 0.7708; // 'b','d','f','h','k','l','t','j' reach above the caps
const XH = 0.5208; // x-height, × fontSize
const DESC = 0.2292; // descender depth below the baseline, × fontSize
const ADVANCE = 0.55; // per-character advance, × fontSize

/** Per-family metric scaling, so "different font, same size" can be tested. */
let familyScale: Record<string, number> = { Inter: 1, Condensed: 1 };

interface FakeMetrics {
  width: number;
  actualBoundingBoxAscent: number;
  actualBoundingBoxDescent: number;
  actualBoundingBoxLeft: number;
  actualBoundingBoxRight: number;
  fontBoundingBoxAscent: number;
  fontBoundingBoxDescent: number;
}

class FakeCtx {
  font = '10px sans-serif';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  letterSpacing = '0px';

  private parse(): { size: number; family: string } {
    const m = /(\d+(?:\.\d+)?)px\s+"?([^",]+)"?/.exec(this.font);
    return { size: m ? Number(m[1]) : 10, family: m ? (m[2] ?? 'Inter').trim() : 'Inter' };
  }

  measureText(text: string): FakeMetrics {
    const { size, family } = this.parse();
    const k = (familyScale[family] ?? 1) * size;
    // Ink extents measured from the ALPHABETIC baseline first — that is the
    // physical truth about the glyphs; the baseline only moves the origin.
    const hasAscender = /[bdfhkltj]/.test(text);
    const hasCap = /[A-Z]/.test(text);
    const hasDesc = /[gjpqy]/.test(text);
    const inkAscentAlpha = (hasAscender ? ASCENDER : hasCap ? CAP : XH) * k;
    const inkDescentAlpha = (hasDesc ? DESC : 0) * k;
    // Shift into whatever baseline the caller asked for.
    const shift = this.textBaseline === 'middle' ? MIDDLE_UP * k : 0;
    const w = text.length * ADVANCE * k;
    return {
      width: w,
      actualBoundingBoxAscent: inkAscentAlpha - shift,
      actualBoundingBoxDescent: inkDescentAlpha + shift,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: w,
      fontBoundingBoxAscent: A_ASCENT * k - shift,
      fontBoundingBoxDescent: A_DESCENT * k + shift,
    };
  }
}

/** Fresh module instance with the fake context installed (module caches metrics). */
function loadMeasure(): typeof import('./measureText') {
  let mod!: typeof import('./measureText');
  jest.isolateModules(() => {
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function getContext() {
      return new FakeCtx() as unknown as CanvasRenderingContext2D;
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('./measureText') as typeof import('./measureText');
  });
  return mod;
}

const style = (over: Partial<import('./measureText').MeasuredTextStyle> = {}) => ({
  content: 'HELLO',
  fontSize: 48,
  fontFamily: 'Inter',
  fontWeight: '600',
  fontStyle: 'normal',
  letterSpacing: 0,
  lineHeight: 1.2,
  paragraphSpacing: 0,
  ...over,
});

/**
 * Where the glyphs actually land relative to the DRAW ORIGIN, computed
 * independently of the code under test — the rasterizer draws with
 * `textBaseline: 'middle'`, so the origin sits `MIDDLE_UP × size` above the
 * alphabetic baseline.
 */
function drawnInk(s: ReturnType<typeof style>): { top: number; bottom: number } {
  const k = (familyScale[s.fontFamily] ?? 1) * s.fontSize;
  const hasAscender = /[bdfhkltj]/.test(s.content);
  const hasCap = /[A-Z]/.test(s.content);
  const hasDesc = /[gjpqy]/.test(s.content);
  return {
    top: -((hasAscender ? ASCENDER : hasCap ? CAP : XH) * k - MIDDLE_UP * k),
    bottom: (hasDesc ? DESC : 0) * k + MIDDLE_UP * k,
  };
}

beforeEach(() => {
  familyScale = { Inter: 1, Condensed: 0.75 };
});

describe('measureText — the baseline-origin bug', () => {
  it('measures ink in the baseline it DRAWS in, not the default alphabetic one', () => {
    const M = loadMeasure();
    const s = style({ content: 'HELLO' });
    const truth = drawnInk(s);
    const boxes = M.measureTextBoxes(s)!;
    // Measured under 'alphabetic' this would be −34; under 'middle' it is −20.77.
    expect(boxes.ink.top).toBeCloseTo(truth.top, 4);
    expect(boxes.ink.bottom).toBeCloseTo(truth.bottom, 4);
  });

  it('does not assume the box is concentric with the origin', () => {
    const M = loadMeasure();
    const boxes = M.measureTextBoxes(style())!;
    // A caps-only run is asymmetric about the draw origin, so its box centre
    // must be offset. Zero here means the old concentric assumption is back.
    expect(boxes.font.offsetY).not.toBeCloseTo(0, 3);
    expect(boxes.ink.offsetY).not.toBeCloseTo(0, 3);
  });

  it('reports offsetY as the box centre, consistent with top/bottom', () => {
    const M = loadMeasure();
    const b = M.measureTextBoxes(style())!.font;
    expect(b.offsetY).toBeCloseTo((b.top + b.bottom) / 2, 6);
    expect(b.height).toBeCloseTo(b.bottom - b.top, 6);
  });
});

describe('measureText — acceptance criteria', () => {
  it('HELLO: no glyph falls above the top edge of the selection box', () => {
    const M = loadMeasure();
    const s = style({ content: 'HELLO' });
    const truth = drawnInk(s);
    const box = M.measureTextBoxes(s)!.font;
    // Assert the EDGE POSITION, not the height.
    expect(box.top).toBeLessThanOrEqual(truth.top);
    expect(box.bottom).toBeGreaterThanOrEqual(truth.bottom);
  });

  it('Hpqjy: descenders fall inside the bottom edge', () => {
    const M = loadMeasure();
    const s = style({ content: 'Hpqjy' });
    const truth = drawnInk(s);
    const box = M.measureTextBoxes(s)!.font;
    expect(box.bottom).toBeGreaterThanOrEqual(truth.bottom);
    expect(box.top).toBeLessThanOrEqual(truth.top);
  });

  it('typing changes the box width but not its height', () => {
    const M = loadMeasure();
    const a = M.measureTextBoxes(style({ content: 'HELLO' }))!.font;
    const b = M.measureTextBoxes(style({ content: 'Hpqjy' }))!.font;
    const c = M.measureTextBoxes(style({ content: 'HELLO WORLD' }))!.font;
    expect(b.height).toBeCloseTo(a.height, 6);
    expect(c.height).toBeCloseTo(a.height, 6);
    expect(b.top).toBeCloseTo(a.top, 6);
    expect(c.width).toBeGreaterThan(a.width);
  });

  it('the ink box, by contrast, DOES change with content (kept for plates)', () => {
    const M = loadMeasure();
    const a = M.measureTextBoxes(style({ content: 'HELLO' }))!.ink;
    const b = M.measureTextBoxes(style({ content: 'Hpqjy' }))!.ink;
    expect(b.height).toBeGreaterThan(a.height);
  });

  it('box height changes when the font FAMILY changes at a fixed size', () => {
    const M = loadMeasure();
    const inter = M.measureTextBoxes(style({ fontFamily: 'Inter' }))!.font;
    const cond = M.measureTextBoxes(style({ fontFamily: 'Condensed' }))!.font;
    expect(cond.height).not.toBeCloseTo(inter.height, 3);
  });

  it('lineHeight 0.85 still produces a box that encloses the glyphs', () => {
    const M = loadMeasure();
    const s = style({ content: 'Hpqjy', lineHeight: 0.85, fontSize: 200 });
    const truth = drawnInk(s);
    const box = M.measureTextBoxes(s)!.font;
    expect(box.top).toBeLessThanOrEqual(truth.top);
    expect(box.bottom).toBeGreaterThanOrEqual(truth.bottom);
  });

  it('a 10px stroke is enclosed on every side', () => {
    const M = loadMeasure();
    const s = style({ content: 'Hpqjy' });
    const plain = M.measureTextBoxes(s, 0)!.font;
    const stroked = M.measureTextBoxes(s, 10)!.font;
    expect(stroked.top).toBeCloseTo(plain.top - 5, 6);
    expect(stroked.bottom).toBeCloseTo(plain.bottom + 5, 6);
    expect(stroked.left).toBeCloseTo(plain.left - 5, 6);
    expect(stroked.right).toBeCloseTo(plain.right + 5, 6);
  });

  it('a webfont that loads after first paint is re-measured, not served stale', () => {
    const M = loadMeasure();
    const before = M.measureTextBoxes(style())!.font.height;
    // The face arrives and its metrics differ.
    familyScale = { ...familyScale, Inter: 1.5 };
    expect(M.measureTextBoxes(style())!.font.height).toBeCloseTo(before, 6); // still cached
    M.invalidateTextMeasurements();
    expect(M.measureTextBoxes(style())!.font.height).toBeCloseTo(before * 1.5, 6);
  });
});

describe('measureText — the font box contains the ink box', () => {
  // Verified in Chromium across the full ASCII range in the app's own face:
  // zero glyphs escape the font box. That is what makes a font-metric selection
  // box viable — it is stable while typing AND never clips.
  it.each(['HELLO', 'Hello', 'Hpqjy', 'x', 'j', 'Wg', 'ABCDEFG'])('contains %s', (content) => {
    const M = loadMeasure();
    const b = M.measureTextBoxes(style({ content }))!;
    expect(b.font.top).toBeLessThanOrEqual(b.ink.top);
    expect(b.font.bottom).toBeGreaterThanOrEqual(b.ink.bottom);
  });
});

describe('measureText — multi-line', () => {
  it('spans the first line’s top to the last line’s bottom', () => {
    const M = loadMeasure();
    const one = M.measureTextBoxes(style({ content: 'Hpqjy' }))!.font;
    const three = M.measureTextBoxes(style({ content: 'Hpqjy\nHpqjy\nHpqjy' }))!.font;
    const gap = 48 * 1.2;
    expect(three.height).toBeCloseTo(one.height + 2 * gap, 4);
    // Symmetric about the block centre, so the extra height splits evenly.
    expect(three.top).toBeCloseTo(one.top - gap, 4);
    expect(three.bottom).toBeCloseTo(one.bottom + gap, 4);
  });

  it('width is the widest line’s advance, not the sum', () => {
    const M = loadMeasure();
    const b = M.measureTextBoxes(style({ content: 'HI\nHELLO WORLD\nHI' }))!;
    const wide = M.measureTextBoxes(style({ content: 'HELLO WORLD' }))!;
    expect(b.advance).toBeCloseTo(wide.advance, 6);
  });
});

describe('measureText — the render box must contain its own glyphs', () => {
  // The clamp that shrank the reported ink box was honest: the RENDER box was
  // genuinely shorter than the glyphs, so they were clipped in the raster, not
  // just in the outline. Verified in Chromium at 320px/0.7 (ink rows 0..239 of
  // a 240px canvas). The height is now floored at the ink band.
  const cases = [
    { fontSize: 48, lineHeight: 1.2 },
    { fontSize: 48, lineHeight: 0.5 },
    { fontSize: 200, lineHeight: 0.85 },
    { fontSize: 320, lineHeight: 0.7 },
    { fontSize: 320, lineHeight: 0.5 },
  ];
  it.each(cases)('contains the ink at $fontSize px / lineHeight $lineHeight', (c) => {
    const M = loadMeasure();
    const s = style({ content: 'Hpqjy', ...c });
    const render = M.measureTextSize(s)!;
    const ink = M.measureTextBoxes(s)!.ink;
    // The box is CENTRED on the draw origin, so containment is about the
    // deeper half-extent — a box merely as tall as the band still clips when
    // the band hangs below the origin, which is the descender case.
    expect(render.h / 2).toBeGreaterThanOrEqual(-ink.top);
    expect(render.h / 2).toBeGreaterThanOrEqual(ink.bottom);
    expect(render.w / 2).toBeGreaterThanOrEqual(ink.right);
    expect(render.w / 2).toBeGreaterThanOrEqual(-ink.left);
  });

  it('is unchanged at normal line heights — the floor only ever grows it', () => {
    const M = loadMeasure();
    const s = style({ content: 'Hpqjy', fontSize: 48, lineHeight: 1.2 });
    // Line box 57.6 + 2×PAD_Y(8) = 73.6 → 74, exactly as before this change.
    expect(M.measureTextSize(s)!.h).toBe(74);
  });
});

describe('measureText — degraded runtimes', () => {
  it('returns null rather than guessing when there is no 2D context', () => {
    let mod!: typeof import('./measureText');
    jest.isolateModules(() => {
      (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () => null;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('./measureText') as typeof import('./measureText');
    });
    expect(mod.measureTextBoxes(style())).toBeNull();
    expect(mod.measureTextSize(style())).toBeNull();
  });

  it('falls back to the line box when no metrics are reported at all', () => {
    let mod!: typeof import('./measureText');
    jest.isolateModules(() => {
      (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () =>
        ({ font: '', textBaseline: 'alphabetic', measureText: () => ({ width: 100 }) }) as unknown as CanvasRenderingContext2D;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('./measureText') as typeof import('./measureText');
    });
    const b = mod.measureTextBoxes(style())!;
    expect(b.font.height).toBeCloseTo(48 * 1.2, 6);
    expect(b.advance).toBe(100);
  });
});
