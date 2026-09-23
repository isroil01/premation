/**
 * The NON-KEYFRAMEABLE fields of a text layer, of its animators and of their
 * selectors, as engine-API properties (ENGINE_API.md §3.4, G1).
 *
 * After Effects models all of these as properties: the Character / Paragraph
 * settings are fields of the TextDocument, More Options' choices are enum
 * properties of the Text group, a selector's Based On / Mode / Shape are enum
 * properties of the selector, Randomize Order is a checkbox, the expression
 * selector's Amount is an expression-driven property. They are not keyframed
 * (AE keys the TextDocument as a whole — Source Text), so here they are static
 * properties with a value type, a default and, for enumerations, the closed
 * list of values.
 *
 * This module is DATA, shared by both engines: the TypeScript catalog
 * (`src/core/engine/fields.ts`) reads it directly and the C++ catalog reads
 * the copy `crossEngineCatalog.test.ts` generates from it. Pure — no scene
 * graph, no stores.
 *
 * Storage is the field's own key on its owner (the Text component, the
 * animator object, the selector object). `clearAtDefault` fields are stored
 * ONLY when they differ from the default — the shape the editor always wrote
 * for them (an absent `ligatures` is "on"), so a document never grows a field
 * nobody changed.
 */

import { STROKE_ORDERS } from './textExtras';
import { ANCHOR_GROUPINGS, FILL_STROKE_MODES, INTER_CHARACTER_BLEND_MODES } from './textMoreOptions';

export type TextFieldType = 'string' | 'choice' | 'bool' | 'scalar' | 'color' | 'scalars' | 'json';

export interface TextFieldSpec {
  /** Storage key on the owner, and the API path leaf. */
  key: string;
  label: string;
  type: TextFieldType;
  /** The value an absent field reads as (a hex string for colours). */
  default: string | number | boolean | number[] | null;
  /** Closed value list of a `choice`. */
  choices?: readonly string[];
  /** Writing the default removes the field instead of storing it. */
  clearAtDefault?: boolean;
  min?: number;
  max?: number;
  /** Selector fields: the selector kinds that carry this field (absent = every kind). */
  kinds?: readonly string[];
}

/** Text component fields: Character, Paragraph, the paragraph box, More Options, OpenType. */
export const TEXT_FIELDS: readonly TextFieldSpec[] = [
  // ── Character ──
  { key: 'fontFamily', label: 'Font', type: 'string', default: 'Inter' },
  { key: 'fontStyle', label: 'Font Style', type: 'string', default: 'normal' },
  { key: 'stroke', label: 'Stroke Color', type: 'color', default: '#000000' },
  // A gradient stroke paint (linear / radial: stops + geometry) — a structured
  // value, so a json field (ENGINE_API.md §14.2); null = the solid Stroke Color.
  { key: 'strokePaint', label: 'Stroke Paint', type: 'json', default: null, clearAtDefault: true },
  { key: 'strokeLineJoin', label: 'Line Join', type: 'choice', default: 'round', choices: ['miter', 'round', 'bevel'] },
  { key: 'strokeOrder', label: 'Fill and Stroke', type: 'choice', default: 'fill-over-stroke', choices: STROKE_ORDERS.map((o) => o.value) },
  { key: 'noFill', label: 'No Fill', type: 'bool', default: false },
  { key: 'noStroke', label: 'No Stroke', type: 'bool', default: false },
  { key: 'fauxBold', label: 'Faux Bold', type: 'bool', default: false },
  { key: 'fauxItalic', label: 'Faux Italic', type: 'bool', default: false },
  { key: 'kerningMode', label: 'Kerning', type: 'choice', default: 'metrics', choices: ['metrics', 'optical'] },
  { key: 'textTransform', label: 'Caps', type: 'choice', default: 'none', choices: ['none', 'uppercase', 'lowercase', 'capitalize'] },
  { key: 'fontVariant', label: 'Small Caps', type: 'choice', default: 'normal', choices: ['normal', 'small-caps'] },
  { key: 'verticalAlign', label: 'Baseline', type: 'choice', default: 'baseline', choices: ['baseline', 'super', 'sub'] },
  { key: 'verticalScale', label: 'Vertical Scale', type: 'scalar', default: 100, min: 1 },
  { key: 'horizontalScale', label: 'Horizontal Scale', type: 'scalar', default: 100, min: 1 },
  { key: 'baselineShift', label: 'Baseline Shift', type: 'scalar', default: 0 },
  // ── Paragraph ──
  {
    key: 'align', label: 'Justification', type: 'choice', default: 'left',
    choices: ['left', 'center', 'right', 'justify', 'justify-left', 'justify-center', 'justify-right', 'justify-all'],
  },
  { key: 'paragraphSpacing', label: 'Paragraph Spacing', type: 'scalar', default: 0 },
  { key: 'leftIndent', label: 'Indent Before', type: 'scalar', default: 0 },
  { key: 'rightIndent', label: 'Indent After', type: 'scalar', default: 0 },
  { key: 'firstLineIndent', label: 'First Line Indent', type: 'scalar', default: 0 },
  { key: 'spaceBefore', label: 'Space Before', type: 'scalar', default: 0 },
  { key: 'spaceAfter', label: 'Space After', type: 'scalar', default: 0 },
  { key: 'direction', label: 'Direction', type: 'choice', default: 'ltr', choices: ['ltr', 'rtl', 'auto'] },
  { key: 'orientation', label: 'Orientation', type: 'choice', default: 'horizontal', choices: ['horizontal', 'vertical'] },
  { key: 'verticalRomanAlignment', label: 'Standard Vertical Roman Alignment', type: 'bool', default: false },
  { key: 'tateChuYokoAuto', label: 'Tate-Chu-Yoko', type: 'bool', default: false },
  { key: 'tateChuYokoDigits', label: 'Tate-Chu-Yoko Digits', type: 'scalar', default: 2, min: 1, max: 4 },
  // ── Paragraph (box) text ──
  { key: 'boxWidth', label: 'Box Width', type: 'scalar', default: 0, min: 0 },
  { key: 'boxHeight', label: 'Box Height', type: 'scalar', default: 0, min: 0 },
  { key: 'boxAutoSize', label: 'Box Auto-Size', type: 'choice', default: 'off', choices: ['off', 'height', 'fit'] },
  { key: 'boxVerticalAlign', label: 'Box Vertical Alignment', type: 'choice', default: 'top', choices: ['top', 'center', 'bottom'] },
  // ── More Options ──
  { key: 'anchorGrouping', label: 'Anchor Point Grouping', type: 'choice', default: 'character', choices: ANCHOR_GROUPINGS.map((g) => g.value) },
  { key: 'fillStrokeMode', label: 'Fill & Stroke', type: 'choice', default: 'perCharacter', choices: FILL_STROKE_MODES.map((m) => m.value) },
  {
    key: 'interCharacterBlending', label: 'Inter-Character Blending', type: 'choice', default: 'normal',
    choices: INTER_CHARACTER_BLEND_MODES.map((m) => m.value),
  },
  // ── OpenType (absent at AE's defaults) ──
  { key: 'ligatures', label: 'Standard Ligatures', type: 'bool', default: true, clearAtDefault: true },
  { key: 'discretionaryLigatures', label: 'Discretionary Ligatures', type: 'bool', default: false, clearAtDefault: true },
  { key: 'contextualAlternates', label: 'Contextual Alternates', type: 'bool', default: true, clearAtDefault: true },
  { key: 'stylisticSets', label: 'Stylistic Sets', type: 'scalars', default: [], clearAtDefault: true },
];

