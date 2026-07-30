/**
 * Fill paints — solids, gradients and strokes.
 *
 * A layer's fill is a paint: a solid colour, a linear gradient, or a radial
 * gradient (multi-stop). It lives on the node's `fx` component (key 'fill'),
 * sibling to blend/mask/matte, so History, autosave and export capture it for
 * free without any extra wiring.
 *
 * Coordinates are LAYER-LOCAL and relative: gradient geometry is expressed in
 * the centred [-0.5..0.5] box, so it composes with any layer size/transform.
 * Both solid and gradient fills render through the Canvas2DVectorRasterizer in
 * the GPU engine — no fallback to a first-stop approximation.
 *
 * Not yet supported: KEYFRAMING per-stop colour or gradient angle. The
 * AnimationEngine holds scalar tracks only, so animatable gradients wait on
 * colour/vector track support. Static editing and undo work today.
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

/**
 * An OPACITY stop — a separate list from the colour stops.
 *
 * Photoshop and After Effects keep colour and opacity as two independent stop
 * lists, and copying that is deliberate: it is the difference between "fade
 * this gradient out at the top" (one opacity stop) and "duplicate every colour
 * stop so you can add alpha to each" (what a single combined list forces).
 * CSS gradients have no equivalent, which is why the naive model everyone
 * reaches for first is the combined one.
 */
export interface OpacityStop {
  id: string;
  /** Position along the same axis as the colour stops, 0..1. */
  offset: number;
  /** 0..1. */
  opacity: number;
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
  /** Independent opacity ramp. Absent = fully opaque throughout. */
  opacityStops?: OpacityStop[];
}
export interface RadialFill {
  type: 'radial';
  /** Centre in the relative [0..1] box (0.5,0.5 = middle). */
  cx: number;
  cy: number;
  /** Radius as a fraction of the layer's half-diagonal. */
  radius: number;
  stops: ColorStop[];
  /** Independent opacity ramp. Absent = fully opaque throughout. */
  opacityStops?: OpacityStop[];
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
  const raw = hex.trim();
  // `rgb()` / `rgba()` as well as hex, because this module PRODUCES that form:
  // `sampleGradientColor` and `toRgbaString` both return `rgba(r, g, b, a)`.
  // Feeding one of those back in — sampling a gradient and then compositing an
  // overlay over the result, say — used to fall through to the failure return
  // and come back opaque BLACK, silently. Accepting it is purely additive: no
  // caller ever wanted black for a colour this file just wrote.
  const fn = /^rgba?\(([^)]+)\)$/i.exec(raw);
  if (fn) {
    const parts = fn[1]!.split(/[,\s/]+/).filter((s) => s.length > 0).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
      const alpha = parts.length > 3 && Number.isFinite(parts[3]!) ? parts[3]! : 1;
      return {
        r: clamp255(parts[0]!),
        g: clamp255(parts[1]!),
        b: clamp255(parts[2]!),
        a: clamp255(Math.max(0, Math.min(1, alpha)) * 255),
      };
    }
    return { r: 0, g: 0, b: 0, a: 255 };
  }
  let h = raw.replace(/^#/, '');
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
  // Colour and opacity are separate ramps, so the canvas gradient is built from
  // their MERGED offsets — a stop from either list becomes a stop in the
  // result, with the other channel sampled at that offset. Without the merge,
  // an opacity stop between two colour stops would simply be ignored.
  const colors = sortedStops(paint.stops);
  const alphas = sortedOpacityStops(paint.opacityStops);
  if (alphas.length === 0) {
    for (const s of colors) grad.addColorStop(clamp01(s.offset), s.color);
    return grad;
  }
  const offsets = [...new Set([...colors.map((c) => c.offset), ...alphas.map((a) => a.offset)])]
    .map(clamp01)
    .sort((p, q) => p - q);
  for (const off of offsets) {
    grad.addColorStop(off, applyAlpha(sampleGradientColor(colors, off), sampleGradientOpacity(alphas, off)));
  }
  return grad;
}

/** Opacity stops sorted by offset ([] when the gradient has none). */
export function sortedOpacityStops(stops: ReadonlyArray<OpacityStop> | undefined): OpacityStop[] {
  return stops ? [...stops].sort((a, b) => a.offset - b.offset) : [];
}

