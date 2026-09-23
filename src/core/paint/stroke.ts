/**
 * Strokes (Prompt E2 — solids, fills, gradients, strokes).
 *
 * A layer's outline: width, colour, opacity, alignment, dashes, caps and joins.
 * Stored on the node's `fx` component (key 'stroke'), captured by History /
 * autosave / export like the other fx data. Rendered by Canvas2D over the
 * layer's primitive path; the GPU backend draws the same strokes by rasterizing
 * any stroked shape through that shared Canvas2D code (`needsShapeRaster`).
 *
 * Alignment shifts the stroke relative to the fill edge: 'center' straddles it
 * (Canvas default), 'inside'/'outside' clip one half away — implemented in the
 * backend by clipping to / out of the fill path.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';
import { bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import { defaultAnimation } from '@motion/animation';
import { strokeTrackPathsFor } from '@core/rendering/strokeTracks';
import {
  normalizePaintOpOptions,
  type PaintBlendMode,
  type PaintComposite,
} from '@core/rendering/raster/paintBlend';
import type { FillPaint } from './fill';

export type StrokeAlign = 'inside' | 'center' | 'outside';
export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

import type { StrokeTaper, StrokeWave } from '@core/scene/strokeProfile';
import { clamp01 } from '@utils/lang';

// ── Paint operation options (AE: Composite + Blend Mode) ─────────────
// Defined in the pure `paintBlend` module so the rasterizer can use them
// without importing this file's scene-graph dependencies; re-exported here,
// where the model lives.
export {
  PAINT_BLEND_MODES,
  PAINT_COMPOSITES,
  isPaintBlendMode,
  normalizePaintOpOptions,
  paintCompositeOperation,
  type PaintBlendMode,
  type PaintComposite,
  type PaintOpOptions,
} from '@core/rendering/raster/paintBlend';

/**
 * AE's Gradient Stroke geometry: a free Start Point and End Point, plus the
 * radial Highlight.
 *
 * In the RELATIVE box units the fill's radial centre uses (0.5, 0.5 = the
 * layer's centre), so the handles ride a resize the way the rest of the paint
 * does. Absent means the gradient keeps its original angle/centre/radius model
 * (`LinearFill.angle`, `RadialFill.cx/cy/radius`) — every gradient stroke
 * authored before this renders byte-identically.
 */
export interface StrokeGradientGeometry {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** Radial: the focal highlight's distance from the centre, −1..1 of the radius. Absent = 0. */
  highlightLength?: number;
  /** Radial: degrees, measured from the Start→End axis. Absent = 0. */
  highlightAngle?: number;
}

export interface Stroke {
  enabled: boolean;
  color: string;
  /** Line width in layer-local px (0 draws nothing). */
  width: number;
  /** 0..1 opacity multiplier for the stroke only. */
  opacity: number;
  align: StrokeAlign;
  /** Dash pattern in px ([] = solid). */
  dash: number[];
  /**
   * How far the dash pattern is slid ALONG THE PATH, in the same layer-local px
   * `dash` is measured in — arc length, not a fraction and not an angle.
   *
   * This is the half of dashes that animates. A static pattern is decoration; a
   * keyframed offset is a line drawing itself on, a marching border, a progress
   * ring. Keyframe it through the `strokeDashOffset` track, which `buildSnapshot`
   * folds in here before the stroke reaches the rasterizer.
   *
   * Absent means 0, so every stroke authored before this renders bit-identically.
   *
   * PERIODIC by construction: `offset` and `offset + sum(dash)` draw the same
   * picture, because the pattern repeats over one full dash+gap period (twice
   * that for an odd-length array, which Canvas2D doubles). That is a property of
   * dashes, not a quirk here — and it is exactly why a fixture at 0, or at one
   * whole period, cannot see an offset bug.
   */
  dashOffset?: number;
  cap: StrokeCap;
  join: StrokeJoin;
  /**
   * Miter-limit ratio for `join: 'miter'` — Canvas2D's `miterLimit`: when a
   * corner's miter length exceeds `miterLimit × width`, the join falls back to
   * a bevel. Meaningless for round/bevel joins.
   *
   * Absent means 4, the Canvas2D default the rasterizer has always run with —
   * and it is OMITTED rather than written as 4 for the same cache-key reason
   * `dashOffset` is: `contentHash` serialises the whole stroke object, so
   * defaulting it into every normalised stroke would invalidate every cached
   * raster in a project on first open for a value that means "unchanged".
   */
  miterLimit?: number;
  /** Optional gradient paint — when set (linear/radial) it overrides `color`;
   *  `color` remains the fallback for renderers without gradient strokes. */
  paint?: FillPaint;
  /**
   * AE's Taper and Wave groups. Absent means identity, so every stroke authored
   * before them renders bit-identically — the profiles are skipped structurally
   * rather than computing 1 everywhere (see `isIdentityTaper`).
   *
   * Both are consumed by `strokeShapeProfiled`, which FILLS a variable-width
   * outline; Canvas2D strokes at one `lineWidth` and cannot vary it.
   */
  taper?: StrokeTaper;
  wave?: StrokeWave;
  /** AE Composite — see `PaintComposite`. Absent = below previous. */
  composite?: PaintComposite;
  /** Blend with the paints already drawn in this shape. Absent = normal. */
  blendMode?: PaintBlendMode;
  /** Free Start/End points and radial highlight for a gradient `paint`. */
  gradient?: StrokeGradientGeometry;
}

