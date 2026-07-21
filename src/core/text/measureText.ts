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
const PAD_X = 8;
const PAD_Y = 6;
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

/** Pull the style fields that affect measurement off a text node. */
export function readMeasuredTextStyle(node: SceneNode): MeasuredTextStyle | null {
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
    w: Math.max(8, Math.ceil(widest) + PAD_X * 2),
    h: Math.max(8, Math.ceil(height) + PAD_Y * 2),
  };
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, out);
  return out;
}

/** Measured box for a text NODE (null for non-text nodes / no DOM). */
export function measureTextNodeSize(node: SceneNode): { w: number; h: number } | null {
  const style = readMeasuredTextStyle(node);
  return style ? measureTextSize(style) : null;
}
