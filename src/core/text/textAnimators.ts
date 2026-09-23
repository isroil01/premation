/**
 * Text ANIMATORS — After Effects–style per-glyph animation.
 *
 * A text layer carries a stack of animator groups. Each group holds:
 *
 *   Animator
 *   ├── Properties   what changes (position, scale, rotation, opacity, fill
 *   │                and stroke colour, stroke width, tracking, line spacing,
 *   │                character offset, blur, skew…) — STATIC values
 *   └── Selectors    which characters it applies to, and how much
 *
 * The properties are static: "affected characters move up 100px". The SELECTOR
 * is what you keyframe — sweep a range selector's Offset across the string and
 * every character passes through its influence in turn, so two keyframes on one
 * property produce a full per-character stagger. See textSelectors.ts, which
 * owns that half and all of its maths.
 *
 * Storage: animator metadata lives as a hidden `__animators` array on the
 * layer's `Text` component (the `__` prefix keeps it out of the generic
 * NodeInspector list). Every numeric parameter is ALSO keyframeable under a
 * stable prop-path — `ta.<i>.<param>` for an animator property, `ta.<i>.s<j>.
 * <param>` for a selector parameter — so they animate through the same
 * reversible command path as x/y/rotation, and buildSnapshot reads them with
 * `av.get(path) ?? staticValue`.
 *
 * Legacy: animators used to hold exactly ONE inlined range selector, whose
 * start/end/offset/wiggleFreq lived directly on the animator. Those prop-paths
 * are still the canonical paths for selector 0 (see `selectorPropPath`), so
 * projects, presets and the AI tool schema written against `ta.0.offset` keep
 * animating without a migration pass.
 *
 * The evaluation ({@link evaluateTextAnimators}) is pure — text plus resolved
 * animators in, per-glyph OFFSETS out. Pixel layout happens in the rasterizer,
 * which has a canvas; this keeps the animator maths fully unit-testable.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { parseExpression, evaluateExpression, defaultAnimation, type NodeAnimSnapshot } from '@motion/animation';
import { clamp01 } from '@utils/lang';
import { splitGraphemes } from './graphemes';
import { mixCssColors } from './cssColor';
import { isAxisTag, MAX_ANIMATED_AXES } from './fontAxes';
import {
  defaultRangeSelector,
  defaultSelector,
  evaluateSelectors,
  setExpressionSelectorCompiler,
  unitPositions,
  type RangeBasedOn,
  type RangeSelectorData,
  type SelectorData,
  type SelectorKind,
  type SelectorShape,
  type UnitMap,
} from './textSelectors';

export {
  unitPositions,
  defaultRangeSelector,
  defaultWigglySelector,
  defaultExpressionSelector,
  defaultSelector,
  rangeSelectorAt,
  wigglySelectorAt,
  shapeFalloff,
  applyEase,
  combineWeights,
  orderPermutation,
} from './textSelectors';
export type {
  RangeBasedOn,
  SelectorShape,
  SelectorUnits,
  SelectorCombineMode,
  SelectorKind,
  SelectorData,
  RangeSelectorData,
  WigglySelectorData,
  ExpressionSelectorData,
} from './textSelectors';

// ── Expression selector compiler (CSP-safe) ─────────────────────────

// `new Function` is refused by the app's script-src, so expression selectors go
// through the same interpreted AST the property expressions use, with a scope
// carrying the per-character names AE exposes.
setExpressionSelectorCompiler((src) => {
  const ast = parseExpression(src);
  return (scope) => {
    const map = new Map<string, unknown>([
      ['textIndex', scope.textIndex],
      ['textTotal', scope.textTotal],
      ['selectorValue', scope.selectorValue],
      ['time', scope.time],
      ['Math', Math],
    ]);
    const v = evaluateExpression(ast, map);
    return typeof v === 'number' ? v : 0;
  };
});

// ── Animator model ──────────────────────────────────────────────────

/**
 * Keyframeable numeric parameters of an animator PROPERTY (not its selectors).
 *
 * `start`/`end`/`offset`/`wiggleFreq` are still listed because they remain the
 * canonical prop-paths for selector 0 — see the legacy note in the file header.
 */
export const ANIMATOR_PARAMS = [
  // Legacy selector-0 aliases.
  'start', 'end', 'offset', 'wiggleFreq',
  // Transform.
  'x', 'y', 'scale', 'scaleY', 'rotation', 'opacity', 'tracking', 'skew',
  // Per-character 3D. Only meaningful on a 3D text layer with "Enable
  // Per-character 3D" — each glyph becomes its own plane, so an animator can
  // push glyphs in Z and tumble them about X/Y. Flat text ignores them.
  'z', 'rotationX', 'rotationY',
  // Paint / typography. `blur` is AE's 2-D animator Blur: the X radius, with
  // `blurY` diverging the Y radius once unlinked (absent = linked/uniform).
  'fillOpacity', 'strokeWidth', 'lineSpacing', 'characterOffset', 'blur', 'blurY',
  // OPTIONAL properties (AE's "Add ▸ Property" menu). Absent from an animator
  // until added, so an animator written before them evaluates — and hashes —
  // exactly as it did. See OPTIONAL_ANIMATOR_PROPERTIES.
  'anchorX', 'anchorY', 'anchorZ', 'skewAxis', 'lineAnchor', 'characterValue',
  'fillHue', 'fillSaturation', 'fillBrightness',
  'strokeOpacity', 'strokeHue', 'strokeSaturation', 'strokeBrightness',
] as const;
export type AnimatorParam = (typeof ANIMATOR_PARAMS)[number];

/** How Character Offset walks: AE's "Character Range". */
export type CharacterRange = 'preserve' | 'full';
/** Where animator tracking is added around each character: AE's "Tracking Type". */
export type TrackingType = 'beforeAfter' | 'before' | 'after';

