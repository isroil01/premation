/**
 * alignNodes — spatial alignment and distribution helpers.
 *
 * Positions are written through SceneGraph.writeProp onto each node's
 * Transform component `x`/`y` props (center-based, comp space) — the same
 * write path the canvas drag uses. Writing `node.transform.position` would be
 * a silent no-op: that property is a derived, getter-only view.
 *
 * Sizes come from the node's own width/height props when present (drag-created
 * shapes, media) with the renderer's per-kind SIZE as fallback, scaled by
 * scaleX/scaleY — matching what buildSnapshot actually draws.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SIZE } from '@core/rendering/buildSnapshot';
import type { SceneNode } from '@core/types';

export type AlignMode =
  | 'left' | 'center-h' | 'right'
  | 'top'  | 'middle-v' | 'bottom'
  | 'distribute-h' | 'distribute-v';

interface Bounds { x: number; y: number; w: number; h: number; cx: number; cy: number; }

/** The component that carries the node's transform props (x/y live here). */
function transformComponent(node: SceneNode): { id: string } | null {
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.x === 'number' || typeof p.y === 'number') return { id: c.id };
  }
  const t = node.components.find((c) => c.type === 'Transform');
  return t ? { id: t.id } : null;
}

function getBounds(nodeId: string): Bounds | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;

  let x: number | undefined;
  let y: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let scaleX: number | undefined;
  let scaleY: number | undefined;
  let scale: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.x === 'number') x = p.x;
    if (typeof p.y === 'number') y = p.y;
    if (typeof p.width === 'number') width = p.width;
    if (typeof p.height === 'number') height = p.height;
    if (typeof p.scaleX === 'number') scaleX = p.scaleX;
    if (typeof p.scaleY === 'number') scaleY = p.scaleY;
    if (typeof p.scale === 'number') scale = p.scale;
  }

  const kind = readNodeKind(node);
  const fallback = (SIZE as Record<string, { w: number; h: number } | undefined>)[kind];
  const sx = Math.abs(scaleX ?? scale ?? 1);
  const sy = Math.abs(scaleY ?? scale ?? 1);
  const w = (width ?? fallback?.w ?? 100) * sx;
  const h = (height ?? fallback?.h ?? 100) * sy;
  const cx = x ?? node.transform.position.x;
  const cy = y ?? node.transform.position.y;
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
}

/** Write a node's center position through the component prop path. */
function setPos(nodeId: string, x: number, y: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || node.locked) return;
  const c = transformComponent(node);
  if (!c) return;
  defaultSceneGraph.writeProp(node.id, c.id, 'x', x);
  defaultSceneGraph.writeProp(node.id, c.id, 'y', y);
}

export function alignNodes(
  ids: string[],
  mode: AlignMode,
  alignTo: 'selection' | 'composition' = 'selection',
  compWidth: number = 1920,
  compHeight: number = 1080
): void {
  if (ids.length < 1) return;
  const boxes = ids
    .map((id) => ({ id, b: getBounds(id) }))
    .filter((v): v is { id: string; b: Bounds } => v.b !== null);
  if (boxes.length === 0) return;

  const left   = alignTo === 'composition' ? 0 : Math.min(...boxes.map((v) => v.b.x));
  const top    = alignTo === 'composition' ? 0 : Math.min(...boxes.map((v) => v.b.y));
  const right  = alignTo === 'composition' ? compWidth : Math.max(...boxes.map((v) => v.b.x + v.b.w));
  const bottom = alignTo === 'composition' ? compHeight : Math.max(...boxes.map((v) => v.b.y + v.b.h));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;

  for (const { id, b } of boxes) {
    switch (mode) {
      case 'left':     setPos(id, left + b.w / 2,            b.cy); break;
      case 'center-h': setPos(id, cx,                        b.cy); break;
      case 'right':    setPos(id, right - b.w / 2,           b.cy); break;
      case 'top':      setPos(id, b.cx, top + b.h / 2);             break;
      case 'middle-v': setPos(id, b.cx, cy);                        break;
      case 'bottom':   setPos(id, b.cx, bottom - b.h / 2);          break;
      default: break;
    }
  }

  if (mode === 'distribute-h' && boxes.length > (alignTo === 'composition' ? 1 : 2)) {
    const sorted = [...boxes].sort((a, b) => a.b.x - b.b.x);
    const totalW = sorted.reduce((s, v) => s + v.b.w, 0);
    const gap = (right - left - totalW) / (sorted.length - (alignTo === 'composition' ? 0 : 1));
    let cursor = left;
    if (alignTo === 'composition') {
      cursor += gap / 2;
    }
    for (const { id, b } of sorted) {
      setPos(id, cursor + b.w / 2, b.cy);
      cursor += b.w + gap;
    }
  }

  if (mode === 'distribute-v' && boxes.length > (alignTo === 'composition' ? 1 : 2)) {
    const sorted = [...boxes].sort((a, b) => a.b.y - b.b.y);
    const totalH = sorted.reduce((s, v) => s + v.b.h, 0);
    const gap = (bottom - top - totalH) / (sorted.length - (alignTo === 'composition' ? 0 : 1));
    let cursor = top;
    if (alignTo === 'composition') {
      cursor += gap / 2;
    }
    for (const { id, b } of sorted) {
      setPos(id, b.cx, cursor + b.h / 2);
      cursor += b.h + gap;
    }
  }

  bumpScene();
}
