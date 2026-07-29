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

/** Padding so antialiasing has somewhere to land (px each side). */
const PAD_X = 12;
const PAD_Y = 8;
const DEFAULT_LINE_HEIGHT = 1.2;

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
}

// A face that arrives after first paint changes every metric it touches. Without
// this, the first measurement — taken against the fallback — is cached forever,
// which is a confusing failure precisely because the text looks right and only
// the boxes are wrong.
if (typeof document !== 'undefined' && typeof document.fonts !== 'undefined') {
  void document.fonts.ready.then(invalidateTextMeasurements);
  document.fonts.addEventListener?.('loadingdone', invalidateTextMeasurements);
}

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
  letterSpacing: number;
  lineHeight: number;
  paragraphSpacing: number;
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
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.content === 'string') content = p.content;
    if (typeof p.fontSize === 'number') fontSize = p.fontSize;
    if (typeof p.fontFamily === 'string') fontFamily = p.fontFamily;
    if (typeof p.fontWeight === 'string') fontWeight = p.fontWeight;
    else if (typeof p.fontWeight === 'number') fontWeight = String(p.fontWeight);
    if (typeof p.fontStyle === 'string') fontStyle = p.fontStyle;
    if (typeof p.letterSpacing === 'number') letterSpacing = p.letterSpacing;
    if (typeof p.lineHeight === 'number') lineHeight = p.lineHeight;
    if (typeof p.paragraphSpacing === 'number') paragraphSpacing = p.paragraphSpacing;
    if (typeof p.boxWidth === 'number') boxWidth = p.boxWidth;
  }
  if (overrideProps) {
    if (typeof overrideProps.content === 'string') content = overrideProps.content;
    if (typeof overrideProps.fontSize === 'number') fontSize = overrideProps.fontSize;
    if (typeof overrideProps.fontFamily === 'string') fontFamily = overrideProps.fontFamily;
    if (typeof overrideProps.fontWeight === 'string') fontWeight = overrideProps.fontWeight;
    else if (typeof overrideProps.fontWeight === 'number') fontWeight = String(overrideProps.fontWeight);
    if (typeof overrideProps.fontStyle === 'string') fontStyle = overrideProps.fontStyle;
    if (typeof overrideProps.letterSpacing === 'number') letterSpacing = overrideProps.letterSpacing;
    if (typeof overrideProps.lineHeight === 'number') lineHeight = overrideProps.lineHeight;
    if (typeof overrideProps.paragraphSpacing === 'number') paragraphSpacing = overrideProps.paragraphSpacing;
    if (typeof overrideProps.boxWidth === 'number') boxWidth = overrideProps.boxWidth;
  }
  if (content === undefined) return null;
  const style: MeasuredTextStyle = {
    content, fontSize, fontFamily, fontWeight, fontStyle, letterSpacing, lineHeight, paragraphSpacing,
    ...(typeof boxWidth === 'number' && boxWidth > 0 ? { boxWidth } : {}),
  };
  // Wrapping happens HERE, once, so measurement and rendering cannot disagree
  // about where the lines break — the wrapped text is just text with newlines
  // in it, which every downstream consumer already handles.
  return style.boxWidth ? { ...style, content: wrapText(style) } : style;
}

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
  const width = s.boxWidth;
  if (!g || !width || width <= 0) return s.content;
  g.font = cssFont(s);

  const advance = (text: string): number => {
    const chars = [...text].length;
    return g.measureText(text).width + (chars > 0 ? (chars - 1) * s.letterSpacing : 0);
  };

  const out: string[] = [];
  for (const paragraph of s.content.split('\n')) {
    // Split on spaces but KEEP them attached to the preceding word, so the
    // measured advance matches what actually gets drawn.
    const words = paragraph.split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (line !== '' && advance(candidate) > width) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

// ── Core measurement ────────────────────────────────────────────────

function cssFont(s: MeasuredTextStyle): string {
  const style = s.fontStyle === 'italic' ? 'italic ' : '';
  return `${style}${s.fontWeight} ${s.fontSize}px "${s.fontFamily}", Inter, system-ui, sans-serif`;
}

function keyOf(s: MeasuredTextStyle, strokeWidth: number): string {
  return `${s.content}|${s.fontSize}|${s.fontFamily}|${s.fontWeight}|${s.fontStyle}|${s.letterSpacing}|${s.lineHeight}|${s.paragraphSpacing}|${strokeWidth}|${s.boxWidth ?? ''}`;
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
  const s = input.boxWidth ? { ...input, content: wrapText(input) } : input;
  const key = keyOf(s, strokeWidth);
  const hit = boxCache.get(key);
  if (hit) return hit;

  g.font = cssFont(s);
  // Belt and braces: some engines reset this with the font shorthand.
  g.textBaseline = 'middle';

  const lines = s.content.split('\n');
  const n = lines.length;
  const lineHeightPx = s.fontSize * (s.lineHeight || DEFAULT_LINE_HEIGHT);
  const gap = lineHeightPx + s.paragraphSpacing;

  let inkTop = Infinity, inkBottom = -Infinity, inkHalfW = 0;
  let fontTop = Infinity, fontBottom = -Infinity, advance = 0;

  for (let i = 0; i < n; i++) {
    const line = lines[i] ?? '';
    const m = g.measureText(line);
    const chars = [...line].length;
    const spacing = chars > 0 ? (chars - 1) * s.letterSpacing : 0;

    // Where this line's origin sits relative to the block's centre — the exact
    // arithmetic the rasterizer uses (`startY = h/2 − (n−1)·gap/2`).
    const dy = (i - (n - 1) / 2) * gap;

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
  const halfLineBlock = ((n - 1) * gap + lineHeightPx) / 2;
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
  };

  if (boxCache.size >= MAX_CACHE) boxCache.clear();
  boxCache.set(key, out);
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
  const s = input.boxWidth ? { ...input, content: wrapText(input) } : input;
  const key = keyOf(s, 0);
  const hit = renderCache.get(key);
  if (hit) return hit;

  const boxes = measureTextBoxes(s, 0);
  const lines = s.content.split('\n');
  const lineHeightPx = s.fontSize * (s.lineHeight || DEFAULT_LINE_HEIGHT);
  const lineBlock = lineHeightPx * lines.length + s.paragraphSpacing * Math.max(0, lines.length - 1);

  // The floor is TWICE the larger half-extent, not the ink band's height.
  //
  // The rasterizer centres the box on the draw origin (`fillText` at `h/2`),
  // but the ink band is NOT centred on that origin — it hangs below it for a
  // descender-heavy run. A box merely as tall as the band still clips the
  // deeper side by the offset. Measured at 320px/lineHeight 0.7: band 310px,
  // but the deeper half reaches 157px, so 314px is the smallest box that
  // contains it — a 310px box clipped the last row of the descenders.
  const halfW = boxes ? Math.max(boxes.advance / 2, -boxes.ink.left, boxes.ink.right) : 0;
  const halfH = boxes ? Math.max(-boxes.ink.top, boxes.ink.bottom) : 0;
  const width = halfW * 2;
  const height = Math.max(lineBlock, halfH * 2);

  const out = {
    // Paragraph text's width is AUTHORED, not measured — that is what makes a
    // handle drag reflow instead of resize. Point text keeps measuring.
    w: s.boxWidth
      ? Math.max(16, Math.ceil(s.boxWidth) + PAD_X * 2)
      : Math.max(16, Math.ceil(width) + PAD_X * 2),
    h: Math.max(16, Math.ceil(height) + PAD_Y * 2),
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
