/**
 * `SourceTextPreview` — what `evaluateExpression` answers for a draft Source
 * Text expression (B4: the expression editor's preview reads the engine). The
 * C++ engine emits the same shape from `motion::expr::SourceTextResult`
 * (native/engine/src/core/queries.cpp): style keys in the declaration order of
 * `SourceTextStyleOverrides` (below), range keys distinct in first-seen order.
 */

import type { SourceTextPreview } from '@motion/engine-api';
import type { SourceTextExpressionResult, SourceTextStyleOverrides } from '@motion/animation';

/** `SourceTextStyleOverrides`' keys in declaration order (packages/animation/src/sourceText.ts, expr.hpp). */
export const SOURCE_TEXT_STYLE_KEYS: ReadonlyArray<keyof SourceTextStyleOverrides> = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fill', 'applyFill', 'stroke', 'strokeWidth',
  'applyStroke', 'tracking', 'leading', 'baselineShift', 'horizontalScale', 'verticalScale',
  'textTransform', 'fontVariant', 'align', 'firstLineIndent', 'leftIndent', 'rightIndent',
  'spaceBefore', 'spaceAfter', 'direction', 'leadingType',
];

function presentKeys(style: SourceTextStyleOverrides): string[] {
  return SOURCE_TEXT_STYLE_KEYS.filter((k) => style[k] !== undefined);
}

export function sourceTextPreview(r: SourceTextExpressionResult): SourceTextPreview {
  const rangeKeys: string[] = [];
  for (const range of r.ranges) {
    for (const k of presentKeys(range.style)) if (!rangeKeys.includes(k)) rangeKeys.push(k);
  }
  return { text: r.text, styleKeys: presentKeys(r.style), ranges: r.ranges.length, rangeKeys };
}
