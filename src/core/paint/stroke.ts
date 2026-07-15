/**
 * Strokes (Prompt E2 — solids, fills, gradients, strokes).
 *
 * A layer's outline: width, colour, opacity, alignment, dashes, caps and joins.
 * Stored on the node's `fx` component (key 'stroke'), captured by History /
 * autosave / export like the other fx data. Rendered by Canvas2D over the
 * layer's primitive path; the GPU backend skips strokes for now (documented
 * gap, mirrors Prompt 5's deferred GPU passes).
 *
 * Alignment shifts the stroke relative to the fill edge: 'center' straddles it
 * (Canvas default), 'inside'/'outside' clip one half away — implemented in the
 * backend by clipping to / out of the fill path.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';
import { bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';

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
  cap: StrokeCap;
  join: StrokeJoin;
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
  return {
    enabled: s.enabled !== false,
    color: typeof s.color === 'string' ? s.color : base.color,
    width: Math.max(0, Number.isFinite(s.width) ? (s.width as number) : base.width),
    opacity: clamp01(Number.isFinite(s.opacity) ? (s.opacity as number) : base.opacity),
    align: s.align === 'inside' || s.align === 'outside' ? s.align : 'center',
    dash: Array.isArray(s.dash) ? s.dash.filter((n) => Number.isFinite(n) && n >= 0) : [],
    cap: s.cap === 'round' || s.cap === 'square' ? s.cap : 'butt',
    join: s.join === 'round' || s.join === 'bevel' ? s.join : 'miter',
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

/** Set (or clear, when undefined) the node's stroke. */
export function setNodeStroke(nodeId: string, stroke: Stroke | undefined): void {
  defaultSceneGraph.setStroke(nodeId, stroke);
  bumpScene();
  getEventBus().emit('AnimationChanged', { nodeId });
}

/** Patch the current stroke (creating a default first if none exists). */
export function updateNodeStroke(nodeId: string, patch: Partial<Stroke>): void {
  const current = getNodeStroke(nodeId) ?? defaultStroke();
  setNodeStroke(nodeId, normalizeStroke({ ...current, ...patch }));
}