export const STROKE_ALIGNS: ReadonlyArray<{ value: StrokeAlign; label: string }> = [
  { value: 'center', label: 'Center' },
  { value: 'inside', label: 'Inside' },
  { value: 'outside', label: 'Outside' },
];
export const STROKE_CAPS: ReadonlyArray<{ value: StrokeCap; label: string }> = [
  { value: 'butt', label: 'Butt' },
  { value: 'round', label: 'Round' },
  { value: 'square', label: 'Square' },
];
export const STROKE_JOINS: ReadonlyArray<{ value: StrokeJoin; label: string }> = [
  { value: 'miter', label: 'Miter' },
  { value: 'round', label: 'Round' },
  { value: 'bevel', label: 'Bevel' },
];

/** A sensible default stroke (enabled, thin, opaque, centred). */
export function defaultStroke(color = '#ffffff'): Stroke {
  return { enabled: true, color, width: 4, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' };
}

function isStroke(v: unknown): v is Stroke {
  return !!v && typeof v === 'object' && typeof (v as Stroke).width === 'number';
}

/** Normalise a stored/partial stroke into a complete, sane Stroke. */
export function normalizeStroke(v: unknown): Stroke {
  const base = defaultStroke();
  if (!isStroke(v)) return base;
  const s = v as Partial<Stroke>;
  const paint = s.paint;
  const validPaint =
    !!paint && typeof paint === 'object' && (paint.type === 'linear' || paint.type === 'radial' || paint.type === 'solid');
  return {
    enabled: s.enabled !== false,
    color: typeof s.color === 'string' ? s.color : base.color,
    width: Math.max(0, Number.isFinite(s.width) ? (s.width as number) : base.width),
    opacity: clamp01(Number.isFinite(s.opacity) ? (s.opacity as number) : base.opacity),
    align: s.align === 'inside' || s.align === 'outside' ? s.align : 'center',
    dash: Array.isArray(s.dash) ? s.dash.filter((n) => Number.isFinite(n) && n >= 0) : [],
    // Omitted rather than defaulted to 0. `contentHash` serialises the whole
    // stroke object as the raster cache key, so writing `dashOffset: 0` into
    // every normalised stroke would change the key for every existing layer and
    // invalidate every cached raster in the project on first open — for a value
    // that means "unchanged". Negative offsets are legal (they slide the other
    // way), so this only rejects non-finite input.
    ...(Number.isFinite(s.dashOffset) ? { dashOffset: s.dashOffset as number } : {}),
    cap: s.cap === 'round' || s.cap === 'square' ? s.cap : 'butt',
    join: s.join === 'round' || s.join === 'bevel' ? s.join : 'miter',
    // Omitted when absent — see the field note (cache-key argument, mirroring
    // `dashOffset`). Floored at 1: Canvas2D ignores miterLimit < 1.
    ...(Number.isFinite(s.miterLimit) ? { miterLimit: Math.max(1, s.miterLimit as number) } : {}),
    ...(validPaint ? { paint } : {}),
    // Taper and Wave, OMITTED when absent for exactly the reason `dashOffset`
    // is: `contentHash` serialises the whole stroke as the raster cache key, so
    // writing an identity profile into every normalised stroke would change the
    // key for every existing layer and invalidate every cached raster in the
    // project on first open — for a value that means "unchanged".
    ...(normTaper(s.taper) ? { taper: normTaper(s.taper)! } : {}),
    ...(normWave(s.wave) ? { wave: normWave(s.wave)! } : {}),
    // Composite, blend mode and gradient points: appended LAST and omitted at
    // their defaults, so a stroke that uses none of them normalises to exactly
    // the object (and raster cache key) it did before they existed.
    ...normalizePaintOpOptions(s),
    ...(validPaint && paint!.type !== 'solid' && normGradient(s.gradient) ? { gradient: normGradient(s.gradient)! } : {}),
  };
}

/**
 * Normalise a stored Taper, or undefined when it is absent or says nothing.
 *
 * Ranges are clamped HERE rather than trusted, because these arrive from a
 * saved document as well as from the inspector: widths to 0..1, percentage
 * lengths to 0..1 (so a hand-edited file cannot ask for a 300% ramp and get a
 * stroke that inverts), pixel lengths to ≥ 0, eases to AE's −1..1.
 */
function normTaper(v: unknown): StrokeTaper | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const t = v as Partial<StrokeTaper>;
  const fin = (x: unknown, d: number): number => (Number.isFinite(x) ? (x as number) : d);
  const n = (x: unknown, d: number): number => clamp01(fin(x, d));
  const pixels = t.lengthUnits === 'pixels';
  const len = (x: unknown): number => (pixels ? Math.max(0, fin(x, 0)) : n(x, 0));
  const ease = (x: unknown): number => Math.max(-1, Math.min(1, fin(x, 0)));
  const out: StrokeTaper = {
    startWidth: n(t.startWidth, 1), endWidth: n(t.endWidth, 1),
    startLength: len(t.startLength), endLength: len(t.endLength),
    startEase: ease(t.startEase), endEase: ease(t.endEase),
    // Percent is the default and is not written — the cache-key argument.
    ...(pixels ? { lengthUnits: 'pixels' as const } : {}),
  };
  // An identity taper is dropped, not stored — same cache-key argument.
  const noRamp = out.startLength <= 0 && out.endLength <= 0;
  const fullWidth = out.startWidth === 1 && out.endWidth === 1;
  return noRamp || fullWidth ? undefined : out;
}