/**
 * The properties an animator carries only once ADDED — AE's Animate / Add ▸
 * Property menu. `defaultValue` is what a freshly added one holds (its no-op).
 */
export const OPTIONAL_ANIMATOR_PROPERTIES: ReadonlyArray<{
  param: AnimatorParam;
  label: string;
  unit: string;
  defaultValue: number;
  min?: number;
  max?: number;
  step?: number;
  group: 'transform' | 'typography' | 'fill' | 'stroke';
}> = [
  { param: 'anchorX', label: 'Anchor Point X', unit: 'px', defaultValue: 0, group: 'transform' },
  { param: 'anchorY', label: 'Anchor Point Y', unit: 'px', defaultValue: 0, group: 'transform' },
  { param: 'anchorZ', label: 'Anchor Point Z', unit: 'px', defaultValue: 0, group: 'transform' },
  { param: 'skewAxis', label: 'Skew Axis', unit: '°', defaultValue: 0, group: 'transform' },
  { param: 'lineAnchor', label: 'Line Anchor', unit: '%', defaultValue: 0, min: 0, max: 100, group: 'typography' },
  { param: 'characterValue', label: 'Character Value', unit: '', defaultValue: 65, min: 0, max: 0x10ffff, step: 1, group: 'typography' },
  { param: 'fillHue', label: 'Fill Hue', unit: '°', defaultValue: 0, group: 'fill' },
  { param: 'fillSaturation', label: 'Fill Saturation', unit: '%', defaultValue: 0, min: -100, max: 100, group: 'fill' },
  { param: 'fillBrightness', label: 'Fill Brightness', unit: '%', defaultValue: 0, min: -100, max: 100, group: 'fill' },
  { param: 'strokeOpacity', label: 'Stroke Opacity', unit: '%', defaultValue: 100, min: 0, max: 100, group: 'stroke' },
  { param: 'strokeHue', label: 'Stroke Hue', unit: '°', defaultValue: 0, group: 'stroke' },
  { param: 'strokeSaturation', label: 'Stroke Saturation', unit: '%', defaultValue: 0, min: -100, max: 100, group: 'stroke' },
  { param: 'strokeBrightness', label: 'Stroke Brightness', unit: '%', defaultValue: 0, min: -100, max: 100, group: 'stroke' },
];

/** AE's "All Transform Properties": the optional transform properties it adds
 *  (position / scale / skew / rotation / opacity are always present here). */
export const ALL_TRANSFORM_OPTIONAL: ReadonlyArray<AnimatorParam> = ['anchorX', 'anchorY', 'skewAxis'];

/** Prop-path of a Font Axis property: `ta.<i>.axis<TAG>`. */
export function animatorAxisPropPath(index: number, tag: string): string {
  return `ta.${index}.axis${tag}`;
}

/** The tag an animator param names when it is a Font Axis (`axisGRAD`), else null. */
export function axisTagOfParam(param: string): string | null {
  return /^axis[A-Za-z0-9]{4}$/.test(param) ? param.slice(4) : null;
}

/** Keyframeable numeric parameters of a SELECTOR. */
export const SELECTOR_PARAMS = [
  'start', 'end', 'offset', 'amount', 'smoothness', 'easeHigh', 'easeLow',
  'maxAmount', 'minAmount', 'wigglesPerSecond', 'correlation',
  'temporalPhase', 'spatialPhase',
] as const;
export type SelectorParam = (typeof SELECTOR_PARAMS)[number];

/** Prop-path an animator's own numeric parameter animates under. */
export function animatorPropPath(index: number, param: AnimatorParam): string {
  return `ta.${index}.${param}`;
}

/**
 * Prop-path a selector parameter animates under.
 *
 * Selector 0's window parameters keep their legacy flat paths so nothing
 * written against `ta.0.offset` — projects, the preset library, the AI tool
 * schema — silently stops animating.
 */
export function selectorPropPath(
  index: number,
  selectorIndex: number,
  param: SelectorParam,
): string {
  if (selectorIndex === 0) {
    if (param === 'start' || param === 'end' || param === 'offset') {
      return `ta.${index}.${param}`;
    }
    if (param === 'wigglesPerSecond') return `ta.${index}.wiggleFreq`;
  }
  return `ta.${index}.s${selectorIndex}.${param}`;
}

/** Serialized animator metadata (JSON-safe) stored on the Text component. */
export interface TextAnimatorData {
  id: string;
  /** Author-facing name. AE numbers them; a name survives reordering. */
  name?: string;
  /** Off keeps the group in the stack contributing nothing. */
  enabled?: boolean;
  /** The selector stack. Absent on data written before selectors were split
   *  out — `normalizeAnimator` rebuilds one from the legacy flat fields. */
  selectors?: SelectorData[];

  // ── Properties ──
  /** Position offset, comp px. */
  x: number;
  y: number;
  /** Depth offset, comp px (per-character 3D only). */
  z?: number;
  /** Scale, percent (100 = no change). `scaleY` falls back to `scale`. */
  scale: number;
  scaleY?: number;
  /** Rotation offset, degrees. */
  rotation: number;
  /** Tumble about the glyph's own X / Y axis, degrees (per-character 3D only). */
  rotationX?: number;
  rotationY?: number;
  /** Opacity, percent (100 = no change). */
  opacity: number;
  /** Fill opacity, percent — fades the glyph's fill but not its stroke. */
  fillOpacity?: number;
  /** Extra tracking, px. */
  tracking: number;
  /** Extra leading between lines, px. */
  lineSpacing?: number;
  /**
   * Shifts each affected character N places through its alphabet — AE's
   * Character Offset. A staggered offset that rolls back to 0 is the
   * scrambling / decode reveal, and it cannot be faked with transforms.
   */
  characterOffset?: number;
  /** Per-glyph blur, px. AE's animator Blur is 2-D: this is the X radius. */
  blur?: number;
  /** Per-glyph vertical blur, px. ABSENT means linked to `blur` (uniform) —
   *  the pre-2-D scalar shape every older document carries. Present only once
   *  the axes are unlinked, so an untouched animator round-trips byte-identical. */
  blurY?: number;
  /** Skew, degrees (italic-style shear per glyph). */
  skew?: number;
  /** Fill colour the covered glyphs blend toward. */
  color?: string;
  /** Stroke colour and width for the covered glyphs. */
  strokeColor?: string;
  strokeWidth?: number;

