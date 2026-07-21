/**
 * Fill paints (Prompt E2 — solids, fills, gradients, strokes).
 *
 * A layer's fill is a paint: a solid colour, a linear gradient, or a radial
 * gradient (multi-stop). It lives on the node's `fx` component (key 'fill'),
 * sibling to blend/mask/matte, so History / autosave / export capture it for
 * free — the same pattern as [[project-motion-editor]] Prompt 5's compositing.
 *
 * Coordinates are LAYER-LOCAL and relative: gradient geometry is expressed in
 * the centred [-0.5..0.5] box, so it composes with any layer size/transform.
 * Both solid and gradient fills render through the Canvas2DVectorRasterizer in
 * the unified GPU engine — no fallback to first-stop approximation.
 *
 * Deferred (like Prompt 5's keyframeable mask points): per-stop colour / angle
 * KEYFRAME animation — the AnimationEngine is scalar-only in v1, so animatable
 * gradients wait on colour/vector tracks. Static editing + undo work now.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';
import { bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';

export interface ColorStop {
  id: string;
  /** Position along the gradient, 0..1. */
  offset: number;
  /** Hex (#rgb/#rrggbb/#rrggbbaa) colour. */
  color: string;
}

export type FillType = 'solid' | 'linear' | 'radial';

export interface SolidFill {
  type: 'solid';
  color: string;
}
export interface LinearFill {
  type: 'linear';
  /** Gradient direction in degrees (0 = →, 90 = ↓). */
  angle: number;
  stops: ColorStop[];
}
export interface RadialFill {
  type: 'radial';
  /** Centre in the relative [0..1] box (0.5,0.5 = middle). */
  cx: number;
  cy: number;
  /** Radius as a fraction of the layer's half-diagonal. */
  radius: number;
  stops: ColorStop[];
}

export type FillPaint = SolidFill | LinearFill | RadialFill;

let seq = 0;
function sid(): string {
  return `stop_${(seq += 1)}`;
}

/** A fresh two-stop ramp from `from`→`to` (defaults: current colour → black). */
export function defaultStops(from = '#ffffff', to = '#000000'): ColorStop[] {
  return [
    { id: sid(), offset: 0, color: from },
    { id: sid(), offset: 1, color: to },
  ];
}

export function makeStop(offset: number, color: string): ColorStop {
  return { id: sid(), offset: clamp01(offset), color };
}

export function solidFill(color: string): SolidFill {
  return { type: 'solid', color };
}
export function linearFill(color = '#ffffff'): LinearFill {
  return { type: 'linear', angle: 90, stops: defaultStops(color, '#000000') };
}
export function radialFill(color = '#ffffff'): RadialFill {
  return { type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, stops: defaultStops(color, '#000000') };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ── Gradient colour sampling (pure — the tested core) ────────────────

interface RGBA { r: number; g: number; b: number; a: number }

/** Parse #rgb / #rrggbb / #rrggbbaa into 0..255 rgba. Falls back to opaque black. */
export function parseHex(hex: string): RGBA {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 6) h += 'ff';
  if (h.length !== 8 || /[^0-9a-fA-F]/.test(h)) return { r: 0, g: 0, b: 0, a: 255 };
  const n = Number.parseInt(h, 16);
  return { r: (n >>> 24) & 0xff, g: (n >>> 16) & 0xff, b: (n >>> 8) & 0xff, a: n & 0xff };
}

