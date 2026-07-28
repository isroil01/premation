/**
 * Relative units for animation presets.
 *
 * The single most-hit design bug in After Effects' own preset library is that
 * its text presets were authored in a 720×480 composition at 72pt, with the
 * position values baked in as absolute pixels. Apply one in a 4K comp and the
 * text flies several screens off-frame. Adobe has been unable to fix it for
 * twenty years, because fixing it would break every existing project.
 *
 * So we do not bake pixels. A preset track declares what its numbers are
 * relative to, and applying resolves them against the target: a slide-in
 * authored as "0.25 of the comp width" travels a quarter of the frame whether
 * that frame is 720p or 4K, and a blur authored as "0.4 of the font size" stays
 * proportionate at any type size.
 *
 * This costs nothing to get right up front and is painful to retrofit — which
 * is exactly why it lives here, in front of the library rather than behind it.
 */

/** What a preset value is measured against. */
export type PresetUnit =
  /** Absolute — the number is already in the property's own units. Correct for
   *  rotation (degrees), opacity and scale (percent), and anything unitless. */
  | 'abs'
  /** Fraction of the composition's width / height / smaller edge. */
  | 'compW'
  | 'compH'
  | 'compMin'
  /** Fraction of the layer's own width / height. */
  | 'layerW'
  | 'layerH'
  /** Multiple of the layer's font size — the right reference for anything that
   *  should scale with the type: tracking, blur, stroke width, line spacing. */
  | 'fontSize';

/** How a preset's keyframe TIMES are measured. */
export type PresetTimeUnit =
  /** Seconds from the preset's start. */
  | 'seconds'
  /** Fraction of the layer's duration — a "fade out over the last 20%" preset
   *  then lands correctly on a 2-second layer and a 2-minute one. */
  | 'duration';

/** Everything a preset needs to turn relative numbers into concrete ones. */
export interface PresetContext {
  compWidth: number;
  compHeight: number;
  layerWidth: number;
  layerHeight: number;
  fontSize: number;
  /** The target layer's duration in seconds, for `timeUnit: 'duration'`. */
  layerDuration: number;
}

export const DEFAULT_PRESET_CONTEXT: PresetContext = {
  compWidth: 1920,
  compHeight: 1080,
  layerWidth: 400,
  layerHeight: 200,
  fontSize: 48,
  layerDuration: 2,
};

/** The scalar a `unit` fraction multiplies by, in the given context. */
export function unitScale(unit: PresetUnit | undefined, ctx: PresetContext): number {
  switch (unit) {
    case 'compW':
      return ctx.compWidth;
    case 'compH':
      return ctx.compHeight;
    case 'compMin':
      return Math.min(ctx.compWidth, ctx.compHeight);
    case 'layerW':
      return ctx.layerWidth;
    case 'layerH':
      return ctx.layerHeight;
    case 'fontSize':
      return ctx.fontSize;
    case 'abs':
    case undefined:
    default:
      return 1;
  }
}

/** Turn an authored (relative) value into a concrete one. */
export function resolveUnitValue(
  value: number,
  unit: PresetUnit | undefined,
  ctx: PresetContext,
): number {
  return value * unitScale(unit, ctx);
}

/** Turn a concrete value back into an authored one — the capture direction, so
 *  "save as preset" produces something that survives a different comp. */
export function toUnitValue(
  value: number,
  unit: PresetUnit | undefined,
  ctx: PresetContext,
): number {
  const s = unitScale(unit, ctx);
  return s === 0 ? value : value / s;
}

/** Scale a preset time to the target, per the preset's time unit. */
export function resolveUnitTime(
  t: number,
  timeUnit: PresetTimeUnit | undefined,
  ctx: PresetContext,
): number {
  return timeUnit === 'duration' ? t * Math.max(0.0001, ctx.layerDuration) : t;
}

/**
 * The unit that suits a property when a preset is captured without the author
 * saying. Positions scale with the comp, type metrics with the font size, and
 * everything angular or proportional stays absolute — a 90° rotation is 90° in
 * any comp, and turning it into a fraction of the width would be nonsense.
 */
export function defaultUnitForProp(prop: string): PresetUnit {
  const leaf = prop.split('.').pop() ?? prop;
  switch (leaf) {
    case 'x':
    case 'positionX':
      return 'compW';
    case 'y':
    case 'positionY':
      return 'compH';
    case 'z':
      return 'compMin';
    case 'tracking':
    case 'lineSpacing':
    case 'blur':
    case 'strokeWidth':
      return 'fontSize';
    default:
      return 'abs';
  }
}
