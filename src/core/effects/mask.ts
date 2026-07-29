/**
 * Vector masks.
 *
 * A layer carries a set of closed bezier paths (stored on its `fx` component)
 * that clip what the layer draws. Points live in the layer's LOCAL space, the
 * same centred space Canvas2DBackend draws its primitives in ([-w/2..w/2]), so a
 * mask composes cleanly with the layer transform.
 *
 * This module owns the data model, the presets, the geometry (points → cubic
 * segments) and the scene-graph read/write. The rasterizer and the inspector
 * consume it. Not yet supported: on-canvas pen editing of mask points, feather
 * blur, and per-mask opacity compositing.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

/**
 * How a mask combines with the matte accumulated from the masks above it.
 *
 * The first three are set operations on coverage; `lighten`, `darken` and
 * `difference` are AE's per-pixel modes, which matter once masks have FEATHER
 * or partial opacity — with hard-edged, fully-opaque masks `lighten` matches
 * `add` and `darken` matches `intersect`, and the difference only appears in
 * the soft overlap.
 */
export type MaskMode = 'add' | 'subtract' | 'intersect' | 'lighten' | 'darken' | 'difference';

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
  /** Edge softness in px (a diameter, as in AE; the backend blurs by half). */
  feather: number;
  /** 0..1 mask strength. */
  opacity: number;
  /** Outline expansion/dilation in px (positive dilates outward, negative erodes inward). */
  expansion: number;
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
    id: pid(), mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false,
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
    id: pid(), mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false,
    points: [
      pt(0, -ry, -kx, -ry, kx, -ry), // top
      pt(rx, 0, rx, -ky, rx, ky), // right
      pt(0, ry, kx, ry, -kx, ry), // bottom
      pt(-rx, 0, -rx, ky, -rx, -ky), // left
    ],
  };
}

/** Dilate or erode points along vertex normals by `expansion` pixels. */
export function expandMaskPoints(points: MaskPoint[], expansion: number): MaskPoint[] {
  if (!expansion || Math.abs(expansion) < 1e-4 || points.length < 2) return points;
  const n = points.length;
  return points.map((curr, i) => {
    const prev = points[(i - 1 + n) % n]!;
    const next = points[(i + 1) % n]!;

    // Incoming tangent arriving at curr
    let vx1 = curr.x - curr.inX;
    let vy1 = curr.y - curr.inY;
    if (Math.hypot(vx1, vy1) < 1e-4) {
      vx1 = curr.x - prev.x;
      vy1 = curr.y - prev.y;
    }
    const l1 = Math.hypot(vx1, vy1) || 1;
    const nx1 = vy1 / l1;
    const ny1 = -vx1 / l1;

    // Outgoing tangent leaving curr
    let vx2 = curr.outX - curr.x;
    let vy2 = curr.outY - curr.y;
    if (Math.hypot(vx2, vy2) < 1e-4) {
      vx2 = next.x - curr.x;
      vy2 = next.y - curr.y;
    }
    const l2 = Math.hypot(vx2, vy2) || 1;
    const nx2 = vy2 / l2;
    const ny2 = -vx2 / l2;

    // Average normal at vertex (miter bisector)
    const nx = (nx1 + nx2) / 2;
    const ny = (ny1 + ny2) / 2;
    const nLen = Math.hypot(nx, ny) || 1;
    const factor = expansion / Math.max(0.2, nLen);

    const dx = nx * factor;
    const dy = ny * factor;

    return {
      x: curr.x + dx,
      y: curr.y + dy,
      inX: curr.inX + dx,
      inY: curr.inY + dy,
      outX: curr.outX + dx,
      outY: curr.outY + dy,
    };
  });
}

