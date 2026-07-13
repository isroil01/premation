/**
 * alignNodes — spatial alignment and distribution helpers.
 *
 * All operations mutate the Transform position components of the given node
 * ids in defaultSceneGraph, then call bumpScene() to trigger a re-render.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

export type AlignMode =
  | 'left' | 'center-h' | 'right'
  | 'top'  | 'middle-v' | 'bottom'
  | 'distribute-h' | 'distribute-v';

interface Bounds { x: number; y: number; w: number; h: number; }

function getBounds(nodeId: string): Bounds | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const pos = node.transform?.position ?? { x: 0, y: 0 };
  const sc  = node.transform?.scale    ?? { x: 1, y: 1 };
  const w = ((node.components.find(c => c.type === 'Geometry')?.props as any)?.width  ?? 100) * Math.abs(sc.x);
  const h = ((node.components.find(c => c.type === 'Geometry')?.props as any)?.height ?? 100) * Math.abs(sc.y);
  return { x: pos.x - w / 2, y: pos.y - h / 2, w, h };
}

function setPos(nodeId: string, x: number, y: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  if (!node.transform) node.transform = { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } };
  else node.transform.position = { x, y };
}

export function alignNodes(ids: string[], mode: AlignMode): void {
  if (ids.length < 1) return;
  const boxes = ids.map(id => ({ id, b: getBounds(id) })).filter((v): v is { id: string; b: Bounds } => v.b !== null);
  if (boxes.length === 0) return;

  const left   = Math.min(...boxes.map(v => v.b.x));
  const top    = Math.min(...boxes.map(v => v.b.y));
  const right  = Math.max(...boxes.map(v => v.b.x + v.b.w));
  const bottom = Math.max(...boxes.map(v => v.b.y + v.b.h));
  const cx = (left + right) / 2;
  const cy = (top  + bottom) / 2;

  for (const { id, b } of boxes) {
    const node = defaultSceneGraph.getNode(id);
    if (!node) continue;
    const px = node.transform.position.x;
    const py = node.transform.position.y;
    switch (mode) {
      case 'left':         setPos(id, px + (left  - b.x),        py); break;
      case 'center-h':     setPos(id, cx,                         py); break;
      case 'right':        setPos(id, px + (right  - (b.x+b.w)), py); break;
      case 'top':          setPos(id, px, py + (top    - b.y));        break;
      case 'middle-v':     setPos(id, px, cy);                         break;
      case 'bottom':       setPos(id, px, py + (bottom - (b.y+b.h)));  break;
      default: break;
    }
  }

  if (mode === 'distribute-h' && boxes.length > 2) {
    const sorted = [...boxes].sort((a, b) => a.b.x - b.b.x);
    const totalW = sorted.reduce((s, v) => s + v.b.w, 0);
    const gap    = (right - left - totalW) / (sorted.length - 1);
    let cursor = left;
    for (const { id, b } of sorted) {
      const node = defaultSceneGraph.getNode(id);
      if (node) setPos(id, cursor + b.w / 2, node.transform.position.y);
      cursor += b.w + gap;
    }
  }

  if (mode === 'distribute-v' && boxes.length > 2) {
    const sorted = [...boxes].sort((a, b) => a.b.y - b.b.y);
    const totalH = sorted.reduce((s, v) => s + v.b.h, 0);
    const gap    = (bottom - top - totalH) / (sorted.length - 1);
    let cursor = top;
    for (const { id, b } of sorted) {
      const node = defaultSceneGraph.getNode(id);
      if (node) setPos(id, node.transform.position.x, cursor + b.h / 2);
      cursor += b.h + gap;
    }
  }

  bumpScene();
}
