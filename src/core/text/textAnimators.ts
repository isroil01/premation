/**
 * Text animators (MG Phase D) — After Effects–style per-glyph animation.
 *
 * A text layer can carry one or more ANIMATOR GROUPS. Each group has a RANGE
 * SELECTOR (which characters / words / lines it covers, and with what falloff
 * shape) and a set of TRANSFORM OFFSETS (position, scale, rotation, opacity,
 * tracking, colour) applied to the covered glyphs, weighted by the selector.
 *
 * Storage: the group metadata lives as a hidden `__animators` array on the
 * layer's `Text` component (the `__` prefix keeps it out of the generic
 * NodeInspector list). Each numeric parameter is also keyframeable under a
 * stable prop-path `ta.<index>.<param>` — the animation engine keys tracks by
 * (nodeId, propPath), so these animate through the exact same reversible
 * command path (Prompt 2) as x/y/rotation. buildSnapshot reads an animated
 * value with `av.get(path) ?? staticValue`.
 *
 * The evaluation ({@link evaluateTextAnimators}) is a pure function of the text
 * plus the resolved (already-sampled) animators — it produces per-glyph OFFSETS
 * only. Pixel-level layout/measuring happens in the render backend, which has a
 * canvas context. This keeps the animator math fully unit-testable.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

export type RangeBasedOn = 'characters' | 'words' | 'lines';
export type SelectorShape = 'square' | 'rampUp' | 'rampDown' | 'triangle' | 'round' | 'smooth';

/** The numeric parameters of an animator, each keyframeable by prop-path. */
export const ANIMATOR_PARAMS = [
  'start', 'end', 'offset', 'x', 'y', 'scale', 'rotation', 'opacity', 'tracking',
] as const;
export type AnimatorParam = (typeof ANIMATOR_PARAMS)[number];

/** Prop-path an animator's numeric parameter animates under. */
export function animatorPropPath(index: number, param: AnimatorParam): string {
  return `ta.${index}.${param}`;
}

/** Serialized animator metadata (JSON-safe) stored on the Text component. */
export interface TextAnimatorData {
  id: string;
  basedOn: RangeBasedOn;
  shape: SelectorShape;
  /** Selector window, percent 0..100. */
  start: number;
  end: number;
  /** Window shift, percent -100..100. */
  offset: number;
  /** Position offset, comp px. */
  x: number;
  y: number;
  /** Scale, percent (100 = no change). */
  scale: number;
  /** Rotation offset, degrees. */
  rotation: number;
  /** Opacity, percent (100 = no change). */
  opacity: number;
  /** Extra tracking, px. */
  tracking: number;
  /** Optional fill colour the covered glyphs blend toward. */
  color?: string;
}

/** An animator with every parameter resolved to a concrete number for a frame. */
export interface ResolvedAnimator {
  basedOn: RangeBasedOn;
  shape: SelectorShape;
  start: number;
  end: number;
  offset: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  tracking: number;
  color?: string;
}

/** Per-glyph transform the renderer applies when laying out animated text. */
export interface GlyphTransform {
  char: string;
  /** Position offset, comp px. */
  dx: number;
  dy: number;
  /** Scale multiplier (1 = none). */
  scale: number;
  /** Rotation, degrees. */
  rotation: number;
  /** Opacity multiplier, 0..1. */
  opacity: number;
  /** Extra advance width, px. */
  tracking: number;
  /** Colour to blend toward, with `colorMix` as the blend amount. */
  color?: string;
  colorMix?: number;
}

/** A fresh animator that covers the whole string and does nothing until edited. */
export function defaultAnimator(): TextAnimatorData {
  return {
    id: `anim_${Math.random().toString(36).slice(2, 9)}`,
    basedOn: 'characters',
    shape: 'square',
    start: 0,
    end: 100,
    offset: 0,
    x: 0,
    y: 0,
    scale: 100,
    rotation: 0,
    opacity: 100,
    tracking: 0,
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Selector coverage weight in [0,1] for a unit at normalized position `u`
 * (0..1) given the window [start,end] (+offset) and falloff `shape`. Influence
 * is confined to the window; outside it the weight is 0.
 */
export function rangeSelectorWeight(
  u: number,
  start: number,
  end: number,
  offset: number,
  shape: SelectorShape,
): number {
  const lo = Math.min(start + offset, end + offset) / 100;
  const hi = Math.max(start + offset, end + offset) / 100;
  if (hi <= lo) return 0; // empty selection
  if (u < lo || u > hi) return 0; // outside the window
  const t = (u - lo) / (hi - lo); // 0..1 across the window
  switch (shape) {
    case 'square':
      return 1;
    case 'rampUp':
      return t;
    case 'rampDown':
      return 1 - t;
    case 'triangle':
      return 1 - Math.abs(2 * t - 1);
    case 'round':
      return Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2));
    case 'smooth': {
      const tri = 1 - Math.abs(2 * t - 1);
      return tri * tri * (3 - 2 * tri);
    }
    default:
      return 1;
  }
}

