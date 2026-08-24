/**
 * Vector masks.
 *
 * A layer carries a set of closed bezier paths (stored on its `fx` component)
 * that clip what the layer draws. Points live in the layer's LOCAL space, the
 * same centred space Canvas2DBackend draws its primitives in ([-w/2..w/2]), so a
 * mask composes cleanly with the layer transform.
 *
 * This module owns the data model, the presets, the geometry (points → cubic
 * segments) and the scene-graph read/write. On-canvas authoring lives in the
 * workspace tools: `mask-rect` / `mask-ellipse` / `mask-pen` create masks;
 * Direct Select (A) edits vertices and tangents. Feather (incl. variable),
 * per-mask opacity and the seven AE combine modes are supported.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';
// Function-level cycle with maskFeather.ts (it builds its outline from
// maskSegments here) — safe because both sides touch the other only inside
// function bodies, never at module evaluation.
import { hasVariableFeather, paintVariableFeatherPath } from './maskFeather';

/**
 * How a mask combines with the matte accumulated from the masks above it.
 *
 * `add`, `subtract` and `intersect` are set operations on coverage; `lighten`,
 * `darken` and `difference` are AE's per-pixel modes, which matter once masks
 * have FEATHER or partial opacity — with hard-edged, fully-opaque masks
 * `lighten` matches `add` and `darken` matches `intersect`, and the difference
 * only appears in the soft overlap.
 *
 * `none` is the odd one out and the reason it exists is worth stating: a `none`
 * mask contributes NOTHING to layer alpha. It is a path that stays in the stack
 * as addressable geometry without clipping anything — which is what lets a mask
 * be used as data rather than as a cut. That is the prerequisite for scoping an
 * effect to a mask region (an effect mask must not modify layer alpha), and for
 * anything else that wants to reference a path without it becoming a hole.
 *
 * It is also AE's 7th mode, so the label is familiar rather than invented.
 */
export type MaskMode = 'none' | 'add' | 'subtract' | 'intersect' | 'lighten' | 'darken' | 'difference';

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
  /**
   * Per-vertex feather DIAMETER override, px (AE's variable-width feather).
   *
   * Absent means "use the path's own `feather`" — which is every stored
   * document, so nothing renders differently until a vertex opts in. When ANY
   * vertex on a path carries one, the whole path renders through the
   * distance-field painter (`maskFeather.ts`), with the width interpolated
   * along the outline between vertices — the uniform blur has one radius and
   * cannot express that.
   */
  feather?: number;
}

