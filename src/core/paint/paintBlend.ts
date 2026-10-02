/**
 * Paint-operation Composite and Blend Mode — the pure half, importable by the
 * rasterizer without pulling the scene graph in through `@core/paint/stroke`
 * (which re-exports everything here for model and UI callers).
 */

import type { LayerBlendMode } from '@core/effects/blendMode';

/**
 * AE's "Composite" on a Fill or Stroke: render this paint BELOW the previous
 * paint operation in the same group (the default) or ABOVE it.
 *
 * "Previous" is the paint listed immediately above in AE's Contents order. Our
 * stacks have that order implicitly — strokes above fills, later entries above
 * earlier ones — which is exactly the order every layer has always rendered in
 * when every entry says 'below'. See `paintRenderOrder` in vectorDraw.
 */
export type PaintComposite = 'below' | 'above';

/**
 * The blend modes a paint operation offers: AE's list, cut to the modes Canvas2D
 * composites natively (`globalCompositeOperation`), since a shape's paints are
 * blended INSIDE its raster, before the layer ever reaches the GPU compositor.
 *
 * NOT offered, and why: Dissolve / Dancing Dissolve (stochastic, need the
 * compositor's hash), the Classic aliases, Linear Burn, Darker/Lighter Color,
 * Linear/Vivid/Pin Light, Hard Mix, Subtract, Divide and the Utility/Matte
 * families — Canvas2D has no operator for them, and an approximation would be a
 * menu entry that draws something AE does not. `add` maps to 'lighter', which
 * is additive in both colour and alpha — AE's Add over a transparent group.
 */
export type PaintBlendMode = Extract<LayerBlendMode,
  | 'normal' | 'darken' | 'multiply' | 'color-burn' | 'add' | 'lighten' | 'screen' | 'color-dodge'
  | 'overlay' | 'soft-light' | 'hard-light' | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity'>;

/** The two optional fields every paint operation (fill or stroke) may carry. */
export interface PaintOpOptions {
  /** Absent = 'below' (AE's default). */
  composite?: PaintComposite;
  /** Absent = 'normal'. */
  blendMode?: PaintBlendMode;
}

export const PAINT_COMPOSITES: ReadonlyArray<{ value: PaintComposite; label: string }> = [
  { value: 'below', label: 'Below Previous in Same Group' },
  { value: 'above', label: 'Above Previous in Same Group' },
];

/** AE's menu order, each with the Canvas2D operator that draws it. */
export const PAINT_BLEND_MODES: ReadonlyArray<{ value: PaintBlendMode; label: string; op: GlobalCompositeOperation }> = [
  { value: 'normal', label: 'Normal', op: 'source-over' },
  { value: 'darken', label: 'Darken', op: 'darken' },
  { value: 'multiply', label: 'Multiply', op: 'multiply' },
  { value: 'color-burn', label: 'Color Burn', op: 'color-burn' },
  { value: 'add', label: 'Add', op: 'lighter' },
  { value: 'lighten', label: 'Lighten', op: 'lighten' },
  { value: 'screen', label: 'Screen', op: 'screen' },
  { value: 'color-dodge', label: 'Color Dodge', op: 'color-dodge' },
  { value: 'overlay', label: 'Overlay', op: 'overlay' },
  { value: 'soft-light', label: 'Soft Light', op: 'soft-light' },
  { value: 'hard-light', label: 'Hard Light', op: 'hard-light' },
  { value: 'difference', label: 'Difference', op: 'difference' },
  { value: 'exclusion', label: 'Exclusion', op: 'exclusion' },
  { value: 'hue', label: 'Hue', op: 'hue' },
  { value: 'saturation', label: 'Saturation', op: 'saturation' },
  { value: 'color', label: 'Color', op: 'color' },
  { value: 'luminosity', label: 'Luminosity', op: 'luminosity' },
];

const BLEND_OP = new Map<string, GlobalCompositeOperation>(PAINT_BLEND_MODES.map((m) => [m.value, m.op]));

/** The Canvas2D operator a paint's blend mode draws with ('source-over' for normal/unknown). */
export function paintCompositeOperation(mode: string | undefined): GlobalCompositeOperation {
  return (mode && BLEND_OP.get(mode)) || 'source-over';
}

/** True for a blend mode a paint may carry (Canvas2D-native, see `PaintBlendMode`). */
export function isPaintBlendMode(v: unknown): v is PaintBlendMode {
  return typeof v === 'string' && BLEND_OP.has(v);
}

/**
 * Lottie's `bm` numbers (bodymovin's BlendMode enum), index = value. `null` for
 * the one Lottie mode no Canvas2D operator draws (17, Hard Mix) — it imports as
 * Normal and is reported by the importer's caller if it cares.
 */
export const LOTTIE_BLEND_MODES: ReadonlyArray<PaintBlendMode | null> = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
  'add', null,
];

/** A Lottie `bm` → a paint blend mode, or undefined for Normal / unknown / unsupported. */
export function lottieBlendToPaint(bm: unknown): PaintBlendMode | undefined {
  if (typeof bm !== 'number' || bm <= 0) return undefined;
  return LOTTIE_BLEND_MODES[bm] ?? undefined;
}

/** A paint blend mode → Lottie `bm` (0 for Normal/absent). */
export function paintBlendToLottie(mode: string | undefined): number {
  const i = mode ? LOTTIE_BLEND_MODES.indexOf(mode as PaintBlendMode) : -1;
  return i > 0 ? i : 0;
}

/**
 * The paint-op fields of a stored fill or stroke, OMITTING defaults.
 *
 * Omitted rather than written for the cache-key reason `Stroke.dashOffset`
 * gives: `contentHash` serialises paints whole, so stamping `composite: 'below'`
 * onto every paint would re-key every raster in a project for a value that means
 * "unchanged".
 */
export function normalizePaintOpOptions(v: unknown): PaintOpOptions {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const out: PaintOpOptions = {};
  if (o.composite === 'above') out.composite = 'above';
  if (isPaintBlendMode(o.blendMode) && o.blendMode !== 'normal') out.blendMode = o.blendMode;
  return out;
}