  // ── Optional properties (present once added; see OPTIONAL_ANIMATOR_PROPERTIES) ──
  /** Per-character anchor offset, px: the glyph is drawn at −anchor about its
   *  transform origin, as a layer's content sits about its anchor point. */
  anchorX?: number;
  anchorY?: number;
  anchorZ?: number;
  /** Angle of the axis Skew shears along, degrees (0 = horizontal shear). */
  skewAxis?: number;
  /** Where animator tracking pivots within each line, 0–100 %. */
  lineAnchor?: number;
  /** Replace affected characters with this Unicode code point. */
  characterValue?: number;
  /** Character Offset's walk: letters/digits within their own set, or all of Unicode. */
  characterRange?: CharacterRange;
  /** Where Tracking is added. Absent = after (this build's original behaviour). */
  trackingType?: TrackingType;
  /** HSB offsets applied to the base fill / stroke colour. */
  fillHue?: number;
  fillSaturation?: number;
  fillBrightness?: number;
  /** Stroke-only opacity, percent. */
  strokeOpacity?: number;
  strokeHue?: number;
  strokeSaturation?: number;
  strokeBrightness?: number;
  /** Font Axis offsets by tag (AE 26), at most MAX_ANIMATED_AXES per layer. */
  axes?: Record<string, number>;

  // ── Legacy flat selector fields (read for migration, never written) ──
  /** @deprecated moved to `selectors[0].basedOn`. */
  basedOn?: RangeBasedOn;
  /** @deprecated moved to `selectors[0].shape`. */
  shape?: SelectorShape;
  /** @deprecated moved to `selectors[0].start`. */
  start?: number;
  /** @deprecated moved to `selectors[0].end`. */
  end?: number;
  /** @deprecated moved to `selectors[0].offset`. */
  offset?: number;
  /** @deprecated selector kind now lives on the selector itself. */
  mode?: 'range' | 'wiggly';
  /** @deprecated moved to `selectors[0].wigglesPerSecond`. */
  wiggleFreq?: number;
}

/** An animator with every parameter resolved to a concrete number for a frame. */
export interface ResolvedAnimator {
  enabled: boolean;
  selectors: SelectorData[];
  x: number;
  y: number;
  z: number;
  scale: number;
  scaleY: number;
  rotation: number;
  rotationX: number;
  rotationY: number;
  opacity: number;
  fillOpacity: number;
  tracking: number;
  lineSpacing: number;
  characterOffset: number;
  blur: number;
  /** Y blur radius, px. Undefined = linked to `blur` (uniform). */
  blurY?: number;
  skew: number;
  strokeWidth: number;
  color?: string;
  strokeColor?: string;
  // Optional properties — undefined when the animator has not added them.
  anchorX?: number;
  anchorY?: number;
  anchorZ?: number;
  skewAxis?: number;
  lineAnchor?: number;
  characterValue?: number;
  characterRange?: CharacterRange;
  trackingType?: TrackingType;
  fillHue?: number;
  fillSaturation?: number;
  fillBrightness?: number;
  strokeOpacity?: number;
  strokeHue?: number;
  strokeSaturation?: number;
  strokeBrightness?: number;
  axes?: Record<string, number>;
}

/** Per-glyph transform the rasterizer applies when laying out animated text. */
export interface GlyphTransform {
  char: string;
  /** Position offset, comp px. */
  dx: number;
  dy: number;
  /** Depth offset, comp px (per-character 3D only; absent on flat text). */
  dz?: number;
  /** Tumble about the glyph's own X / Y axis, degrees (per-character 3D only). */
  rotationX?: number;
  rotationY?: number;
  /** Scale multipliers (1 = none). */
  scale: number;
  scaleY: number;
  /** Rotation, degrees. */
  rotation: number;
  /** Opacity multiplier, 0..1. */
  opacity: number;
  /** Fill-only opacity multiplier, 0..1 — the stroke stays put. */
  fillOpacity: number;
  /** Extra advance width, px. */
  tracking: number;
  /** Extra leading for the line this glyph sits on, px. */
  lineSpacing: number;
  /** Blur radius, px — the X radius of AE's 2-D animator Blur. */
  blur: number;
  /** Y blur radius, px. Set ONLY when it diverges from `blur`, so a uniform
   *  blur's glyph list — and every cache key hashed from it — is unchanged. */
  blurY?: number;
  /** Shear, degrees (applied as a horizontal skew per glyph). */
  skew: number;
  /** Colour to blend toward, with `colorMix` as the blend amount. */
  color?: string;
  colorMix?: number;
  /** Stroke to paint under/over the glyph. Applies to the layer's own stroke
   *  too, whenever the layer has one — not only when the animator adds width. */
  strokeColor?: string;
  /** How far toward `strokeColor` the stroke is blended (selector amount). */
  strokeColorMix?: number;
  strokeWidth: number;
  /** The character actually drawn, after Character Offset walked it through
   *  its alphabet. Equals `char` when no animator offsets it. */
  displayChar: string;

