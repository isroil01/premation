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
import { parseExpression, evaluateExpression } from '@motion/animation';
import { clamp01 } from '@utils/lang';
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
  // Paint / typography.
  'fillOpacity', 'strokeWidth', 'lineSpacing', 'characterOffset', 'blur',
] as const;
export type AnimatorParam = (typeof ANIMATOR_PARAMS)[number];

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
  /** Per-glyph blur, px. */
  blur?: number;
  /** Skew, degrees (italic-style shear per glyph). */
  skew?: number;
  /** Fill colour the covered glyphs blend toward. */
  color?: string;
  /** Stroke colour and width for the covered glyphs. */
  strokeColor?: string;
  strokeWidth?: number;

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
  skew: number;
  strokeWidth: number;
  color?: string;
  strokeColor?: string;
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
  /** Blur radius, px. */
  blur: number;
  /** Shear, degrees (applied as a horizontal skew per glyph). */
  skew: number;
  /** Colour to blend toward, with `colorMix` as the blend amount. */
  color?: string;
  colorMix?: number;
  /** Stroke to paint under/over the glyph. */
  strokeColor?: string;
  strokeWidth: number;
  /** The character actually drawn, after Character Offset walked it through
   *  its alphabet. Equals `char` when no animator offsets it. */
  displayChar: string;
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
  const chars = [...text];
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

  for (const a of animators) {
    if (!a.enabled) continue;
    for (let i = 0; i < chars.length; i++) {
      const w = evaluateSelectors(a.selectors, i, unitsFor, time);
      if (w.x <= 0 && w.y <= 0) continue;
      const g = glyphs[i]!;
      g.dx += a.x * w.x;
      g.dy += a.y * w.y;
      if (a.z) g.dz = (g.dz ?? 0) + a.z * w.x;
      if (a.rotationX) g.rotationX = (g.rotationX ?? 0) + a.rotationX * w.x;
      if (a.rotationY) g.rotationY = (g.rotationY ?? 0) + a.rotationY * w.y;
      g.rotation += a.rotation * w.x;
      g.tracking += a.tracking * w.x;
      g.lineSpacing += a.lineSpacing * w.y;
      g.skew += a.skew * w.x;
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
      if (a.strokeColor) g.strokeColor = a.strokeColor;
    }
  }

  for (let i = 0; i < glyphs.length; i++) {
    const shift = Math.round(charShift[i] ?? 0);
    if (shift) glyphs[i]!.displayChar = offsetCharacter(glyphs[i]!.char, shift);
  }
  return glyphs;
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
    return {
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
  writeAnimators(nodeId, readAnimatorData(node).filter((_, i) => i !== index));
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

/** Blend two `#rrggbb` colours by `mix` (0 = a, 1 = b). Falls back to `b`. */
export function mixHex(a: string | undefined, b: string, mix: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return b;
  const m = clamp01(mix);
  const ch = (x: number, y: number): number => Math.round(x + (y - x) * m);
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${hex(ch(pa[0], pb[0]))}${hex(ch(pa[1], pb[1]))}${hex(ch(pa[2], pb[2]))}`;
}

function parseHex(c: string | undefined): [number, number, number] | null {
  if (!c) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