/** Convert a closed path's anchors into the cubic segments that draw it. */
export function maskSegments(path: MaskPath): MaskSegment[] {
  const pts = expandMaskPoints(path.points, path.expansion ?? 0);
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

/**
 * One mask path as a Path2D in layer-local (centred) space.
 *
 * An inverted path covers everything EXCEPT its outline, which even-odd gives
 * us for free by adding the layer rect around it.
 */
export function maskPathToPath2D(path: MaskPath, width: number, height: number): Path2D | null {
  const segs = maskSegments(path);
  if (segs.length === 0) return null;
  const p = new Path2D();
  if (path.inverted) p.rect(-width / 2, -height / 2, width, height);
  p.moveTo(segs[0]!.x0, segs[0]!.y0);
  for (const s of segs) p.bezierCurveTo(s.cx1, s.cy1, s.cx2, s.cy2, s.x1, s.y1);
  p.closePath();
  return p;
}

/** The composite op that implements a mask mode against the accumulated matte. */
export function maskModeToComposite(mode: MaskMode): GlobalCompositeOperation {
  switch (mode) {
    case 'subtract': return 'destination-out';
    case 'intersect': return 'destination-in';
    // The matte is a white-on-transparent coverage map, so the separable blend
    // modes act on COVERAGE: `lighten` keeps the greater of the two (a softer
    // union than `add`, which sums toward opaque), `darken` the lesser (a
    // softer intersection), and `difference` the absolute gap — which is what
    // makes an XOR-style cut-out of two overlapping feathered masks.
    case 'lighten': return 'lighten';
    case 'darken': return 'darken';
    case 'difference': return 'difference';
    case 'add':
    default: return 'source-over';
  }
}

/**
 * Modes that need a full-frame starting matte when they lead the stack.
 *
 * `add` and `lighten` build up from nothing, so they start empty. Everything
 * else REMOVES from what is already there — leading with one against an empty
 * matte would erase from nothing and the layer would simply vanish, which is
 * the AE behaviour this preserves.
 */
export function maskModeStartsFull(mode: MaskMode): boolean {
  return mode !== 'add' && mode !== 'lighten';
}

/**
 * Paint a layer's masks into `g` as a white alpha matte, honouring MODE
 * (Add paints / Subtract erases / Intersect keeps the overlap / Lighten,
 * Darken and Difference blend coverage per-pixel), FEATHER
 * (canvas blur at half the AE diameter) and per-mask OPACITY — the single
 * shared implementation both render backends rasterize through, so the GPU
 * path cannot drift from Canvas2D again (it used to union everything with one
 * even-odd fill, which XOR'd two Add masks and ignored feather/opacity).
 *
 * Expects `g` already cleared, with its transform placing the origin at the
 * layer centre (masks are stored in centred local space). A leading Subtract
 * or Intersect starts from a full frame, as in AE — otherwise it would erase
 * from nothing and the layer would simply vanish.
 */
export function paintMaskMatte(
  g: CanvasRenderingContext2D,
  mask: LayerMask,
  w: number,
  h: number,
): void {
  if (mask.paths[0] && maskModeStartsFull(mask.paths[0].mode)) {
    g.fillStyle = '#fff';
    g.fillRect(-w / 2, -h / 2, w, h);
  }
  for (const path of mask.paths) {
    const p = maskPathToPath2D(path, w, h);
    if (!p) continue;
    g.save();
    g.globalCompositeOperation = maskModeToComposite(path.mode);
    const op = path.opacity ?? 1;
    g.globalAlpha = op < 0 ? 0 : op > 1 ? 1 : op;
    // Feather is a diameter in AE terms; blur takes a radius.
    if (path.feather > 0) g.filter = `blur(${path.feather / 2}px)`;
    g.fillStyle = '#fff';
    g.fill(p, 'evenodd');
    g.restore();
  }
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

// ── Animated mask paths (keyframeable mask shapes) ───────────────────

export interface MaskKeyframe {
  t: number;
  mask: LayerMask;
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

function lerpPoint(p: MaskPoint, q: MaskPoint, f: number): MaskPoint {
  return {
    x: lerp(p.x, q.x, f), y: lerp(p.y, q.y, f),
    inX: lerp(p.inX, q.inX, f), inY: lerp(p.inY, q.inY, f),
    outX: lerp(p.outX, q.outX, f), outY: lerp(p.outY, q.outY, f),
  };
}

/**
 * Interpolate an animated mask at time `t`. Paths/points are paired by index and
 * lerped; a path whose point count differs between keyframes snaps to the nearer
 * keyframe (no vertex-count morph). Pure. Returns undefined for no keyframes.
 */
export function interpolateMask(kfs: ReadonlyArray<MaskKeyframe>, t: number): LayerMask | undefined {
  if (kfs.length === 0) return undefined;
  const s = [...kfs].sort((a, b) => a.t - b.t);
  if (s.length === 1 || t <= s[0]!.t) return s[0]!.mask;
  if (t >= s[s.length - 1]!.t) return s[s.length - 1]!.mask;
  let a = s[0]!;
  let b = s[s.length - 1]!;
  for (let i = 0; i < s.length - 1; i++) {
    if (t >= s[i]!.t && t <= s[i + 1]!.t) { a = s[i]!; b = s[i + 1]!; break; }
  }
  const f = (t - a.t) / ((b.t - a.t) || 1);
  const paths = a.mask.paths.map((pa, i) => {
    const pb = b.mask.paths[i];
    if (!pb || pb.points.length !== pa.points.length) return f < 0.5 ? pa : (pb ?? pa);
    return {
      ...pa,
      feather: lerp(pa.feather, pb.feather, f),
      opacity: lerp(pa.opacity, pb.opacity, f),
      expansion: lerp(pa.expansion ?? 0, pb.expansion ?? 0, f),
      points: pa.points.map((pt, j) => lerpPoint(pt, pb.points[j]!, f)),
    };
  });
  return { paths };
}

/** Read the node's mask keyframes (empty when none). */
export function readNodeMaskAnim(node: SceneNode): MaskKeyframe[] {
  const fx = node.components.find((c) => c.type === 'fx');
  const raw = (fx?.props as Record<string, unknown> | undefined)?.maskAnim;
  return Array.isArray(raw) ? (raw as MaskKeyframe[]) : [];
}

/** True when the mask is animated. */
export function hasMaskAnim(node: SceneNode): boolean {
  return readNodeMaskAnim(node).length > 0;
}

/** The mask to render at time `t` — the interpolated animated shape when the
 *  mask is keyframed, else the static mask. */
export function readNodeMaskAt(node: SceneNode, t: number): LayerMask | undefined {
  const anim = readNodeMaskAnim(node);
  if (anim.length > 0) {
    const m = interpolateMask(anim, t);
    return m && m.paths.length > 0 ? m : undefined;
  }
  return readNodeMask(node);
}

/** Keyframe the layer's current mask shape at time `t` (replaces same-t kf). */
export function keyframeMask(nodeId: string, t: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const mask = readNodeMaskAt(node, t) ?? readNodeMask(node);
  if (!mask || mask.paths.length === 0) return;
  const kfs = readNodeMaskAnim(node).filter((k) => Math.abs(k.t - t) > 1e-4);
  kfs.push({ t, mask });
  kfs.sort((a, b) => a.t - b.t);
  defaultSceneGraph.setMaskAnim(nodeId, kfs);
  getEventBus().emit('AnimationChanged', { nodeId });
}

/** Remove all mask keyframes (mask reverts to its static shape). */
export function clearMaskAnim(nodeId: string): void {
  defaultSceneGraph.setMaskAnim(nodeId, undefined);
  getEventBus().emit('AnimationChanged', { nodeId });
}

function writeNodeMask(nodeId: string, mask: LayerMask): void {
  defaultSceneGraph.setMask(nodeId, mask.paths.length > 0 ? mask : undefined);
  getEventBus().emit('AnimationChanged', { nodeId });
}

/**
 * Edit whichever mask the RENDERER will actually read, at time `t`.
 *
 * The trap this closes: once a mask is keyframed, `readNodeMaskAt` returns the
 * interpolated shape and ignores the static one — but every mutator wrote the
 * static mask. So on an animated mask, changing mode/feather/opacity/expansion
 * did nothing visible, and there was no way for an edit to ever reach the
 * animation. Now, as in After Effects, editing an animated mask writes a
 * keyframe at the playhead.
 *
 * Callers that have no time (headless, tests) fall back to the static mask,
 * which is correct for a mask that isn't animated.
 */
function editMaskAt(nodeId: string, t: number | undefined, fn: (mask: LayerMask) => LayerMask): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const anim = readNodeMaskAnim(node);

  if (anim.length > 0 && t !== undefined) {
    const current = interpolateMask(anim, t) ?? readNodeMask(node) ?? { paths: [] };
    const kfs = anim.filter((k) => Math.abs(k.t - t) > 1e-4);
    kfs.push({ t, mask: fn(current) });
    kfs.sort((a, b) => a.t - b.t);
    defaultSceneGraph.setMaskAnim(nodeId, kfs);
    getEventBus().emit('AnimationChanged', { nodeId });
    return;
  }

  writeNodeMask(nodeId, fn(getNodeMask(nodeId)));
}

/**
 * Apply a STRUCTURAL change (adding or removing a whole path) everywhere.
 *
 * `interpolateMask` pairs paths by index, so keyframes must agree on their path
 * count — writing a new path into one keyframe only would make the mask snap
 * between shapes instead of morphing.
 */
function editEveryMaskState(nodeId: string, fn: (mask: LayerMask) => LayerMask): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;

  writeNodeMask(nodeId, fn(getNodeMask(nodeId)));

  const anim = readNodeMaskAnim(node);
  if (anim.length > 0) {
    defaultSceneGraph.setMaskAnim(nodeId, anim.map((k) => ({ t: k.t, mask: fn(k.mask) })));
    getEventBus().emit('AnimationChanged', { nodeId });
  }
}

export function addMaskPath(nodeId: string, path: MaskPath): void {
  editEveryMaskState(nodeId, (mask) => ({ paths: [...mask.paths, path] }));
}

/**
 * Patch one mask path. Pass `t` (the playhead) so edits to an ANIMATED mask
 * land on a keyframe rather than on the static shape nothing renders.
 */
export function updateMaskPath(nodeId: string, pathId: string, patch: Partial<MaskPath>, t?: number): void {
  editMaskAt(nodeId, t, (mask) => ({
    paths: mask.paths.map((p) => (p.id === pathId ? { ...p, ...patch } : p)),
  }));
}

export function removeMaskPath(nodeId: string, pathId: string): void {
  editEveryMaskState(nodeId, (mask) => ({ paths: mask.paths.filter((p) => p.id !== pathId) }));
}

/**
 * Move a mask's vertices (the pen/direct-select drag on canvas).
 *
 * `updateMaskPath` was never once called with `points`, so a mask's shape was
 * frozen the moment it was created — and mask path animation, which morphs
 * exactly these points, had no way to be authored.
 */
export function setMaskPoints(nodeId: string, pathId: string, points: MaskPoint[], t?: number): void {
  updateMaskPath(nodeId, pathId, { points }, t);
}