  // ── Optional (set only when an animator adds the property, so an existing
  //    document's glyph list — and the cache key built from it — is unchanged) ──
  /** Anchor offset, px: drawn at −anchor in the glyph's transformed frame. */
  anchorX?: number;
  anchorY?: number;
  /** Depth anchor, px — per-character 3D only (perChar3D.ts pivots about it). */
  anchorZ?: number;
  /** Skew axis, degrees. */
  skewAxis?: number;
  /** Line Anchor, 0..1 — where this line's animator tracking pivots. */
  lineAnchor?: number;
  /** Px of this glyph's animator tracking that sits BEFORE it (Tracking Type). */
  trackingBefore?: number;
  /** HSB offsets on the fill (degrees, %, %). */
  fillHue?: number;
  fillSaturation?: number;
  fillBrightness?: number;
  /** Stroke-only opacity multiplier, 0..1. */
  strokeOpacity?: number;
  strokeHue?: number;
  strokeSaturation?: number;
  strokeBrightness?: number;
  /** Font Axis offsets by tag. */
  axes?: Record<string, number>;
}

/** An identity glyph transform — every field at its no-op value. Callers that
 *  build a transform by hand (tests, the per-character 3D splitter) start here
 *  so a field added later cannot silently arrive as `undefined`. */
export function identityGlyphTransform(
  char: string,
  patch: Partial<GlyphTransform> = {},
): GlyphTransform {
  return {
    char,
    displayChar: char,
    dx: 0,
    dy: 0,
    scale: 1,
    scaleY: 1,
    rotation: 0,
    opacity: 1,
    fillOpacity: 1,
    tracking: 0,
    lineSpacing: 0,
    blur: 0,
    skew: 0,
    strokeWidth: 0,
    ...patch,
  };
}

/** A fresh animator that covers the whole string and does nothing until edited. */
export function defaultAnimator(): TextAnimatorData {
  return {
    id: `anim_${Math.random().toString(36).slice(2, 9)}`,
    enabled: true,
    selectors: [defaultRangeSelector()],
    x: 0,
    y: 0,
    z: 0,
    scale: 100,
    scaleY: 100,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    opacity: 100,
    fillOpacity: 100,
    tracking: 0,
    lineSpacing: 0,
    characterOffset: 0,
    blur: 0,
    skew: 0,
    strokeWidth: 0,
  };
}

/**
 * Fill in everything a stored animator may be missing, including rebuilding a
 * selector stack from the legacy inline fields.
 *
 * Every read goes through here so an old document and a new one are the same
 * shape by the time anything looks at them — relying on a single migration
 * point at load is how a stale shape ends up rendering wrong somewhere else.
 */
export function normalizeAnimator(d: TextAnimatorData): TextAnimatorData {
  const selectors: SelectorData[] =
    Array.isArray(d.selectors) && d.selectors.length > 0
      ? d.selectors.map(normalizeSelector)
      : [legacySelector(d)];
  return {
    ...d,
    enabled: d.enabled !== false,
    selectors,
    x: d.x ?? 0,
    y: d.y ?? 0,
    z: d.z ?? 0,
    scale: d.scale ?? 100,
    scaleY: d.scaleY ?? d.scale ?? 100,
    rotation: d.rotation ?? 0,
    rotationX: d.rotationX ?? 0,
    rotationY: d.rotationY ?? 0,
    opacity: d.opacity ?? 100,
    fillOpacity: d.fillOpacity ?? 100,
    tracking: d.tracking ?? 0,
    lineSpacing: d.lineSpacing ?? 0,
    characterOffset: d.characterOffset ?? 0,
    blur: d.blur ?? 0,
    skew: d.skew ?? 0,
    strokeWidth: d.strokeWidth ?? 0,
  };
}

/** Rebuild the single inline selector an old animator carried. */
function legacySelector(d: TextAnimatorData): SelectorData {
  if (d.mode === 'wiggly') {
    return {
      ...defaultSelector('wiggly'),
      id: `${d.id}_s0`,
      basedOn: d.basedOn ?? 'characters',
      wigglesPerSecond: d.wiggleFreq ?? 2,
      // The old wiggly multiplied the range weight; `intersect` is that.
      mode: 'intersect',
    } as SelectorData;
  }
  const base = defaultRangeSelector();
  return {
    ...base,
    id: `${d.id}_s0`,
    basedOn: d.basedOn ?? 'characters',
    shape: d.shape ?? 'square',
    start: d.start ?? 0,
    end: d.end ?? 100,
    offset: d.offset ?? 0,
    // The old range selector had a hard window with no edge softening; keeping
    // smoothness at 0 means an existing project looks exactly as it did.
    smoothness: 0,
  };
}

function normalizeSelector(s: SelectorData): SelectorData {
  const kind: SelectorKind = s.kind ?? 'range';
  const base = defaultSelector(kind);
  return { ...base, ...s, kind } as SelectorData;
}

// ── Evaluation ──────────────────────────────────────────────────────


/** Ranges Character Offset walks through. A digit rolls within digits, a letter
 *  within its own case — offsetting 'Z' by 1 must not produce '['. */
const ALPHABETS: ReadonlyArray<readonly [number, number]> = [
  [0x30, 0x39], // 0-9
  [0x41, 0x5a], // A-Z
  [0x61, 0x7a], // a-z
];

/** Shift a character `n` places through its alphabet, wrapping. Characters in
 *  no alphabet (punctuation, spaces, CJK) are left alone. */
export function offsetCharacter(ch: string, n: number): string {
  if (!n) return ch;
  // A grapheme cluster ('é' as e + U+0301, an emoji sequence) is not a letter
  // in any alphabet we walk — rebuilding it from its first code point would
  // silently drop the rest of the cluster.
  if ([...ch].length !== 1) return ch;
  const code = ch.codePointAt(0);
  if (code === undefined) return ch;
  for (const [lo, hi] of ALPHABETS) {
    if (code >= lo && code <= hi) {
      const span = hi - lo + 1;
      const shifted = (((code - lo + Math.round(n)) % span) + span) % span;
      return String.fromCodePoint(lo + shifted);
    }
  }
  return ch;
}

