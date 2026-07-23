/**
 * Scene-node geometry for the Workspace interaction engine.
 *
 * Mirrors exactly how `buildSnapshot` places layers on the canvas — center
 * position (x, y) + fixed per-kind size, rotation in degrees, ellipse-vs-rect by
 * name — so hit-testing and selection overlays land pixel-on-pixel with what the
 * renderer draws. Comp space (1920×1080) is the Workspace's world space.
 */

import type { SceneNode } from '@core/types';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SIZE } from '@core/rendering/buildSnapshot';
import { measureTextNodeSize } from '@core/text/measureText';
import { useCompositionStore } from '@stores/compositionStore';
import { Mat, Rect, type Vec2, type Mat2D } from '@motion/workspace';

/** Active comp dimensions (hit box for full-frame comp-instance layers). */
function compositionSize(): { width: number; height: number } {
  const c = useCompositionStore.getState();
  return { width: c.width || 1920, height: c.height || 1080 };
}

/** The workspace's plain rectangle value type. */
type WRect = ReturnType<typeof Rect.rect>;

export interface NodeGeometry {
  x: number;
  y: number;
  rotationDeg: number;
  /** Base (unscaled) size in comp px. */
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  ellipse: boolean;
}

/**
 * True for kinds that are selectable/draggable in the viewport.
 * Everything a user inserts should be grabbable on canvas: particles get an
 * emitter gizmo box, comp instances a full-frame box, nulls an AE-style
 * gizmo. Only kinds with no canvas presence stay out (group = children carry
 * the geometry; audio = no visual; adjustment = invisible full-frame overlay
 * that would swallow every click above the layers it grades).
 */
export function isDrawableKind(kind: string): boolean {
  return kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video'
    || kind === 'light' || kind === 'camera'
    || kind === 'particle' || kind === 'comp' || kind === 'null' || kind === 'group';
}

/** Read a node's on-canvas geometry from its components (base/authoring props). */
export function readGeometry(node: SceneNode): NodeGeometry | null {
  const kind = readNodeKind(node);
  if (!isDrawableKind(kind)) return null;

  let x: number | undefined;
  let y: number | undefined;
  let rotation: number | undefined;
  let scaleX: number | undefined;
  let scaleY: number | undefined;
  let scale: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let shapeType: string | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.x === 'number') x = p.x;
    if (typeof p.y === 'number') y = p.y;
    if (typeof p.rotation === 'number') rotation = p.rotation;
    if (typeof p.scaleX === 'number') scaleX = p.scaleX;
    if (typeof p.scaleY === 'number') scaleY = p.scaleY;
    if (typeof p.scale === 'number') scale = p.scale;
    if (typeof p.width === 'number') width = p.width;
    if (typeof p.height === 'number') height = p.height;
    if (typeof p.shapeType === 'string') shapeType = p.shapeType;
  }
  // Text layers size to their MEASURED content (point text, AE-style): the
  // fixed SIZE.text fallback left the outline/hit box at 320×80 while long or
  // large text drew far past it.
  const measured = kind === 'text' ? measureTextNodeSize(node) : null;
  const size = measured ? { w: measured.w, h: measured.h }
             : kind === 'light' ? { w: 100, h: 100 }
             : kind === 'camera' ? { w: 80, h: 80 }
             : kind === 'particle' ? { w: 140, h: 140 }
             : kind === 'null' ? { w: 60, h: 60 }
             : kind === 'group' ? { w: 280, h: 280 }
             : kind === 'comp' ? { w: compositionSize().width, h: compositionSize().height }
             : (SIZE as any)[kind] ?? { w: 100, h: 100 };
  const name = (node.name ?? '').toLowerCase();
  return {
    x: x ?? node.transform.position.x,
    y: y ?? node.transform.position.y,
    rotationDeg: rotation ?? node.transform.rotation,
    // Real authored size when present (drag-created shapes, media) — the fixed
    // per-kind SIZE is only the fallback. Otherwise hit boxes float off the
    // shape (a 100×100 rect carried a 220×220 selection box).
    width: width ?? size.w,
    height: height ?? size.h,
    scaleX: scaleX ?? scale ?? 1,
    scaleY: scaleY ?? scale ?? 1,
    // Explicit shapeType wins; the name regex only covers legacy nodes.
    ellipse: shapeType ? shapeType === 'ellipse' : /circle|ellip|dot|orb/.test(name),
  };
}

/** local → world matrix: translate(center) · rotate(deg) · scale. */
export function worldMatrix(g: NodeGeometry): Mat2D {
  const tr = Mat.multiply(Mat.translation(g.x, g.y), Mat.rotation((g.rotationDeg * Math.PI) / 180));
  return Mat.multiply(tr, Mat.scaling(g.scaleX, g.scaleY));
}

/** Untransformed local bounds — centered on the origin. */
export function localBounds(g: NodeGeometry): WRect {
  return Rect.rect(-g.width / 2, -g.height / 2, g.width, g.height);
}

/** World-space axis-aligned bounding box (handles rotation). */
export function worldBounds(g: NodeGeometry): WRect {
  return Rect.transform(localBounds(g), worldMatrix(g));
}

/** Precise local-space hit test (rect or inscribed ellipse). */
export function makeHitTestLocal(g: NodeGeometry): (p: Vec2) => boolean {
  const rx = g.width / 2;
  const ry = g.height / 2;
  if (g.ellipse) {
    return (p) => (p.x * p.x) / (rx * rx) + (p.y * p.y) / (ry * ry) <= 1;
  }
  return (p) => Math.abs(p.x) <= rx && Math.abs(p.y) <= ry;
}
