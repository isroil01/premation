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
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { writeTransformProps } from '@core/scene/transformWrite';

const DEG = Math.PI / 180;
export const ANCHOR_PROPS = ['anchorX', 'anchorY'] as const;

function transformComponent(node: SceneNode): { id: string; props: Record<string, unknown> } | undefined {
  return node.components.find((c) => c.type === 'Transform') as
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

/** Enable/disable anchor editing (seeds anchorX/anchorY at 0, or removes them). */
export function setAnchorEnabled(nodeId: string, on: boolean): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformComponent(node) : undefined;
  if (!node || !t) return;
  for (const p of ANCHOR_PROPS) {
    defaultSceneGraph.writeProp(nodeId, t.id, p, on ? num(t.props[p]) : undefined);
  }
  bumpScene();
}

/**
 * AE's Pan Behind (Y): set the anchor to (ax, ay) and compensate Position so the
 * content does not move. Position shifts by R·S·(Δanchor), matching how the
 * renderer places `content_world = position + R·S·(local − anchor)`.
 *
 * This is the CANVAS-TOOL semantic, not the numeric one. Typing an anchor value
 * in the Inspector moves the layer (see `setAnchor`), exactly as in AE — which
 * is the whole reason Pan Behind exists as a separate tool.
 *
 * All four writes go through `writeTransformProps`, so each lands as a keyframe
 * when its property is animated. They used to be raw `writeProp` calls: on a
 * layer with animated Position the compensation was silently discarded (the
 * renderer reads animated values first) and the layer JUMPED by the
 * compensation amount — precisely the error pan-behind exists to prevent.
 */
export function moveAnchorCompensated(nodeId: string, ax: number, ay: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformComponent(node) : undefined;
  if (!node || !t) return;
  const oldAx = num(t.props.anchorX);
  const oldAy = num(t.props.anchorY);
  const rot = num(t.props.rotation) * DEG;
  const sx = num(t.props.scaleX, 1);
  const sy = num(t.props.scaleY, 1);
  const dax = ax - oldAx;
  const day = ay - oldAy;
  const wdx = dax * sx * Math.cos(rot) - day * sy * Math.sin(rot);
  const wdy = dax * sx * Math.sin(rot) + day * sy * Math.cos(rot);
  writeTransformProps(
    nodeId,
    [
      { prop: 'anchorX', value: ax },
      { prop: 'anchorY', value: ay },
      { prop: 'x', value: num(t.props.x) + wdx },
      { prop: 'y', value: num(t.props.y) + wdy },
    ],
    'Pan Behind',
  );
}

/**
 * AE's NUMERIC anchor edit: move the pivot within the layer and leave Position
 * alone — so the layer MOVES on screen.
 *
 * This surprises everyone once, and it is what After Effects does. Anchor Point
 * is a coordinate in the layer's own space; Position says where that point sits
 * in the parent. Move the anchor inside the layer and the content shifts by
 * −R·S·Δanchor. `moveAnchorCompensated` above is the compensated variant, bound
 * to the Pan Behind tool.
 *
 * The Inspector's anchor fields used to call the compensated version, which was
 * neither AE nor internally consistent: compensation was skipped whenever the
 * anchor itself carried a track (that path writes a keyframe and never reached
 * this module), so one field had three behaviours depending on which properties
 * happened to be animated.
 */
export function setAnchor(nodeId: string, ax: number, ay: number): void {
  writeTransformProps(
    nodeId,
    [
      { prop: 'anchorX', value: ax },
      { prop: 'anchorY', value: ay },
    ],
    'Set Anchor Point',
  );
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

/** 
 * Estimate the visual bounds of a node to support automatic anchor point snapping. 
 * Defaults to 100x100 if dimensions cannot be cleanly inferred from components.
 */
export function estimateNodeBounds(nodeId: string): { width: number; height: number } {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return { width: 100, height: 100 };
  
  const t = transformComponent(node);
  if (t) {
    const w = t.props.width;
    const h = t.props.height;
    if (typeof w === 'number' && typeof h === 'number') {
      return { width: w, height: h };
    }
  }
  
  // Fallback heuristic based on kind
  const isText = node.components.some(c => c.type === 'Text');
  if (isText) return { width: 300, height: 50 };
  
  return { width: 100, height: 100 };
}