/**
 * Character Range "Full Unicode": shift the code point itself by `n`, stepping
 * over the surrogate block (not characters) and staying within printable
 * space (U+0020..U+10FFFF). Multi-code-point clusters are left alone, as in
 * {@link offsetCharacter}.
 */
export function offsetCharacterFull(ch: string, n: number): string {
  const k = Math.round(n);
  if (!k || [...ch].length !== 1) return ch;
  const code = ch.codePointAt(0);
  if (code === undefined) return ch;
  let c = code + k;
  if (c >= 0xd800 && c <= 0xdfff) c += k > 0 ? 0x800 : -0x800;
  c = Math.max(0x20, Math.min(0x10ffff, c));
  return String.fromCodePoint(c);
}

/** Character Value: the code point as a drawable character (clamped, surrogates refused). */
export function characterFromValue(value: number): string | null {
  const c = Math.round(value);
  if (!Number.isFinite(c) || c < 0x20 || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return null;
  return String.fromCodePoint(c);
}

/**
 * Evaluate the animator stack into per-glyph transforms.
 *
 * Pure: same text, animators and time always yields the same result. Multiple
 * animators accumulate — position / rotation / tracking / skew / blur add,
 * scale and the opacities multiply — which is how you stack a position stagger
 * and a colour sweep on different schedules over one string.
 */
export function evaluateTextAnimators(
  text: string,
  animators: readonly ResolvedAnimator[],
  time = 0,
): GlyphTransform[] {
  // Grapheme clusters — the index space runs, selectors and layout share.
  const chars = splitGraphemes(text);
  const glyphs: GlyphTransform[] = chars.map((ch) => identityGlyphTransform(ch));

  // One unit map per basedOn per string, shared across every selector that
  // asks for it — recomputing it per glyph is an O(n²) walk of the string.
  const unitCache = new Map<RangeBasedOn, UnitMap>();
  const unitsFor = (basedOn: RangeBasedOn): UnitMap => {
    let hit = unitCache.get(basedOn);
    if (!hit) {
      hit = unitPositions(text, basedOn);
      unitCache.set(basedOn, hit);
    }
    return hit;
  };

  // Character Offset accumulates as a number and is applied ONCE at the end —
  // walking the alphabet twice for two animators would compound the wrap.
  const charShift = new Array<number>(chars.length).fill(0);
  // Character Value replaces (last affecting animator wins); Character Range
  // decides how the accumulated offset then walks.
  const charValue = new Array<number | undefined>(chars.length);
  const charRange = new Array<CharacterRange | undefined>(chars.length);

  for (const a of animators) {
    if (!a.enabled) continue;
    for (let i = 0; i < chars.length; i++) {
      // Line Anchor is a property of the LINE, not a per-character amount: it
      // says where tracking pivots, so it applies whatever the selector says.
      if (a.lineAnchor !== undefined) glyphs[i]!.lineAnchor = clamp01(a.lineAnchor / 100);
      const w = evaluateSelectors(a.selectors, i, unitsFor, time);
      if (w.x <= 0 && w.y <= 0) continue;
      const g = glyphs[i]!;
      applyOptionalProperties(g, a, w.x, w.y);
      if (a.characterValue !== undefined && w.x >= 0.5) charValue[i] = a.characterValue;
      if (a.characterRange && a.characterOffset) charRange[i] = a.characterRange;
      g.dx += a.x * w.x;
      g.dy += a.y * w.y;
      if (a.z) g.dz = (g.dz ?? 0) + a.z * w.x;
      if (a.rotationX) g.rotationX = (g.rotationX ?? 0) + a.rotationX * w.x;
      if (a.rotationY) g.rotationY = (g.rotationY ?? 0) + a.rotationY * w.y;
      g.rotation += a.rotation * w.x;
      g.tracking += a.tracking * w.x;
      g.lineSpacing += a.lineSpacing * w.y;
      g.skew += a.skew * w.x;
      // 2-D blur. The Y radius exists only once an animator unlinks it
      // (a.blurY defined and different) — a scalar-blur stack keeps the
      // single field, so an existing document's glyph list is field-for-field
      // what it always was. Once diverged, every animator feeds Y through the
      // selector's Y weight, the axis rule position and scale follow.
      {
        const aBlurY = a.blurY ?? a.blur;
        if (aBlurY !== a.blur || g.blurY !== undefined) {
          g.blurY = (g.blurY ?? g.blur) + aBlurY * w.y;
        }
      }
      g.blur += a.blur * w.x;
      g.strokeWidth += a.strokeWidth * w.x;
      charShift[i] = (charShift[i] ?? 0) + a.characterOffset * w.x;
      g.scale *= 1 + (a.scale / 100 - 1) * w.x; // lerp(1, scale/100, w)
      g.scaleY *= 1 + (a.scaleY / 100 - 1) * w.y;
      g.opacity *= 1 + (a.opacity / 100 - 1) * w.x;
      g.fillOpacity *= 1 + (a.fillOpacity / 100 - 1) * w.x;
      if (a.color) {
        g.color = a.color;
        g.colorMix = Math.max(g.colorMix ?? 0, clamp01(w.x));
      }
      if (a.strokeColor) {
        g.strokeColor = a.strokeColor;
        g.strokeColorMix = Math.max(g.strokeColorMix ?? 0, clamp01(w.x));
      }
    }
  }

  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]!;
    // Value first, then the offset walks from the replaced character — AE's
    // order, so a Character Value + Character Offset pair counts up from it.
    const replaced = charValue[i] !== undefined ? characterFromValue(charValue[i]!) : null;
    const from = replaced ?? g.char;
    const shift = Math.round(charShift[i] ?? 0);
    const walked = shift ? (charRange[i] === 'full' ? offsetCharacterFull(from, shift) : offsetCharacter(from, shift)) : from;
    if (walked !== g.char) g.displayChar = walked;
  }
  return glyphs;
}

