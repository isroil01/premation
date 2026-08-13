/**
 * Generic adapter: build a `FrameScene` from flat, already-resolved scene items.
 * It is deliberately decoupled from any specific scene-graph package — the app's
 * scene layer produces `SceneItemInput`s (world position/size, resolved at the
 * current time by the animation system) and this computes model matrices +
 * culling bounds. The renderer thus depends only on its own DTO.
 */

import { Mat3 } from '../core/math/Mat3';
import type { Color } from '../core/math/Color';
import type { Rect, Size } from '../core/math/geometry';
import type { BlendMode } from '../gpu/types';
import type { CompositionInfo, FrameScene, Renderable, RenderableKind } from '../scene/FrameScene';

export interface SceneItemInput {
  id: string;
  kind: RenderableKind;
  /** World-space top-left position. */
  x: number;
  y: number;
  /** Local size in world units. */
  width: number;
  height: number;
  rotation?: number; // degrees
  opacity?: number;
  blend?: BlendMode;
  color?: Color;
  textureKey?: string;
  uvRect?: Rect;
}

/** Model matrix mapping the unit quad to the item's rotated world quad. */
function modelMatrix(item: SceneItemInput): Mat3 {
  const rad = ((item.rotation ?? 0) * Math.PI) / 180;
  // translate(x,y) · rotate · scale(w,h)
  return Mat3.compose(item.x, item.y, rad, item.width, item.height);
}

/** World-space AABB of the transformed unit quad (for culling). */
function boundsOf(model: Mat3): Rect {
  const corners = [
    Mat3.transformPoint(model, { x: 0, y: 0 }),
    Mat3.transformPoint(model, { x: 1, y: 0 }),
    Mat3.transformPoint(model, { x: 0, y: 1 }),
    Mat3.transformPoint(model, { x: 1, y: 1 }),
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function toRenderable(item: SceneItemInput): Renderable {
  const model = modelMatrix(item);
  return {
    id: item.id,
    kind: item.kind,
    modelMatrix: model,
    bounds: boundsOf(model),
    opacity: item.opacity ?? 1,
    blend: item.blend ?? 'normal',
    color: item.color,
    textureKey: item.textureKey,
    uvRect: item.uvRect,
  };
}

export function buildFrameScene(
  composition: { id: string; size: Size; background?: Color },
  items: SceneItemInput[],
): FrameScene {
  const info: CompositionInfo = { id: composition.id, size: composition.size, background: composition.background };
  return { composition: info, renderables: items.map(toRenderable) };
}
