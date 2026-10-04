/**
 * Section presets — what each preset-capable section captures and how it
 * applies a saved bag back, for every selected layer, as one undo entry.
 *
 * The store (`sectionPresetStore`) holds flat `{ key: number | string |
 * boolean }` bags and knows nothing about what a key means; this module is
 * the schema. Four sections take presets:
 *
 *   transform   numeric transform props, written through the multi-selection
 *               seam (keyframed where the target is animated);
 *   text        the Text component's style props (family, size, weight,
 *               tracking, leading …), written as static component props;
 *   appearance  a solid fill colour and the stroke's scalar fields;
 *   material    the whole `MaterialParams` surface.
 *
 * Capture reads the PRIMARY layer; apply writes EVERY selected layer that can
 * take the value — so "make these three lower-thirds match the house style"
 * is one pick.
 */

export type PresetSectionId = 'transform' | 'text' | 'appearance' | 'material';

/** The transform props a preset carries, in the order the section lists them. */
export const TRANSFORM_PRESET_PROPS: ReadonlyArray<string> = [
  'anchorX', 'anchorY', 'anchorZ',
  'x', 'y', 'z',
  'scaleX', 'scaleY',
  'width', 'height',
  'rotation', 'rotationX', 'rotationY',
  'orientationX', 'orientationY', 'orientationZ',
  'skew', 'skewAxis',
  'opacity', 'fillOpacity',
];

/** The Text component props a text-style preset carries. */
export const TEXT_PRESET_PROPS: ReadonlyArray<string> = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
  'letterSpacing', 'lineHeight', 'textTransform', 'fontVariant',
  'verticalScale', 'horizontalScale', 'baselineShift',
  'fill', 'stroke', 'strokeWidth', 'strokeOverFill',
];