function toRgbaString({ r, g, b, a }: RGBA): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(a / 255).toFixed(3)})`;
}

/** Stops sorted by offset (stable), for deterministic sampling + rendering. */
export function sortedStops(stops: ReadonlyArray<ColorStop>): ColorStop[] {
  return [...stops].sort((s1, s2) => s1.offset - s2.offset);
}

/**
 * Sample the gradient colour at position `t` (0..1) with linear rgba
 * interpolation between the surrounding stops. Clamps outside the stop range.
 * Returns a CSS `rgba(...)` string. Pure — the unit-tested core of E2.
 */
export function sampleGradientColor(stops: ReadonlyArray<ColorStop>, t: number): string {
  const s = sortedStops(stops);
  if (s.length === 0) return 'rgba(0, 0, 0, 1.000)';
  if (s.length === 1) return toRgbaString(parseHex(s[0]!.color));
  const x = clamp01(t);
  if (x <= s[0]!.offset) return toRgbaString(parseHex(s[0]!.color));
  const lastStop = s[s.length - 1]!;
  if (x >= lastStop.offset) return toRgbaString(parseHex(lastStop.color));
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]!;
    const b = s[i + 1]!;
    if (x >= a.offset && x <= b.offset) {
      const span = b.offset - a.offset;
      const f = span <= 0 ? 0 : (x - a.offset) / span;
      const ca = parseHex(a.color);
      const cb = parseHex(b.color);
      return toRgbaString({
        r: ca.r + (cb.r - ca.r) * f,
        g: ca.g + (cb.g - ca.g) * f,
        b: ca.b + (cb.b - ca.b) * f,
        a: ca.a + (cb.a - ca.a) * f,
      });
    }
  }
  return toRgbaString(parseHex(lastStop.color));
}

// ── Read / write on the scene graph ──────────────────────────────────

function isFillPaint(v: unknown): v is FillPaint {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  return t === 'solid' || t === 'linear' || t === 'radial';
}

/** Read a node's fill paint from its `fx` component. Falls back to the legacy
 *  solid `fill` string on a style component so pre-E2 nodes keep rendering. */
export function readNodeFill(node: SceneNode): FillPaint | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  const paint = fx?.props.fill;
  if (isFillPaint(paint)) return paint;
  // Legacy: a plain colour string on any component.
  for (const c of node.components) {
    const f = (c.props as Record<string, unknown>).fill;
    if (typeof f === 'string') return solidFill(f);
  }
  return undefined;
}

export function getNodeFill(nodeId: string): FillPaint | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeFill(node) : undefined;
}

// ── Multi-fill (fill STACK, drawn bottom→top) ────────────────────────

function rawFills(node: SceneNode): FillPaint[] | null {
  const fx = node.components.find((c) => c.type === 'fx');
  const arr = fx?.props.fills;
  if (!Array.isArray(arr)) return null;
  const valid = arr.filter(isFillPaint);
  return valid.length > 0 ? valid : null;
}

/**
 * The node's full fill stack. Nodes saved before multi-fill (or edited only
 * through the single-fill API) report their one legacy fill as a 1-element
 * stack, so every consumer can treat fills as an array.
 */
export function readNodeFills(node: SceneNode): FillPaint[] {
  const arr = rawFills(node);
  if (arr) return arr;
  const single = readNodeFill(node);
  return single ? [single] : [];
}

export function getNodeFills(nodeId: string): FillPaint[] {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeFills(node) : [];
}

/**
 * Replace the whole fill stack. The legacy single-fill slot mirrors fills[0]
 * so older readers (text finalFill, GPU backend, exports) keep working.
 */
export function setNodeFills(nodeId: string, fills: FillPaint[]): void {
  defaultSceneGraph.setFills(nodeId, fills.length > 1 ? fills : undefined);
  defaultSceneGraph.setFill(nodeId, fills[0]);
  bumpScene();
  getEventBus().emit('AnimationChanged', { nodeId });
}

/** Set (or clear, when undefined) the node's PRIMARY fill. When a fill stack
 *  exists this edits its first entry (clearing drops it from the stack), so
 *  the single-fill inspector controls and the gradient gizmo stay truthful. */
export function setNodeFill(nodeId: string, paint: FillPaint | undefined): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const arr = node ? rawFills(node) : null;
  if (arr) {
    setNodeFills(nodeId, paint ? [paint, ...arr.slice(1)] : arr.slice(1));
    return;
  }
  defaultSceneGraph.setFill(nodeId, paint);
  bumpScene();
  getEventBus().emit('AnimationChanged', { nodeId });
}

/**
 * Build a Canvas2D gradient for a linear/radial paint over a `w`×`h` box.
 *
 * Geometry is expressed relative to an origin `(ox, oy)`: pass `(0, 0)` when the
 * context is already translated to the box centre (layer fills), or the box
 * centre `(w/2, h/2)` when filling a canvas from its top-left (the GPU
 * background texture). Shared by the Canvas2D backend and the GPU texture
 * rasterizer so both paths produce identical gradients.
 */
export function makeCanvasGradient(
  ctx: CanvasRenderingContext2D,
  paint: LinearFill | RadialFill,
  w: number,
  h: number,
  ox = 0,
  oy = 0,
): CanvasGradient {
  let grad: CanvasGradient;
  if (paint.type === 'linear') {
    // Endpoints span the box along the angle (0°=→, 90°=↓).
    const a = (paint.angle * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    grad = ctx.createLinearGradient(ox - dx * half, oy - dy * half, ox + dx * half, oy + dy * half);
  } else {
    const cx = ox + (paint.cx - 0.5) * w;
    const cy = oy + (paint.cy - 0.5) * h;
    const r = (Math.max(0.01, paint.radius) * Math.hypot(w, h)) / 2;
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  }
  for (const s of sortedStops(paint.stops)) grad.addColorStop(clamp01(s.offset), s.color);
  return grad;
}

/** Switch fill type, preserving colour/stops where sensible. */
export function convertFill(current: FillPaint | undefined, type: FillType): FillPaint {
  const firstColor = current
    ? current.type === 'solid'
      ? current.color
      : sortedStops(current.stops)[0]?.color ?? '#ffffff'
    : '#ffffff';
  if (type === 'solid') return solidFill(firstColor);
  const stops = current && current.type !== 'solid' ? current.stops : defaultStops(firstColor, '#000000');
  if (type === 'linear') {
    return { type: 'linear', angle: current?.type === 'linear' ? current.angle : 90, stops };
  }
  return {
    type: 'radial',
    cx: current?.type === 'radial' ? current.cx : 0.5,
    cy: current?.type === 'radial' ? current.cy : 0.5,
    radius: current?.type === 'radial' ? current.radius : 0.5,
    stops,
  };
}