/**
 * The optional properties' per-glyph maths. Every field is touched only when
 * the animator carries the property, so a glyph list from an animator that
 * predates them is identical — field for field — to what it always was.
 */
function applyOptionalProperties(g: GlyphTransform, a: ResolvedAnimator, wx: number, wy: number): void {
  const add = (key: 'anchorX' | 'anchorY' | 'anchorZ' | 'skewAxis' | 'fillHue' | 'fillSaturation' | 'fillBrightness' | 'strokeHue' | 'strokeSaturation' | 'strokeBrightness', v: number | undefined, w: number): void => {
    if (v === undefined || !v) return;
    g[key] = (g[key] ?? 0) + v * w;
  };
  add('anchorX', a.anchorX, wx);
  add('anchorY', a.anchorY, wy);
  add('anchorZ', a.anchorZ, wx);
  add('skewAxis', a.skewAxis, wx);
  add('fillHue', a.fillHue, wx);
  add('fillSaturation', a.fillSaturation, wx);
  add('fillBrightness', a.fillBrightness, wx);
  add('strokeHue', a.strokeHue, wx);
  add('strokeSaturation', a.strokeSaturation, wx);
  add('strokeBrightness', a.strokeBrightness, wx);
  if (a.strokeOpacity !== undefined && a.strokeOpacity !== 100) {
    g.strokeOpacity = (g.strokeOpacity ?? 1) * (1 + (a.strokeOpacity / 100 - 1) * wx);
  }
  // Tracking Type: the advance always grows by the full amount (tracking is
  // accumulated by the caller); what changes is how much of it sits in FRONT.
  if (a.tracking && (a.trackingType === 'before' || a.trackingType === 'beforeAfter')) {
    const t = a.tracking * wx;
    g.trackingBefore = (g.trackingBefore ?? 0) + (a.trackingType === 'before' ? t : t / 2);
  }
  if (a.axes) {
    for (const [tag, v] of Object.entries(a.axes)) {
      if (!isAxisTag(tag) || !Number.isFinite(v) || !v) continue;
      g.axes = { ...(g.axes ?? {}), [tag]: (g.axes?.[tag] ?? 0) + v * wx };
    }
  }
}

// ── Scene integration ───────────────────────────────────────────────

interface CompRef {
  id: string;
  props: Record<string, unknown>;
}

function textComponent(node: SceneNode): CompRef | undefined {
  return node.components.find((c) => c.type === 'Text') as CompRef | undefined;
}

/** True when the node is a text layer (has a Text component). */
export function hasTextComponent(node: SceneNode): boolean {
  return textComponent(node) !== undefined;
}

/** Read the stored animator metadata for a node, normalized (empty when none). */
export function readAnimatorData(node: SceneNode): TextAnimatorData[] {
  const t = textComponent(node);
  const raw = t?.props.__animators;
  if (!Array.isArray(raw)) return [];
  return (raw as TextAnimatorData[]).map(normalizeAnimator);
}

/**
 * Resolve a node's animators for a frame, overriding each static parameter with
 * its sampled animated value when a track exists. `av` is the node's evaluated
 * value map from the animation engine (prop-path → number).
 */
export function resolveAnimators(
  node: SceneNode,
  av: Map<string, number> | undefined,
): ResolvedAnimator[] {
  const data = readAnimatorData(node);
  return data.map((d, i) => {
    const val = (param: AnimatorParam, fallback: number): number =>
      av?.get(animatorPropPath(i, param)) ?? fallback;
    // An optional property resolves only when the animator carries it — a
    // leftover track for a removed property must not resurrect it.
    const opt = (param: AnimatorParam, v: number | undefined): Partial<ResolvedAnimator> =>
      v === undefined ? {} : { [param]: val(param, v) };
    const axes = d.axes
      ? Object.fromEntries(
          Object.entries(d.axes)
            .filter(([tag, v]) => isAxisTag(tag) && typeof v === 'number')
            .map(([tag, v]) => [tag, av?.get(animatorAxisPropPath(i, tag)) ?? v]),
        )
      : undefined;
    return {
      ...opt('anchorX', d.anchorX),
      ...opt('anchorY', d.anchorY),
      ...opt('anchorZ', d.anchorZ),
      ...opt('skewAxis', d.skewAxis),
      ...opt('lineAnchor', d.lineAnchor),
      ...opt('characterValue', d.characterValue),
      ...opt('fillHue', d.fillHue),
      ...opt('fillSaturation', d.fillSaturation),
      ...opt('fillBrightness', d.fillBrightness),
      ...opt('strokeOpacity', d.strokeOpacity),
      ...opt('strokeHue', d.strokeHue),
      ...opt('strokeSaturation', d.strokeSaturation),
      ...opt('strokeBrightness', d.strokeBrightness),
      ...(d.characterRange ? { characterRange: d.characterRange } : {}),
      ...(d.trackingType ? { trackingType: d.trackingType } : {}),
      ...(axes && Object.keys(axes).length > 0 ? { axes } : {}),
      enabled: d.enabled !== false,
      selectors: (d.selectors ?? []).map((s, j) => resolveSelector(s, i, j, av)),
      x: val('x', d.x),
      y: val('y', d.y),
      z: val('z', d.z ?? 0),
      scale: val('scale', d.scale),
      scaleY: val('scaleY', d.scaleY ?? d.scale),
      rotation: val('rotation', d.rotation),
      rotationX: val('rotationX', d.rotationX ?? 0),
      rotationY: val('rotationY', d.rotationY ?? 0),
      opacity: val('opacity', d.opacity),
      fillOpacity: val('fillOpacity', d.fillOpacity ?? 100),
      tracking: val('tracking', d.tracking),
      lineSpacing: val('lineSpacing', d.lineSpacing ?? 0),
      characterOffset: val('characterOffset', d.characterOffset ?? 0),
      blur: val('blur', d.blur ?? 0),
      // Resolved only when the animator stores its own Y radius or a track
      // drives one — otherwise it stays linked (undefined), the legacy shape.
      ...(d.blurY !== undefined || av?.get(animatorPropPath(i, 'blurY')) !== undefined
        ? { blurY: val('blurY', d.blurY ?? d.blur ?? 0) }
        : {}),
      skew: val('skew', d.skew ?? 0),
      strokeWidth: val('strokeWidth', d.strokeWidth ?? 0),
      color: d.color,
      strokeColor: d.strokeColor,
    };
  });
}

