/**
 * Measured text-layer size — the box a text layer ACTUALLY occupies.
 *
 * Text nodes carry no width/height props, so every consumer used to fall back
 * to the fixed SIZE.text (320×80): the selection outline, the hit box and the
 * render-layer box all sat at 320px while the glyphs drew at their natural
 * width — long text visibly overflowed its own "blueprint".
 *
 * One measurement, shared by the workspace geometry (outline/hit test) and
 * buildSnapshot (render box), mirroring the Canvas2D draw arithmetic exactly:
 * per-line `measureText` + letterSpacing, stacked at
 * `fontSize·lineHeight (+ paragraphSpacing)`.
 *
 * Results are memoized per (content, style) — geometry runs per pointer-move.
 */

import type { SceneNode } from '@core/types';

/** Padding so descenders/antialiasing are inside the box (px each side). */
/** Padding so descenders/antialiasing are inside the box (px each side). */
const PAD_X = 12;
const PAD_Y = 8;
const DEFAULT_LINE_HEIGHT = 1.2;

let ctx: CanvasRenderingContext2D | null | undefined;
function measureCtx(): CanvasRenderingContext2D | null {
  if (ctx === undefined) {
    ctx = typeof document !== 'undefined'
      ? document.createElement('canvas').getContext('2d')
      : null;
  }
  return ctx;
}

const cache = new Map<string, { w: number; h: number }>();
const MAX_CACHE = 500;

export interface MeasuredTextStyle {
  content: string;
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
  }
  if (content === undefined) return null;
  return { content, fontSize, fontFamily, fontWeight, fontStyle, letterSpacing, lineHeight, paragraphSpacing };
}

/**
 * The measured box for a text style, or null when measurement is impossible
 * (no DOM — jsdom). Mirrors Canvas2DBackend's multi-line draw: widest line +
 * letter spacing horizontally; `lines · fontSize·lineHeight` plus paragraph
 * spacing vertically.
 */
export function measureTextSize(s: MeasuredTextStyle): { w: number; h: number } | null {
  const g = measureCtx();
  if (!g) return null;
  const key = `${s.content}|${s.fontSize}|${s.fontFamily}|${s.fontWeight}|${s.fontStyle}|${s.letterSpacing}|${s.lineHeight}|${s.paragraphSpacing}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const style = s.fontStyle === 'italic' ? 'italic ' : '';
  g.font = `${style}${s.fontWeight} ${s.fontSize}px "${s.fontFamily}", Inter, system-ui, sans-serif`;
  const lines = s.content.split('\n');
  let widest = 0;
  for (const line of lines) {
    const chars = [...line].length;
    const w = g.measureText(line).width + (chars > 0 ? (chars - 1) * s.letterSpacing : 0);
    widest = Math.max(widest, w);
  }
  const lineHeightPx = s.fontSize * (s.lineHeight || DEFAULT_LINE_HEIGHT);
  const height = lineHeightPx * lines.length + s.paragraphSpacing * Math.max(0, lines.length - 1);

  const out = {
    w: Math.max(16, Math.ceil(widest) + PAD_X * 2),
    h: Math.max(16, Math.ceil(height) + PAD_Y * 2),
  };
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, out);
  return out;
}

/** Measured box for a text NODE (null for non-text nodes / no DOM). Accepts optional evaluated props map. */
export function measureTextNodeSize(node: SceneNode, overrideProps?: Record<string, unknown>): { w: number; h: number } | null {
  const style = readMeasuredTextStyle(node, overrideProps);
  return style ? measureTextSize(style) : null;
}

const inkCache = new Map<string, { w: number; h: number }>();

/**
 * The GLYPH box — what the letters actually cover — as opposed to the RENDER
 * box `measureTextSize` returns.
 *
 * The render box is deliberately loose: `PAD_X`/`PAD_Y` keep descenders and
 * antialiasing off the raster edge, and its height is `fontSize × lineHeight`
 * (the typographic line box), not the ink. That is right for rasterizing and
 * wrong for the SELECTION OUTLINE, which is why a "Hello" at 48px/600 drew a
 * 139×74 blueprint around 110×36 of ink — a fat margin on every side that After
 * Effects does not have.
 *
 * Both boxes are CONCENTRIC, so a consumer can swap one for the other without
 * an offset: the widest line spans the render box's full inner width (left
 * align draws at `PAD_X`, right align ends at `width − PAD_X`, centre is
 * centred), and the stack of line centres is symmetric about the box centre.
 *
 * Uses `actualBoundingBox*` metrics; falls back to the advance width and the
 * line box when a runtime does not report them (jsdom).
 */
export function measureTextInkSize(s: MeasuredTextStyle): { w: number; h: number } | null {
  const g = measureCtx();
  if (!g) return null;
  const key = `${s.content}|${s.fontSize}|${s.fontFamily}|${s.fontWeight}|${s.fontStyle}|${s.letterSpacing}|${s.lineHeight}|${s.paragraphSpacing}`;
  const hit = inkCache.get(key);
  if (hit) return hit;

  const style = s.fontStyle === 'italic' ? 'italic ' : '';
  g.font = `${style}${s.fontWeight} ${s.fontSize}px "${s.fontFamily}", Inter, system-ui, sans-serif`;
  const lines = s.content.split('\n');

  let widest = 0;
  let ascent = 0;
  let descent = 0;
  for (const line of lines) {
    const m = g.measureText(line);
    const chars = [...line].length;
    const spacing = chars > 0 ? (chars - 1) * s.letterSpacing : 0;
    const ink =
      typeof m.actualBoundingBoxLeft === 'number' && typeof m.actualBoundingBoxRight === 'number'
        ? m.actualBoundingBoxLeft + m.actualBoundingBoxRight
        : m.width;
    widest = Math.max(widest, ink + spacing);
    // textBaseline is 'middle' at draw time, so the metrics are already
    // measured from that same origin — no baseline conversion needed.
    if (typeof m.actualBoundingBoxAscent === 'number') ascent = Math.max(ascent, m.actualBoundingBoxAscent);
    if (typeof m.actualBoundingBoxDescent === 'number') descent = Math.max(descent, m.actualBoundingBoxDescent);
  }

  const lineHeightPx = s.fontSize * (s.lineHeight || DEFAULT_LINE_HEIGHT);
  const gap = lineHeightPx + s.paragraphSpacing;
  const glyphBand = ascent + descent > 0 ? ascent + descent : lineHeightPx;
  const height = (lines.length - 1) * gap + glyphBand;

  // Never report a box larger than the render box — the outline must stay
  // inside what the rasterizer actually produced.
  const render = measureTextSize(s);
  const out = {
    w: Math.max(8, Math.min(Math.ceil(widest), render?.w ?? Infinity)),
    h: Math.max(8, Math.min(Math.ceil(height), render?.h ?? Infinity)),
  };
  if (inkCache.size >= MAX_CACHE) inkCache.clear();
  inkCache.set(key, out);
  return out;
}

/** Glyph box for a text NODE (null for non-text nodes / no DOM). */
export function measureTextNodeInkSize(node: SceneNode, overrideProps?: Record<string, unknown>): { w: number; h: number } | null {
  const style = readMeasuredTextStyle(node, overrideProps);
  return style ? measureTextInkSize(style) : null;
}
