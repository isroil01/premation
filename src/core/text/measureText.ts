/**
 * Text measurement — the boxes a text layer occupies.
 *
 * Three different boxes, for three different jobs. Conflating them is what
 * caused the selection outline to sit below the capitals it was supposed to
 * enclose, so they are named and returned separately:
 *
 *   • FONT box — from `fontBoundingBoxAscent/Descent`. Stable for ANY string
 *                  in this font at this size. This is the SELECTION box. AE
 *                  does the same: `HELLO` and `Hello` get identical heights, so
 *                  the outline does not twitch while you type.
 *   • INK box — from `actualBoundingBox*`. Tight to these specific glyphs,
 *                  changes on every keystroke. What an auto-sizing plate behind
 *                  the text needs; wrong for a selection outline.
 *   • RENDER box — the texture the rasterizer allocates. The typographic line
 *                  box plus padding, but never smaller than the ink, because a
 *                  texture smaller than the glyphs CLIPS them (see below).
 *
 * ── The origin, stated explicitly ───────────────────────────────────
 * Every offset in a `TextBox` is relative to the DRAW ORIGIN: the centre of the
 * render box, which is where `Canvas2DVectorRasterizer.drawText` places the text
 * (`fillText(line, w/2, startY + i*gap)` with `textBaseline = 'middle'`).
 * +x is right, +y is down. `offsetY` is where the box's own centre sits relative
 * to that origin — it is NOT zero, and assuming it was is the bug this file used
 * to have.
 *
 * ── Why the measuring context sets textBaseline ─────────────────────
 * `measureText` reports ascent/descent relative to the MEASURING context's
 * `textBaseline`, not the drawing one. This context used to leave it at the
 * default `'alphabetic'` while the rasterizer drew with `'middle'`, and a
 * comment here asserted the opposite. Measured in Chromium, Inter 48px/600,
 * "HELLO":
 *
 *     textBaseline 'alphabetic' → ascent 34.00, descent  0.00
 *     textBaseline 'middle'     → ascent 20.77, descent 13.23
 *
 * The sum is identical (34), which is why the HEIGHT always looked right; the
 * band's placement is what differed. Centring a 34px band on the draw origin
 * put its top at 17px above the origin when the caps actually reach 20.77px —
 * capitals hung ~4px above their own selection box. The fix is one line: measure
 * in the same baseline we draw in.
 *
 * ── Why the render box grew a floor ─────────────────────────────────
 * The render box height was `fontSize × lineHeight + padding` — a number with no
 * relationship to how tall the glyphs are. Below roughly
 * `lineHeight < 0.97 − 2·PAD_Y/fontSize` the glyphs are taller than the texture
 * and are genuinely cut off in the rendered frame, not merely in the outline.
 * Verified in Chromium: at 320px/0.7 the ink spans rows 0..239 of a 240px
 * canvas; at 200px/0.85, rows 1..185 of 186. The height is now floored at the
 * ink band, so the texture always contains its own glyphs.
 *
 * Results are memoized per (content, style, stroke) — geometry runs per
 * pointer-move — and the caches are dropped when webfonts finish loading, so a
 * measurement taken against a fallback face cannot be cached forever.
 */

import type { SceneNode } from '@core/types';
import { codePointToGraphemeIndex, graphemeCount, graphemesAreCodePoints, splitGraphemes } from './graphemes';
import { onFontVariantsChanged, variantFamily } from './fontFaceVariants';
import { fontVariationString, readFontAxesProp } from './fontAxes';
import { layoutVerticalText } from './verticalLayout';
import { isIdeographicUnit, joinWrapped, wrapUnits } from './lineBreak';
import { layoutText, paragraphLineMetrics, type RichRun, type TextLayout } from './textLayout';
import { opticalKernPx, opticalKernVerticalPx, REF_EM_PX, type OpticalFace } from './opticalKerning';
import {
  FAUX_BOLD_STROKE_RATIO,
  FAUX_ITALIC_SKEW,
  TATE_CHU_YOKO_DEFAULT_DIGITS,
  TEXT_PAD_X,
  centredLineYs,
  hardEndsOf,
  hasTextPath,
  lineOffsets,
  placeLinesInBox,
  readParagraphBox,
  resolveAlignForDirection,
  softBreakLines as softBreakLinesOf,
} from './textExtras';

/** Padding so antialiasing has somewhere to land (px each side). Shared with
 *  the painter, which insets left/right-aligned lines by the same amount. */
const PAD_X = TEXT_PAD_X;
const PAD_Y = 8;
/** Line height a text node uses when it declares none — the measuring default. */
export const DEFAULT_LINE_HEIGHT = 1.2;

/**
 * A measured box, in px, relative to the draw origin (see the file docblock).
 * `top`/`left` are negative for content above/left of the origin.
 */
export interface TextBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
  /** The box centre relative to the draw origin. Negative = the box sits high. */
  offsetY: number;
}

export interface MeasuredText {
  /** Font-metric box — stable per (font, size, line count). Use for selection. */
  font: TextBox;
  /** Glyph-ink box — tight, changes as the user types. Use for auto-plates. */
  ink: TextBox;
  /** Widest line's advance width (NOT its ink width — italics overhang it). */
  advance: number;
  /**
   * How far the FIRST line's alphabetic baseline sits BELOW the block centre.
   *
   * The rasterizer draws on the `middle` baseline at the block centre, and
   * `middle` is by definition near the middle of the em box — so `font.offsetY`
   * is ~0 and says nothing about where the baseline is. Anything that has to
   * place text by its BASELINE (an SVG `<text y>`, say) needs this instead:
   * measured 9.62px for 32px Inter, i.e. 0.30em, where `offsetY` was 1.88.
   *
   * Zero on a runtime that reports no baseline metric (jsdom), which leaves the
   * caller drawing centred on the baseline exactly as it did before.
   */
  baselineOffset: number;
}

// ── Shared measuring context ────────────────────────────────────────
// One reused offscreen context: creating a canvas per measurement shows up
// during scrubbing. `textBaseline` matches the rasterizer's — see the docblock.

let ctx: CanvasRenderingContext2D | null | undefined;
function measureCtx(): CanvasRenderingContext2D | null {
  if (ctx === undefined) {
    ctx = typeof document !== 'undefined'
      ? document.createElement('canvas').getContext('2d')
      : null;
    if (ctx) ctx.textBaseline = 'middle';
  }
  return ctx;
}

// ── Caches, invalidated when webfonts arrive ────────────────────────

const boxCache = new Map<string, MeasuredText>();
const renderCache = new Map<string, { w: number; h: number }>();
const MAX_CACHE = 500;

/** Drop every memoized measurement (a newly-loaded face changes all of them). */
export function invalidateTextMeasurements(): void {
  boxCache.clear();
  renderCache.clear();
  wrapCache.clear();
  fitCache.clear();
}

// A face that arrives after first paint changes every metric it touches. Without
// this, the first measurement — taken against the fallback — is cached forever,
// which is a confusing failure precisely because the text looks right and only
// the boxes are wrong.
if (typeof document !== 'undefined' && typeof document.fonts !== 'undefined') {
  void document.fonts.ready.then(invalidateTextMeasurements);
  document.fonts.addEventListener?.('loadingdone', invalidateTextMeasurements);
}
// A variable-axis ALIAS face (fontFaceVariants.ts) lands asynchronously too.
// Its arrival already turns the texture provider over (re-rasterize + render);
// dropping the boxes here makes that same render re-measure the layer box with
// the alias instead of reusing the plain-family width.
onFontVariantsChanged(invalidateTextMeasurements);