/** Override a selector's numeric parameters with their sampled tracks. */
function resolveSelector(
  s: SelectorData,
  animIndex: number,
  selIndex: number,
  av: Map<string, number> | undefined,
): SelectorData {
  if (!av || av.size === 0) return s;
  const out: Record<string, unknown> = { ...s };
  for (const param of SELECTOR_PARAMS) {
    if (!(param in out)) continue;
    const v = av.get(selectorPropPath(animIndex, selIndex, param));
    if (v !== undefined) out[param] = v;
  }
  return out as unknown as SelectorData;
}

/** Replace a layer's whole animator stack. Public because applying a preset
 *  installs a serialized rig wholesale rather than one field at a time. */
export function writeAnimatorData(nodeId: string, animators: TextAnimatorData[]): void {
  writeAnimators(nodeId, animators.map(normalizeAnimator));
}

function writeAnimators(nodeId: string, animators: TextAnimatorData[]): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? textComponent(node) : undefined;
  if (!node || !t) return;
  // Persist through the graph so the rebuilt plain-view keeps the value.
  defaultSceneGraph.writeProp(nodeId, t.id, '__animators', animators);
  bumpScene();
}

/** Add a fresh animator group to a text layer. Returns its index, or -1. */
export function addTextAnimator(nodeId: string): number {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return -1;
  const next = [...readAnimatorData(node), defaultAnimator()];
  writeAnimators(nodeId, next);
  return next.length - 1;
}

/** Remove the animator at `index`. */
export function removeTextAnimator(nodeId: string, index: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const count = readAnimatorData(node).length;
  if (index < 0 || index >= count) return;
  // The animator's tracks go with it and every later animator's tracks move
  // down one slot (ENGINE_API.md §2.5 #8). Tracks are addressed by INDEX
  // (`ta.<i>.…`), so without this, removing animator 0 handed its keyframes to
  // the animator that slid into slot 0.
  rekeyTextAnimatorTracks(nodeId, (i) => (i === index ? null : i > index ? i - 1 : i));
  writeAnimators(nodeId, readAnimatorData(node).filter((_, i) => i !== index));
}

/** A `ta.*` track name, decomposed. `sel` null = an animator's own param. */
interface AnimatorTrackRef {
  anim: number;
  sel: number | null;
  param: string;
}

const LEGACY_SELECTOR0: Readonly<Record<string, string>> = {
  start: 'start', end: 'end', offset: 'offset', wiggleFreq: 'wigglesPerSecond',
};

/** Parse `ta.<i>.<param>` / `ta.<i>.s<j>.<param>` (selector-0 legacy aliases included). */
export function parseAnimatorTrack(prop: string): AnimatorTrackRef | null {
  const sel = /^ta\.(\d+)\.s(\d+)\.(.+)$/.exec(prop);
  if (sel) return { anim: Number(sel[1]), sel: Number(sel[2]), param: sel[3]! };
  const own = /^ta\.(\d+)\.(.+)$/.exec(prop);
  if (!own) return null;
  const param = own[2]!;
  const legacy = LEGACY_SELECTOR0[param];
  if (legacy) return { anim: Number(own[1]), sel: 0, param: legacy };
  return { anim: Number(own[1]), sel: null, param };
}

/** The track name for a decomposed ref — the inverse of {@link parseAnimatorTrack}. */
export function animatorTrackName(ref: AnimatorTrackRef): string {
  if (ref.sel === null) return `ta.${ref.anim}.${ref.param}`;
  return selectorPropPath(ref.anim, ref.sel, ref.param as SelectorParam);
}

/**
 * Move every `ta.*` track, expression and data track of a text layer to the
 * slots `mapAnim` / `mapSel` give (null = drop it). The one place the index
 * addressing is kept consistent when animators or selectors are removed or
 * reordered — the engine API addresses them by id and relies on it.
 */
export function rekeyTextAnimatorTracks(
  nodeId: string,
  mapAnim: (index: number) => number | null,
  mapSel?: (animIndex: number, selIndex: number) => number | null,
): void {
  const snap = defaultAnimation.snapshotNode(nodeId);
  if (!snap) return;
  let changed = false;
  const remap = <V>(section: Record<string, V>): Record<string, V> => {
    const out: Record<string, V> = {};
    for (const [prop, v] of Object.entries(section)) {
      const ref = parseAnimatorTrack(prop);
      if (!ref) { out[prop] = v; continue; }
      const anim = mapAnim(ref.anim);
      const sel = ref.sel === null ? null : mapSel ? mapSel(ref.anim, ref.sel) : ref.sel;
      if (anim === null || (ref.sel !== null && sel === null)) { changed = true; continue; }
      const name = animatorTrackName({ anim, sel, param: ref.param });
      if (name !== prop) changed = true;
      out[name] = v;
    }
    return out;
  };
  const next: NodeAnimSnapshot = {
    tracks: remap(snap.tracks),
    expressions: remap(snap.expressions),
    data: Object.fromEntries(
      Object.entries(remap(snap.data)).map(([prop, t]) => [prop, { ...t, prop }]),
    ),
  };
  if (changed) defaultAnimation.restoreNode(nodeId, next);
}

