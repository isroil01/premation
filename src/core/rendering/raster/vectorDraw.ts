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
import { effectNumber } from '@core/effects/effects';
import { effectsNeedCpuBake } from '@core/effects/effectBake';

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** A Gaussian is visually dead by ~3σ, and `filter: blur(Npx)` uses σ = N. */
const BLUR_EXTENT = 3;

/** Ceiling on effect bleed (px). A 100px softness would otherwise quadruple the
 *  texture area; past this the clipped tail is too faint to see anyway. */
const MAX_EFFECT_PAD = 256;

/**
 * How far a CPU-BAKED effect chain paints outside the layer's own box.
 *
 * This only applies to chains that `effectsNeedCpuBake` sends down the Canvas2D
 * path — one Canvas2D-only effect (Fill / Stroke / Beam / Sharpen / Noise /
 * Wave Warp / Turbulent Displace / Keylight / 4-Colour Gradient) forces the
 * WHOLE stack, blurs and shadows included, to bake into the layer's raster.
 * `applyEffectChain` then runs inside a canvas sized to the layer box, so every
 * halo is sliced off flat at the texture edge instead of fading out — measured
 * on a blurred star: 567 border pixels still carrying ink.
 *
 * A pure-GPU stack does NOT need this. Those effects run in CompositionPass
 * over a viewport-sized LAYER_TARGET, so their halos already have room; padding
 * them would only grow textures for nothing.
 */
function bakedEffectSpread(layer: RenderLayer): number {
  if (!effectsNeedCpuBake(layer.effects)) return 0;
  let spread = 0;
  for (const e of layer.effects!) {
    if (e.enabled === false) continue;
    let s = 0;
    switch (e.type) {
      case 'blur':
        s = effectNumber(e, 'amount') * BLUR_EXTENT;
        break;
      case 'glow':
        s = effectNumber(e, 'radius') * BLUR_EXTENT;
        break;
      case 'drop-shadow':
        s = effectNumber(e, 'distance') + effectNumber(e, 'softness') * BLUR_EXTENT;
        break;
      // The Stroke EFFECT dilates the layer's alpha by ring offsets, so it
      // straddles the edge. Translation-invariant, so padding only un-clips it.
      case 'stroke':
        s = effectNumber(e, 'width');
        break;
      // NOT wave-warp / turbulent-displace, even though they clearly do push
      // pixels outward. Both index their displacement field by ABSOLUTE canvas
      // coordinates — `along = x·px + y·py` in waveWarpData, the noise lookup in
      // turbulentDisplaceData — so padding shifts every pixel by `pad` and moves
      // the wave/noise PATTERN across the artwork. The golden suite caught it:
      // effect-wave-warp diverged 18.99% and effect-turbulent-displace 9.34%,
      // which is a changed distortion, not a recovered halo. Padding these needs
      // an origin offset threaded into the warp math first; until then, leaving
      // them unpadded keeps the (correct) appearance and costs only the tail of
      // a displacement that reaches past the layer box.
      default:
        // Everything else (colour grades, LUTs, generators, sharpen, noise,
        // keylight) is a per-pixel pass — it cannot paint outside the box.
        s = 0;
    }
    if (s > spread) spread = s;
  }
  return Math.min(spread, MAX_EFFECT_PAD);
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
/**
 * How far a text layer's GLYPHS escape its own box.
 *
 * Text is rasterized into a texture the size of the layer box, so anything
 * drawn outside that box is sliced off at the texture edge. That was harmless
 * while text just sat in its box — but a text animator's whole job is to move
 * glyphs off their baseline, and a preset that lifts a character 40px or scales
 * it to 220% then had the character guillotined by an invisible border.
 *
 * So the box grows to fit whatever the animators are doing this frame. It is
 * per-frame and part of the raster cache key, which is correct: an animation
 * that starts subtle and ends extreme should not pay for its worst frame all
 * the way through.
 */
function glyphSpread(layer: RenderLayer): number {
  const glyphs = layer.glyphs;
  if (!glyphs || glyphs.length === 0) return 0;
  // The glyph's own extent, used to turn a SCALE multiplier into pixels. Height
  // is the honest measure for a font: a glyph is roughly em-tall.
  const em = layer.fontSize ?? 48;
  let spread = 0;
  for (const g of glyphs) {
    // Position offsets translate the glyph bodily out of the box.
    let d = Math.max(Math.abs(g.dx), Math.abs(g.dy) + Math.abs(g.lineSpacing));
    // Scale grows it about its own origin, so half the growth escapes each side.
    const grow = Math.max(g.scale, g.scaleY) - 1;
    if (grow > 0) d += (grow * em) / 2;
    // Blur bleeds symmetrically; a stroke sits half outside the outline.
    d += g.blur * 2 + g.strokeWidth / 2;
    // Shear pushes the top and bottom of the glyph sideways.
    if (g.skew) d += Math.abs(Math.tan((g.skew * Math.PI) / 180)) * em * 0.5;
    if (d > spread) spread = d;
  }
  return spread;
}

/**
 * How far text riding a path escapes its box.
 *
 * The path is a mask in layer-local space and is routinely much larger than the
 * text box — an ellipse the text orbits, say. Without this the orbit is cropped
 * to the box and only the part of the ring crossing it survives.
 */
function textPathSpread(layer: RenderLayer): number {
  const tp = layer.textPath;
  if (!tp || tp.points.length === 0) return 0;
  const halfW = layer.width / 2;
  const halfH = layer.height / 2;
  let spread = 0;
  for (const p of tp.points) {
    spread = Math.max(spread, Math.abs(p.x) - halfW, Math.abs(p.y) - halfH);
  }
  // Plus room for the glyphs themselves, which straddle the path.
  return spread > 0 ? spread + (layer.fontSize ?? 48) : 0;
}

/**
 * Ceiling on raster growth, in px per side.
 *
 * Padding is quadratic in texture memory: a 400×100 text layer padded by 512
 * becomes 1424×1124, which is 6.4 MB per resolution tier. A preset with an
 * absurd offset should be clipped rather than allowed to allocate without
 * bound — and at that point the layer's own box is the wrong size anyway.
 */
const MAX_GLYPH_PAD = 512;

export function rasterPadding(layer: RenderLayer): number {
  // Baked effect bleed applies to every rasterized kind (shape AND text) —
  // it is a property of the effect chain, not of the geometry.
  let pad = bakedEffectSpread(layer);
  if (layer.kind !== 'shape') {
    // Text escapes its box through its animators and through a text path;
    // both are resolved per-frame in buildSnapshot, so both are known here.
    const escape = Math.min(MAX_GLYPH_PAD, Math.max(glyphSpread(layer), textPathSpread(layer)));
    if (escape > pad) pad = escape;
    return pad > 0 ? Math.ceil(pad + 1) : 0;
  }
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