/** Normalise a stored Wave, or undefined when it cannot displace anything. */
function normWave(v: unknown): StrokeWave | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const w = v as Partial<StrokeWave>;
  const num = (x: unknown, d: number): number => (Number.isFinite(x) ? (x as number) : d);
  const out: StrokeWave = {
    amount: num(w.amount, 0),
    // A negative wavelength is not a backwards wave, it is a sign flip on the
    // phase — which the phase control already expresses. Clamped so there is
    // one way to say it. Under Cycles it is the cycle count, same floor.
    wavelength: Math.max(0, num(w.wavelength, 0)),
    phase: num(w.phase, 0),
    ...(w.units === 'cycles' ? { units: 'cycles' as const } : {}),
  };
  return out.amount === 0 || out.wavelength <= 0 ? undefined : out;
}

/** Normalise stored gradient points; undefined unless all four coordinates are finite. */
function normGradient(v: unknown): StrokeGradientGeometry | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const g = v as Partial<StrokeGradientGeometry>;
  const coords = [g.startX, g.startY, g.endX, g.endY];
  if (!coords.every((c) => Number.isFinite(c))) return undefined;
  return {
    startX: g.startX as number, startY: g.startY as number,
    endX: g.endX as number, endY: g.endY as number,
    ...(Number.isFinite(g.highlightLength) && g.highlightLength !== 0
      ? { highlightLength: Math.max(-1, Math.min(1, g.highlightLength as number)) } : {}),
    ...(Number.isFinite(g.highlightAngle) && g.highlightAngle !== 0 ? { highlightAngle: g.highlightAngle as number } : {}),
  };
}


/** Read a node's stroke from its `fx` component (undefined when none/off). */
export function readNodeStroke(node: SceneNode): Stroke | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  const raw = fx?.props.stroke;
  if (!isStroke(raw)) return undefined;
  const s = normalizeStroke(raw);
  return s.enabled && s.width > 0 ? s : undefined;
}

export function getNodeStroke(nodeId: string): Stroke | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  const fx = node?.components.find((c) => c.type === 'fx');
  return fx && isStroke(fx.props.stroke) ? normalizeStroke(fx.props.stroke) : undefined;
}

// ── Multi-stroke (stroke STACK, drawn bottom→top) ────────────────────

function rawStrokes(node: SceneNode): Stroke[] | null {
  const fx = node.components.find((c) => c.type === 'fx');
  const arr = fx?.props.strokes;
  if (!Array.isArray(arr)) return null;
  const valid = arr.filter(isStroke).map(normalizeStroke);
  return valid.length > 0 ? valid : null;
}

/** The node's full stroke stack (normalized, INCLUDING disabled entries — the
 *  UI needs them; renderers filter). Legacy single strokes report as [stroke]. */
export function readNodeStrokes(node: SceneNode): Stroke[] {
  const arr = rawStrokes(node);
  if (arr) return arr;
  const fx = node.components.find((c) => c.type === 'fx');
  return fx && isStroke(fx.props.stroke) ? [normalizeStroke(fx.props.stroke)] : [];
}

export function getNodeStrokes(nodeId: string): Stroke[] {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeStrokes(node) : [];
}

/** The renderable subset of the stack (enabled, width > 0). */
export function readNodeRenderStrokes(node: SceneNode): Stroke[] {
  return readNodeStrokes(node).filter((s) => s.enabled && s.width > 0);
}

/** Replace the whole stroke stack; the legacy single-stroke slot mirrors
 *  strokes[0] so older readers keep working. */
