/**
 * Shared Canvas2D vector-drawing primitives (engine-unification Phase 1).
 *
 * MOVED VERBATIM out of Canvas2DBackend so BOTH the reference Canvas2D backend
 * and the GPU path's AppTextureProvider rasterise vector content (shape paths,
 * strokes with joins/caps/dash + alignment, trim) through ONE implementation.
 * The GPU side previously re-hand-rolled its own path/stroke code, which drifted
 * from Canvas2D (the golden suite measures ~10% on stroke joins). This is the
 * single source those two copies collapse onto.
 *
 * Pure w.r.t. a passed-in 2D context — no instance state, no globals, no time.
 * Coordinates are the layer's centred local space (origin at the box centre).
 */

import type { RenderLayer } from '../RenderBackend';
import { makeCanvasGradient, type FillPaint } from '@core/paint/fill';
import type { Stroke } from '@core/paint/stroke';
import { trimPolyline, type Pt } from '@core/scene/trimPath';

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Extra px the rasterizer must pad around a shape's tight w×h box so stroke
 * overshoot isn't clipped at the texture boundary. A center-aligned stroke
 * extends ~half its width beyond the path (more at miter tips); an outside
 * stroke extends a full width (plus miter). Without this the GPU `path:` texture
 * clips the outer stroke band that Canvas2D — drawing on the full canvas — shows.
 *
 * The SAME value sizes the raster canvas (AppTextureProvider.rasterizePath) AND
 * grows the placement quad (snapshotToFrameScene), so texture and placement stay
 * aligned without threading state — both derive it from the layer.
 *
 * Returns 0 for anything that needs no bleed (unstroked shapes, text, image).
 * Over-padding is harmless (transparent margin), so the bounds are generous
 * enough to contain miter joins. Mask feather is intentionally excluded — the
 * feathered-mask scenes already match without a larger box, and growing it would
 * perturb them.
 */
export function rasterPadding(layer: RenderLayer): number {
  if (layer.kind !== 'shape') return 0;
  let pad = 0;
  const strokes = layer.strokes && layer.strokes.length > 0 ? layer.strokes : layer.stroke ? [layer.stroke] : [];
  for (const s of strokes) {
    if (!s || s.width <= 0) continue;
    // center/miter: a full width covers the half-width band + a 90° miter tip
    // (~0.71×w). outside: the band sits fully outside (~1×w) + miter → 2×w.
    const overshoot = s.align === 'outside' ? s.width * 2 : s.align === 'inside' ? 0 : s.width;
    if (overshoot > pad) pad = overshoot;
  }
  if (layer.paint && layer.paint.strokes.length > 0) {
    let maxStroke = 0;
    for (const s of layer.paint.strokes) {
      if (s.size > maxStroke) maxStroke = s.size;
    }
    if (maxStroke / 2 > pad) pad = maxStroke / 2;
  }
  return pad > 0 ? Math.ceil(pad + 1) : 0;
}

/** Resolve a layer's fill into a Canvas fillStyle. Gradients are built in the
 *  layer's centred local space ([-w/2..w/2]); falls back to the solid string. */
export function fillStyleFor(
  ctx: CanvasRenderingContext2D,
  paint: FillPaint | undefined,
  fallback: string,
  w: number,
  h: number,
): string | CanvasGradient {
  if (!paint || paint.type === 'solid') return fallback;
  // Context is translated to the box centre at every call site → origin (0, 0).
  return makeCanvasGradient(ctx, paint, w, h);
}

/** Apply a stroke's paint state (colour+opacity, width, dash, cap, join).
 *  A gradient `paint` overrides the solid colour — built in the layer's
 *  centred local space, so pass the layer's w/h at shape call sites. */
export function applyStrokeStyle(ctx: CanvasRenderingContext2D, stroke: Stroke, w = 100, h = 100): void {
  ctx.globalAlpha *= clamp01(stroke.opacity);
  ctx.strokeStyle =
    stroke.paint && stroke.paint.type !== 'solid'
      ? fillStyleFor(ctx, stroke.paint, stroke.color, w, h)
      : (stroke.paint?.type === 'solid' ? stroke.paint.color : stroke.color);
  ctx.lineWidth = stroke.width;
  ctx.lineCap = stroke.cap;
  ctx.lineJoin = stroke.join;
  ctx.setLineDash(stroke.dash.length ? stroke.dash : []);
}