/**
 * Map each character to the index of the unit (character / word / line) it
 * belongs to, and report the total unit count. Whitespace characters take the
 * unit of the word/line they sit within.
 */
export function unitPositions(
  text: string,
  basedOn: RangeBasedOn,
): { count: number; unitOfChar: number[] } {
  const chars = [...text];
  if (basedOn === 'characters') {
    return { count: chars.length, unitOfChar: chars.map((_, i) => i) };
  }
  if (basedOn === 'lines') {
    const unitOfChar: number[] = [];
    let unit = 0;
    for (const c of chars) {
      unitOfChar.push(unit);
      if (c === '\n') unit++;
    }
    return { count: unit + 1, unitOfChar };
  }
  // words: a new word starts on the first non-space after a space.
  const unitOfChar: number[] = [];
  let wordIdx = -1;
  let prevSpace = true;
  for (const c of chars) {
    const space = /\s/.test(c);
    if (!space && prevSpace) wordIdx++;
    unitOfChar.push(wordIdx < 0 ? 0 : wordIdx);
    prevSpace = space;
  }
  return { count: wordIdx < 0 ? Math.max(1, chars.length) : wordIdx + 1, unitOfChar };
}

/**
 * Evaluate the animator stack into per-glyph transforms. Pure: given the same
 * text and resolved animators it always yields the same result. Multiple
 * animators accumulate (position/rotation/tracking add; scale/opacity multiply).
 */
export function evaluateTextAnimators(
  text: string,
  animators: readonly ResolvedAnimator[],
): GlyphTransform[] {
  const chars = [...text];
  const glyphs: GlyphTransform[] = chars.map((ch) => ({
    char: ch,
    dx: 0,
    dy: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    tracking: 0,
  }));
  for (const a of animators) {
    const { count, unitOfChar } = unitPositions(text, a.basedOn);
    for (let i = 0; i < chars.length; i++) {
      const unit = unitOfChar[i] ?? 0;
      const u = count <= 0 ? 0.5 : (unit + 0.5) / count;
      const w = rangeSelectorWeight(u, a.start, a.end, a.offset, a.shape);
      if (w <= 0) continue;
      const g = glyphs[i]!;
      g.dx += a.x * w;
      g.dy += a.y * w;
      g.rotation += a.rotation * w;
      g.tracking += a.tracking * w;
      g.scale *= 1 + (a.scale / 100 - 1) * w; // lerp(1, scale/100, w)
      g.opacity *= 1 + (a.opacity / 100 - 1) * w; // lerp(1, opacity/100, w)
      if (a.color) {
        g.color = a.color;
        g.colorMix = Math.max(g.colorMix ?? 0, clamp01(w));
      }
    }
  }
  return glyphs;
}

// ── Scene integration ─────────────────────────────────────────────

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

/** Read the stored animator metadata for a node (empty when none). */
export function readAnimatorData(node: SceneNode): TextAnimatorData[] {
  const t = textComponent(node);
  const raw = t?.props.__animators;
  return Array.isArray(raw) ? (raw as TextAnimatorData[]) : [];
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
      basedOn: d.basedOn,
      shape: d.shape,
      start: val('start', d.start),
      end: val('end', d.end),
      offset: val('offset', d.offset),
      x: val('x', d.x),
      y: val('y', d.y),
      scale: val('scale', d.scale),
      rotation: val('rotation', d.rotation),
      opacity: val('opacity', d.opacity),
      tracking: val('tracking', d.tracking),
      color: d.color,
    };
  });
}

function writeAnimators(nodeId: string, animators: TextAnimatorData[]): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? textComponent(node) : undefined;
  if (!node || !t) return;
  // Persist through the graph so the rebuilt plain-view keeps the value.
  defaultSceneGraph.writeProp(nodeId, t.id, '__animators', animators);
  bumpScene();
}

/** Add a fresh animator group to a text layer. */
export function addTextAnimator(nodeId: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  writeAnimators(nodeId, [...readAnimatorData(node), defaultAnimator()]);
}

/** Remove the animator at `index`. */
export function removeTextAnimator(nodeId: string, index: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const next = readAnimatorData(node).filter((_, i) => i !== index);
  writeAnimators(nodeId, next);
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
  next[index] = { ...cur, ...patch };
  writeAnimators(nodeId, next);
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
