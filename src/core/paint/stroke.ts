/**
 * Strokes (Prompt E2 — solids, fills, gradients, strokes).
 *
 * A layer's outline: width, colour, opacity, alignment, dashes, caps and joins.
 * Stored on the node's `fx` component (key 'stroke'), captured by History /
 * autosave / export like the other fx data. Rendered by Canvas2D over the
 * layer's primitive path; the GPU backend skips strokes for now (documented
 * gap, mirrors deferred GPU passes).
 *
 * Alignment shifts the stroke relative to the fill edge: 'center' straddles it
 * (Canvas default), 'inside'/'outside' clip one half away — implemented in the
 * backend by clipping to / out of the fill path.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';
import { bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import type { FillPaint } from './fill';

export type StrokeAlign = 'inside' | 'center' | 'outside';
export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

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
  /** Optional gradient paint — when set (linear/radial) it overrides `color`;
   *  `color` remains the fallback for renderers without gradient strokes. */
  paint?: FillPaint;
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
    ...(validPaint ? { paint } : {}),
  };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
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
