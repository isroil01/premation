/**
 * Shared text layout — the single source of truth for where every glyph sits.
 *
 * Both backends used to lay text out for themselves: `Canvas2DBackend`'s text
 * case and `AppTextureProvider.rasterizeText` were parallel copies of the same
 * line-split / align / lineHeight arithmetic, kept in agreement by convention
 * and one test comment. That was survivable while a layer had exactly one font,
 * but per-character runs multiply every decision by the number of runs, and two
 * copies of that is two chances to disagree. So the arithmetic lives here once
 * and both backends ask this module where the glyphs go.
 *
 * The module is pure: it never touches a canvas. Measurement is injected as a
 * `MeasureGlyph` callback, so layout is unit-testable with a fake metric (and
 * jsdom, which has no real text metrics, can still exercise every branch).
 *
 * Coordinate space matches `Canvas2DBackend`: the layer box is centred on
 * (0, 0), +x right, +y down, and `y` is a `textBaseline: 'middle'` baseline.
 * `rasterizeText` draws in top-left box space and offsets by half the box.
 */

import type { GlyphTransform } from './textAnimators';

/** Everything that can vary per character. */
export interface TextStyle {
  fontSize: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  /** Extra advance after each glyph, px. */
  letterSpacing?: number;
  /** Glyph colour. Layer-wide `fill` is the default; a run may override it. */
  fill?: string;
}

/**
 * A styled span over `[...text]`, half-open `[start, end)`.
 *
 * Indices are into the **code-point array**, not `string.length` — the same
 * index space `unitPositions()` in textAnimators.ts uses, so a run and an
 * animator selector agree about what character 5 is.
 */
export interface RichRun {
  start: number;
  end: number;
  style: Partial<TextStyle>;
}

/** Layer-wide paragraph settings — these cannot vary per character. */
export interface ParagraphStyle {
  /** 'left' | 'center' | 'right' | 'justify'. */
  align?: string;
  /** Multiple of font size between baselines. */
  lineHeight?: number;
  /** Extra px between paragraphs. Every newline starts a new paragraph. */
  paragraphSpacing?: number;
}

/** A glyph, resolved and placed. */
export interface PlacedGlyph {
  char: string;
  /** Index into `[...text]`. */
  index: number;
  /** Glyph centre X (the pen is advanced to the centre, matching the
   *  `textAlign: 'center'` draw the backends already do per glyph). */
  x: number;
  /** Baseline Y for `textBaseline: 'middle'`. */
  y: number;
  /** Width consumed, including letter spacing and animator tracking. */
  advance: number;
  /** Fully resolved style — base merged with whichever run covers `index`. */
  style: TextStyle;
  /** 0-based line this glyph landed on. */
  line: number;
  /** The animator transform for this glyph, when the layer has animators. */
  transform?: GlyphTransform;
  /** Baseline rotation in radians, set when the glyph rides a path. Absent for
   *  ordinary text — the backend only rotates when it is told to. */
  angle?: number;
}

export interface LineBox {
  /** Sum of the line's advances. */
  width: number;
  /** Baseline Y. */
  y: number;
  /** Where the line's left edge sits, after `align`. Text on a path measures
   *  each glyph's offset from here to turn it into an arc length. */
  left: number;
}

export interface TextLayout {
  glyphs: PlacedGlyph[];
  lines: LineBox[];
  /** Widest line. */
  width: number;
  /** First to last baseline, plus one line's leading. */
  height: number;
}

/** Measures one glyph under a fully-resolved style. Injected so this module
 *  stays pure — the backends pass a canvas-backed (and cached) implementation. */
export type MeasureGlyph = (char: string, style: TextStyle) => number;

export interface LayoutOptions {
  /** Per-character style overrides. Later runs win where they overlap. */
  runs?: ReadonlyArray<RichRun>;
  /** Animator output, one entry per character of `text`. Contributes
   *  `tracking` to the advance; the rest is applied by the backend at paint. */
  transforms?: ReadonlyArray<GlyphTransform>;
  /** Layer box width — the frame `align` anchors against. */
  boxWidth: number;
}

