/**
 * Merge a Source Text expression's result into a text layer's render spec.
 *
 * The engine evaluates an expression on Source Text to plain data
 * (`SourceTextExpressionResult`: text, layer-wide overrides, per-character
 * ranges — see `packages/animation/src/sourceText.ts`). This is the one place
 * that data becomes the fields the rasteriser reads, so "what the expression
 * set" and "what the frame draws" cannot drift apart.
 *
 * ## Contract
 *
 * PURE: returns a new spec, never mutates its input. Fields the expression did
 * not touch are left exactly as they were — no defaults are materialised onto
 * the spec, so a layer relying on the rasteriser's own fallbacks keeps them.
 *
 * Call it AFTER the spec's `runs` are set, with `spec.text` still the
 * pre-expression text: that is what lets a changed text re-index the stored
 * runs instead of leaving them on the wrong letters.
 *
 * ## What maps where
 *
 *   font/fontSize/fauxBold/fauxItalic → fontFamily/fontSize/fontWeight/fontStyle
 *   fillColor (+applyFill)            → fill
 *   strokeColor / strokeWidth (+applyStroke) → textStroke / textStrokeWidth
 *   tracking (1/1000 em)              → letterSpacing px at the FINAL size
 *   leading (px)                      → lineHeight (multiple of size)
 *   allCaps / smallCaps               → textTransform / fontVariant
 *   baselineShift, h/v scaling        → baselineShift, horizontalScale/verticalScale (%)
 *   justification                     → align
 *   spaceAfter + spaceBefore          → paragraphSpacing
 *   direction                         → textExtras.direction ('rtl' | absent)
 *
 * NOT RENDERED (accepted, stored in the result, no spec field exists for the
 * rasteriser to read): firstLineIndent, leftMargin, rightMargin, leadingType.
 *
 * Per-character RANGES become rich-text runs, which carry fontSize,
 * fontFamily, fontWeight, fontStyle, letterSpacing and fill. `setAllCaps(true,
 * start, n)` is honoured by upper-casing those characters. Range overrides of
 * stroke, baseline shift, scaling and small caps have no per-character field in
 * the renderer and are ignored — `unsupportedRangeKeys` names them so the
 * editor can say so instead of failing silently.
 */

import {
  resolveSourceTextStyle,
  type SourceTextExpressionResult,
  type SourceTextRangeKey,
  type SourceTextStyle,
} from '@motion/animation';
import type { RichRun, TextStyle } from '@core/text/textLayout';
import type { TextExtras } from '@core/text/textExtras';
import { splitGraphemes } from '@core/text/graphemes';
import { diffEdit, shiftRunsForEdits } from '@core/textTools/runOffsets';

/** The text fields of a render layer this merge reads and writes. */
export interface SourceTextSpec {
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  fill?: string;
  letterSpacing?: number;
  lineHeight?: number;
  align?: string;
  paragraphSpacing?: number;
  textTransform?: string;
  fontVariant?: string;
  verticalScale?: number;
  horizontalScale?: number;
  baselineShift?: number;
  textStroke?: string;
  textStrokeWidth?: number;
  runs?: ReadonlyArray<RichRun>;
  /** Paragraph extras; `setDirection` writes its `direction`. */
  textExtras?: TextExtras;
}

/** Range keys that DO reach the renderer. */
const APPLIED_RANGE_KEYS: ReadonlySet<SourceTextRangeKey> = new Set<SourceTextRangeKey>([
  'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'fill', 'tracking', 'applyFill', 'textTransform',
]);

/** Range overrides in `result` the renderer cannot draw per character. */
export function unsupportedRangeKeys(result: SourceTextExpressionResult | null | undefined): SourceTextRangeKey[] {
  const out = new Set<SourceTextRangeKey>();
  for (const r of result?.ranges ?? []) {
    for (const k of Object.keys(r.style) as SourceTextRangeKey[]) if (!APPLIED_RANGE_KEYS.has(k)) out.add(k);
  }
  return [...out];
}

/** The same test over range key NAMES (the engine's `SourceTextPreview.rangeKeys`). */
export function unsupportedRangeKeyNames(keys: ReadonlyArray<string>): string[] {
  return keys.filter((k) => !APPLIED_RANGE_KEYS.has(k as SourceTextRangeKey));
}

/** The spec's style with the rasteriser's defaults filled in — for unit conversion only. */
function specStyle(spec: SourceTextSpec): SourceTextStyle {
  return {
    fontFamily: spec.fontFamily ?? 'Inter',
    fontSize: spec.fontSize ?? 48,
    fontWeight: spec.fontWeight ?? '600',
    fontStyle: spec.fontStyle ?? 'normal',
    fill: spec.fill ?? '#ffffff',
    stroke: spec.textStroke,
    strokeWidth: spec.textStrokeWidth ?? 0,
    letterSpacing: spec.letterSpacing ?? 0,
    lineHeight: spec.lineHeight ?? 1.2,
    baselineShift: spec.baselineShift ?? 0,
    horizontalScale: spec.horizontalScale ?? 100,
    verticalScale: spec.verticalScale ?? 100,
    textTransform: spec.textTransform ?? 'none',
    fontVariant: spec.fontVariant ?? 'normal',
    align: spec.align ?? 'left',
    paragraphSpacing: spec.paragraphSpacing ?? 0,
    firstLineIndent: 0,
    leftIndent: 0,
    rightIndent: 0,
    spaceBefore: 0,
  };
}