// ── Style extraction ────────────────────────────────────────────────

export interface MeasuredTextStyle {
  content: string;
  /**
   * Fixed box width in px — the POINT vs PARAGRAPH distinction.
   *
   * Absent = point text: the box is derived from the content, so dragging a
   * handle scales the type. Present = paragraph text: the box is authored, the
   * content wraps inside it, and resizing REFLOWS rather than changing the
   * font size. That is the whole behavioural difference, and it comes down to
   * which of the two is the input and which is the output.
   */
  boxWidth?: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  /** Variable-font wdth axis (%). Applied via fontVariationSettings when set. */
  fontWidth?: number;
  /** Variable-font slnt axis (degrees). Applied via fontVariationSettings when set. */
  fontSlant?: number;
  /** Variable-font axes beyond wght/wdth/slnt (`fontAxes` on the Text component). */
  fontAxes?: Record<string, number>;
  /** Vertical type (verticalLayout.ts): measured as columns, never wrapped. */
  orientation?: 'vertical';
  /** Standard Vertical Roman Alignment. */
  verticalRomanAlignment?: boolean;
  /** Vertical type's auto tate-chu-yoko digit count (absent = off). */
  tateChuYokoDigits?: number;
  /**
   * An AUTO-HEIGHT box's authored height, px: the box keeps the top edge of a
   * box this tall while its text grows or shrinks (AE). Absent = the legacy
   * box that grows about its centre.
   */
  boxAnchorHeight?: number;
  letterSpacing: number;
  lineHeight: number;
  paragraphSpacing: number;
  /** Character-panel case: 'none' | 'uppercase' | 'lowercase' | 'capitalize'. */
  textTransform?: string;
  /** 'normal' | 'small-caps'. */
  fontVariant?: string;
  /** 'baseline' | 'super' | 'sub' — superscript/subscript for the whole layer. */
  verticalAlign?: string;
  /** Percent; 100 = unscaled. */
  verticalScale?: number;
  horizontalScale?: number;
  /** Px, positive raises the type. */
  baselineShift?: number;
  /** Paragraph indents, px — shrink the WRAP width of paragraph text. */
  leftIndent?: number;
  rightIndent?: number;
  firstLineIndent?: number;
  /** Px between paragraphs (hard newlines). */
  spaceBefore?: number;
  spaceAfter?: number;
  /** Wrapped-content line numbers that end in a soft wrap. Set by
   *  `readMeasuredTextStyle` for paragraph text; derived when absent. */
  softBreakLines?: number[];
  /** Faux styles widen the ink slightly; the render box allows for it. */
  fauxBold?: boolean;
  fauxItalic?: boolean;
  /**
   * Paragraph text with a FIXED box height (auto-size Off or Fit), px. Absent
   * = auto height. See `readParagraphBox` in textExtras.ts.
   */
  boxHeight?: number;
  boxVerticalAlign?: 'center' | 'bottom';
  /** 'fit' = Fit Text to Box; the only mode that needs a flag of its own. */
  boxAutoSize?: 'fit';
  /**
   * Fit Text to Box's render-time type scale (1 = fits as authored). Set by
   * `wrappedStyle`; the text wraps at `boxWidth / fitScale` and is drawn
   * scaled by it, which is the same layout as the font at `fontSize × scale`.
   */
  fitScale?: number;
  /** Optical kerning (opticalKerning.ts): line widths use the painter's pair
   *  adjustments on unkerned advances. Absent = the font's metrics kerning. */
  kerningMode?: 'optical';
  /**
   * Character runs that change a line's HEIGHT (font size or leading), in
   * grapheme indices — so the paragraph box's line stack and overflow flag are
   * the painter's (`paragraphLineMetrics`). Absent when no run does.
   */
  lineRuns?: RichRun[];
}

/** AE's superscript/subscript: the glyphs shrink to this fraction of the size… */
export const SUPER_SUB_SCALE = 0.65;
/** …and move by this fraction of the font size (up for super, down for sub). */
export const SUPER_SHIFT = 0.35;
export const SUB_SHIFT = 0.15;

/** The Character panel's case transform, applied to the drawn string. */
export function applyTextCase(text: string, mode: string | undefined): string {
  switch (mode) {
    case 'uppercase': return text.toUpperCase();
    case 'lowercase': return text.toLowerCase();
    case 'capitalize': return text.replace(/(^|\s)(\S)/g, (_m, sp: string, ch: string) => sp + ch.toUpperCase());
    default: return text;
  }
}

/**
 * The whole-layer glyph transform the Character panel's scale, baseline
 * shift and super/subscript buttons amount to: an x/y scale about the box
 * centre and a vertical offset in px (positive = down, canvas convention).
 * One function, read by measurement AND the rasterizer, so the box a text
 * layer reports is the box its pixels fill.
 */
export function textStyleTransform(
  s: Pick<MeasuredTextStyle, 'fontSize' | 'verticalAlign' | 'verticalScale' | 'horizontalScale' | 'baselineShift'>,
): { sx: number; sy: number; dy: number } {
  const va = s.verticalAlign === 'super' || s.verticalAlign === 'sub' ? SUPER_SUB_SCALE : 1;
  const sx = ((typeof s.horizontalScale === 'number' && s.horizontalScale > 0 ? s.horizontalScale : 100) / 100) * va;
  const sy = ((typeof s.verticalScale === 'number' && s.verticalScale > 0 ? s.verticalScale : 100) / 100) * va;
  let dy = -(typeof s.baselineShift === 'number' && Number.isFinite(s.baselineShift) ? s.baselineShift : 0);
  if (s.verticalAlign === 'super') dy -= s.fontSize * SUPER_SHIFT;
  else if (s.verticalAlign === 'sub') dy += s.fontSize * SUB_SHIFT;
  return { sx, sy, dy };
}

