/**
 * Vector masks (Prompt 5 — GPU compositing, feature 2).
 *
 * A layer carries a set of closed bezier paths (stored on its `fx` component)
 * that clip what the layer draws. Points live in the layer's LOCAL space, the
 * same centred space Canvas2DBackend draws its primitives in ([-w/2..w/2]), so a
 * mask composes cleanly with the layer transform.
 *
 * This slice implements the data model + presets + geometry (points → cubic
 * segments) + read/write on the scene graph. Rendering (Canvas2D clip) and the
 * inspector consume it. Deferred to later sub-commits: on-canvas pen editing,
 * keyframeable point coordinates (they'll route through the Prompt 2 command
 * system), feather blur, per-mask opacity compositing, and the GPU MaskPass.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

export type MaskMode = 'add' | 'subtract' | 'intersect';

/** A single anchor with absolute in/out bezier handles (local space). */
export interface MaskPoint {
  x: number;
  y: number;
  /** Incoming handle (absolute). Equal to (x,y) for a corner. */
  inX: number;
  inY: number;
  /** Outgoing handle (absolute). Equal to (x,y) for a corner. */
  outX: number;
  outY: number;
}

export interface MaskPath {
  id: string;
  mode: MaskMode;
  /** Closed loop (the only kind that can clip). */
  closed: boolean;
  points: MaskPoint[];
  /** Edge softness in px (stored; blur rendering is a later slice). */
  feather: number;
  /** 0..1 mask strength (stored; compositing is a later slice). */
  opacity: number;
  /** Clip to the OUTSIDE of the path instead of the inside. */
  inverted: boolean;
}

export interface LayerMask {
  paths: MaskPath[];
}

/** A cubic bezier segment between two anchors. */
export interface MaskSegment {
  x0: number; y0: number;
  cx1: number; cy1: number;
  cx2: number; cy2: number;
  x1: number; y1: number;
}

let seq = 0;
function pid(): string {
  return `mask_${(seq += 1)}`;
}

function corner(x: number, y: number): MaskPoint {
  return { x, y, inX: x, inY: y, outX: x, outY: y };
}

/** Rectangle mask filling the layer's local bounds (w×h, centred). */
export function rectangleMask(w: number, h: number): MaskPath {
  const hw = w / 2;
  const hh = h / 2;
  return {
    id: pid(), mode: 'add', closed: true, feather: 0, opacity: 1, inverted: false,
    points: [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)],
  };
}

/** Ellipse mask inscribed in the layer bounds (4-point cubic circle). */
export function ellipseMask(w: number, h: number): MaskPath {
  const rx = w / 2;
  const ry = h / 2;
  const k = 0.5522847498307936; // 4/3·(√2−1): cubic circle constant
  const kx = rx * k;
  const ky = ry * k;
  const pt = (x: number, y: number, inX: number, inY: number, outX: number, outY: number): MaskPoint =>
    ({ x, y, inX, inY, outX, outY });
  return {
    id: pid(), mode: 'add', closed: true, feather: 0, opacity: 1, inverted: false,
    points: [
      pt(0, -ry, -kx, -ry, kx, -ry), // top
      pt(rx, 0, rx, -ky, rx, ky), // right
      pt(0, ry, kx, ry, -kx, ry), // bottom
      pt(-rx, 0, -rx, ky, -rx, -ky), // left
    ],
  };
}

/** Convert a closed path's anchors into the cubic segments that draw it. */
export function maskSegments(path: MaskPath): MaskSegment[] {
  const pts = path.points;
  const n = pts.length;
  if (n < 2) return [];
  const segs: MaskSegment[] = [];
  const last = path.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    segs.push({ x0: a.x, y0: a.y, cx1: a.outX, cy1: a.outY, cx2: b.inX, cy2: b.inY, x1: b.x, y1: b.y });
  }
  return segs;
}

/** Read a node's mask from its `fx` component (undefined when none). */
export function readNodeMask(node: SceneNode): LayerMask | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  const m = fx?.props.mask as LayerMask | undefined;
  return m && Array.isArray(m.paths) && m.paths.length > 0 ? m : undefined;
}

export function getNodeMask(nodeId: string): LayerMask {
  const node = defaultSceneGraph.getNode(nodeId);
  return (node && readNodeMask(node)) ?? { paths: [] };
}

function writeNodeMask(nodeId: string, mask: LayerMask): void {
  defaultSceneGraph.setMask(nodeId, mask.paths.length > 0 ? mask : undefined);
  getEventBus().emit('AnimationChanged', { nodeId });
}

export function addMaskPath(nodeId: string, path: MaskPath): void {
  const mask = getNodeMask(nodeId);
  writeNodeMask(nodeId, { paths: [...mask.paths, path] });
}

export function updateMaskPath(nodeId: string, pathId: string, patch: Partial<MaskPath>): void {
  const mask = getNodeMask(nodeId);
  writeNodeMask(nodeId, {
    paths: mask.paths.map((p) => (p.id === pathId ? { ...p, ...patch } : p)),
  });
}

export function removeMaskPath(nodeId: string, pathId: string): void {
  const mask = getNodeMask(nodeId);
  writeNodeMask(nodeId, { paths: mask.paths.filter((p) => p.id !== pathId) });
}