const DEFAULT_LINE_HEIGHT = 1.2;

/**
 * Merge the base style with every run covering `index`.
 *
 * Runs are applied in array order, so a later run wins an overlap. Callers that
 * care about determinism should normalize first (`normalizeRuns`), which makes
 * runs disjoint and ordered — but layout must not *depend* on that, because a
 * document written by an older build may carry overlapping runs.
 */
export function resolveGlyphStyle(
  base: TextStyle,
  runs: ReadonlyArray<RichRun> | undefined,
  index: number,
): TextStyle {
  if (!runs || runs.length === 0) return base;
  let style = base;
  for (const run of runs) {
    if (index >= run.start && index < run.end) {
      style = { ...style, ...run.style };
    }
  }
  return style;
}

/**
 * Place every glyph of `text`.
 *
 * Newlines break lines and are not emitted as glyphs. Whitespace IS emitted —
 * it advances the pen, and the backend skips painting it. Empty lines still
 * occupy their leading.
 */
export function layoutText(
  text: string,
  base: TextStyle & ParagraphStyle,
  measure: MeasureGlyph,
  opts: LayoutOptions,
): TextLayout {
  const chars = [...text];
  const align = base.align ?? 'left';
  const lineHeightMul = base.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const paragraphSpacing = base.paragraphSpacing ?? 0;

  // Pass 1 — measure and group into lines. Advances are resolved per glyph
  // under that glyph's own style: a run that changes the font changes the
  // width, so measuring the whole string under one font (as drawGlyphs did)
  // would misplace everything after the first run boundary.
  interface Pending {
    char: string;
    index: number;
    advance: number;
    style: TextStyle;
    transform?: GlyphTransform;
  }
  const lines: Pending[][] = [[]];
  let lineHeightPx = (base.fontSize || 0) * lineHeightMul;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (char === '\n') {
      lines.push([]);
      continue;
    }
    const style = resolveGlyphStyle(base, opts.runs, i);
    const transform = opts.transforms?.[i];
    const advance =
      measure(char, style) + (style.letterSpacing ?? 0) + (transform?.tracking ?? 0);
    lines[lines.length - 1]!.push({ char, index: i, advance, style, transform });
    // A run may raise the font size; the tallest glyph sets the leading, so a
    // mixed-size line does not overlap its neighbour.
    lineHeightPx = Math.max(lineHeightPx, style.fontSize * lineHeightMul);
  }

  // Pass 2 — place. Lines are stacked about the vertical centre so a layer with
  // one line renders exactly where the single-line fast path puts it.
  const lineAdvance = lineHeightPx + paragraphSpacing;
  const totalHeight = (lines.length - 1) * lineAdvance;
  const startY = -totalHeight / 2;
  const halfW = opts.boxWidth / 2;

  const glyphs: PlacedGlyph[] = [];
  const boxes: LineBox[] = [];
  let widest = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const lineWidth = line.reduce((sum, g) => sum + g.advance, 0);
    widest = Math.max(widest, lineWidth);
    const y = startY + li * lineAdvance;

    // Where the line's left edge sits. 'justify' aliases to left, as it has
    // since the single-line path — real justification needs word-level
    // distribution, and is not what this change is for.
    let pen: number;
    if (align === 'center') pen = -lineWidth / 2;
    else if (align === 'right') pen = halfW - lineWidth;
    else pen = -halfW;
    boxes.push({ width: lineWidth, y, left: pen });

    for (const g of line) {
      glyphs.push({
        char: g.char,
        index: g.index,
        x: pen + g.advance / 2,
        y,
        advance: g.advance,
        style: g.style,
        line: li,
        transform: g.transform,
      });
      pen += g.advance;
    }
  }

  return { glyphs, lines: boxes, width: widest, height: totalHeight + lineHeightPx };
}
