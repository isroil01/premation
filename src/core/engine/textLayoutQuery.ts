/**
 * `getTextLayout` (ENGINE_API.md §7, §15.12) — the TypeScript engine's answer,
 * measured by src/core/text/measureText.ts exactly as the painter lays the
 * text out. The C++ twin is native/engine/src/scene/text_query.cpp (over the
 * scene port's TextMeasurer).
 *
 * The STORED style is measured (readMeasuredTextStyle: animated values at
 * their base), with the query's overrides winning — the question a Point ⇄
 * Paragraph conversion or a Box Auto-Size change asks before it writes.
 */

import type { GetTextLayout, TextLayout, Vec2 } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import {
  measureGlyphBoxes,
  measureParagraphBox,
  measureTextBoxes,
  measureTextSize,
  readMeasuredTextStyle,
  textStyleTransform,
  type MeasuredTextStyle,
} from '@core/text/measureText';
import { firstParagraphDirection, hasTextPath, readParagraphBox } from '@core/text/textExtras';
import { lineBlockAnchorX } from '@core/text/paragraphBox';
import { fail } from './errors';
import { requireLayer } from './doc';

/** The overrides as the `overrideProps` bag readMeasuredTextStyle / readParagraphBox take. */
function overrideProps(o: GetTextLayout['overrides']): Record<string, unknown> | undefined {
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  if (o.content !== undefined) out.content = o.content;
  if (o.boxWidth !== undefined) out.boxWidth = o.boxWidth;
  if (o.boxHeight !== undefined) out.boxHeight = o.boxHeight;
  if (o.boxAutoSize !== undefined) out.boxAutoSize = o.boxAutoSize;
  if (o.fontSize !== undefined) out.fontSize = o.fontSize;
  if (o.letterSpacing !== undefined) out.letterSpacing = o.letterSpacing;
  if (o.paragraphSpacing !== undefined) out.paragraphSpacing = o.paragraphSpacing;
  return out;
}

/** The last `align` a component stores (the Paragraph panel's). */
function alignOf(node: SceneNode): string | undefined {
  let align: string | undefined;
  for (const c of node.components) {
    const a = (c.props as Record<string, unknown>).align;
    if (typeof a === 'string') align = a;
  }
  return align;
}

/** The FIRST paragraph's direction (the line block's anchor follows it; 'auto' resolves it). */
function directionOf(node: SceneNode): 'ltr' | 'rtl' {
  let dir: unknown;
  let content: string | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (p.direction === 'rtl' || p.direction === 'ltr' || p.direction === 'auto') dir = p.direction;
    if (typeof p.content === 'string') content = p.content;
  }
  return firstParagraphDirection(dir, content);
}

/**
 * Where the line block sits in its layer (local units, after the Character
 * panel's scale): the x its lines start / centre / end at, and its vertical
 * offset from the centred position. Null without text metrics.
 */
export function lineBlockPlacement(style: MeasuredTextStyle, align: string | undefined, direction?: 'ltr' | 'rtl'): Vec2 | null {
  const size = measureTextSize(style);
  if (!size) return null;
  const tr = textStyleTransform(style);
  const box = style.boxWidth ? measureParagraphBox(style) : null;
  const k = box?.fitScale ?? 1;
  const indents = style.boxWidth
    ? { left: (style.leftIndent ?? 0) * k, right: (style.rightIndent ?? 0) * k }
    : undefined;
  return {
    x: tr.sx * lineBlockAnchorX(align, size.w, indents, direction),
    // A fixed box aligns its lines INSIDE the character-scaled space; an
    // auto-height box's top-anchor offset is applied outside it (textPaint).
    y: box?.fixedHeight ? tr.sy * box.lineOffsetY : box?.lineOffsetY ?? 0,
  };
}

/** The wrapped line numbers ending in a soft wrap (the style records them; derived when it does not). */
function softBreaksOf(style: MeasuredTextStyle): number[] {
  return [...(style.softBreakLines ?? [])];
}

export function textLayoutAnswer(q: GetTextLayout): TextLayout {
  const node = requireLayer(q.layer);
  if (!node.components.some((c) => c.type === 'Text')) fail('invalidArgument', `layer '${q.layer}' is not a text layer`, { layer: q.layer });
  const override = overrideProps(q.overrides);
  const style = readMeasuredTextStyle(node, override);
  if (!style) fail('invalidArgument', `text layer '${q.layer}' has no content`, { layer: q.layer });
  const size = measureTextSize(style);
  const boxes = measureTextBoxes(style, 0);
  const placement = lineBlockPlacement(style, alignOf(node), directionOf(node));
  if (!size || !boxes || !placement) fail('unsupported', 'no text metrics in this runtime (text is measured with a canvas)');
  const tr = textStyleTransform(style);
  const pbox = readParagraphBox(node, override);
  const para = style.boxWidth ? measureParagraphBox(style) : null;
  // B4 round 5: per-grapheme boxes (none for text on a path: its glyphs ride the curve).
  const glyphs = hasTextPath(node) ? [] : measureGlyphBoxes(style, alignOf(node), directionOf(node)) ?? [];
  return {
    glyphs: glyphs.map((g) => ({ index: g.index, line: g.line, box: { x: g.x, y: g.y, width: g.width, height: g.height }, baseline: g.baseline, advance: g.width })),
    lines: style.content.split('\n').length,
    box: { x: boxes.font.left, y: boxes.font.top, width: boxes.font.width, height: boxes.font.height },
    size: { x: size.w, y: size.h },
    wrapped: style.content,
    softBreaks: softBreaksOf(style),
    ...(para && pbox ? {
      paragraph: {
        boxWidth: para.boxWidth,
        boxHeight: para.boxHeight,
        fixedHeight: para.fixedHeight,
        overflow: para.overflow,
        fitScale: para.fitScale,
        contentHeight: para.contentHeight,
        lineCount: para.lineCount,
        visibleLines: para.visibleLines,
        lineOffsetY: para.lineOffsetY,
        autoSize: pbox.autoSize,
        verticalAlign: pbox.verticalAlign,
        storedHeight: pbox.boxHeight,
      },
    } : {}),
    lineBlock: placement,
    styleScale: { x: tr.sx, y: tr.sy },
    onPath: hasTextPath(node),
    fontSize: style.fontSize,
    letterSpacing: style.letterSpacing,
    paragraphSpacing: style.paragraphSpacing,
  };
}