type RunStyle = Partial<TextStyle>;
const RUN_KEYS = ['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'letterSpacing', 'fill'] as const;

function sameRunStyle(a: RunStyle | undefined, b: RunStyle | undefined): boolean {
  return RUN_KEYS.every((k) => a?.[k] === b?.[k]);
}

/**
 * Stored runs + expression ranges → disjoint, sorted runs, and the text with
 * range all-caps applied. Later ranges win where they overlap, as in AE.
 */
function mergeRanges(
  text: string,
  runs: ReadonlyArray<RichRun>,
  result: SourceTextExpressionResult,
  layerFontSize: number,
): { text: string; runs: RichRun[] } {
  const graphemes = [...splitGraphemes(text)];
  const n = graphemes.length;
  const perChar: Array<RunStyle | undefined> = new Array(n);
  for (const r of runs) {
    for (let i = Math.max(0, r.start); i < Math.min(n, r.end); i++) perChar[i] = { ...(perChar[i] ?? {}), ...r.style };
  }
  // Tracking is em-relative, so it resolves after every size on the character is known.
  const tracking: Array<number | undefined> = new Array(n);
  let touched = false;
  for (const range of result.ranges) {
    const from = Math.max(0, range.start);
    const to = Math.min(n, range.start + range.count);
    for (let i = from; i < to; i++) {
      const s = range.style;
      const next: RunStyle = { ...(perChar[i] ?? {}) };
      if (s.fontSize !== undefined) next.fontSize = s.fontSize;
      if (s.fontFamily !== undefined) next.fontFamily = s.fontFamily;
      if (s.fontWeight !== undefined) next.fontWeight = s.fontWeight;
      if (s.fontStyle !== undefined) next.fontStyle = s.fontStyle;
      if (s.fill !== undefined) next.fill = s.fill;
      if (s.applyFill === false) next.fill = 'transparent';
      if (s.tracking !== undefined) tracking[i] = s.tracking;
      if (s.textTransform === 'uppercase') {
        const up = graphemes[i]!.toUpperCase();
        // 'ß' → 'SS' would change the character count and misalign every run
        // after it; such a character keeps its case.
        if (splitGraphemes(up).length === 1) graphemes[i] = up;
      }
      perChar[i] = next;
      touched = true;
    }
  }
  if (!touched) return { text, runs: [...runs] };
  for (let i = 0; i < n; i++) {
    const tr = tracking[i];
    if (tr === undefined) continue;
    const size = perChar[i]?.fontSize ?? layerFontSize;
    perChar[i] = { ...(perChar[i] ?? {}), letterSpacing: (tr * size) / 1000 };
  }
  const out: RichRun[] = [];
  let i = 0;
  while (i < n) {
    const style = perChar[i];
    if (!style || RUN_KEYS.every((k) => style[k] === undefined)) { i++; continue; }
    let j = i + 1;
    while (j < n && sameRunStyle(perChar[j], style)) j++;
    const clean: RunStyle = {};
    for (const k of RUN_KEYS) if (style[k] !== undefined) (clean as Record<string, unknown>)[k] = style[k];
    out.push({ start: i, end: j, style: clean });
    i = j;
  }
  return { text: graphemes.join(''), runs: out };
}

export function applySourceTextExpressionResult<T extends SourceTextSpec>(
  spec: T,
  result: SourceTextExpressionResult | null | undefined,
): T {
  if (!result) return spec;
  const out: T = { ...spec };
  const o = result.style;
  const eff = resolveSourceTextStyle(specStyle(spec), o);

  if (o.fontFamily !== undefined) out.fontFamily = eff.fontFamily;
  if (o.fontSize !== undefined) out.fontSize = eff.fontSize;
  if (o.fontWeight !== undefined) out.fontWeight = eff.fontWeight;
  if (o.fontStyle !== undefined) out.fontStyle = eff.fontStyle;
  if (o.fill !== undefined || o.applyFill !== undefined) out.fill = eff.fill;
  if (o.stroke !== undefined) out.textStroke = eff.stroke;
  if (o.strokeWidth !== undefined || o.applyStroke !== undefined) out.textStrokeWidth = eff.strokeWidth;
  if (o.tracking !== undefined) out.letterSpacing = eff.letterSpacing;
  if (o.leading !== undefined) out.lineHeight = eff.lineHeight;
  if (o.baselineShift !== undefined) out.baselineShift = eff.baselineShift;
  if (o.horizontalScale !== undefined) out.horizontalScale = eff.horizontalScale;
  if (o.verticalScale !== undefined) out.verticalScale = eff.verticalScale;
  if (o.textTransform !== undefined) out.textTransform = eff.textTransform;
  if (o.fontVariant !== undefined) out.fontVariant = eff.fontVariant;
  if (o.align !== undefined) out.align = eff.align;
  if (o.spaceAfter !== undefined || o.spaceBefore !== undefined) out.paragraphSpacing = eff.paragraphSpacing;
  if (o.direction !== undefined) {
    // AE's paragraph direction reaches the painter through the layer's extras;
    // LTR is the absence of the field, so an LTR result drops it.
    const extras: TextExtras = { ...(spec.textExtras ?? {}) };
    if (o.direction === 'rtl') extras.direction = 'rtl';
    else delete extras.direction;
    if (Object.keys(extras).length > 0) out.textExtras = extras;
    else delete out.textExtras;
  }

  const before = spec.text ?? '';
  let runs: ReadonlyArray<RichRun> = spec.runs ?? [];
  if (result.text !== before && runs.length > 0) {
    const a = splitGraphemes(before);
    const b = splitGraphemes(result.text);
    runs = shiftRunsForEdits(runs, [diffEdit(a, b)], b.length);
  }
  const merged = result.ranges.length > 0
    ? mergeRanges(result.text, runs, result, eff.fontSize)
    : { text: result.text, runs: [...runs] };

  out.text = merged.text;
  if (merged.runs.length > 0) out.runs = merged.runs;
  else if (spec.runs !== undefined) delete out.runs;
  return out;
}
