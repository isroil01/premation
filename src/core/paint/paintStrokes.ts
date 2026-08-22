/**
 * Paint strokes — AE's Paint effect, modelled as EDITABLE VECTOR strokes stored
 * on a layer's `fx` component (like masks), not a flattened raster. Each stroke
 * is a polyline the Canvas2D backend draws over the layer's content: paint mode
 * composites colour (`source-over`), erase mode cuts holes (`destination-out`),
 * and clone mode paints the layer's OWN content sampled at a fixed offset —
 * the clone stamp, for raster retouch on footage and stills.
 * Points are in layer-local space (centred at 0,0), matching masks.
 *
 * This module is the pure model + a testable bounds helper; the drawing lives in
 * Canvas2DBackend, the capture in the Brush tool.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import { bumpScene } from '@stores/sceneStore';
import { clamp01 } from '@utils/lang';

export type PaintMode = 'paint' | 'erase' | 'clone';

export interface PaintStroke {
  id: string;
  /** Polyline points in layer-local space (0,0 = layer centre). */
  points: ReadonlyArray<{ x: number; y: number }>;
  /** Stroke colour `#rrggbb` (ignored for erase). */
  color: string;
  /** Brush diameter in px. */
  size: number;
  /** 0..1. */
  opacity: number;
  /** 0..1 — 1 = hard edge, <1 = softer (feathered) edge. */
  hardness: number;
  mode: PaintMode;
  /**
   * Clone stamp only — where the stroke SAMPLES from, as a layer-local offset
   * added to each painted point (classic clone: offset = source − first dab,
   * fixed for the stroke's life). Colour is ignored for clone; the paint IS
   * the layer's own content, shifted.
   */
  cloneOffsetX?: number;
  cloneOffsetY?: number;
}

export interface PaintConfig {
  strokes: PaintStroke[];
}

/** Read a node's paint config off its `fx` component, or null when it has none. */
export function readNodePaint(node: SceneNode): PaintConfig | null {
  const fx = node.components.find((c) => c.type === 'fx');
  const raw = fx?.props.paint as { strokes?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.strokes) || raw.strokes.length === 0) return null;
  const strokes = (raw.strokes as PaintStroke[]).filter(
    (s) => s && Array.isArray(s.points) && s.points.length > 0,
  );
  return strokes.length > 0 ? { strokes } : null;
}

/** Normalise a partial stroke into a full one (fills defaults). Pure/testable. */
export function normalizeStroke(raw: Partial<PaintStroke> & { points: ReadonlyArray<{ x: number; y: number }> }, id: string): PaintStroke {
  return {
    id: raw.id ?? id,
    points: raw.points,
    color: typeof raw.color === 'string' ? raw.color : '#ffffff',
    size: typeof raw.size === 'number' && raw.size > 0 ? raw.size : 12,
    opacity: clamp01(typeof raw.opacity === 'number' ? raw.opacity : 1),
    hardness: clamp01(typeof raw.hardness === 'number' ? raw.hardness : 1),
    mode: raw.mode === 'erase' || raw.mode === 'clone' ? raw.mode : 'paint',
    ...(raw.mode === 'clone'
      ? {
          cloneOffsetX: typeof raw.cloneOffsetX === 'number' ? raw.cloneOffsetX : 0,
          cloneOffsetY: typeof raw.cloneOffsetY === 'number' ? raw.cloneOffsetY : 0,
        }
      : {}),
  };
}

/** Axis-aligned bounds of a stroke including its brush radius (layer-local px).
 *  Pure/testable — used for dirty-region / hit-testing. Null for an empty stroke. */
export function strokeBounds(stroke: PaintStroke): { x: number; y: number; width: number; height: number } | null {
  if (stroke.points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of stroke.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const r = stroke.size / 2;
  return { x: minX - r, y: minY - r, width: maxX - minX + stroke.size, height: maxY - minY + stroke.size };
}


// ── Mutations (write to the layer's fx + notify) ──────────────────────

let strokeSeq = 0;

export function getNodePaint(nodeId: string): PaintConfig | null {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodePaint(node) : null;
}

/** Append a paint stroke to a layer, creating the paint config on demand. */
export function addPaintStroke(
  nodeId: string,
  stroke: Partial<PaintStroke> & { points: ReadonlyArray<{ x: number; y: number }> },
): void {
  const existing = getNodePaint(nodeId)?.strokes ?? [];
  const strokes = [...existing, normalizeStroke(stroke, `pstroke_${(strokeSeq += 1)}`)];
  defaultSceneGraph.setPaint(nodeId, { strokes });
  getEventBus().emit('AnimationChanged', { nodeId });
  bumpScene();
}

/** Remove the most recent stroke (undo the last brush pass). */
export function removeLastStroke(nodeId: string): void {
  const strokes = getNodePaint(nodeId)?.strokes;
  if (!strokes || strokes.length === 0) return;
  defaultSceneGraph.setPaint(nodeId, { strokes: strokes.slice(0, -1) });
  getEventBus().emit('AnimationChanged', { nodeId });
  bumpScene();
}

