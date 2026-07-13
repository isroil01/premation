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
 * The Canvas2D backend maps them to pixels; the GPU backend uses the first stop
 * (documented gap) until gradient paints land in @motion/renderer.
 *
 * Deferred (like Prompt 5's keyframeable mask points): per-stop colour / angle
 * KEYFRAME animation — the AnimationEngine is scalar-only in v1, so animatable
 * gradients wait on colour/vector tracks. Static editing + undo work now.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

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

/** Set (or clear, when undefined) the node's fill paint. */
export function setNodeFill(nodeId: string, paint: FillPaint | undefined): void {
  defaultSceneGraph.setFill(nodeId, paint);
  getEventBus().emit('AnimationChanged', { nodeId });
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
