/**
 * Paint coordinate helpers — pure geometry shared by the Brush tool (capture)
 * and its tests. Kept out of the React hook so the transform-inversion math is
 * unit-testable without pulling in the workspace/engine.
 */

import type { SceneNode } from '@core/types';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readNodeAnchor } from '@core/scene/anchor';

/** Layer kinds the Brush tool can paint onto (everything with raster content;
 *  cameras/lights/audio have no surface). */
export function isPaintableKind(node: SceneNode): boolean {
  const k = readNodeKind(node);
  return k !== 'camera' && k !== 'light' && k !== 'audio';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * The layer's effective scale (geometric mean of |scaleX|·|scaleY|), used to
 * convert a comp-pixel brush size into the layer's local paint units. A shape
 * whose geometry is authored tiny and blown up by a large Transform scale has a
 * local space measured in those tiny units — a comp-pixel brush size must be
 * divided by this so the stroke is the intended thickness on screen, not a blob.
 */
export function layerScaleOf(node: SceneNode): number {
  const t = node.components.find((c) => c.type === 'Transform');
  const sx = Math.abs(num(t?.props.scaleX) ?? num(t?.props.scale) ?? 1) || 1;
  const sy = Math.abs(num(t?.props.scaleY) ?? num(t?.props.scale) ?? 1) || 1;
  return Math.sqrt(sx * sy) || 1;
}

/** Convert a comp-pixel brush diameter into the layer's local paint units. */
export function localBrushSize(node: SceneNode, compSize: number): number {
  return compSize / layerScaleOf(node);
}

/**
 * Map a comp-space point to a layer's local paint space (0,0 = layer centre),
 * inverting the layer's transform — AE stores paint in layer space, independent
 * of the layer's position/rotation/scale. Handles a static top-level transform
 * (the common case); parent chains and transform animation are not inverted.
 */
export function compToLayerLocal(
  node: SceneNode,
  cp: { x: number; y: number },
): { x: number; y: number } {
  const t = node.components.find((c) => c.type === 'Transform');
  const x = num(t?.props.x) ?? node.transform.position.x;
  const y = num(t?.props.y) ?? node.transform.position.y;
  const rot = ((num(t?.props.rotation) ?? node.transform.rotation ?? 0) * Math.PI) / 180;
  const sx = num(t?.props.scaleX) ?? num(t?.props.scale) ?? 1;
  const sy = num(t?.props.scaleY) ?? num(t?.props.scale) ?? 1;
  const anchor = readNodeAnchor(node);
  const dx = cp.x - x;
  const dy = cp.y - y;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  const rx = (dx * cos - dy * sin) / (sx || 1);
  const ry = (dx * sin + dy * cos) / (sy || 1);
  return { x: rx + anchor.x, y: ry + anchor.y };
}