/**
 * Text animator fields (under `text/animators/<id>/props/`). `color` and
 * `strokeColor` are AE's optional Fill Color / Stroke Color properties: they
 * exist only once added (`addProperties`), so they are listed in
 * {@link ANIMATOR_OPTIONAL_FIELDS}, not here.
 */
export const ANIMATOR_FIELDS: readonly TextFieldSpec[] = [
  { key: 'trackingType', label: 'Tracking Type', type: 'choice', default: 'after', choices: ['after', 'before', 'beforeAfter'], clearAtDefault: true },
  { key: 'characterRange', label: 'Character Range', type: 'choice', default: 'preserve', choices: ['preserve', 'full'], clearAtDefault: true },
];

/** Optional non-numeric animator properties: present only once added. `default` is what Add ▸ Property stores. */
export const ANIMATOR_OPTIONAL_FIELDS: readonly TextFieldSpec[] = [
  { key: 'color', label: 'Fill Color', type: 'color', default: '#ff3b30' },
  { key: 'strokeColor', label: 'Stroke Color', type: 'color', default: '#ff3b30' },
];

/** Selector fields (under `text/animators/<id>/selectors/<id>/`), per selector kind. */
export const SELECTOR_FIELDS: readonly TextFieldSpec[] = [
  { key: 'kind', label: 'Selector', type: 'choice', default: 'range', choices: ['range', 'wiggly', 'expression'] },
  { key: 'basedOn', label: 'Based On', type: 'choice', default: 'characters', choices: ['characters', 'charactersExcludingSpaces', 'words', 'lines'] },
  { key: 'mode', label: 'Mode', type: 'choice', default: 'add', choices: ['add', 'subtract', 'intersect', 'min', 'max', 'difference'] },
  { key: 'units', label: 'Units', type: 'choice', default: 'percentage', choices: ['percentage', 'index'], kinds: ['range'] },
  { key: 'shape', label: 'Shape', type: 'choice', default: 'square', choices: ['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'], kinds: ['range'] },
  { key: 'randomizeOrder', label: 'Randomize Order', type: 'bool', default: false, kinds: ['range'] },
  { key: 'lockDimensions', label: 'Lock Dimensions', type: 'bool', default: false, kinds: ['wiggly'] },
  { key: 'randomSeed', label: 'Random Seed', type: 'scalar', default: 0, kinds: ['range', 'wiggly'] },
  { key: 'expression', label: 'Amount Expression', type: 'string', default: 'selectorValue', kinds: ['expression'] },
];

/** The keyframeable numeric parameters each selector kind carries (the rest of a switched kind's tracks go). */
export const SELECTOR_KIND_PARAMS: Readonly<Record<string, readonly string[]>> = {
  range: ['start', 'end', 'offset', 'amount', 'smoothness', 'easeHigh', 'easeLow'],
  wiggly: ['maxAmount', 'minAmount', 'wigglesPerSecond', 'correlation', 'temporalPhase', 'spatialPhase'],
  expression: ['amount'],
};

/** The Text component fields a stroke-order write keeps in step: the legacy boolean older readers use. */
export function strokeOverFillFor(order: string): boolean {
  return order === 'stroke-over-fill' || order === 'all-strokes-over-all-fills';
}
