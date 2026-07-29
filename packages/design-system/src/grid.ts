/**
 * Layout grid, baseline rhythm, safe area, and optical centring.
 *
 * ## The rule this file enforces
 *
 * **Nothing is free-positioned.** A layout template may not write an arbitrary
 * `x, y`; it names a column span and a baseline row, and this file turns that
 * into pixels. That constraint is the difference between a layout and a
 * placement: free coordinates produce elements that are *nearly* aligned, and
 * "nearly aligned" is the most reliable amateur signal in visual design —
 * legible to everyone, nameable by almost no one.
 *
 * ## Optical vs geometric centring
 *
 * Centring text on its bounding box is wrong. A text layer's box includes
 * ascender and descender space the glyphs do not fill, so a headline geometrically
 * centred in a frame sits visibly low. Real typesetting centres on the cap
 * height. It is about a 2% offset and it is one of the clearest tells between
 * "designed" and "placed".
 *
 * Pure — takes a grid and numbers, returns numbers.
 */

export interface GridSpec {
  /** Frame width in px. */
  width: number;
  /** Frame height in px. */
  height: number;
  /** Column count. 12 is the default for a reason: it divides by 2, 3, 4 and 6. */
  columns: number;
  /** Space between columns, px. */
  gutter: number;
  /** Outer margin, px. Generous margins are most of what makes a layout breathe. */
  margin: number;
  /** Vertical rhythm unit, px. Every y lands on a multiple of this. */
  baseline: number;
  /**
   * Fraction of each edge kept clear of content — title-safe area. Even for
   * web-only output this stops elements kissing the frame edge.
   */
  safeArea: number;
}

/** A sane 12-column grid derived from the frame size. */
export function grid(width: number, height: number, over: Partial<GridSpec> = {}): GridSpec {
  // Margin scales with the frame rather than being a fixed px value: a 96px
  // margin is generous at 1920 and swallows a 640px frame whole.
  const margin = Math.round(Math.min(width, height) * 0.075);
  return {
    width,
    height,
    columns: 12,
    gutter: Math.round(margin / 3),
    margin,
    baseline: 8,
    safeArea: 0.05,
    ...over,
  };
}

/** Total width available to content, after margins. */
export function contentWidth(g: GridSpec): number {
  return g.width - g.margin * 2;
}

/** Width of one column. */
export function columnWidth(g: GridSpec): number {
  return (contentWidth(g) - g.gutter * (g.columns - 1)) / g.columns;
}

/** Left edge of column `i` (0-based). */
export function columnLeft(g: GridSpec, i: number): number {
  return g.margin + i * (columnWidth(g) + g.gutter);
}

export interface Span {
  /** Inclusive 0-based column range, e.g. [0, 5] is the left half of a 12-col grid. */
  col: [number, number];
}

/** Pixel width of a column span, gutters included. */
export function spanWidth(g: GridSpec, [from, to]: [number, number]): number {
  const n = to - from + 1;
  return n * columnWidth(g) + (n - 1) * g.gutter;
}

/** Centre X of a column span — what a layer's `x` should be. */
export function spanCenterX(g: GridSpec, span: [number, number]): number {
  return columnLeft(g, span[0]) + spanWidth(g, span) / 2;
}

/** Y of baseline row `n` (0-based), measured from the top margin. */
export function baselineY(g: GridSpec, n: number): number {
  return g.margin + n * g.baseline;
}

/** Snap an arbitrary y to the nearest baseline. */
export function snapBaseline(g: GridSpec, y: number): number {
  return g.margin + Math.round((y - g.margin) / g.baseline) * g.baseline;
}

/** How many baseline rows fit between the margins. */
export function baselineRows(g: GridSpec): number {
  return Math.floor((g.height - g.margin * 2) / g.baseline);
}

// ── Optical centring ──────────────────────────────────────────────────

/**
 * Cap height as a fraction of font size, and where the visual centre of a line
 * sits relative to its geometric centre.
 *
 * These are averages across the sans-serif families the type system ships. Using
 * per-font metrics would be more correct, but the font files are not available in
 * a pure package — and the *direction* of the correction matters far more than
 * the last percent of its magnitude.
 */
export const CAP_HEIGHT_RATIO = 0.71;
export const X_HEIGHT_RATIO = 0.52;

/**
 * The y a text layer needs so its **cap height** is centred on `targetY`.
 *
 * A text layer's origin is its box centre, which sits between the ascender line
 * and the descender line. Descender space is empty for most headlines (no
 * lowercase g/y/p in "LAUNCH"), so the visible mass sits above the box centre and
 * geometric centring reads as too low. This nudges it back up.
 */
export function opticalCenterY(targetY: number, fontSizePx: number): number {
  // Box centre → cap-height centre. Half the difference between the full em box
  // and the cap band, biased for the empty descender.
  const correction = fontSizePx * (1 - CAP_HEIGHT_RATIO) * 0.5;
  return targetY - correction;
}

/**
 * Optical left edge for a glyph that visually overhangs — round letters (O, C,
 * G), pointed ones (A, V, W), and quotes all need to start slightly outside the
 * margin or the column edge looks ragged.
 */