/** Patch fields of the animator at `index` (static base values). */
export function updateAnimator(
  nodeId: string,
  index: number,
  patch: Partial<TextAnimatorData>,
): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const data = readAnimatorData(node);
  const cur = data[index];
  if (!cur) return;
  const next = data.slice();
  next[index] = normalizeAnimator({ ...cur, ...patch });
  writeAnimators(nodeId, next);
}

/** Add optional properties (at their no-op defaults) to the animator at `index`.
 *  Already-present ones keep their value. */
export function addAnimatorProperties(nodeId: string, index: number, params: ReadonlyArray<AnimatorParam>): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const cur = node ? readAnimatorData(node)[index] : undefined;
  if (!cur) return;
  const patch: Record<string, number> = {};
  for (const p of params) {
    const spec = OPTIONAL_ANIMATOR_PROPERTIES.find((o) => o.param === p);
    if (spec && (cur as unknown as Record<string, unknown>)[p] === undefined) patch[p] = spec.defaultValue;
  }
  if (Object.keys(patch).length > 0) updateAnimator(nodeId, index, patch as Partial<TextAnimatorData>);
}

/** Remove an optional property (or a Font Axis, by `axis<TAG>`) from an animator. */
export function removeAnimatorProperty(nodeId: string, index: number, param: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const data = readAnimatorData(node);
  const cur = data[index];
  if (!cur) return;
  const next = { ...cur } as unknown as Record<string, unknown>;
  const tag = axisTagOfParam(param);
  if (tag) {
    const axes = { ...(cur.axes ?? {}) };
    delete axes[tag];
    next.axes = Object.keys(axes).length > 0 ? axes : undefined;
  } else {
    delete next[param];
  }
  const all = data.slice();
  all[index] = normalizeAnimator(next as unknown as TextAnimatorData);
  writeAnimators(nodeId, all);
}

/** Add a Font Axis property. Refused past MAX_ANIMATED_AXES distinct tags on
 *  the LAYER (AE's limit is per layer, across all of its animators). */
export function addAnimatorAxis(nodeId: string, index: number, tag: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !isAxisTag(tag)) return false;
  const data = readAnimatorData(node);
  const cur = data[index];
  if (!cur) return false;
  const used = new Set(data.flatMap((a) => Object.keys(a.axes ?? {})));
  if (!used.has(tag) && used.size >= MAX_ANIMATED_AXES) return false;
  if (cur.axes && tag in cur.axes) return true;
  updateAnimator(nodeId, index, { axes: { ...(cur.axes ?? {}), [tag]: 0 } });
  return true;
}

/** Append a selector of `kind` to the animator at `index`. */
export function addSelector(
  nodeId: string,
  index: number,
  kind: SelectorKind = 'range',
): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const cur = readAnimatorData(node)[index];
  if (!cur) return;
  updateAnimator(nodeId, index, {
    selectors: [...(cur.selectors ?? []), defaultSelector(kind)],
  });
}

/** Remove the selector at `selectorIndex`. The last one cannot be removed —
 *  an animator with no selector affects nothing and reads as broken. */
export function removeSelector(
  nodeId: string,
  index: number,
  selectorIndex: number,
): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const cur = readAnimatorData(node)[index];
  if (!cur || (cur.selectors?.length ?? 0) <= 1) return;
  if (selectorIndex < 0 || selectorIndex >= cur.selectors!.length) return;
  // Same index-addressing hazard as removeTextAnimator: move later selectors'
  // tracks down a slot and drop the removed one's.
  rekeyTextAnimatorTracks(nodeId, (i) => i, (a, s) =>
    a !== index ? s : s === selectorIndex ? null : s > selectorIndex ? s - 1 : s);
  updateAnimator(nodeId, index, {
    selectors: cur.selectors!.filter((_, j) => j !== selectorIndex),
  });
}

/** Patch one selector. Changing `kind` rebuilds it from that kind's defaults,
 *  keeping only what both kinds share. */
export function updateSelector(
  nodeId: string,
  index: number,
  selectorIndex: number,
  patch: Partial<RangeSelectorData> & Record<string, unknown>,
): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const cur = readAnimatorData(node)[index];
  const sel = cur?.selectors?.[selectorIndex];
  if (!cur || !sel) return;
  let next: SelectorData;
  if (patch.kind && patch.kind !== sel.kind) {
    const fresh = defaultSelector(patch.kind as SelectorKind);
    next = {
      ...fresh,
      id: sel.id,
      basedOn: sel.basedOn,
      mode: sel.mode,
      enabled: sel.enabled,
      ...patch,
    } as SelectorData;
  } else {
    next = { ...sel, ...patch } as SelectorData;
  }
  const selectors = cur.selectors!.slice();
  selectors[selectorIndex] = next;
  updateAnimator(nodeId, index, { selectors });
}

/**
 * Blend two colours by `mix` (0 = a, 1 = b).
 *
 * Accepts any CSS colour `cssColor.ts` understands (hex of every length,
 * rgb()/rgba(), `var(--token)`, named colours) and NEVER returns a string the
 * canvas cannot parse: this used to hand `'var(--color-primary)'` straight to
 * `fillStyle`, which Canvas2D silently ignores — the glyph then painted in
 * whatever colour the previous glyph left behind. An unreadable target keeps
 * the base colour; an unreadable base takes the target.
 */
export function mixHex(a: string | undefined, b: string, mix: number): string {
  return mixCssColors(a, b, mix);
}