export function setNodeStrokes(nodeId: string, strokes: Stroke[]): void {
  const normalized = strokes.map(normalizeStroke);
  defaultSceneGraph.setStrokes(nodeId, normalized.length > 1 ? normalized : undefined);
  defaultSceneGraph.setStroke(nodeId, normalized[0]);
  bumpScene();
  getEventBus().emit('AnimationChanged', { nodeId });
}

/**
 * The ENGINE's stack write (`layer/strokes`, the property seam): exactly
 * `setNodeStrokes`' storage — normalised, the stack kept only when > 1, the
 * single slot mirroring strokes[0] — without the UI refresh (the engine
 * reports its own changes).
 */
export function storeNodeStrokes(nodeId: string, strokes: ReadonlyArray<unknown>): void {
  const normalized = strokes.map(normalizeStroke);
  defaultSceneGraph.setStrokes(nodeId, normalized.length > 1 ? normalized : undefined);
  defaultSceneGraph.setStroke(nodeId, normalized[0]);
}

/** Replace the stored stroke at `index` of the stack (engine seam; see storeNodeStrokes). */
export function storeNodeStrokeAt(nodeId: string, index: number, stroke: Stroke): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const stack = readNodeStrokes(node);
  if (index < 0 || index >= stack.length) return;
  const next = [...stack];
  next[index] = stroke;
  storeNodeStrokes(nodeId, next);
}

/** Set (or clear, when undefined) the node's PRIMARY stroke. Routes through
 *  the stack when one exists so single-stroke controls stay truthful. */
export function setNodeStroke(nodeId: string, stroke: Stroke | undefined): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const arr = node ? rawStrokes(node) : null;
  if (arr) {
    setNodeStrokes(nodeId, stroke ? [normalizeStroke(stroke), ...arr.slice(1)] : arr.slice(1));
    return;
  }
  defaultSceneGraph.setStroke(nodeId, stroke);
  bumpScene();
  getEventBus().emit('AnimationChanged', { nodeId });
}

/** Patch the current PRIMARY stroke (creating a default first if none exists). */
export function updateNodeStroke(nodeId: string, patch: Partial<Stroke>): void {
  const current = getNodeStroke(nodeId) ?? defaultStroke();
  setNodeStroke(nodeId, normalizeStroke({ ...current, ...patch }));
}

// ── Any stroke of the stack, by index ───────────────────────────────

/** The stored stroke at `index` of the stack (normalized, disabled included), or undefined. */
export function getNodeStrokeAt(nodeId: string, index: number): Stroke | undefined {
  return index === 0 ? getNodeStroke(nodeId) : getNodeStrokes(nodeId)[index];
}

/**
 * Patch the stroke at `index`. Index 0 routes through `updateNodeStroke`, so the
 * primary keeps its create-on-first-edit behaviour and the legacy single-stroke
 * slot stays mirrored; a higher index that does not exist is a no-op rather than
 * a silent append.
 */
export function updateNodeStrokeAt(nodeId: string, index: number, patch: Partial<Stroke>): void {
  if (index === 0) {
    updateNodeStroke(nodeId, patch);
    return;
  }
  const stack = getNodeStrokes(nodeId);
  const current = stack[index];
  if (!current) return;
  const next = [...stack];
  next[index] = normalizeStroke({ ...current, ...patch });
  setNodeStrokes(nodeId, next);
}

/**
 * Remove the stroke at `index` AND re-key the tracks of every stroke above it.
 *
 * Stroke tracks are index-scoped (`strokeTracks.ts`), so deleting stroke 2 of 3
 * without this would leave stroke 3's keyframes on `stroke.2.*` — the old
 * stroke 3 would lose its animation and nothing would own stroke 2's leftover
 * tracks. The removed stroke's own tracks are dropped with it.
 */
export function removeNodeStrokeAt(nodeId: string, index: number): void {
  const stack = getNodeStrokes(nodeId);
  if (index < 0 || index >= stack.length) return;
  const byProp = new Map(defaultAnimation.tracksFor(nodeId).map((t) => [t.prop, t]));
  defaultAnimation.batch(() => {
    for (const prop of strokeTrackPathsFor(index)) if (byProp.has(prop)) defaultAnimation.removeTrack(nodeId, prop);
    for (let j = index + 1; j < stack.length; j++) {
      const from = strokeTrackPathsFor(j);
      const to = strokeTrackPathsFor(j - 1);
      from.forEach((prop, k) => {
        const track = byProp.get(prop);
        if (!track) return;
        defaultAnimation.setKeyframes(nodeId, to[k]!, track.keyframes);
        defaultAnimation.removeTrack(nodeId, prop);
      });
    }
  });
  setNodeStrokes(nodeId, stack.filter((_, i) => i !== index));
}
