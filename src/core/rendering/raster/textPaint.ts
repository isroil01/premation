/**
 * The text layout + paint that both text rasters share.
 *
 * ONE painter, two consumers:
 *   • `Canvas2DVectorRasterizer.drawText` — the layer's front raster (its
 *     texture);
 *   • `shapesFromText.traceTextSpec` — the 4× silhouette that becomes the
 *     3D extrusion body and Create Shapes From Text.
 *
 * They used to be two hand-kept copies of the same layout. The trace copy
 * centred on the INK box while the raster centred on the box origin, laid
 * letter-spaced glyphs by hand (unkerned) while the raster used the canvas's
 * own `letterSpacing`, and knew nothing of case, small caps, scale, baseline
 * shift, the layer stroke, per-run styles or text-on-path. Every one of those
 * put the extruded body somewhere the front face was not — a title with a
 * descender sat ~22 px high on its own solid, and a letter-spaced one drifted
 * off it letter by letter.
 *
 * Draws in the UNPADDED box: (0,0)–(width,height), the draw origin at the
 * box centre. The caller sets any supersample / padding transform first.
 * `spec.color` is the fill; a caller that wants a silhouette passes white for
 * both `color` and `textStroke`.
 *
 * ── Two draw paths, one geometry ─────────────────────────────────────
 * Static single-style text draws a line (or, justified, a word) per
 * `fillText`; anything with per-character work draws from `layoutText`. Both
 * take line starts, justification stretch, indents and baseline spacing from
 * textExtras.ts, and `textPaint.test.ts` holds them to identical x positions.
 *
 * ── Shaping ──────────────────────────────────────────────────────────
 * Drawing one cluster at a time breaks contextual shaping — Arabic letters
 * lose their joins, Indic conjuncts fall apart. So on the per-glyph path a line
 * with NO per-character variation (no animator offsets, one style, no
 * justification, no path) is still drawn as one string from its first pen,
 * and a same-style span of a complex script is kept whole wherever its glyphs
 * are untransformed. A glyph an animator actually moves is necessarily drawn
 * on its own.
 */

import { layoutText, planWholeStringLines, glyphStyleScale, softWrapChangesBidi, type PlacedGlyph, type TextLayout, type TextStyle } from '@core/text/textLayout';
import { clusterLevels, hasStrongRtl } from '@core/text/bidi';
import { layoutVerticalText, type VerticalGlyph } from '@core/text/verticalLayout';
import { applyTextCase, textStyleTransform } from '@core/text/measureText';
import { applyTextPath } from '@core/text/textPath';
import { arcTable } from '@core/scene/trimPath';
import { mixHex, type GlyphTransform } from '@core/text/textAnimators';
import { toCanvasColor, adjustHsb } from '@core/text/cssColor';
import { hasComplexScript } from '@core/text/graphemes';
import { featureSettingsString, variantFamily, verticalAlternatesFor, type VerticalAlternates } from '@core/text/fontFaceVariants';
import { opticalKernPx, opticalKernVerticalPx, REF_EM_PX, type OpticalFace } from '@core/text/opticalKerning';
import { groupPivots, interCharacterCompositeOp, layerStrokeOrder } from '@core/text/textMoreOptions';
import { createTextGradientFill } from './textGradient';
import {
  AUTO_LEADING,
  FAUX_BOLD_STROKE_RATIO,
  FAUX_ITALIC_SKEW,
  TEXT_PAD_X,
  placeLinesInBox,
  resolveAlign,
  strokeOrderOf,
  type TextExtras,
} from '@core/text/textExtras';
import { textCssFont, textFontVariationSettings } from '../AppTextureProvider';
import type { TextSpec } from '../AppTextureProvider';

/** The fields the painter reads. `TextSpec` satisfies it; so does a RenderLayer-derived subset. */
export type TextPaintSpec = Pick<
  TextSpec,
  | 'text' | 'fontSize' | 'color' | 'width' | 'height'
  | 'fontFamily' | 'fontWeight' | 'fontWidth' | 'fontSlant' | 'fontStyle'
  | 'align' | 'letterSpacing' | 'lineHeight' | 'paragraphSpacing'
  | 'strokeOverFill' | 'textTransform' | 'fontVariant' | 'verticalAlign'
  | 'verticalScale' | 'horizontalScale' | 'baselineShift'
  | 'textStroke' | 'textStrokeWidth' | 'runs' | 'glyphs' | 'textPath'
> & {
  textExtras?: TextExtras;
  fontAxes?: TextSpec['fontAxes'];
  fillPaint?: TextSpec['fillPaint'];
  strokePaint?: TextSpec['strokePaint'];
};

type Part = 'stroke' | 'fill';

/** A transform that moves, tints or restyles nothing. */
function isIdentityTransform(tr: GlyphTransform): boolean {
  return (
    tr.dx === 0 && tr.dy === 0 && !tr.dz && !tr.rotationX && !tr.rotationY &&
    tr.scale === 1 && tr.scaleY === 1 && tr.rotation === 0 &&
    tr.opacity === 1 && tr.fillOpacity === 1 && tr.tracking === 0 && tr.lineSpacing === 0 &&
    tr.blur === 0 && !tr.blurY && tr.skew === 0 && tr.strokeWidth === 0 &&
    !(tr.color && (tr.colorMix ?? 0) > 0) &&
    !(tr.strokeColor && (tr.strokeColorMix ?? 0) > 0) &&
    tr.displayChar === tr.char &&
    // Optional animator properties (absent on older animators).
    !tr.anchorX && !tr.anchorY && !tr.skewAxis && !tr.trackingBefore &&
    !tr.fillHue && !tr.fillSaturation && !tr.fillBrightness &&
    (tr.strokeOpacity === undefined || tr.strokeOpacity === 1) &&
    !tr.strokeHue && !tr.strokeSaturation && !tr.strokeBrightness &&
    !(tr.axes && Object.keys(tr.axes).length > 0)
  );
}

/** Everything about a style that changes the pixels of a same-string draw. */
function paintKey(s: TextStyle): string {
  return `${textCssFontOf(s)}|${s.letterSpacing ?? 0}|${s.fill ?? ''}|${s.fauxBold ? 1 : 0}|${s.fauxItalic ? 1 : 0}|${s.kerning ?? 0}`
    + `|${s.strokeColor ?? ''}|${s.strokeWidth ?? ''}|${s.smallCaps ? 1 : 0}|${s.allCaps ? 1 : 0}`
    + `|${s.axisOffsets ? JSON.stringify(s.axisOffsets) : ''}`;
}

/** A per-range style a whole-run draw cannot reproduce (scale, baseline, tsume). */
function hasGlyphGeometryStyle(s: TextStyle): boolean {
  const gs = glyphStyleScale(s);
  return gs.sx !== 1 || gs.sy !== 1 || gs.dy !== 0 || !!s.tsume;
}
const textCssFontOf = (s: TextStyle): string => textCssFont(s);