/**
 * Opacity at `t` along the ramp. Clamps outside the stop range, and returns 1
 * for an empty list so a gradient without an opacity ramp is fully opaque.
 */
export function sampleGradientOpacity(stops: ReadonlyArray<OpacityStop>, t: number): number {
  const s = sortedOpacityStops(stops);
  if (s.length === 0) return 1;
  if (t <= s[0]!.offset) return s[0]!.opacity;
  const last = s[s.length - 1]!;
  if (t >= last.offset) return last.opacity;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]!;
    const b = s[i + 1]!;
    if (t >= a.offset && t <= b.offset) {
      const span = b.offset - a.offset;
      const u = span === 0 ? 0 : (t - a.offset) / span;
      return a.opacity + (b.opacity - a.opacity) * u;
    }
  }
  return last.opacity;
}

/**
 * The colour this paint resolves to at ONE point of the box, in the same
 * centred local space `makeCanvasGradient` builds in (origin at the box
 * centre, x ∈ [−w/2, w/2], y ∈ [−h/2, h/2]).
 *
 * Deliberately adjacent to `makeCanvasGradient`, and duplicating its geometry
 * line for line, because the two MUST agree: this is how a surface that can
 * only be one flat colour finds out which colour it should be, and if it
 * disagreed with the gradient the renderer actually draws, the two would meet
 * along a visible seam.
 *
 * The caller is an extruded solid's side walls. Each wall is a flat strip the
 * renderer synthesizes, and it used to take `layer.fill` — the layer's BASE
 * colour, which a gradient fill never updates. So a blue→orange gradient box
 * rendered its front and back caps as the gradient and all four walls as flat
 * blue: one object in two unrelated colours, split along the front edge. A
 * cylinder did the same across all twenty of its wall segments. Sampling each
 * face at its own centre makes the walls belong to the object — the top wall
 * takes the colour at the top edge, the bottom wall the colour at the bottom,
 * and a cylinder's segments wrap smoothly around the ramp.
 *
 * Returns undefined for a paint with no resolvable colour, so callers keep
 * whatever fallback they already had.
 */
export function sampleFillAt(
  paint: FillPaint | undefined,
  w: number,
  h: number,
  x: number,
  y: number,
): string | undefined {
  if (!paint) return undefined;
  if (paint.type === 'solid') return typeof paint.color === 'string' ? paint.color : undefined;

  let t: number;
  if (paint.type === 'linear') {
    // Endpoints span the box along the angle (0°=→, 90°=↓) — makeCanvasGradient.
    const a = (paint.angle * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    // Project onto the axis and renormalise from [−half, half] to [0, 1].
    t = half <= 0 ? 0 : clamp01((x * dx + y * dy + half) / (2 * half));
  } else {
    const cx = (paint.cx - 0.5) * w;
    const cy = (paint.cy - 0.5) * h;
    const r = (Math.max(0.01, paint.radius) * Math.hypot(w, h)) / 2;
    t = r <= 0 ? 0 : clamp01(Math.hypot(x - cx, y - cy) / r);
  }

  const colors = sortedStops(paint.stops);
  if (colors.length === 0) return undefined;
  const color = sampleGradientColor(colors, t);
  const alphas = sortedOpacityStops(paint.opacityStops);
  return alphas.length === 0 ? color : applyAlpha(color, sampleGradientOpacity(alphas, t));
}

/** Multiply a hex colour's alpha by `opacity`, returning 8-digit hex. */
export function applyAlpha(hex: string, opacity: number): string {
  const c = parseHex(hex);
  const a = Math.max(0, Math.min(255, Math.round(c.a * clamp01(opacity))));
  const h = (v: number): string => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${h(a)}`;
}

/** A fresh two-stop opacity ramp, opaque throughout. */
export function defaultOpacityStops(): OpacityStop[] {
  return [
    { id: sid(), offset: 0, opacity: 1 },
    { id: sid(), offset: 1, opacity: 1 },
  ];
}

/** A new opacity stop. */
export function makeOpacityStop(offset: number, opacity: number): OpacityStop {
  return { id: sid(), offset: clamp01(offset), opacity: clamp01(opacity) };
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