/** Pull the style fields that affect measurement off a text node (with optional evaluated props override). */
export function readMeasuredTextStyle(node: SceneNode, overrideProps?: Record<string, unknown>): MeasuredTextStyle | null {
  let content: string | undefined;
  let fontSize = 48;
  let fontFamily = 'Inter';
  let fontWeight = '600';
  let fontStyle = 'normal';
  let letterSpacing = 0;
  let lineHeight = DEFAULT_LINE_HEIGHT;
  let paragraphSpacing = 0;
  let boxWidth: number | undefined;
  let fontWidth: number | undefined;
  let fontSlant: number | undefined;
  let textTransform: string | undefined;
  let fontVariant: string | undefined;
  let verticalAlign: string | undefined;
  let verticalScale: number | undefined;
  let horizontalScale: number | undefined;
  let baselineShift: number | undefined;
  const para: Pick<MeasuredTextStyle, 'leftIndent' | 'rightIndent' | 'firstLineIndent' | 'spaceBefore' | 'spaceAfter' | 'fauxBold' | 'fauxItalic'> = {};
  const readExtras = (p: Record<string, unknown>): void => {
    for (const k of ['leftIndent', 'rightIndent', 'firstLineIndent', 'spaceBefore', 'spaceAfter'] as const) {
      const v = p[k];
      if (typeof v === 'number' && Number.isFinite(v)) para[k] = v;
    }
    if (typeof p.fauxBold === 'boolean') para.fauxBold = p.fauxBold;
    if (typeof p.fauxItalic === 'boolean') para.fauxItalic = p.fauxItalic;
    if (typeof p.textTransform === 'string') textTransform = p.textTransform;
    if (typeof p.fontVariant === 'string') fontVariant = p.fontVariant;
    if (typeof p.verticalAlign === 'string') verticalAlign = p.verticalAlign;
    if (typeof p.verticalScale === 'number') verticalScale = p.verticalScale;
    if (typeof p.horizontalScale === 'number') horizontalScale = p.horizontalScale;
    if (typeof p.baselineShift === 'number') baselineShift = p.baselineShift;
    if (p.orientation === 'vertical' || p.orientation === 'horizontal') orientation = p.orientation;
    if (typeof p.verticalRomanAlignment === 'boolean') romanUpright = p.verticalRomanAlignment;
    if (typeof p.tateChuYokoAuto === 'boolean') tcyAuto = p.tateChuYokoAuto;
    if (typeof p.tateChuYokoDigits === 'number' && Number.isFinite(p.tateChuYokoDigits)) tcyDigits = p.tateChuYokoDigits;
    if (p.kerningMode === 'optical' || p.kerningMode === 'metrics') kerningMode = p.kerningMode;
  };
  let orientation: string | undefined;
  let romanUpright = false;
  let tcyAuto = false;
  let tcyDigits = TATE_CHU_YOKO_DEFAULT_DIGITS;
  let kerningMode: string | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    readExtras(p);
    if (typeof p.content === 'string') content = p.content;
    if (typeof p.fontSize === 'number') fontSize = p.fontSize;
    if (typeof p.fontFamily === 'string') fontFamily = p.fontFamily;
    if (typeof p.fontWeight === 'string') fontWeight = p.fontWeight;
    else if (typeof p.fontWeight === 'number') fontWeight = String(p.fontWeight);
    if (typeof p.fontStyle === 'string') fontStyle = p.fontStyle;
    if (typeof p.fontWidth === 'number') fontWidth = p.fontWidth;
    if (typeof p.fontSlant === 'number') fontSlant = p.fontSlant;
    if (typeof p.letterSpacing === 'number') letterSpacing = p.letterSpacing;
    if (typeof p.lineHeight === 'number') lineHeight = p.lineHeight;
    if (typeof p.paragraphSpacing === 'number') paragraphSpacing = p.paragraphSpacing;
    if (typeof p.boxWidth === 'number') boxWidth = p.boxWidth;
  }
  if (overrideProps) {
    readExtras(overrideProps);
    if (typeof overrideProps.content === 'string') content = overrideProps.content;
    if (typeof overrideProps.fontSize === 'number') fontSize = overrideProps.fontSize;
    if (typeof overrideProps.fontFamily === 'string') fontFamily = overrideProps.fontFamily;
    if (typeof overrideProps.fontWeight === 'string') fontWeight = overrideProps.fontWeight;
    else if (typeof overrideProps.fontWeight === 'number') fontWeight = String(overrideProps.fontWeight);
    if (typeof overrideProps.fontStyle === 'string') fontStyle = overrideProps.fontStyle;
    if (typeof overrideProps.fontWidth === 'number') fontWidth = overrideProps.fontWidth;
    if (typeof overrideProps.fontSlant === 'number') fontSlant = overrideProps.fontSlant;
    if (typeof overrideProps.letterSpacing === 'number') letterSpacing = overrideProps.letterSpacing;
    if (typeof overrideProps.lineHeight === 'number') lineHeight = overrideProps.lineHeight;
    if (typeof overrideProps.paragraphSpacing === 'number') paragraphSpacing = overrideProps.paragraphSpacing;
    if (typeof overrideProps.boxWidth === 'number') boxWidth = overrideProps.boxWidth;
  }
  if (content === undefined) return null;
  // Text on a PATH is point text (AE): its authored box width neither wraps it
  // nor sizes it — the same reading `readParagraphBox` gives the box height.
  if (hasTextPath(node)) boxWidth = undefined;
  const style: MeasuredTextStyle = {
    content, fontSize, fontFamily, fontWeight, fontStyle, letterSpacing, lineHeight, paragraphSpacing,
    ...(typeof fontWidth === 'number' ? { fontWidth } : {}),
    ...(typeof fontSlant === 'number' ? { fontSlant } : {}),
    ...(typeof boxWidth === 'number' && boxWidth > 0 ? { boxWidth } : {}),
    ...(textTransform && textTransform !== 'none' ? { textTransform } : {}),
    ...(fontVariant && fontVariant !== 'normal' ? { fontVariant } : {}),
    ...(verticalAlign && verticalAlign !== 'baseline' ? { verticalAlign } : {}),
    ...(typeof verticalScale === 'number' && verticalScale !== 100 ? { verticalScale } : {}),
    ...(typeof horizontalScale === 'number' && horizontalScale !== 100 ? { horizontalScale } : {}),
    ...(typeof baselineShift === 'number' && baselineShift !== 0 ? { baselineShift } : {}),
    ...(para.leftIndent ? { leftIndent: para.leftIndent } : {}),
    ...(para.rightIndent ? { rightIndent: para.rightIndent } : {}),
    ...(para.firstLineIndent ? { firstLineIndent: para.firstLineIndent } : {}),
    ...(para.spaceBefore ? { spaceBefore: para.spaceBefore } : {}),
    ...(para.spaceAfter ? { spaceAfter: para.spaceAfter } : {}),
    ...(para.fauxBold ? { fauxBold: true } : {}),
    ...(para.fauxItalic ? { fauxItalic: true } : {}),
  };
  const axes = readFontAxesProp(node);
  if (Object.keys(axes).length > 0) style.fontAxes = axes;
  if (orientation === 'vertical') {
    style.orientation = 'vertical';
    if (romanUpright) style.verticalRomanAlignment = true;
    if (tcyAuto) style.tateChuYokoDigits = Math.max(1, Math.min(4, Math.round(tcyDigits)));
  }
  // Optical kerning applies to vertical columns too (verticalLayout.ts).
  if (kerningMode === 'optical') style.kerningMode = 'optical';
  if (style.boxWidth) {
    const lineRuns = readLineRuns(node);
    if (lineRuns) style.lineRuns = lineRuns;
  }
  const paragraphBox = style.boxWidth ? readParagraphBox(node, overrideProps) : null;
  if (paragraphBox && paragraphBox.fixedHeight) {
    style.boxHeight = paragraphBox.boxHeight;
    if (paragraphBox.verticalAlign !== 'top') style.boxVerticalAlign = paragraphBox.verticalAlign;
    if (paragraphBox.autoSize === 'fit') style.boxAutoSize = 'fit';
  } else if (paragraphBox && paragraphBox.boxHeight > 0 && orientation !== 'vertical') {
    style.boxAnchorHeight = paragraphBox.boxHeight;
  }
  // Wrapping happens HERE, once, so measurement and rendering cannot disagree
  // about where the lines break — the wrapped text is just text with newlines
  // in it, which every downstream consumer already handles. Which of those
  // newlines were SOFT is remembered, for justification and paragraph spacing.
  return style.boxWidth ? wrappedStyle(style) : style;
}

/** A paragraph style with its content wrapped and its soft breaks recorded.
 *  Idempotent: an already-wrapped style keeps the soft breaks it carries. */
function wrappedStyle(s: MeasuredTextStyle): MeasuredTextStyle {
  // Vertical type breaks its COLUMNS at layout time (by box height, anywhere
  // between characters — CJK has no spaces to replace with newlines).
  if (!s.boxWidth || s.orientation === 'vertical') return s;
  // Fit Text to Box decides its scale on the UNWRAPPED content, once; the
  // scale then rides on the style so re-wrapping an already-wrapped style
  // (idempotence) never searches again.
  const fitted = s.boxAutoSize === 'fit' && s.boxHeight && s.fitScale === undefined
    ? { ...s, fitScale: fitScaleOf(s) }
    : s;
  const wrapped = wrapText(fitted);
  return { ...fitted, content: wrapped, softBreakLines: fitted.softBreakLines ?? softBreakLinesOf(fitted.content, wrapped) };
}