export interface MaskPath {
  id: string;
  /** Optional display name — AE's mask list label. */
  name?: string;
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

/**
 * Rounded-rectangle mask filling the layer's local bounds.
 *
 * Used to honour Appearance → Corners on image/video layers (which draw as
 * textured quads and otherwise ignore `cornerRadius`). Eight anchors: ends of
 * each straight side, with cubic handles only on the quarter-circle corners
 * (same κ as `ellipseMask`).
 *
 * `radii` is TL → TR → BR → BL. A single number still works (uniform).
 */
export function roundedRectMask(
  w: number,
  h: number,
  radii: number | readonly [number, number, number, number],
): MaskPath {
  const hw = w / 2;
  const hh = h / 2;
  const raw = typeof radii === 'number' ? [radii, radii, radii, radii] as const : radii;
  // Clamp against box edges so adjacent arcs cannot overlap.
  const scale = (a: number, b: number, limit: number): number => {
    const sum = a + b;
    if (sum <= limit || sum <= 1e-6) return 1;
    return limit / sum;
  };
  let [tl, tr, br, bl] = raw.map((r) => Math.max(0, r)) as [number, number, number, number];
  const s = Math.min(
    scale(tl, tr, w),
    scale(tr, br, h),
    scale(br, bl, w),
    scale(bl, tl, h),
    1,
  );
  tl *= s; tr *= s; br *= s; bl *= s;
  if (tl < 0.5 && tr < 0.5 && br < 0.5 && bl < 0.5) return rectangleMask(w, h);
  const k = 0.5522847498307936;
  const pt = (x: number, y: number, inX: number, inY: number, outX: number, outY: number): MaskPoint =>
    ({ x, y, inX, inY, outX, outY });
  // Clockwise: top edge → TR arc → right → BR → bottom → BL → left → TL arc.
  return {
    id: pid(), mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false,
    points: [
      pt(-hw + tl, -hh, -hw + tl - tl * k, -hh, -hw + tl, -hh),
      pt(hw - tr, -hh, hw - tr, -hh, hw - tr + tr * k, -hh),
      pt(hw, -hh + tr, hw, -hh + tr - tr * k, hw, -hh + tr),
      pt(hw, hh - br, hw, hh - br, hw, hh - br + br * k),
      pt(hw - br, hh, hw - br + br * k, hh, hw - br, hh),
      pt(-hw + bl, hh, -hw + bl, hh, -hw + bl - bl * k, hh),
      pt(-hw, hh - bl, -hw, hh - bl + bl * k, -hw, hh - bl),
      pt(-hw, -hh + tl, -hw, -hh + tl, -hw, -hh + tl - tl * k),
    ],
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

/**
 * The composite op that implements a mask mode against the accumulated matte.
 *
 * `none` has no meaningful answer here — it never reaches the canvas, because
 * `paintMaskMatte` filters it out before compositing. It maps to `source-over`
 * only so the function stays total; a `none` path arriving here is a bug in the
 * caller, not a mask that should be drawn normally.
 */
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
 *
 * `none` never leads the stack for this purpose: it is filtered out before the
 * decision is made, so the question is asked of the first ACTIVE mask. Answering
 * false here is belt-and-braces — a `none` mask must never cause a full-frame
 * fill, since that would make it change the picture.
 */
export function maskModeStartsFull(mode: MaskMode): boolean {
  return mode !== 'add' && mode !== 'lighten' && mode !== 'none';
}

/** The masks that actually affect alpha — everything except `none`. */
export function activeMaskPaths(mask: LayerMask): MaskPath[] {
  return mask.paths.filter((p) => p.mode !== 'none');
}

/**
 * True when the mask stack clips anything at all.
 *
 * A stack of only `none` paths is geometry, not a cut, so the layer must render
 * UNMASKED. Render gates currently test `mask.paths.length > 0`; this is the
 * predicate they should move to when that path is next touched (see the note in
 * `paintMaskMatte`).
 */
export function hasActiveMaskPaths(mask: LayerMask | undefined): boolean {
  return !!mask && mask.paths.some((p) => p.mode !== 'none');
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
  // `none` masks are geometry, not coverage — they never reach the canvas.
  const paths = activeMaskPaths(mask);

  // A stack of only `none` paths must leave the layer UNMASKED, so the matte is
  // fully opaque. Without this the matte would come out empty and the layer
  // would vanish — the exact failure a mode called "none" must not cause.
  //
  // Callers still gate on `mask.paths.length > 0`, so this pass runs and fills
  // the frame rather than being skipped. That is one redundant full-frame fill
  // for an all-`none` stack; correctness first, and `hasActiveMaskPaths` is
  // ready for when those gates are next touched.
  if (paths.length === 0) {
    g.fillStyle = '#fff';
    g.fillRect(-w / 2, -h / 2, w, h);
    return;
  }

  if (maskModeStartsFull(paths[0]!.mode)) {
    g.fillStyle = '#fff';
    g.fillRect(-w / 2, -h / 2, w, h);
  }
  for (const path of paths) {
    const p = maskPathToPath2D(path, w, h);
    if (!p) continue;
    g.save();
    g.globalCompositeOperation = maskModeToComposite(path.mode);
    const op = path.opacity ?? 1;
    g.globalAlpha = op < 0 ? 0 : op > 1 ? 1 : op;
    // Variable-width feather (any vertex with its own value) renders through
    // the distance-field painter — a blur has one radius and cannot vary the
    // softness along the outline. Falls back to the uniform path when the
    // scratch context is unavailable, so headless runtimes lose the variation,
    // not the mask.
    if (hasVariableFeather(path) && paintVariableFeatherPath(g, path, w, h)) {
      g.restore();
      continue;
    }
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
    // Per-vertex feather rides the same interpolation as every other vertex
    // quantity. One side lacking it means "the path's uniform value" — no
    // number to lerp toward, so the animated side's value carries (snapping to
    // undefined mid-tween would flash the whole path back to uniform).
    ...(typeof p.feather === 'number' || typeof q.feather === 'number'
      ? { feather: lerp(p.feather ?? q.feather ?? 0, q.feather ?? p.feather ?? 0, f) }
      : {}),
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

// ── Per-property mask tracks (AE's Mask Feather / Opacity / Expansion) ──

/** The per-path mask settings that animate as ordinary numeric tracks. */
export const MASK_PROPERTY_KEYS = ['feather', 'opacity', 'expansion'] as const;
export type MaskPropertyKey = (typeof MASK_PROPERTY_KEYS)[number];

/**
 * The animation prop path for one mask path's setting: `mask.<pathId>.feather`.
 *
 * Id-scoped like effect params and path operators, so reordering or deleting
 * a sibling path cannot hand a keyframe to the wrong mask.
 */
export function maskPropPath(pathId: string, key: MaskPropertyKey): string {
  return `mask.${pathId}.${key}`;
}

export function parseMaskPropPath(prop: string): { pathId: string; key: MaskPropertyKey } | null {
  const m = /^mask\.([^.]+)\.(feather|opacity|expansion)$/.exec(prop);
  return m ? { pathId: m[1]!, key: m[2] as MaskPropertyKey } : null;
}

/**
 * Lay the frame's animated mask settings over the resolved mask.
 *
 * The SHAPE still comes from the whole-mask snapshot track (or the static
 * mask); this is the other half of AE's model — Feather, Opacity and
 * Expansion as independent curves. `av` is the node's evaluated map for the
 * frame. A path with no tracks is returned as-is (same object), so the mask
 * raster cache keyed on the mask's identity keeps hitting for static masks.
 */
export function applyMaskPropertyTracks(
  mask: LayerMask | undefined,
  av: ReadonlyMap<string, number> | undefined,
): LayerMask | undefined {
  if (!mask || !av || av.size === 0) return mask;
  let changed = false;
  const paths = mask.paths.map((p) => {
    const f = av.get(maskPropPath(p.id, 'feather'));
    const o = av.get(maskPropPath(p.id, 'opacity'));
    const e = av.get(maskPropPath(p.id, 'expansion'));
    if (f === undefined && o === undefined && e === undefined) return p;
    changed = true;
    return {
      ...p,
      ...(f !== undefined ? { feather: Math.max(0, f) } : {}),
      // Opacity tracks are 0..100 like every other opacity in the registry;
      // the mask stores 0..1.
      ...(o !== undefined ? { opacity: Math.max(0, Math.min(1, o / 100)) } : {}),
      ...(e !== undefined ? { expansion: e } : {}),
    };
  });
  return changed ? { ...mask, paths } : mask;
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

/**
 * Move one mask keyframe along the time axis.
 *
 * The timeline draws mask keyframes as diamonds on the layer's Mask Shape row,
 * and a diamond you can see but not drag is a control that looks broken. The
 * shape travels with the keyframe untouched — this is a retime, not an edit.
 */
export function moveMaskKeyframe(nodeId: string, fromT: number, toT: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const kfs = readNodeMaskAnim(node);
  const moving = kfs.find((k) => Math.abs(k.t - fromT) < 1e-4);
  if (!moving) return;
  // Landing on an existing keyframe REPLACES it, matching every other track:
  // two shapes at one time is not a state the interpolator can express.
  const next = kfs
    .filter((k) => k !== moving && Math.abs(k.t - toT) > 1e-4)
    .concat({ ...moving, t: toT })
    .sort((a, b) => a.t - b.t);
  defaultSceneGraph.setMaskAnim(nodeId, next);
  getEventBus().emit('AnimationChanged', { nodeId });
}

/**
 * Delete one mask keyframe. Removing the LAST one clears the animation
 * outright, so the mask goes back to reading its static shape rather than being
 * left with a one-keyframe track that pins it forever.
 */
export function removeMaskKeyframe(nodeId: string, t: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const next = readNodeMaskAnim(node).filter((k) => Math.abs(k.t - t) > 1e-4);
  defaultSceneGraph.setMaskAnim(nodeId, next.length > 0 ? next : undefined);
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

/**
 * Set (or clear, with undefined) one vertex's feather override — the write
 * behind the variable-width feather rows. Clearing removes the KEY rather than
 * writing 0: an absent override means "the path's uniform value", and a path
 * whose every override is cleared drops back to the plain blur renderer.
 */
export function setMaskPointFeather(
  nodeId: string,
  pathId: string,
  pointIndex: number,
  feather: number | undefined,
  t?: number,
): void {
  editMaskAt(nodeId, t, (mask) => ({
    paths: mask.paths.map((p) => {
      if (p.id !== pathId) return p;
      const points = p.points.map((pt, i) => {
        if (i !== pointIndex) return pt;
        if (feather === undefined) {
          const { feather: _drop, ...rest } = pt;
          return rest as MaskPoint;
        }
        return { ...pt, feather: Math.max(0, feather) };
      });
      return { ...p, points };
    }),
  }));
}
