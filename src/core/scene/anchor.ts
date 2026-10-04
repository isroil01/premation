/**
 * Anchor point / pan-behind (Prompt E4 / MG-A). A layer's anchor is the pivot
 * that rotation and scale happen around, and the point the layer's position
 * places. Moving it changes how the layer spins/scales without you wanting the
 * layer to jump — so the pan-behind edit compensates the position so the layer
 * stays visually put.
 *
 * Stored as `anchorX`/`anchorY` px offsets from the layer centre on the
 * Transform component (0,0 = centre). buildSnapshot threads them to the render
 * layer and the backend offsets the content so the anchor sits at the pivot.
 */

import type { SceneNode } from '@core/types';
import { renderComponentsOf } from '@core/scene/SceneGraph';

const DEG = Math.PI / 180;
export const ANCHOR_PROPS = ['anchorX', 'anchorY'] as const;

// Read-only (writes go through `writeProp`), so the memoised view — see threeD.ts.
function transformComponent(node: SceneNode): { id: string; props: Record<string, unknown> } | undefined {
  return renderComponentsOf(node).find((c) => c.type === 'Transform') as
    | { id: string; props: Record<string, unknown> }
    | undefined;
}
const num = (v: unknown, fb = 0): number => (typeof v === 'number' ? v : fb);

/** The layer's anchor offset from centre (0,0 when unset). */
export function readNodeAnchor(node: SceneNode): { x: number; y: number } {
  const t = transformComponent(node);
  if (!t) return { x: 0, y: 0 };
  return { x: num(t.props.anchorX), y: num(t.props.anchorY) };
}

/** True when the layer carries anchor props (anchor editing enabled). */
export function hasAnchor(node: SceneNode): boolean {
  const t = transformComponent(node);
  if (!t) return false;
  return ANCHOR_PROPS.some((p) => typeof t.props[p] === 'number');
}

/** Pure world-delta for a pan-behind, exposed for testing. */
export function anchorCompensation(
  dax: number,
  day: number,
  rotationDeg: number,
  sx: number,
  sy: number,
): { dx: number; dy: number } {
  const rot = rotationDeg * DEG;
  return {
    dx: dax * sx * Math.cos(rot) - day * sy * Math.sin(rot),
    dy: dax * sx * Math.sin(rot) + day * sy * Math.cos(rot),
  };
}