/** One `fillText`/`strokeText` unit: a single glyph, or a run drawn whole. */
interface DrawItem {
  text: string;
  /** Box-centre-relative x: the glyph centre (single) or first pen (run). */
  x: number;
  y: number;
  align: CanvasTextAlign;
  style: TextStyle;
  tr?: GlyphTransform;
  angle?: number;
  line: number;
  /** Anchor Point Grouping origin (box-centre relative), when not the glyph's own. */
  pivot?: { x: number; y: number };
  /** Several glyphs drawn as one string (carries the style's letter spacing). */
  run?: boolean;
  /** Grapheme index of a single glyph. */
  index?: number;
  /** Canvas direction for this draw — right-to-left paragraphs only. A run at
   *  an odd bidi level is drawn as its LOGICAL string with 'rtl', so the canvas
   *  shapes (Arabic joining) and mirrors it; absent = the context's own. */
  direction?: CanvasDirection;
  /** Vertical type: draw with the font's vertical alternates ('vert' alias face). */
  vert?: boolean;
}

/*
  ── Anisotropic animator blur ─────────────────────────────────────────
  `ctx.filter = blur()` is isotropic, so a 2-D animator Blur with X ≠ Y is
  staged through two scratch canvases: the glyph is painted UNBLURRED into
  scratch A under the layer context's own transform and text state, squashed
  into scratch B so one isotropic blur equals the requested radii, then
  stretched back onto the layer. Scale factors: painting squashed by s and
  stretching back by 1/s turns a blur of B px into B/s px on that axis, so
  s(axis) = B / radius(axis) with B chosen ≥ 1 px (sub-pixel blur in squashed
  space would resample as bands, not a gradient).

  The scratches are module-level and grow-only — a texture raster paints many
  glyphs per frame and must not allocate canvases per glyph.
*/
const ANISO_SCRATCH: Array<HTMLCanvasElement | null> = [null, null];

