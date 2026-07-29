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
 * index space `unitPositions` in textAnimators.ts uses, so a run and an
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
  /**
   * The glyph's own advance width, without kerning or letter-spacing.
   *
   * `x - inkWidth / 2` is the PEN position — where the browser's own
   * `fillText` would start this glyph. Drawing from the pen with
   * `textAlign: 'left'` reproduces the browser's side bearings exactly;
   * drawing centred on the advance box does not, and the difference is a
   * per-glyph offset that shows up as edge shimmer when a partially-animated
   * string mixes the two draw paths.
   */
  inkWidth: number;
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

/**
 * Measures a whole STRING under one style — the kerning-aware path.
 *
 * ## Why this exists
 *
 * Summing per-glyph widths silently discards kerning, because kerning is a
 * property of a PAIR and there is no pair in a one-character measurement. On
 * `JOIN THE REVOLUTION` at 129px the per-glyph sum came to 1684px against a
 * true width of 1676px — 8px of drift, accumulating left to right.
 *
 * That is not a cosmetic 0.5% error. The rasterizer has two paths: static text
 * draws as one `fillText` per line (kerned, 1676px) and text with any animator
 * draws per glyph (unkerned, 1684px). Anything that composites both — a cached
 * texture crossfading into a freshly drawn one — superimposes the same string at
 * two spacings, and the result is a picket fence of 1px vertical bars densest
 * where the drift has accumulated most. Rendered and measured: 71 ink runs
 * against 17 for a single clean draw.
 *
 * Measuring cumulative prefixes and taking differences recovers the exact
 * advances, kerning included, and makes the two paths agree to the pixel.
 */
export type MeasureRun = (text: string, style: TextStyle) => number;

export interface LayoutOptions {
  /** Per-character style overrides. Later runs win where they overlap. */
  runs?: ReadonlyArray<RichRun>;
  /** Animator output, one entry per character of `text`. Contributes
   *  `tracking` to the advance; the rest is applied by the backend at paint. */
  transforms?: ReadonlyArray<GlyphTransform>;
  /** Layer box width — the frame `align` anchors against. */
  boxWidth: number;
  /**
   * Kerning-aware measurement. Strongly preferred — see `MeasureRun`.
   *
   * Optional so backends without real text metrics (jsdom in the unit tests,
   * the headless rasterizers) keep working on the per-glyph fallback. They lose
   * kerning, which for a metric-free fake measurer is meaningless anyway.
   */
  measureRun?: MeasureRun;
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
  /**
   * Kerned advance for each glyph, or null when the caller gave us no run
   * measurer (headless backends with no real metrics, and the unit tests).
   *
   * Computed per maximal same-style span: kerning only applies between glyphs
   * that share a font, and a prefix measured across a style boundary would be
   * measured under the wrong font from the boundary onward.
   */
  const kernedAdvances = ((): (number | null)[] | null => {
    const run = opts.measureRun;
    if (!run) return null;
    const cs = [...text];
    const out: (number | null)[] = new Array(cs.length).fill(null);
    let spanStart = 0;
    const flush = (end: number): void => {
      if (end <= spanStart) return;
      const style = resolveGlyphStyle(base, opts.runs, spanStart);
      let prev = 0;
      for (let i = spanStart; i < end; i++) {
        // A substituted glyph (Character Offset) changes the string being
        // measured, so build the prefix from what will actually be DRAWN.
        const drawnSoFar = cs
          .slice(spanStart, i + 1)
          .map((c, k) => opts.transforms?.[spanStart + k]?.displayChar ?? c)
          .join('');
        const w = run(drawnSoFar, style);
        out[i] = w - prev;
        prev = w;
      }
    };
    for (let i = 0; i <= cs.length; i++) {
      const atEnd = i === cs.length;
      // A newline is a hard break for kerning as well as for layout.
      const broken = atEnd || cs[i] === '\n';
      const styleChanged =
        !atEnd && i > spanStart && resolveGlyphStyle(base, opts.runs, i) !== resolveGlyphStyle(base, opts.runs, spanStart);
      if (broken || styleChanged) {
        flush(i);
        spanStart = broken && !atEnd ? i + 1 : i;
      }
    }
    return out;
  })();

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
    /**
     * The glyph's own width, ignoring kerning.
     *
     * Kerning belongs BETWEEN two glyphs, but a prefix-difference measurement
     * necessarily attributes each pair's tuck to the SECOND glyph — so 'V' in
     * 'AV' comes back 8px narrower than it draws. Centring it in that shrunken
     * box shifts it 4px left of where the browser puts it, which is a residual
     * mismatch that survives even after the total widths agree.
     *
     * So the pen steps by `advance` (kerned, and therefore correct cumulatively)
     * while each glyph is centred on `inkWidth` (its own box). Both properties
     * hold at once, which is what makes the two draw paths land on the same
     * pixels rather than merely end at the same place.
     */
    inkWidth: number;
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
    // Character Offset can substitute a wider glyph ('l' → 'W'); measuring the
    // original would leave the line short by the difference and the rest of it
    // creeping left as the offset animates.
    const drawn = transform?.displayChar ?? char;
    // The kerned advance already includes this glyph's letter-spacing, because
    // the run measurement is taken with the style's spacing applied. The
    // per-glyph fallback has to add it back by hand.
    const kerned = kernedAdvances?.[i];
    const advance =
      kerned !== null && kerned !== undefined
        ? kerned + (transform?.tracking ?? 0)
        : measure(drawn, style) + (style.letterSpacing ?? 0) + (transform?.tracking ?? 0);
    const inkWidth = measure(drawn, style);
    lines[lines.length - 1]!.push({ char, index: i, advance, inkWidth, style, transform });
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
        // Centred on the glyph's OWN box, not on its kerned advance — see
        // `inkWidth`. The pen still steps by the kerned advance below.
        x: pen + g.inkWidth / 2,
        y,
        advance: g.advance,
        inkWidth: g.inkWidth,
        style: g.style,
        line: li,
        transform: g.transform,
      });
      pen += g.advance;
    }
  }

  return { glyphs, lines: boxes, width: widest, height: totalHeight + lineHeightPx };
}