/**
 * The runs of a text node that change line HEIGHT (font size / leading), in
 * grapheme indices, or undefined. Read here rather than through richText.ts
 * (which pulls in the scene graph); the legacy code-point migration is the same.
 */
function readLineRuns(node: SceneNode): RichRun[] | undefined {
  const t = node.components.find((c) => c.type === 'Text')?.props as Record<string, unknown> | undefined;
  const raw = t?.__runs;
  if (!Array.isArray(raw)) return undefined;
  const content = typeof t?.content === 'string' ? t.content : '';
  const migrate = t?.__runsIndex !== 'grapheme' && !graphemesAreCodePoints(content);
  const out: RichRun[] = [];
  for (const r of raw as unknown[]) {
    const run = r as Partial<RichRun> | null;
    const st = run?.style as Record<string, unknown> | undefined;
    if (!run || typeof run.start !== 'number' || typeof run.end !== 'number' || !st) continue;
    const size = typeof st.fontSize === 'number' && st.fontSize > 0 ? st.fontSize : undefined;
    const leading = typeof st.lineHeight === 'number' && st.lineHeight > 0 ? st.lineHeight : undefined;
    if (size === undefined && leading === undefined) continue;
    out.push({
      start: migrate ? codePointToGraphemeIndex(content, run.start, false) : run.start,
      end: migrate ? codePointToGraphemeIndex(content, run.end, true) : run.end,
      style: { ...(size !== undefined ? { fontSize: size } : {}), ...(leading !== undefined ? { lineHeight: leading } : {}) },
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Where the lines of a WRAPPED fixed-box style sit, in its own (unscaled) units. */
function boxPlacementOf(s: MeasuredTextStyle): { placement: ReturnType<typeof placeLinesInBox>; lineHeightPx: number; blockHeight: number; lineCount: number } {
  if (s.lineRuns) {
    // Runs that raise the size or leading: the painter's own line stack
    // (textLayout.stackLines), per-line line boxes included.
    const m = paragraphLineMetrics(
      s.content,
      { fontSize: s.fontSize, lineHeight: s.lineHeight || DEFAULT_LINE_HEIGHT, paragraphSpacing: s.paragraphSpacing, spaceBefore: s.spaceBefore, spaceAfter: s.spaceAfter },
      s.lineRuns,
      s.softBreakLines,
    );
    const k = s.fitScale && s.fitScale > 0 ? s.fitScale : 1;
    const placement = s.boxHeight
      ? placeLinesInBox(m.ys, m.leading, s.boxHeight / k, s.boxVerticalAlign)
      : { dy: 0, visible: m.ys.length, overflow: false };
    return { placement, lineHeightPx: m.lineHeightPx, blockHeight: m.blockHeight, lineCount: m.ys.length };
  }
  const n = s.content.split('\n').length;
  const lineHeightPx = s.fontSize * (s.lineHeight || DEFAULT_LINE_HEIGHT);
  const { offsets, total } = lineOffsets(
    hardEndsOf(n, s.softBreakLines),
    lineHeightPx + s.paragraphSpacing,
    s.spaceBefore,
    s.spaceAfter,
  );
  const k = s.fitScale && s.fitScale > 0 ? s.fitScale : 1;
  const placement = s.boxHeight
    ? placeLinesInBox(centredLineYs(offsets, total), lineHeightPx, s.boxHeight / k, s.boxVerticalAlign)
    : { dy: 0, visible: n, overflow: false };
  return { placement, lineHeightPx, blockHeight: total + lineHeightPx, lineCount: n };
}

const fitCache = new Map<string, number>();
/** Fit Text to Box never shrinks the type below this fraction. */
export const MIN_FIT_SCALE = 0.05;

/**
 * The largest type scale ≤ 1 at which a fixed box holds all of its text —
 * every line inside the box height and no line wider than the box. A binary
 * search on the real wrap: shrinking the type re-wraps it, so the answer is
 * not a ratio of heights. 1 when the text already fits (or nothing can be
 * measured); `MIN_FIT_SCALE` when even that overflows.
 */
function fitScaleOf(s: MeasuredTextStyle): number {
  const g = measureCtx();
  if (!g || !s.boxWidth || !s.boxHeight) return 1;
  const key = keyOf(s, 0);
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;
  const fits = (k: number): boolean => {
    const trial: MeasuredTextStyle = { ...s, fitScale: k, softBreakLines: undefined };
    const wrapped = wrapText(trial);
    const laid: MeasuredTextStyle = { ...trial, content: wrapped, softBreakLines: softBreakLinesOf(s.content, wrapped) };
    if (boxPlacementOf(laid).placement.overflow) return false;
    g.font = cssFont(s);
    applyFontVariations(g, s);
    const inner = s.boxWidth! / k - (s.leftIndent ?? 0) - (s.rightIndent ?? 0);
    for (const line of wrapped.split('\n')) {
      const chars = graphemeCount(line);
      const w = g.measureText(line).width + (chars > 0 ? (chars - 1) * s.letterSpacing : 0) + opticalLineDelta(s, line);
      if (w > inner + 0.5) return false;
    }
    return true;
  };
  let result = 1;
  if (!fits(1)) {
    let lo = MIN_FIT_SCALE;
    let hi = 1;
    if (fits(lo)) {
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
    }
    result = Math.floor(lo * 1e4) / 1e4;
  }
  if (fitCache.size >= MAX_CACHE) fitCache.clear();
  fitCache.set(key, result);
  return result;
}

export interface ParagraphBoxMeasure {
  boxWidth: number;
  /** The box's height: authored when fixed, the text's own when auto. */
  boxHeight: number;
  fixedHeight: boolean;
  /** Text runs past the bottom of a fixed box (AE's red overflow "+"). */
  overflow: boolean;
  /** Fit Text to Box scale; 1 otherwise. */
  fitScale: number;
  /** Height the lines occupy as drawn (after any fit scale), px. */
  contentHeight: number;
  lineCount: number;
  /** Lines actually drawn — the rest are clipped. */
  visibleLines: number;
  /**
   * How far the line block sits from where it would sit centred on the layer
   * origin (the auto-height / point-text position), px, +y down. Zero unless a
   * fixed box aligns its lines to the top or bottom.
   */
  lineOffsetY: number;
}

/**
 * The paragraph box of a style: its size, whether its text overflows, and the
 * fit scale. Null for point text. Needs no canvas beyond what wrapping needs,
 * so the overflow flag the viewport shows is computed by the same
 * `placeLinesInBox` the painter clips with.
 */
export function measureParagraphBox(input: MeasuredTextStyle): ParagraphBoxMeasure | null {
  if (!input.boxWidth) return null;
  const s = wrappedStyle(input);
  if (s.orientation === 'vertical') {
    const g = measureCtx();
    const laid = g ? verticalLayoutOf(s, g) : null;
    const columns = laid?.lines.length ?? 1;
    const visible = laid?.visibleLines ?? columns;
    const height = laid?.height ?? 0;
    return {
      boxWidth: s.boxWidth!,
      boxHeight: s.boxHeight ? s.boxHeight : height,
      fixedHeight: !!s.boxHeight,
      overflow: visible < columns,
      fitScale: 1,
      contentHeight: height,
      lineCount: columns,
      visibleLines: visible,
      lineOffsetY: 0,
    };
  }
  const k = s.fitScale && s.fitScale > 0 ? s.fitScale : 1;
  const { placement, blockHeight, lineCount } = boxPlacementOf(s);
  const contentHeight = blockHeight * k;
  return {
    boxWidth: s.boxWidth!,
    boxHeight: s.boxHeight ? s.boxHeight : contentHeight,
    fixedHeight: !!s.boxHeight,
    overflow: placement.overflow,
    fitScale: k,
    contentHeight,
    lineCount,
    visibleLines: placement.visible,
    // Auto height with an authored height: the TOP edge of that box stays put,
    // so the (centred) line block moves down by half of what it grew.
    lineOffsetY: !s.boxHeight && s.boxAnchorHeight ? anchorOffsetOf(s, contentHeight) : placement.dy * k,
  };
}

/** How far an anchored auto-height box's content sits below centre, px. */
function anchorOffsetOf(s: MeasuredTextStyle, contentHeight: number): number {
  return s.boxAnchorHeight ? (contentHeight - s.boxAnchorHeight) / 2 : 0;
}

/** `measureParagraphBox` for a text NODE (null for point text / non-text). */
export function measureTextNodeParagraphBox(node: SceneNode, overrideProps?: Record<string, unknown>): ParagraphBoxMeasure | null {
  const style = readMeasuredTextStyle(node, overrideProps);
  return style ? measureParagraphBox(style) : null;
}

const wrapCache = new Map<string, string>();

/**
 * Break `content` to fit `boxWidth`, returning the same string with newlines
 * inserted. Existing hard newlines are preserved as paragraph breaks.
 *
 * Greedy word wrapping: a word that does not fit starts a new line. A single
 * word longer than the box is NOT broken mid-word — it overhangs, which is
 * what every text engine does and what users expect from a long URL. Returns
 * the input unchanged when there is no DOM to measure with.
 */
export function wrapText(s: MeasuredTextStyle): string {
  const g = measureCtx();
  // Fit Text to Box lays out at the unscaled font in a box `1 / fitScale`
  // wider, then draws scaled — identical to the smaller font in the real box.
  const width = s.boxWidth && s.fitScale && s.fitScale > 0 ? s.boxWidth / s.fitScale : s.boxWidth;
  if (!g || !width || width <= 0) return s.content;
  // Wrapping measures every candidate line; buildSnapshot asks for the same
  // wrap more than once per frame, so it is memoized like the boxes are.
  const key = keyOf(s, 0);
  const hit = wrapCache.get(key);
  if (hit !== undefined) return hit;
  g.font = cssFont(s);
  applyFontVariations(g, s);

  const advance = (text: string): number => {
    // Letter spacing sits between typographic characters — grapheme clusters.
    const chars = graphemeCount(text);
    return g.measureText(text).width + (chars > 0 ? (chars - 1) * s.letterSpacing : 0) + opticalLineDelta(s, text);
  };

  // Indents shrink the measure: the frame lines are drawn into is the box
  // minus the left and right indents, and a paragraph's first line also gives
  // up its first-line indent (a negative one — a hanging indent — gives room).
  const inner = width - (s.leftIndent ?? 0) - (s.rightIndent ?? 0);

  const out: string[] = [];
  for (const paragraph of s.content.split('\n')) {
    // CJK: lines break between characters (with kinsoku shori), where there is
    // no space to replace — lineBreak.ts. Paragraphs without an ideographic
    // character keep the space-only wrap below, byte for byte.
    const clusters = splitGraphemes(paragraph);
    if (clusters.some(isIdeographicUnit)) {
      const widths = clusters.map((c) => g.measureText(c).width + s.letterSpacing);
      const starts = wrapUnits(clusters, widths, (lineNo) => inner - (lineNo === 0 ? s.firstLineIndent ?? 0 : 0));
      out.push(joinWrapped(clusters, starts));
      continue;
    }
    // Split on spaces; each break REPLACES exactly one space with '\n', so the
    // wrapped string is the same length as the input and every run, selector
    // and soft-break index survives wrapping unchanged.
    const words = paragraph.split(' ');
    let line = words[0] ?? '';
    let first = true;
    for (let w = 1; w < words.length; w++) {
      const word = words[w]!;
      const candidate = `${line} ${word}`;
      const limit = inner - (first ? s.firstLineIndent ?? 0 : 0);
      if (line.trim() !== '' && word !== '' && advance(candidate) > limit) {
        out.push(line);
        line = word;
        first = false;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  const result = out.join('\n');
  if (wrapCache.size >= MAX_CACHE) wrapCache.clear();
  wrapCache.set(key, result);
  return result;
}

// ── Core measurement ────────────────────────────────────────────────

function cssFont(s: MeasuredTextStyle): string {
  const style = s.fontStyle === 'italic' ? 'italic ' : '';
  // Axes reach a 2D canvas only through an alias FontFace (fontFaceVariants.ts)
  // — the same family the painter draws with, so the box is the drawn width.
  const family = measureAlias(s) ?? s.fontFamily;
  return `${style}${s.fontWeight} ${s.fontSize}px "${family}", Inter, system-ui, sans-serif`;
}

/**
 * The loaded alias family for a style's variable axes, or null (no axes beyond
 * weight, no FontFace API, or not loaded yet — the plain family is then the
 * best available measure, and the alias's arrival re-measures).
 */
/** The variation string an axis alias draws `s` with, or undefined when it needs none. */
function measureVariation(s: MeasuredTextStyle): string | undefined {
  const axes = s.fontWidth !== undefined || s.fontSlant !== undefined || (!!s.fontAxes && Object.keys(s.fontAxes).length > 0);
  if (!axes) return undefined;
  return fontVariationString({ fontWeight: s.fontWeight, fontWidth: s.fontWidth, fontSlant: s.fontSlant, fontAxes: s.fontAxes });
}

function measureAlias(s: MeasuredTextStyle): string | null {
  const variation = measureVariation(s);
  if (variation === undefined) return null;
  return variantFamily({ fontFamily: s.fontFamily, fontWeight: s.fontWeight, fontStyle: s.fontStyle }, variation, undefined);
}

/** Vertical type laid out with this context's metrics (the painter's geometry). */
/**
 * A text node's glyphs laid out with this runtime's metrics, in the painter's
 * centre-origin space (layer-wide style; character runs are not resolved) —
 * what text on a path bends onto a curve. Null without a canvas (jsdom).
 */
export function measureTextNodeLayout(node: SceneNode, overrideProps?: Record<string, unknown>): TextLayout | null {
  const s = readMeasuredTextStyle(node, overrideProps);
  const g = measureCtx();
  if (!s || !g) return null;
  if (s.orientation === 'vertical') return verticalLayoutOf(s, g);
  let align: string | undefined;
  for (const c of node.components) {
    const a = (c.props as Record<string, unknown>).align;
    if (typeof a === 'string') align = a;
  }
  g.font = cssFont(s);
  applyFontVariations(g, s);
  const content = applyTextCase(s.content, s.textTransform);
  return layoutText(
    content,
    { fontSize: s.fontSize, letterSpacing: s.letterSpacing, lineHeight: s.lineHeight, paragraphSpacing: s.paragraphSpacing, align },
    (ch) => g.measureText(ch).width,
    { boxWidth: 0, measureRun: (t) => g.measureText(t).width + graphemeCount(t) * s.letterSpacing },
  );
}

function verticalLayoutOf(s: MeasuredTextStyle, g: CanvasRenderingContext2D): TextLayout {
  const font = cssFont(s);
  const content = applyTextCase(s.content, s.textTransform);
  const widths = new Map<string, number>();
  const measureOne = (t: string): number => {
    const hit = widths.get(t);
    if (hit !== undefined) return hit;
    g.font = font;
    const w = g.measureText(t).width;
    widths.set(t, w);
    return w;
  };
  return layoutVerticalText(
    content,
    {
      fontSize: s.fontSize,
      letterSpacing: s.letterSpacing,
      lineHeight: s.lineHeight,
      paragraphSpacing: s.paragraphSpacing,
      spaceBefore: s.spaceBefore,
      spaceAfter: s.spaceAfter,
    },
    (ch) => measureOne(ch),
    {
      boxWidth: s.boxWidth ? s.boxWidth + PAD_X * 2 : 0,
      padX: PAD_X,
      columnLimit: s.boxWidth ? s.boxHeight : undefined,
      measureRun: (t) => measureOne(t) + graphemeCount(t) * s.letterSpacing,
      romanUpright: !!s.verticalRomanAlignment,
      ...(s.tateChuYokoDigits ? { tateChuYokoDigits: s.tateChuYokoDigits } : {}),
      // The painter's optical pairs, so the box holds the columns it draws.
      ...(s.kerningMode === 'optical'
        ? (() => {
            const face: OpticalFace = {
              css: cssFont({ ...s, fontSize: REF_EM_PX }),
              family: s.fontFamily,
              weight: s.fontWeight,
              italic: s.fontStyle === 'italic',
              variable: measureAlias(s) !== null,
              variation: measureVariation(s),
            };
            return {
              opticalKern: (a: string, sa: { fontSize: number }, b: string, sb: { fontSize: number }) =>
                opticalKernPx(face, a, sa.fontSize, face, b, sb.fontSize),
              opticalKernVertical: (a: string, sa: { fontSize: number }, b: string, sb: { fontSize: number }) =>
                opticalKernVerticalPx(face, a, sa.fontSize, face, b, sb.fontSize),
            };
          })()
        : {}),
    },
  );
}

/** Match the rasterizer's font-variation-settings so measure agrees with paint. */
export function applyFontVariations(g: CanvasRenderingContext2D, s: MeasuredTextStyle): void {
  const parts: string[] = [];
  const w = Number(s.fontWeight);
  if (Number.isFinite(w)) parts.push(`'wght' ${w}`);
  if (s.fontWidth !== undefined && Number.isFinite(s.fontWidth)) parts.push(`'wdth' ${s.fontWidth}`);
  if (s.fontSlant !== undefined && Number.isFinite(s.fontSlant)) parts.push(`'slnt' ${s.fontSlant}`);
  (g as CanvasRenderingContext2D & { fontVariationSettings?: string }).fontVariationSettings = parts.length ? parts.join(', ') : 'normal';
  // Optical kerning replaces the font's kern pairs, exactly as the painter does.
  const kern = g as CanvasRenderingContext2D & { fontKerning?: string };
  if ('fontKerning' in kern) kern.fontKerning = s.kerningMode === 'optical' ? 'none' : 'auto';
}

/**
 * Optical kerning's net change to a line's width, px — the sum of the pair
 * adjustments the painter's `layoutText` adds (0 unless the style opted in).
 */
function opticalLineDelta(s: MeasuredTextStyle, line: string): number {
  if (s.kerningMode !== 'optical' || line.length < 2) return 0;
  const face: OpticalFace = {
    css: cssFont({ ...s, fontSize: REF_EM_PX }),
    family: s.fontFamily,
    weight: s.fontWeight,
    italic: s.fontStyle === 'italic',
    variable: measureAlias(s) !== null,
    variation: measureVariation(s),
  };
  const clusters = splitGraphemes(line);
  let d = 0;
  for (let i = 0; i < clusters.length - 1; i++) d += opticalKernPx(face, clusters[i]!, s.fontSize, face, clusters[i + 1]!, s.fontSize);
  return d;
}

function keyOf(s: MeasuredTextStyle, strokeWidth: number): string {
  return `${s.content}|${s.fontSize}|${s.fontFamily}|${s.fontWeight}|${s.fontStyle}|${s.fontWidth ?? ''}|${s.fontSlant ?? ''}|${s.letterSpacing}|${s.lineHeight}|${s.paragraphSpacing}|${strokeWidth}|${s.boxWidth ?? ''}`
    + `|${s.textTransform ?? ''}|${s.fontVariant ?? ''}|${s.verticalAlign ?? ''}|${s.verticalScale ?? ''}|${s.horizontalScale ?? ''}|${s.baselineShift ?? ''}`
    + `|${s.leftIndent ?? ''}|${s.rightIndent ?? ''}|${s.firstLineIndent ?? ''}|${s.spaceBefore ?? ''}|${s.spaceAfter ?? ''}|${s.fauxBold ? 1 : ''}|${s.fauxItalic ? 1 : ''}`
    + `|${s.softBreakLines ? s.softBreakLines.join(',') : ''}`
    + (s.boxHeight ? `|bh${s.boxHeight}|${s.boxVerticalAlign ?? ''}|${s.boxAutoSize ?? ''}|${s.fitScale ?? ''}` : '')
    // Appended only when set, so every existing key is unchanged.
    + (s.fontAxes ? `|ax${JSON.stringify(s.fontAxes)}` : '')
    + (s.fontWidth !== undefined || s.fontSlant !== undefined || s.fontAxes ? `|al${measureAlias(s) ?? ''}` : '')
    + (s.orientation === 'vertical' ? `|v${s.verticalRomanAlignment ? 'u' : ''}${s.tateChuYokoDigits ? `t${s.tateChuYokoDigits}` : ''}` : '')
    + (s.boxAnchorHeight ? `|ba${s.boxAnchorHeight}` : '')
    + (s.kerningMode === 'optical' ? '|ko' : '')
    + (s.lineRuns ? `|lr${JSON.stringify(s.lineRuns)}` : '');
}

function box(top: number, bottom: number, halfWidth: number): TextBox {
  return {
    top,
    bottom,
    left: -halfWidth,
    right: halfWidth,
    width: halfWidth * 2,
    height: bottom - top,
    offsetY: (top + bottom) / 2,
  };
}

/**
 * Measure a text style into its font, ink and advance boxes.
 *
 * `strokeWidth` expands every edge by half of it — a stroke straddles the path.
 * Returns null when measurement is impossible (no DOM, e.g. jsdom).
 *
 * Horizontal placement is concentric with the draw origin for ALL alignments,
 * and that is not an approximation: the rasterizer sizes the box as
 * `widestLine + 2·PAD_X` and then insets left-aligned text by `PAD_X` and
 * right-aligned text to `width − PAD_X`, so the run lands centred either way.
 */
export function measureTextBoxes(input: MeasuredTextStyle, strokeWidth = 0): MeasuredText | null {
  const g = measureCtx();
  if (!g) return null;
  // Paragraph text measures its WRAPPED content — otherwise a caller that built
  // the style by hand would measure one long line and report a box one line
  // tall, which is exactly the reflow the box width was set to produce.
  const s = wrappedStyle(input);
  const key = keyOf(s, strokeWidth);
  const hit = boxCache.get(key);
  if (hit) return hit;

  if (s.orientation === 'vertical') {
    // Columns: the block is centred on the draw origin in both axes.
    const laid = verticalLayoutOf(s, g);
    const half = strokeWidth / 2;
    const hw = laid.width / 2 + half;
    const hh = laid.height / 2 + half;
    const vbox = box(-hh, hh, hw);
    const vout: MeasuredText = { font: vbox, ink: vbox, advance: laid.width, baselineOffset: 0 };
    if (boxCache.size >= MAX_CACHE) boxCache.clear();
    boxCache.set(key, vout);
    return vout;
  }

  g.font = cssFont(s);
  applyFontVariations(g, s);
  // Belt and braces: some engines reset this with the font shorthand.
  g.textBaseline = 'middle';

  const lines = s.content.split('\n');
  const n = lines.length;
  const lineHeightPx = s.fontSize * (s.lineHeight || DEFAULT_LINE_HEIGHT);
  const gap = lineHeightPx + s.paragraphSpacing;
  // Space before/after moves lines apart across hard breaks. When neither is
  // set the offsets below are the uniform `(i − (n−1)/2)·gap` this function
  // always used, kept literally so existing boxes do not move by an ulp.
  const paraGap = (s.spaceBefore ?? 0) + (s.spaceAfter ?? 0);
  const vert = paraGap !== 0 ? lineOffsets(hardEndsOf(n, s.softBreakLines), gap, s.spaceBefore, s.spaceAfter) : null;
  const lineDy = (i: number): number => (vert ? -vert.total / 2 + vert.offsets[i]! : (i - (n - 1) / 2) * gap);

  let inkTop = Infinity, inkBottom = -Infinity, inkHalfW = 0;
  let fontTop = Infinity, fontBottom = -Infinity, advance = 0;
  /** First line's alphabetic baseline, relative to the block centre. */
  let baselineOffset = 0;

  for (let i = 0; i < n; i++) {
    const line = lines[i] ?? '';
    const m = g.measureText(line);
    if (i === 0) {
      // `alphabeticBaseline` is the distance from the CURRENT baseline (middle)
      // to the alphabetic one, positive UP — so negating it gives the downward
      // offset, and adding this line's own `dy` puts it in block-centre space.
      const ab = m.alphabeticBaseline;
      if (typeof ab === 'number' && Number.isFinite(ab)) {
        baselineOffset = lineDy(i) - ab;
      }
    }
    const chars = graphemeCount(line);
    // Optical kerning's pair adjustments count as spacing: they move ink and
    // advance alike (the canvas measured this line with kerning off).
    const spacing = (chars > 0 ? (chars - 1) * s.letterSpacing : 0) + opticalLineDelta(s, line);

    // Where this line's origin sits relative to the block's centre — the exact
    // arithmetic the rasterizer uses (`startY = h/2 − (n−1)·gap/2`).
    const dy = lineDy(i);

    const aAsc = m.actualBoundingBoxAscent;
    const aDesc = m.actualBoundingBoxDescent;
    if (typeof aAsc === 'number' && typeof aDesc === 'number') {
      inkTop = Math.min(inkTop, dy - aAsc);
      inkBottom = Math.max(inkBottom, dy + aDesc);
    }
    const aLeft = m.actualBoundingBoxLeft;
    const aRight = m.actualBoundingBoxRight;
    if (typeof aLeft === 'number' && typeof aRight === 'number') {
      inkHalfW = Math.max(inkHalfW, (aLeft + aRight + spacing) / 2);
    }

    const fAsc = m.fontBoundingBoxAscent;
    const fDesc = m.fontBoundingBoxDescent;
    if (typeof fAsc === 'number' && typeof fDesc === 'number') {
      fontTop = Math.min(fontTop, dy - fAsc);
      fontBottom = Math.max(fontBottom, dy + fDesc);
    }
    advance = Math.max(advance, m.width + spacing);
  }

  // Fallbacks, in descending order of trustworthiness, for runtimes that report
  // only some metrics (jsdom reports none). The line box is the last resort and
  // is what this file used before it read metrics at all.
  const halfLineBlock = ((vert ? vert.total : (n - 1) * gap) + lineHeightPx) / 2;
  if (!Number.isFinite(fontTop) || !Number.isFinite(fontBottom)) {
    if (Number.isFinite(inkTop) && Number.isFinite(inkBottom)) {
      fontTop = inkTop;
      fontBottom = inkBottom;
    } else {
      fontTop = -halfLineBlock;
      fontBottom = halfLineBlock;
    }
  }
  if (!Number.isFinite(inkTop) || !Number.isFinite(inkBottom)) {
    inkTop = fontTop;
    inkBottom = fontBottom;
  }
  if (inkHalfW <= 0) inkHalfW = advance / 2;

  const half = strokeWidth / 2;
  const out: MeasuredText = {
    font: box(fontTop - half, fontBottom + half, advance / 2 + half),
    ink: box(inkTop - half, inkBottom + half, inkHalfW + half),
    advance,
    baselineOffset,
  };

  if (boxCache.size >= MAX_CACHE) boxCache.clear();
  boxCache.set(key, out);
  return out;
}

/** One laid-out grapheme's box (getTextLayout.glyphs, B4 round 5): `measureTextBoxes`' space. */
export interface MeasuredGlyph {
  /** Grapheme index in the laid-out (wrapped) content. */
  index: number;
  line: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The line's middle baseline y (`textBaseline: 'middle'`). */
  baseline: number;
}

/**
 * Per-grapheme boxes of a HORIZONTAL style, in `measureTextBoxes`' space (the
 * layer origin; before the Character panel's scale and a Fit Text to Box
 * scale): each line's graphemes in logical order, x by canvas prefix widths
 * plus tracking from the line's pen start — the widest line's box (point text)
 * or the paragraph box less its indents (paragraph text), placed by the
 * resolved alignment (a justified line as its last-line alignment; a
 * right-to-left `direction` mirrors it and the indents) — y / height the line's
 * font band, baseline its middle baseline. The C++ twin is
 * native/engine/src/scene/text_query.cpp `glyph_boxes`. Empty for vertical
 * type; null without a canvas (jsdom).
 */
export function measureGlyphBoxes(input: MeasuredTextStyle, align: string | undefined, direction: 'ltr' | 'rtl'): MeasuredGlyph[] | null {
  if (input.orientation === 'vertical') return [];
  const g = measureCtx();
  if (!g) return null;
  const s = wrappedStyle(input);
  g.font = cssFont(s);
  applyFontVariations(g, s);
  g.textBaseline = 'middle';
  const lines = s.content.split('\n');
  const n = lines.length;
  const lineHeightPx = s.fontSize * (s.lineHeight || DEFAULT_LINE_HEIGHT);
  const gap = lineHeightPx + s.paragraphSpacing;
  const paraGap = (s.spaceBefore ?? 0) + (s.spaceAfter ?? 0);
  const vert = paraGap !== 0 ? lineOffsets(hardEndsOf(n, s.softBreakLines), gap, s.spaceBefore, s.spaceAfter) : null;
  const lineDy = (i: number): number => (vert ? -vert.total / 2 + vert.offsets[i]! : (i - (n - 1) / 2) * gap);
  const measured = lines.map((line) => {
    const m = g.measureText(line);
    const chars = graphemeCount(line);
    return { m, width: m.width + (chars > 0 ? (chars - 1) * s.letterSpacing : 0) + opticalLineDelta(s, line) };
  });
  const widest = measured.reduce((w, l) => Math.max(w, l.width), 0);
  const rtl = direction === 'rtl';
  let left = -widest / 2;
  let right = widest / 2;
  if (s.boxWidth) {
    const k = s.fitScale && s.fitScale > 0 ? s.fitScale : 1;
    const half = s.boxWidth / k / 2;
    left = -half + ((rtl ? s.rightIndent : s.leftIndent) ?? 0);
    right = half - ((rtl ? s.leftIndent : s.rightIndent) ?? 0);
  }
  const lineAlign = resolveAlignForDirection(align, direction).line;
  const out: MeasuredGlyph[] = [];
  let index = 0;
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    const { m, width } = measured[i]!;
    const gs = splitGraphemes(line);
    const dy = lineDy(i);
    const asc = typeof m.fontBoundingBoxAscent === 'number' && Number.isFinite(m.fontBoundingBoxAscent) ? m.fontBoundingBoxAscent : lineHeightPx / 2;
    const desc = typeof m.fontBoundingBoxDescent === 'number' && Number.isFinite(m.fontBoundingBoxDescent) ? m.fontBoundingBoxDescent : lineHeightPx / 2;
    const start = lineAlign === 'left' ? left : lineAlign === 'right' ? right - width : (left + right) / 2 - width / 2;
    let prefix = '';
    let pen = 0;
    for (let j = 0; j < gs.length; j++) {
      prefix += gs[j]!;
      const next = j === gs.length - 1 ? width : g.measureText(prefix).width + (j + 1) * s.letterSpacing;
      out.push({ index: index + j, line: i, x: start + pen, y: dy - asc, width: next - pen, height: asc + desc, baseline: dy });
      pen = next;
    }
    index += gs.length + 1;  // the line break
  }
  return out;
}

/**
 * The RENDER box: the texture the rasterizer allocates for this style.
 *
 * The typographic line box plus padding — but floored at the ink band, because
 * a texture shorter than its own glyphs clips them. At any normal line height
 * the line box wins and this is byte-identical to the old behaviour; it only
 * grows where the glyphs would previously have been cut off.
 */
export function measureTextSize(input: MeasuredTextStyle): { w: number; h: number } | null {
  const g = measureCtx();
  if (!g) return null;
  const s = wrappedStyle(input);
  const key = keyOf(s, 0);
  const hit = renderCache.get(key);
  if (hit) return hit;

  if (s.orientation === 'vertical') {
    const laid = verticalLayoutOf(s, g);
    const vt = textStyleTransform(s);
    const vout = {
      w: s.boxWidth
        ? Math.max(16, Math.ceil(s.boxWidth) + PAD_X * 2)
        : Math.max(16, Math.ceil(laid.width * vt.sx) + PAD_X * 2),
      h: s.boxWidth && s.boxHeight
        ? Math.max(16, Math.ceil(s.boxHeight) + PAD_Y * 2)
        : Math.max(16, Math.ceil(laid.height * vt.sy + Math.abs(vt.dy) * 2) + PAD_Y * 2),
    };
    if (renderCache.size >= MAX_CACHE) renderCache.clear();
    renderCache.set(key, vout);
    return vout;
  }

  // Measured on the CASED string — "wide" and "WIDE" are different widths.
  const boxes = measureTextBoxes(s.textTransform ? { ...s, content: applyTextCase(s.content, s.textTransform) } : s, 0);
  const lines = s.content.split('\n');
  const lineHeightPx = s.fontSize * (s.lineHeight || DEFAULT_LINE_HEIGHT);
  const paraGap = (s.spaceBefore ?? 0) + (s.spaceAfter ?? 0);
  const hardBreaks = paraGap !== 0 ? hardEndsOf(lines.length, s.softBreakLines).slice(0, -1).filter(Boolean).length : 0;
  const lineBlock =
    lineHeightPx * lines.length + s.paragraphSpacing * Math.max(0, lines.length - 1) + paraGap * hardBreaks;

  // The floor is TWICE the larger half-extent, not the ink band's height.
  //
  // The rasterizer centres the box on the draw origin (`fillText` at `h/2`),
  // but the ink band is NOT centred on that origin — it hangs below it for a
  // descender-heavy run. A box merely as tall as the band still clips the
  // deeper side by the offset. Measured at 320px/lineHeight 0.7: band 310px,
  // but the deeper half reaches 157px, so 314px is the smallest box that
  // contains it — a 310px box clipped the last row of the descenders.
  // Scaled, shifted glyphs (Character panel: T-, IT, A_, super/sub) need a
  // box that fits what is actually drawn, or the layer clips its own type.
  const tr = textStyleTransform(s);
  // Faux bold strokes outward by half its width; faux italic shears the ink
  // sideways by up to half a line's height. Neither changes the advance, so
  // the render box must allow for them or the texture clips its own glyphs.
  const fauxW = (s.fauxBold ? (s.fontSize * FAUX_BOLD_STROKE_RATIO) / 2 : 0)
    + (s.fauxItalic ? (s.fontSize * FAUX_ITALIC_SKEW) / 2 : 0);
  const fauxH = s.fauxBold ? (s.fontSize * FAUX_BOLD_STROKE_RATIO) / 2 : 0;
  const halfW = ((boxes ? Math.max(boxes.advance / 2, -boxes.ink.left, boxes.ink.right) : 0) + fauxW) * tr.sx;
  const halfH = ((boxes ? Math.max(-boxes.ink.top, boxes.ink.bottom) : 0) + fauxH) * tr.sy + Math.abs(tr.dy);
  const width = halfW * 2;
  // An anchored auto-height box draws its content `lineOffsetY` below centre
  // (textExtras.boxOffsetY), so the centred texture grows by twice that.
  const anchorDy = s.boxWidth && !s.boxHeight && s.boxAnchorHeight
    ? Math.abs(anchorOffsetOf(s, boxPlacementOf(s).blockHeight))
    : 0;
  const height = Math.max(lineBlock * tr.sy + Math.abs(tr.dy) * 2, halfH * 2) + anchorDy * 2;

  const out = {
    // Paragraph text's width is AUTHORED, not measured — that is what makes a
    // handle drag reflow instead of resize. Point text keeps measuring.
    w: s.boxWidth
      ? Math.max(16, Math.ceil(s.boxWidth) + PAD_X * 2)
      : Math.max(16, Math.ceil(width) + PAD_X * 2),
    // A FIXED paragraph box is authored in both directions: the texture is the
    // box (plus padding) and the painter clips the lines that do not fit.
    h: s.boxWidth && s.boxHeight
      ? Math.max(16, Math.ceil(s.boxHeight) + PAD_Y * 2)
      : Math.max(16, Math.ceil(height) + PAD_Y * 2),
  };
  if (renderCache.size >= MAX_CACHE) renderCache.clear();
  renderCache.set(key, out);
  return out;
}

// ── Node-level helpers ──────────────────────────────────────────────

/** Render box for a text NODE (null for non-text nodes / no DOM). */
export function measureTextNodeSize(node: SceneNode, overrideProps?: Record<string, unknown>): { w: number; h: number } | null {
  const style = readMeasuredTextStyle(node, overrideProps);
  return style ? measureTextSize(style) : null;
}

/** Font, ink and advance boxes for a text NODE (null for non-text / no DOM). */
export function measureTextNodeBoxes(
  node: SceneNode,
  overrideProps?: Record<string, unknown>,
  strokeWidth = 0,
): MeasuredText | null {
  const style = readMeasuredTextStyle(node, overrideProps);
  return style ? measureTextBoxes(style, strokeWidth) : null;
}

/**
 * The SELECTION box for a text node: font metrics, so it is stable while typing.
 *
 * `strokeWidth` is currently always 0 for text and that is deliberate, not an
 * oversight: `Canvas2DVectorRasterizer.drawText` has no stroke path at all
 * (only `drawPath` strokes), so text strokes render nothing. Padding the
 * outline for a stroke that does not exist would draw a box around empty space.
 * The parameter is measured and tested, so wiring it up is one argument once
 * text stroking lands.
 */
export function measureTextNodeSelectionBox(
  node: SceneNode,
  overrideProps?: Record<string, unknown>,
): TextBox | null {
  return measureTextNodeBoxes(node, overrideProps, 0)?.font ?? null;
}