function anisoScratch(i: 0 | 1, w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  let canvas = ANISO_SCRATCH[i] ?? null;
  if (!canvas) {
    if (typeof document === 'undefined') return null;
    canvas = document.createElement('canvas');
    ANISO_SCRATCH[i] = canvas;
  }
  // Size BEFORE getContext, and getContext per use rather than cached: a
  // backing store that follows the element's size (the test harness's Skia
  // bridge, notably) syncs at getContext/drawImage time, and a context grabbed
  // before a resize would paint into — or be wiped with — the stale store.
  if (canvas.width < w) canvas.width = w;
  if (canvas.height < h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

/** Text-drawing state a scratch must share with the layer context so the same
 *  paintPart call produces the same glyph. Optional properties (letterSpacing,
 *  variation settings, kerning, direction) copy only where implemented. */
function copyTextDrawState(src: CanvasRenderingContext2D, dst: CanvasRenderingContext2D): void {
  dst.font = src.font;
  dst.textAlign = src.textAlign;
  dst.textBaseline = src.textBaseline;
  const s = src as unknown as Record<string, unknown>;
  const d = dst as unknown as Record<string, unknown>;
  for (const key of ['letterSpacing', 'direction', 'fontVariationSettings', 'fontVariantCaps', 'fontKerning'] as const) {
    if (key in s && key in d) {
      try { d[key] = s[key]; } catch { /* jsdom setters can throw; the draw still lands */ }
    }
  }
}

export function paintTextInBox(ctx: CanvasRenderingContext2D, spec: TextPaintSpec): void {
  const ex: TextExtras = spec.textExtras ?? {};
  // An auto-height paragraph box keeps its TOP edge: the texture is grown by
  // twice the offset (measureTextSize) and everything is drawn that far down.
  // Zero for every other layer, which then issues no transform at all.
  const offY = ex.boxOffsetY && Number.isFinite(ex.boxOffsetY) ? ex.boxOffsetY : 0;
  if (offY) ctx.translate(0, offY + Math.abs(offY));
  const gradientH = offY ? spec.height - 2 * Math.abs(offY) : spec.height;
  // A gradient fill (or stroke) spans the LAYER box, so it is anchored to the
  // transform the painter was handed — before character-panel scale or Fit to Box.
  const gradient = createTextGradientFill(ctx, spec.fillPaint, spec.width, gradientH);
  const strokeGradient = createTextGradientFill(ctx, spec.strokePaint, spec.width, gradientH);
  if (offY) ctx.translate(0, -Math.abs(offY));
  // Vertical type ignores any right-to-left direction (columns have no bidi
  // reordering here). On a text path its columns ride the path (textPath.ts).
  const vertical = ex.orientation === 'vertical';
  // 'auto' resolves per paragraph (textLayout.paragraphBidiLines).
  const bidiDir = !vertical && (ex.direction === 'rtl' || ex.direction === 'auto') ? ex.direction : undefined;
  const rtl = bidiDir === 'rtl';
  // Character panel: horizontal/vertical scale, baseline shift and
  // super/subscript are ONE affine transform about the box centre, applied
  // before any glyph is laid out so both draw paths below inherit it.
  {
    const tr = textStyleTransform(spec);
    if (tr.sx !== 1 || tr.sy !== 1 || tr.dy !== 0) {
      ctx.translate(spec.width / 2, spec.height / 2 + tr.dy);
      ctx.scale(tr.sx, tr.sy);
      ctx.translate(-spec.width / 2, -spec.height / 2);
    }
  }
  // Paragraph box "Fit Text to Box": lay the text out in a box 1/fitScale the
  // size (wrapping at the same width `measureText` wrapped at) and draw it
  // scaled about the centre. The text's left/right edges land exactly on the
  // real box's, and the authored font size is never rewritten.
  if (ex.fitScale && ex.fitScale > 0 && ex.fitScale < 1) {
    const k = ex.fitScale;
    const vw = (spec.width - 2 * TEXT_PAD_X) / k + 2 * TEXT_PAD_X;
    const vh = spec.height / k;
    ctx.translate(spec.width / 2, spec.height / 2);
    ctx.scale(k, k);
    ctx.translate(-vw / 2, -vh / 2);
    spec = { ...spec, width: vw, height: vh };
  }
  const boxScale = ex.fitScale && ex.fitScale > 0 && ex.fitScale < 1 ? ex.fitScale : 1;
  // Axes beyond weight and OpenType features reach the canvas only through an
  // alias FontFace (fontFaceVariants.ts). With neither, `fontFor` is exactly
  // `textCssFont` — the string every existing layer has always drawn with.
  const features = featureSettingsString(ex);
  const layerAxes = spec.fontWidth !== undefined || spec.fontSlant !== undefined || (!!spec.fontAxes && Object.keys(spec.fontAxes).length > 0);
  const variationOf = (s: TextStyle): string | undefined => (layerAxes || s.axisOffsets
    ? textFontVariationSettings({ fontWeight: s.fontWeight, fontWidth: spec.fontWidth, fontSlant: spec.fontSlant, fontAxes: spec.fontAxes }, s.axisOffsets)
    : undefined);
  const aliasFor = (s: TextStyle): string | null => variantFamily(s, variationOf(s), features);
  const fontFor = (s: TextStyle): string => {
    const alias = aliasFor(s);
    const css = textCssFont(alias ? { ...s, fontFamily: alias } : s);
    return s.smallCaps ? css.replace(/^(italic )?/, (m) => `${m}small-caps `) : css;
  };
  // Vertical type: upright glyphs take the font's OWN vertical alternates
  // through a 'vert' alias face, when one loads and actually turns the
  // punctuation (fontFaceVariants.verticalAlternatesFamily). Null = the
  // Unicode fallback verticalLayout.ts already chose.
  // With the font's bytes the face's GSUB also says WHICH characters turn;
  // the rest take the Unicode fallback one by one.
  const vertAlternatesFor = (s: TextStyle): VerticalAlternates | null => {
    if (!vertical) return null;
    const variation = layerAxes || s.axisOffsets
      ? textFontVariationSettings({ fontWeight: s.fontWeight, fontWidth: spec.fontWidth, fontSlant: spec.fontSlant, fontAxes: spec.fontAxes }, s.axisOffsets)
      : undefined;
    return verticalAlternatesFor(s, variation, features);
  };
  const vertAliasFor = (s: TextStyle): string | null => vertAlternatesFor(s)?.family ?? null;
  const vertFontFor = (s: TextStyle): string => {
    const alias = vertAliasFor(s);
    if (!alias) return fontFor(s);
    const css = textCssFont({ ...s, fontFamily: alias });
    return s.smallCaps ? css.replace(/^(italic )?/, (m) => `${m}small-caps `) : css;
  };
  // Standard ligatures off with no alias face to turn them off: drawing glyph
  // by glyph is the one way that works for every font.
  const ligaturesOff = ex.ligatures === false;
  const ligatureFallback = ligaturesOff && !aliasFor(spec);
  const blendOp = interCharacterCompositeOp(ex.interCharacterBlending);
  ctx.font = fontFor(spec);
  const optical = ex.kerningMode === 'optical';
  {
    const vars = textFontVariationSettings(spec);
    if (vars) (ctx as CanvasRenderingContext2D & { fontVariationSettings?: string }).fontVariationSettings = vars;
    // Small caps is a font FEATURE, not a font shorthand token Canvas accepts.
    const caps = ctx as CanvasRenderingContext2D & { fontVariantCaps?: string };
    if ('fontVariantCaps' in caps) caps.fontVariantCaps = spec.fontVariant === 'small-caps' ? 'small-caps' : 'normal';
    // Optical kerning replaces the font's metric kerning (see textExtras.ts).
    const kern = ctx as CanvasRenderingContext2D & { fontKerning?: string };
    if (optical && 'fontKerning' in kern) kern.fontKerning = 'none';
  }
  ctx.textBaseline = 'middle';
  // Right-to-left: a whole line drawn at once is reordered and shaped by the
  // canvas's own bidi under an RTL base direction (Chromium supports
  // `ctx.direction`); placement stays ours, via absolute 'left'/'right' align.
  if (rtl) (ctx as CanvasRenderingContext2D & { direction: CanvasDirection }).direction = 'rtl';
  ctx.letterSpacing = spec.letterSpacing ? `${spec.letterSpacing}px` : '0px';
  // Never hand the canvas a colour it cannot parse — it would silently keep
  // the previous fillStyle (see cssColor.ts).
  const layerFill = toCanvasColor(spec.color, '#ffffff');
  ctx.fillStyle = layerFill;

  const text = applyTextCase(spec.text || 'Text', spec.textTransform);
  // The layer's own stroke (Character panel). Zero width = no stroke, the
  // default; the "none" swatch switches it off without losing the width.
  const layerStrokeW =
    !ex.noStroke && typeof spec.textStrokeWidth === 'number' && spec.textStrokeWidth > 0 ? spec.textStrokeWidth : 0;
  const layerStrokeColor = toCanvasColor(
    typeof spec.textStroke === 'string' && spec.textStroke ? spec.textStroke : undefined,
    layerFill,
  );
  const lineJoin: CanvasLineJoin = ex.strokeLineJoin ?? 'round';
  const noFill = !!ex.noFill;
  // AE's Fill & Stroke order. Fill Over Stroke (the default) paints the stroke
  // first: a stroke centres on the outline, so painting it OVER the fill eats
  // half its width out of the glyph and an animated stroke appears to thin the
  // letterforms. The "All …" orders paint every stroke in the layer before (or
  // after) every fill, so neighbouring glyphs' strokes never (or always) cover
  // each other's fills.
  const order = layerStrokeOrder(strokeOrderOf(ex.strokeOrder, spec.strokeOverFill), ex.fillStrokeMode);
  const strokeFirst = order === 'fill-over-stroke' || order === 'all-fills-over-all-strokes';
  const allPasses = order === 'all-fills-over-all-strokes' || order === 'all-strokes-over-all-fills';
  const parts: Part[] = strokeFirst ? ['stroke', 'fill'] : ['fill', 'stroke'];

  const paragraph = {
    align: spec.align,
    lineHeight: spec.lineHeight,
    paragraphSpacing: spec.paragraphSpacing,
    leftIndent: ex.leftIndent,
    rightIndent: ex.rightIndent,
    firstLineIndent: ex.firstLineIndent,
    spaceBefore: ex.spaceBefore,
    spaceAfter: ex.spaceAfter,
  };

  const hasGlyphWork =
    (spec.runs && spec.runs.length > 0) ||
    (spec.glyphs && spec.glyphs.length > 0) ||
    !!spec.textPath ||
    // Optical kerning adjusts individual pairs — one fillText cannot.
    optical ||
    // Inter-character blending composites glyph over glyph, and ligatures off
    // (without an alias face) needs each glyph drawn alone.
    !!blendOp ||
    ligatureFallback ||
    // Vertical type is placed glyph by glyph (verticalLayout.ts).
    vertical ||
    // A justified RTL line is drawn by word in visual order, which only the
    // bidi-aware per-glyph layout knows. And a wrapped paragraph whose levels
    // depend on a neighbouring LINE (bidi resolves per paragraph; a canvas
    // drawing one line resolves that line alone) must be placed by the layout.
    (!!bidiDir && ex.softBreakLines !== undefined && (
      (resolveAlign(spec.align).justify && (rtl || hasStrongRtl(text))) ||
      softWrapChangesBidi(text, ex.softBreakLines, bidiDir)
    ));

  const cx = spec.width / 2;
  const cy = spec.height / 2;

  /** Stroke or fill one item at (x, y) in the current transform. `target`
   *  defaults to the layer's own context; the anisotropic-blur composite
   *  points it at a scratch instead (same code, different destination). */
  const paintPart = (
    part: Part, item: DrawItem, fill: string | CanvasGradient | CanvasPattern, strokeColor: string | CanvasGradient | CanvasPattern,
    strokeW: number, fillAlpha: number, x: number, y: number,
    strokeAlpha = 1,
    target: CanvasRenderingContext2D = ctx,
  ): void => {
    if (part === 'stroke') {
      if (strokeW <= 0 || strokeAlpha <= 0) return;
      const prevA = target.globalAlpha;
      if (strokeAlpha < 1) target.globalAlpha = prevA * strokeAlpha;
      target.lineWidth = strokeW;
      target.lineJoin = lineJoin;
      target.strokeStyle = strokeColor;
      target.strokeText(item.text, x, y);
      if (strokeAlpha < 1) target.globalAlpha = prevA;
      return;
    }
    if (noFill || fillAlpha <= 0) return;
    const prev = target.globalAlpha;
    if (fillAlpha < 1) target.globalAlpha = prev * fillAlpha;
    if (item.style.fauxBold) {
      // Faux bold thickens the FILL, independent of weight: a fill-coloured
      // stroke under it. The advance is untouched, as in AE.
      target.lineWidth = item.style.fontSize * FAUX_BOLD_STROKE_RATIO;
      target.lineJoin = 'round';
      target.strokeStyle = fill;
      target.strokeText(item.text, x, y);
    }
    target.fillStyle = fill;
    target.fillText(item.text, x, y);
    if (fillAlpha < 1) target.globalAlpha = prev;
  };

  /** Draw `which` parts of one item under its own canvas direction, if any. */
  const drawItem = (item: DrawItem, which: ReadonlyArray<Part>): void => {
    if (!item.direction) {
      drawItemInner(item, which);
      return;
    }
    const dctx = ctx as CanvasRenderingContext2D & { direction: CanvasDirection };
    const prev = dctx.direction;
    dctx.direction = item.direction;
    drawItemInner(item, which);
    dctx.direction = prev;
  };

  /** Draw `which` parts of one item, with its full per-glyph transform. */
  const drawItemInner = (item: DrawItem, which: ReadonlyArray<Part>): void => {
    const tr = item.tr;
    const style = item.style;
    const baseFill = toCanvasColor(style.fill, layerFill);
    ctx.textAlign = item.align;

    let fill = tr?.color && (tr.colorMix ?? 0) > 0 ? mixHex(baseFill, tr.color, tr.colorMix ?? 1) : baseFill;
    if (tr && (tr.fillHue || tr.fillSaturation || tr.fillBrightness)) {
      fill = adjustHsb(fill, tr.fillHue ?? 0, tr.fillSaturation ?? 0, tr.fillBrightness ?? 0);
    }
    // The block gradient paints every character nothing else recoloured.
    const useGradient = !!gradient && fill === layerFill;
    // A selection's own stroke width / colour beats the layer's; an animator's
    // stroke width beats both, and its stroke COLOUR applies to whichever
    // stroke is drawn — including the layer's.
    const rangeStrokeW = style.strokeWidth !== undefined && !ex.noStroke ? Math.max(0, style.strokeWidth) : layerStrokeW;
    const strokeW = tr && tr.strokeWidth > 0 ? tr.strokeWidth : rangeStrokeW;
    const strokeBase = style.strokeColor !== undefined
      ? toCanvasColor(style.strokeColor, layerStrokeColor)
      : layerStrokeW > 0 ? layerStrokeColor : fill;
    let strokeColor = tr?.strokeColor ? mixHex(strokeBase, tr.strokeColor, tr.strokeColorMix ?? 1) : strokeBase;
    if (tr && (tr.strokeHue || tr.strokeSaturation || tr.strokeBrightness)) {
      strokeColor = adjustHsb(strokeColor, tr.strokeHue ?? 0, tr.strokeSaturation ?? 0, tr.strokeBrightness ?? 0);
    }
    // The layer's stroke GRADIENT paints wherever the layer's own stroke colour
    // would — not over a selection's own stroke colour or an animator's.
    const useStrokeGradient = !!strokeGradient && layerStrokeW > 0 && style.strokeColor === undefined &&
      !tr?.strokeColor && !(tr && (tr.strokeHue || tr.strokeSaturation || tr.strokeBrightness));
    const strokeAlpha = tr?.strokeOpacity !== undefined ? Math.max(0, tr.strokeOpacity) : 1;
    const fillAlpha = tr ? Math.max(0, tr.fillOpacity) : 1;
    // Per-range horizontal / vertical scale and super/subscript (the layout
    // already placed and spaced the glyph for them).
    const gs = glyphStyleScale(style);
    const rangeScaled = gs.sx !== 1 || gs.sy !== 1;
    // A run drawn whole carries its letter spacing, or every glyph after the
    // first lands short of the pen the layout measured WITH that spacing.
    const runSpacing = item.run && style.letterSpacing ? `${style.letterSpacing}px` : null;
    const blendPrev = blendOp ? ctx.globalCompositeOperation : null;
    if (blendOp) ctx.globalCompositeOperation = blendOp;

    // The cheap path stays cheap: an untransformed, unslanted item draws at
    // absolute coordinates with no save/restore — for plain text, exactly the
    // `font / fillStyle / fillText(text, x, y)` sequence it always issued.
    if (!tr && item.angle === undefined && !style.fauxItalic && !rangeScaled && !item.pivot) {
      ctx.font = item.vert ? vertFontFor(style) : fontFor(style);
      if (runSpacing) ctx.letterSpacing = runSpacing;
      const fillStyle = useGradient ? gradient!.styleFor(ctx) : fill;
      const strokeStyle = useStrokeGradient ? strokeGradient!.styleFor(ctx) : strokeColor;
      for (const part of which) paintPart(part, item, fillStyle, strokeStyle, strokeW, 1, cx + item.x, cy + item.y);
      if (runSpacing) ctx.letterSpacing = '0px';
      if (blendPrev !== null) ctx.globalCompositeOperation = blendPrev;
      return;
    }

    ctx.save();
    // Order matters and mirrors AE: translate to the glyph's own origin (or,
    // under Anchor Point Grouping, its group's), then rotate / skew / scale
    // ABOUT it, so a rotating character spins in place rather than swinging
    // around the layer's anchor — and a grouped word turns as one.
    const lift = (tr?.lineSpacing ?? 0) * item.line;
    const origin = item.pivot ?? { x: item.x, y: item.y };
    ctx.translate(cx + origin.x + (tr?.dx ?? 0), cy + origin.y + (tr?.dy ?? 0) + lift);
    if (item.angle) ctx.rotate(item.angle);
    if (tr) {
      if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
      if (tr.skew) {
        // Skew Axis turns the direction of the shear.
        const axis = tr.skewAxis ? (tr.skewAxis * Math.PI) / 180 : 0;
        if (axis) ctx.rotate(axis);
        ctx.transform(1, 0, Math.tan((-tr.skew * Math.PI) / 180), 1, 0, 0);
        if (axis) ctx.rotate(-axis);
      }
      if (tr.scale !== 1 || tr.scaleY !== 1) ctx.scale(tr.scale, tr.scaleY);
      // Opacity multiplies the layer's own — an animator fading a character
      // to 0 must not brighten a layer that is already half transparent.
      if (tr.opacity !== 1) ctx.globalAlpha = ctx.globalAlpha * Math.max(0, tr.opacity);
      // Uniform blur (blurY absent or equal) keeps the exact filter call it
      // has always issued; unlinked X/Y goes through the anisotropic
      // composite at the paint site below.
      if (tr.blur > 0 && (tr.blurY ?? tr.blur) === tr.blur) ctx.filter = `blur(${tr.blur}px)`;
    }
    // Grouped: the character keeps its offset from the group origin, inside
    // the group's transformed frame.
    if (item.pivot) ctx.translate(item.x - item.pivot.x, item.y - item.pivot.y);
    // Anchor Point: the glyph sits at −anchor about its transform origin.
    if (tr && (tr.anchorX || tr.anchorY)) ctx.translate(-(tr.anchorX ?? 0), -(tr.anchorY ?? 0));
    if (rangeScaled) ctx.scale(gs.sx, gs.sy);
    // Faux italic shears the glyph in its own space (applied last, so first
    // to the glyph), independent of the font's italic.
    if (style.fauxItalic) ctx.transform(1, 0, -FAUX_ITALIC_SKEW, 1, 0, 0);
    ctx.font = item.vert ? vertFontFor(style) : fontFor(style);
    if (runSpacing) ctx.letterSpacing = runSpacing;
    const fillStyle = useGradient ? gradient!.styleFor(ctx) : fill;
    const strokeStyle = useStrokeGradient ? strokeGradient!.styleFor(ctx) : strokeColor;
    const paintParts = (target: CanvasRenderingContext2D): void => {
      for (const part of which) paintPart(part, item, fillStyle, strokeStyle, strokeW, fillAlpha, 0, 0, strokeAlpha, target);
    };
    const trBlurY = tr ? Math.max(0, tr.blurY ?? tr.blur) : 0;
    const trBlurX = tr ? Math.max(0, tr.blur) : 0;
    if (tr && trBlurX !== trBlurY) {
      // Unlinked 2-D blur — staged through the scratch composite. Headless
      // (no scratch canvas) degrades to an isotropic blur at the axis mean,
      // which is at least the right total energy.
      if (!paintAnisoBlur(paintParts, trBlurX, trBlurY)) {
        ctx.filter = `blur(${(trBlurX + trBlurY) / 2}px)`;
        paintParts(ctx);
      }
    } else {
      paintParts(ctx);
    }
    ctx.restore();
    if (blendPrev !== null) ctx.globalCompositeOperation = blendPrev;
  };

  /**
   * Paint one glyph with different X and Y blur radii (see the module note by
   * `anisoScratch`). Returns false when it cannot stage the composite —
   * headless, a zero-sized canvas, a context without `getTransform` — and the
   * caller falls back to an isotropic approximation.
   */
  const paintAnisoBlur = (paint: (target: CanvasRenderingContext2D) => void, bx: number, by: number): boolean => {
    const canvas = (ctx as CanvasRenderingContext2D & { canvas?: HTMLCanvasElement }).canvas;
    const W = canvas?.width ?? 0;
    const H = canvas?.height ?? 0;
    if (!canvas || W <= 0 || H <= 0 || typeof ctx.getTransform !== 'function') return false;
    const A = anisoScratch(0, W, H);
    const B = anisoScratch(1, W, H);
    if (!A || !B) return false;
    const m = ctx.getTransform();
    // 1. The glyph, unblurred, in the layer context's own user space.
    const actx = A.ctx;
    actx.save();
    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.clearRect(0, 0, A.canvas.width, A.canvas.height);
    // Six-argument form: every 2D backend takes it (the DOMMatrix overload is
    // the one canvas shims disagree about).
    actx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    copyTextDrawState(ctx, actx);
    paint(actx);
    actx.restore();
    // 2. Radii in device px — the CTM here carries the raster's oversample and
    // the glyph's own animator scale, both of which stretch a user-space blur.
    const dbx = bx * (Math.hypot(m.a, m.b) || 1);
    const dby = by * (Math.hypot(m.c, m.d) || 1);
    // The isotropic radius applied in squashed space: at least 1 px (sub-pixel
    // would resample as bands), at most the larger request (never over-blur
    // both axes). The sharp axis of a one-sided blur so picks up ≤ 1 px.
    const base = Math.min(Math.max(Math.min(dbx, dby), 1), Math.max(dbx, dby, 1));
    // An axis squashed by k and stretched back gains resampling blur of its
    // own — the box downsample and the bilinear stretch add about k²/4 of
    // variance in device px — so a heavily squashed axis spread ~3 px per
    // side farther than the same radius applied uniformly. Pick k so the
    // total matches the request: (base·k)² + k²/4 = d²  ⇒  k = d / √(base² + ¼).
    const squash = (d: number): number => (d > base ? Math.min(1, Math.sqrt(base * base + 0.25) / d) : 1);
    const sx = squash(dbx);
    const sy = squash(dby);
    const sw = Math.max(1, Math.round(W * sx));
    const sh = Math.max(1, Math.round(H * sy));
    // Squash and blur are SEPARATE draws: the blur must land on the squashed
    // image (that is what makes it anisotropic after the stretch), and a
    // filtered+scaled drawImage would also let a backend apply the filter to
    // the source instead — the two 1:1 filtered draws leave no such choice.
    const bctx = B.ctx;
    bctx.save();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, B.canvas.width, B.canvas.height);
    bctx.drawImage(A.canvas, 0, 0, W, H, 0, 0, sw, sh);
    bctx.restore();
    actx.save();
    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.clearRect(0, 0, A.canvas.width, A.canvas.height);
    actx.filter = `blur(${base}px)`;
    actx.drawImage(B.canvas, 0, 0);
    actx.restore();
    // 3. Stretch back onto the layer. Identity transform: the glyph was
    // captured under the CTM, so the composite is a straight device-space
    // copy. The context's current globalAlpha (layer × animator opacity) and
    // blend op apply to the draw.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(A.canvas, 0, 0, sw, sh, 0, 0, W, H);
    ctx.restore();
    return true;
  };

  const paintItems = (items: ReadonlyArray<DrawItem>): void => {
    if (allPasses) {
      for (const part of parts) for (const it of items) drawItem(it, [part]);
    } else {
      for (const it of items) drawItem(it, parts);
    }
  };

  if (!hasGlyphWork) {
    const layerStyle: TextStyle = {
      fontSize: spec.fontSize,
      fontFamily: spec.fontFamily,
      fontWeight: spec.fontWeight,
      fontStyle: spec.fontStyle,
      letterSpacing: spec.letterSpacing,
      fill: layerFill,
      fauxBold: ex.fauxBold || undefined,
      fauxItalic: ex.fauxItalic || undefined,
    };
    const plans = planWholeStringLines(
      text,
      { fontSize: spec.fontSize, ...paragraph },
      (s) => ctx.measureText(s).width,
      { boxWidth: spec.width, padX: TEXT_PAD_X, softBreakLines: ex.softBreakLines, ...(bidiDir ? { direction: bidiDir } : {}) },
    );
    const items: DrawItem[] = [];
    plans.forEach((p, line) => {
      for (const s of p.segments) {
        // 'auto': a right-to-left paragraph's lines draw under 'rtl' (an 'rtl'
        // layer set that on the context once, above).
        items.push({ text: s.text, x: s.x, y: p.y, align: s.align, style: layerStyle, line, ...(p.direction ? { direction: p.direction } : {}) });
      }
    });
    // The whole-string draw has no per-glyph transform. With no stroke and no
    // faux style it takes drawItem's cheap branch, which is byte-for-byte the
    // `fillText(line, anchorX, y)` this path has always issued.
    paintItems(fitItemsToBox(items, plans.map((p) => p.y), (spec.lineHeight ?? AUTO_LEADING) * spec.fontSize, ex, boxScale));
    return;
  }

  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
  const measureCache = new Map<string, number>();
  const measure = (char: string, style: TextStyle): number => {
    const font = fontFor(style);
    const key = `${font} ${char}`;
    const hit = measureCache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = font;
    const width = ctx.measureText(char).width;
    measureCache.set(key, width);
    return width;
  };
  const bearingCache = new Map<string, { left: number; right: number }>();
  /** The face optical kerning profiles: this style's font at the reference size. */
  const opticalFaceOf = (s: TextStyle): OpticalFace => ({
    css: fontFor({ ...s, fontSize: REF_EM_PX }),
    family: s.fontFamily,
    weight: s.fontWeight,
    italic: s.fontStyle === 'italic',
    variable: !!aliasFor(s),
    variation: variationOf(s),
  });
  /** An upright glyph's face for vertical optical kerning — its vertical
   *  alternates face when it draws with one. */
  const verticalOpticalFaceOf = (s: TextStyle, alternate: boolean): OpticalFace => {
    const ref = { ...s, fontSize: REF_EM_PX };
    return { css: alternate ? vertFontFor(ref) : fontFor(ref), family: s.fontFamily, weight: s.fontWeight, italic: s.fontStyle === 'italic', variable: !!aliasFor(s), variation: variationOf(s) };
  };

  const baseStyle = {
    fontSize: spec.fontSize,
    fontFamily: spec.fontFamily,
    fontWeight: spec.fontWeight,
    fontStyle: spec.fontStyle,
    letterSpacing: spec.letterSpacing,
    fill: layerFill,
    fauxBold: ex.fauxBold || undefined,
    fauxItalic: ex.fauxItalic || undefined,
    ...paragraph,
  };
  // Kerned measurement, so this per-glyph path lands on exactly the same
  // pixels as the whole-string fast path above. Without it the two
  // disagreed by 8px over a 19-character headline, and any frame that
  // composited both showed the string twice at two spacings — a picket
  // fence of 1px vertical bars through the letterforms.
  const measureRun = (run: string, style: TextStyle): number => {
    const font = fontFor(style);
    const key = `run|${font}|${style.letterSpacing ?? 0}|${run}`;
    const hit = measureCache.get(key);
    if (hit !== undefined) return hit;
    // Spacing ON for this measurement: the advance it returns is what the
    // fast path would actually produce.
    ctx.letterSpacing = style.letterSpacing ? `${style.letterSpacing}px` : '0px';
    ctx.font = font;
    const w = ctx.measureText(run).width;
    ctx.letterSpacing = '0px';
    measureCache.set(key, w);
    return w;
  };

  const laid: TextLayout = vertical
    ? layoutVerticalText(text, baseStyle, measure, {
        runs: spec.runs,
        transforms: spec.glyphs,
        boxWidth: spec.width,
        padX: TEXT_PAD_X,
        // A FIXED box's height is the column length; auto-height vertical
        // text lays out like point text inside its box.
        columnLimit: ex.boxHeight,
        measureRun,
        romanUpright: !!ex.verticalRomanAlignment,
        alternates: (s) => vertAlternatesFor(s)?.has ?? false,
        ...(ex.tateChuYokoDigits ? { tateChuYokoDigits: ex.tateChuYokoDigits } : {}),
        // Optical kerning in columns: sideways pairs as horizontal pairs,
        // upright CJK pairs from their top/bottom ink (opticalKerning.ts).
        ...(optical
          ? {
              opticalKern: (a: string, sa: TextStyle, b: string, sb: TextStyle) =>
                opticalKernPx(opticalFaceOf(sa), a, sa.fontSize, opticalFaceOf(sb), b, sb.fontSize),
              opticalKernVertical: (a: string, sa: TextStyle, b: string, sb: TextStyle, alt: { upper: boolean; lower: boolean }) =>
                opticalKernVerticalPx(verticalOpticalFaceOf(sa, alt.upper), a, sa.fontSize, verticalOpticalFaceOf(sb, alt.lower), b, sb.fontSize),
            }
          : {}),
      })
    : layoutText(
    text,
    baseStyle,
    measure,
    {
      runs: spec.runs,
      transforms: spec.glyphs,
      boxWidth: spec.width,
      padX: TEXT_PAD_X,
      softBreakLines: ex.softBreakLines,
      kerningMode: ex.kerningMode,
      ...(bidiDir ? { direction: bidiDir } : {}),
      measureRun,
      // Optical kerning: pair adjustments from the glyphs' ink profiles
      // (opticalKerning.ts), on advances measured with font kerning off.
      ...(optical
        ? {
            opticalKern: (a: string, sa: TextStyle, b: string, sb: TextStyle) =>
              opticalKernPx(opticalFaceOf(sa), a, sa.fontSize, opticalFaceOf(sb), b, sb.fontSize),
          }
        : {}),
      // Per-range tsume reads side bearings.
      measureBearings: spec.runs?.some((r) => r.style.tsume)
        ? (char: string, style: TextStyle) => {
            const font = fontFor(style);
            const key = `${font} ${char}`;
            const hit = bearingCache.get(key);
            if (hit) return hit;
            ctx.font = font;
            ctx.textAlign = 'left';
            const m = ctx.measureText(char);
            const inkL = typeof m.actualBoundingBoxLeft === 'number' ? -m.actualBoundingBoxLeft : 0;
            const inkR = typeof m.actualBoundingBoxRight === 'number' ? m.actualBoundingBoxRight : m.width;
            const out = { left: inkL, right: m.width - inkR };
            bearingCache.set(key, out);
            return out;
          }
        : undefined,
    },
  );

  const placed = spec.textPath
    ? applyTextPath(laid, {
        table: arcTable(spec.textPath.points, spec.textPath.closed),
        firstMargin: spec.textPath.firstMargin,
        reversed: spec.textPath.reversed,
        perpendicular: spec.textPath.perpendicular,
        align: spec.align,
        forceAlignment: spec.textPath.forceAlignment,
        lastMargin: spec.textPath.lastMargin,
        ...(vertical ? { vertical: true } : {}),
      })
    : laid.glyphs;

  // Anchor Point Grouping / Grouping Alignment move the transform ORIGIN of
  // every glyph an animator touches. (Text on a path keeps per-glyph origins:
  // each glyph there has its own baseline direction.)
  const pivots = !spec.textPath && (ex.anchorGrouping || ex.groupingAlign)
    ? groupPivots(placed, ex.anchorGrouping, ex.groupingAlign)
    : null;
  const pivotByIndex = new Map<number, { x: number; y: number }>();
  if (pivots) placed.forEach((g, i) => { const p = pivots[i]; if (p && g.transform && !isIdentityTransform(g.transform)) pivotByIndex.set(g.index, p); });

  const grouped = spec.textPath
    ? placed.map(vertical ? verticalItem : singleItem)
    : vertical
      ? groupVertical(placed, optical || !!blendOp)
      : groupForShaping(placed, laid.lines, optical || !!blendOp, !ligaturesOff);
  const items = pivotByIndex.size > 0
    ? grouped.map((it) => (it.index !== undefined && pivotByIndex.has(it.index) ? { ...it, pivot: pivotByIndex.get(it.index)! } : it))
    : grouped;
  // A paragraph box clips whole lines; a vertical box drops the columns past
  // its left edge. Text on a PATH is point text: `readParagraphBox` already
  // withholds box height / fit / alignment from such a layer, and a box height
  // that reaches here anyway is ignored explicitly rather than half-applied.
  const visibleColumns = laid.visibleLines;
  const boxed = spec.textPath || laid.lines.length === 0
    ? items
    : vertical
      ? visibleColumns !== undefined ? items.filter((it) => it.line < visibleColumns) : items
      : fitItemsToBox(
        items,
        laid.lines.map((l) => l.y),
        // Each line's own leading when runs set one; else the block's one line box.
        laid.lineLeading ?? laid.height - (laid.lines[laid.lines.length - 1]!.y - laid.lines[0]!.y),
        ex,
        boxScale,
      );
  paintItems(boxed.filter((it) => it.text.trim() !== ''));
}

/**
 * Fixed paragraph box: move the lines to the box's vertical alignment and drop
 * every line that does not fully fit (AE's overflow). A no-op without a box
 * height, so point text and auto-height paragraphs paint exactly as before.
 * `scale` is the Fit Text to Box scale the layout space is shrunk by.
 */
function fitItemsToBox(
  items: DrawItem[],
  lineYs: ReadonlyArray<number>,
  lineHeightPx: number | ReadonlyArray<number>,
  ex: TextExtras,
  scale: number,
): DrawItem[] {
  if (!ex.boxHeight || lineYs.length === 0) return items;
  const p = placeLinesInBox(lineYs, lineHeightPx, ex.boxHeight / scale, ex.boxVerticalAlign);
  if (p.dy === 0 && p.visible >= lineYs.length) return items;
  return items.filter((it) => it.line < p.visible).map((it) => ({ ...it, y: it.y + p.dy }));
}

/** One glyph, centred on its own advance box. */
function singleItem(g: PlacedGlyph): DrawItem {
  return {
    text: g.drawn ?? g.transform?.displayChar ?? g.char,
    x: g.x,
    y: g.y,
    align: 'center',
    style: g.style,
    tr: g.transform,
    angle: g.angle,
    line: g.line,
    index: g.index,
    // Right-to-left layers: the canvas mirrors paired punctuation at odd levels.
    ...(g.level !== undefined ? { direction: g.level % 2 === 1 ? 'rtl' as const : 'ltr' as const } : {}),
  };
}

/**
 * One vertical glyph: `singleItem`, drawn with the `vert` alias when the
 * layout chose the font's vertical alternate, and — for a tate-chu-yoko
 * member — squeezed horizontally about its own centre by the run's scale.
 */
function verticalItem(g: PlacedGlyph): DrawItem {
  const v = g as VerticalGlyph;
  const item = singleItem(g);
  if (v.vertAlternate) item.vert = true;
  if (v.tcy && v.tcy.scale < 1) item.style = tcySqueezed(g.style, v.tcy.scale);
  return item;
}

function tcySqueezed(style: TextStyle, scale: number): TextStyle {
  return { ...style, horizontalScale: (style.horizontalScale ?? 100) * scale };
}

/**
 * Vertical type's draw units. Upright glyphs (CJK) are drawn one by one, each
 * centred in its em box. A run of consecutive SIDEWAYS glyphs (rotated Latin)
 * that nothing per-character touches is drawn as one rotated string from its
 * first pen — kerning and ligatures intact, and at the pen `layoutVerticalText`
 * measured the run with. An untouched tate-chu-yoko run is drawn as ONE
 * horizontal string centred in its em, squeezed to the column when wider.
 */
export function groupVertical(glyphs: ReadonlyArray<PlacedGlyph>, never: boolean): DrawItem[] {
  const out: DrawItem[] = [];
  const untouched = (g: PlacedGlyph): boolean =>
    !g.style.kerning && !hasGlyphGeometryStyle(g.style) && (!g.transform || isIdentityTransform(g.transform));
  const groupable = (g: PlacedGlyph): boolean =>
    !never && g.angle !== undefined && untouched(g);
  let i = 0;
  while (i < glyphs.length) {
    const g = glyphs[i]!;
    const tcy = (g as VerticalGlyph).tcy;
    if (tcy) {
      let k = i + 1;
      while (k < glyphs.length && (glyphs[k] as VerticalGlyph).tcy?.start === tcy.start) k++;
      const span = glyphs.slice(i, k);
      const key = paintKey(g.style);
      if (span.length > 1 && !never && span.every((s) => untouched(s) && paintKey(s.style) === key)) {
        const last = span[span.length - 1]!;
        out.push({
          text: span.map((s) => s.drawn ?? s.char).join(''),
          x: (g.x - g.inkWidth / 2 + last.x + last.inkWidth / 2) / 2,
          y: g.y,
          align: 'center',
          style: tcy.scale < 1 ? tcySqueezed(g.style, tcy.scale) : g.style,
          line: g.line,
        });
      } else {
        for (const s of span) out.push(verticalItem(s));
      }
      i = k;
      continue;
    }
    if (!groupable(g)) {
      out.push(verticalItem(g));
      i++;
      continue;
    }
    const key = paintKey(g.style);
    let k = i + 1;
    while (
      k < glyphs.length && groupable(glyphs[k]!) && glyphs[k]!.line === g.line &&
      glyphs[k]!.index === glyphs[k - 1]!.index + 1 && paintKey(glyphs[k]!.style) === key
    ) k++;
    if (k - i > 1) {
      const span = glyphs.slice(i, k);
      out.push({
        text: span.map((s) => s.drawn ?? s.char).join(''),
        x: g.x,
        y: g.y - g.inkWidth / 2,
        align: 'left',
        style: g.style,
        angle: g.angle,
        line: g.line,
        run: true,
      });
    } else {
      out.push(singleItem(g));
    }
    i = k;
  }
  return out;
}

/**
 * Group glyphs into runs that can be drawn as one string without changing
 * where anything lands (see the file docblock's "Shaping").
 *
 * A glyph is groupable when nothing per-character touches it: no animator
 * change, no path angle, no manual kerning. A run is drawn from its first
 * glyph's PEN with `textAlign: 'left'` and the run's letter spacing, which puts
 * every later glyph at its kerned pen — the same place the per-glyph draw
 * would. Whole lines group; within a mixed line, a same-style span groups
 * too — complex scripts always (their shaping needs it), everything else while
 * standard LIGATURES are on (AE's default), because a ligature ("fi", "ffl")
 * only forms when its letters are drawn in one string.
 *
 * `optical` also stands for "never group" (inter-character blending must
 * composite glyph over glyph).
 */
/** Does a canvas drawing this line (logical string, 'rtl' base) resolve the
 *  levels the layout gave its glyphs? */
function canvasAgreesOnLevels(line: ReadonlyArray<PlacedGlyph>): boolean {
  const logical = [...line].sort((a, b) => a.index - b.index);
  const own = clusterLevels(logical.map((g) => g.char), 1);
  return logical.every((g, k) => g.level === own[k]);
}

export function groupForShaping(
  glyphs: ReadonlyArray<PlacedGlyph>,
  lines: ReadonlyArray<{ spaceExtra?: number; direction?: 'ltr' | 'rtl' }>,
  optical: boolean,
  ligatures = true,
): DrawItem[] {
  const out: DrawItem[] = [];
  const groupable = (g: PlacedGlyph): boolean =>
    !optical && g.angle === undefined && !g.style.kerning && !hasGlyphGeometryStyle(g.style) &&
    (!g.transform || isIdentityTransform(g.transform));
  // Right-to-left (glyphs carry bidi levels, in visual order): a span groups
  // only while it stays one level run in logical order — visually adjacent
  // glyphs whose logical indices step by one in that level's direction.
  const continues = (a: PlacedGlyph, b: PlacedGlyph): boolean =>
    a.level === undefined || (a.level === b.level && b.index === a.index + (a.level % 2 === 1 ? -1 : 1));

  let i = 0;
  while (i < glyphs.length) {
    const lineNo = glyphs[i]!.line;
    let end = i;
    while (end < glyphs.length && glyphs[end]!.line === lineNo) end++;
    const line = glyphs.slice(i, end);
    const justified = (lines[lineNo]?.spaceExtra ?? 0) > 0;

    const firstKey = paintKey(line[0]!.style);
    // Ligatures off: only complex scripts may be drawn whole (a Latin line
    // drawn as one string would form the ligatures the author switched off).
    const uniform = !justified && line.every((g) => groupable(g) && paintKey(g.style) === firstKey) &&
      (ligatures || hasComplexScript(line.map((g) => g.char).join('')));
    // A bidi line is drawn whole only in a right-to-left paragraph, and only
    // when the canvas resolving the line ALONE reaches the layout's levels —
    // which were resolved over the whole paragraph (a soft wrap can differ).
    const levelled = line[0]!.level !== undefined;
    if (uniform && line.length > 1 && (!levelled || (lines[lineNo]?.direction !== 'ltr' && canvasAgreesOnLevels(line)))) {
      out.push(levelled ? rtlLineItem(line) : runItem(line));
    } else {
      let j = 0;
      while (j < line.length) {
        const g = line[j]!;
        if (justified || !groupable(g)) {
          out.push(singleItem(g));
          j++;
          continue;
        }
        const key = paintKey(g.style);
        let k = j + 1;
        while (k < line.length && groupable(line[k]!) && paintKey(line[k]!.style) === key && continues(line[k - 1]!, line[k]!)) k++;
        const span = line.slice(j, k);
        if (span.length > 1 && (ligatures || hasComplexScript(span.map((s) => s.char).join('')))) {
          out.push(runItem(span));
        } else {
          for (const s of span) out.push(singleItem(s));
        }
        j = k;
      }
    }
    i = end;
  }
  return out;
}

/**
 * A whole right-to-left line with nothing per-character on it: its LOGICAL
 * string, drawn under `direction = 'rtl'` from the line's leftmost pen — the
 * canvas's own bidi and shaping then put every glyph where the visual layout
 * did.
 */
function rtlLineItem(line: ReadonlyArray<PlacedGlyph>): DrawItem {
  const first = line[0]!;
  const logical = [...line].sort((a, b) => a.index - b.index);
  return {
    text: logical.map((g) => g.drawn ?? g.char).join(''),
    x: first.x - first.inkWidth / 2,
    y: first.y,
    align: 'left',
    style: first.style,
    tr: undefined,
    line: first.line,
    run: true,
    direction: 'rtl',
  };
}

function runItem(span: ReadonlyArray<PlacedGlyph>): DrawItem {
  const first = span[0]!;
  // A right-to-left level run arrives in visual order; draw it logically.
  const odd = first.level !== undefined && first.level % 2 === 1;
  const ordered = odd ? [...span].reverse() : span;
  return {
    ...(first.level !== undefined ? { direction: odd ? 'rtl' as const : 'ltr' as const } : {}),
    text: ordered.map((g) => g.drawn ?? g.char).join(''),
    x: first.x - first.inkWidth / 2,
    y: first.y,
    align: 'left',
    style: first.style,
    // Groupable glyphs carry no transform (or an identity one), so the run is
    // drawn untransformed; layer stroke and faux styles still apply.
    tr: undefined,
    line: first.line,
    run: true,
  };
}