/** Sample the layer's fill outline into a polyline (for trim stroking). */
export function outlinePolyline(layer: RenderLayer): { pts: Pt[]; closed: boolean } {
  const w = layer.width;
  const h = layer.height;
  if (layer.primitive === 'ellipse') {
    const pts: Pt[] = [];
    const N = 64;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * (w / 2), y: Math.sin(a) * (h / 2) });
    }
    return { pts, closed: true };
  }
  if (layer.primitive === 'path' && layer.pathPoints && layer.pathPoints.length > 1) {
    return { pts: layer.pathPoints.map((p) => ({ x: p.x, y: p.y })), closed: layer.pathOpen !== true };
  }
  return {
    pts: [
      { x: -w / 2, y: -h / 2 },
      { x: w / 2, y: -h / 2 },
      { x: w / 2, y: h / 2 },
      { x: -w / 2, y: h / 2 },
    ],
    closed: true,
  };
}

/** Stroke only the trim-path visible arcs of the shape outline (MG-C). */
export function strokeTrimmed(ctx: CanvasRenderingContext2D, layer: RenderLayer, stroke: Stroke): void {
  const { pts, closed } = outlinePolyline(layer);
  const subs = trimPolyline(pts, closed, layer.trim ?? []);
  ctx.save();
  applyStrokeStyle(ctx, stroke);
  for (const sub of subs) {
    if (sub.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(sub[0]!.x, sub[0]!.y);
    for (let i = 1; i < sub.length; i++) ctx.lineTo(sub[i]!.x, sub[i]!.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Trace the layer's fill outline (centred at 0,0) without painting it. */
export function shapePath(ctx: CanvasRenderingContext2D, layer: RenderLayer): void {
  const w = layer.width;
  const h = layer.height;
  if (layer.primitive === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (layer.primitive === 'path' && layer.pathPoints && layer.pathPoints.length > 0) {
    ctx.beginPath();
    const pts = layer.pathPoints;
    // Open strokes (line / freehand pencil) stop at the last point; closed
    // shapes wrap the final segment back to the first and close.
    const open = layer.pathOpen === true;
    // Move to first anchor
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    // Draw cubic bezier segments: each segment uses outgoing handle of current point
    // and incoming handle of next point
    const lastSeg = open ? pts.length - 1 : pts.length;
    for (let i = 0; i < lastSeg; i++) {
      const curr = pts[i]!;
      const next = pts[(i + 1) % pts.length]!;
      ctx.bezierCurveTo(
        curr.outX, curr.outY,   // outgoing handle of current
        next.inX,  next.inY,    // incoming handle of next
        next.x,    next.y,      // next anchor
      );
    }
    if (!open) ctx.closePath();
  } else {
    roundRect(ctx, -w / 2, -h / 2, w, h, layer.cornerRadius ?? 0);
  }
}

/** Stroke a shape honouring width/colour/opacity/dash/cap/join + alignment.
 *  'center' straddles the edge; 'inside'/'outside' clip one half away. */
export function strokeShape(ctx: CanvasRenderingContext2D, stroke: Stroke, trace: () => void, w = 100, h = 100): void {
  if (stroke.width <= 0) return;
  ctx.save();
  if (stroke.align !== 'center') {
    // Clip to (inside) or out of (outside) the fill, then stroke double-width
    // so exactly the desired half remains after clipping.
    trace();
    if (stroke.align === 'inside') {
      ctx.clip();
    } else {
      // Outside: clip to everything EXCEPT the fill (even-odd with a big rect).
      ctx.rect(-1e5, -1e5, 2e5, 2e5);
      ctx.clip('evenodd');
    }
    applyStrokeStyle(ctx, { ...stroke, width: stroke.width * 2 }, w, h);
  } else {
    applyStrokeStyle(ctx, stroke, w, h);
  }
  trace();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