export function opticalLeftX(x: number, fontSizePx: number, firstChar: string): number {
  const round = /[OQCGSocegs068]/.test(firstChar);
  const pointed = /[AVWXYvwxy]/.test(firstChar);
  const quote = /["'“‘«]/.test(firstChar);
  const overhang = quote ? 0.22 : round ? 0.035 : pointed ? 0.025 : 0;
  return x - fontSizePx * overhang;
}

// ── Placement ─────────────────────────────────────────────────────────

export type VAlign = 'top' | 'middle' | 'bottom';
export type HAlign = 'left' | 'center' | 'right';

export interface Placement {
  x: number;
  y: number;
  width: number;
}

export interface PlaceSpec {
  col: [number, number];
  /** Baseline row (0-based from the top margin). */
  baselineRow: number;
  /** Height of the element, px — needed to resolve `align`. */
  height?: number;
  /** Optical correction. Pass the font size for text. */
  opticalFontSize?: number;
  align?: HAlign;
}

/**
 * Resolve a grid placement to the `x`, `y`, `width` a layer needs.
 *
 * Returns a *centre* x/y, because that is what the engine's layers use — a
 * placement helper that returned a top-left corner would push the conversion
 * into every template, which is where sign errors live.
 */
export function place(g: GridSpec, spec: PlaceSpec): Placement {
  const width = spanWidth(g, spec.col);
  const align = spec.align ?? 'center';
  const left = columnLeft(g, spec.col[0]);
  const x = align === 'left' ? left + width / 2 : align === 'right' ? left + width / 2 : spanCenterX(g, spec.col);

  const rawY = baselineY(g, spec.baselineRow) + (spec.height ?? 0) / 2;
  const y = spec.opticalFontSize ? opticalCenterY(rawY, spec.opticalFontSize) : rawY;

  return { x, y, width };
}

// ── Negative space ────────────────────────────────────────────────────

/**
 * Fraction of the frame NOT covered by content, from element boxes.
 *
 * Amateur layouts fill the frame; professional ones are commonly 40–60% empty.
 * This is the number the design linter's `SPACE_STARVED` rule checks, so it needs
 * to be computable without rendering.
 *
 * Overlaps are not subtracted — two stacked cards count twice. That makes the
 * result a *lower bound* on emptiness, which is the safe direction: it can report
 * a crowded layout as more crowded than it is, and never a crowded one as roomy.
 */
export function negativeSpaceRatio(
  g: GridSpec,
  boxes: readonly { width: number; height: number }[],
): number {
  const frame = g.width * g.height;
  if (frame <= 0) return 1;
  const covered = boxes.reduce((sum, b) => sum + Math.max(0, b.width) * Math.max(0, b.height), 0);
  return Math.max(0, 1 - covered / frame);
}

/** Below this fraction of empty frame, a layout is crowded. */
export const MIN_NEGATIVE_SPACE = 0.3;

/**
 * Tolerance for on-grid checks, px.
 *
 * Not 1px, and the reason is `opticalLeftX`: optical alignment *deliberately*
 * pushes a round or pointed first glyph a few px outside the column so the edge
 * does not look ragged. That deviation is the craft, not a defect — a tolerance
 * tight enough to reject it would make the linter fire on exactly the elements
 * that were placed most carefully. A quote mark's overhang can reach ~22% of the
 * font size, so optically-corrected text also declares its own allowance.
 */
export const GRID_TOLERANCE = 4;

/**
 * True when an element sits on the grid.
 *
 * Three things count as on-grid, and the first version only knew about the first,
 * which is why the design linter reported every left-aligned and every bleeding
 * element as misaligned:
 *
 *  1. **Centre on a column-span centre** — a centred element.
 *  2. **Left or right edge on a column edge** — a left- or right-aligned element
 *     whose box is narrower than its span. Its centre is legitimately nowhere
 *     near a span centre, and demanding otherwise is simply wrong.
 *  3. **Bleeding past the frame edge** — an image running off the side is an
 *     editorial device, not a misalignment. Its inboard edge is what must be on
 *     the grid, and that is covered by (2).
 */
export function isOnGrid(
  g: GridSpec,
  x: number,
  y: number,
  o: { width?: number; tolerance?: number } = {},
): boolean {
  const tol = o.tolerance ?? GRID_TOLERANCE;
  const modY = Math.abs(y - g.margin) % g.baseline;
  const onBaseline = modY <= tol || g.baseline - modY <= tol;
  if (!onBaseline) return false;

  const half = (o.width ?? 0) / 2;
  const left = x - half;
  const right = x + half;

  // Bleed: an element extending past a frame edge is anchored by its other edge.
  const bleedsLeft = left < -tol;
  const bleedsRight = right > g.width + tol;

  for (let from = 0; from < g.columns; from++) {
    for (let to = from; to < g.columns; to++) {
      const span: [number, number] = [from, to];
      if (Math.abs(spanCenterX(g, span) - x) <= tol) return true;
      if (half > 0) {
        const spanLeft = columnLeft(g, from);
        const spanRight = spanLeft + spanWidth(g, span);
        if (!bleedsLeft && Math.abs(spanLeft - left) <= tol) return true;
        if (!bleedsRight && Math.abs(spanRight - right) <= tol) return true;
      }
    }
  }
  // Frame centre is always legitimate — a full-bleed element spans everything.
  if (Math.abs(x - g.width / 2) <= tol) return true;
  // Fully bled on one side with the other edge past the margin: an intentional
  // full-bleed crop, which has no column to land on at all.
  if (bleedsLeft || bleedsRight) return true;
  return false;
}
