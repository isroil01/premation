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

import type { RenderLayer, Subpath, SubpathPaint } from '../RenderBackend';
import { makeCanvasGradient, type FillPaint } from '@core/paint/fill';
import type { Stroke } from '@core/paint/stroke';
import type { Pt } from '@core/scene/trimPath';
import { layerSubpaths, hasPathGeometry } from './subpaths';
import { effectNumber } from '@core/effects/effects';
import { layerIsBaked } from '@core/effects/effectBake';

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
 * This only applies to chains that go down the Canvas2D path — one Canvas2D-only
 * effect (Beam / Keylight / 4-Colour Gradient / the warps / the interior styles)
 * forces the WHOLE stack, blurs and shadows included, to bake into the layer's
 * raster. `applyEffectChain` then runs inside a canvas sized to the layer box,
 * so every halo is sliced off flat at the texture edge instead of fading out —
 * measured on a blurred star: 567 border pixels still carrying ink.
 *
 * A pure-GPU stack does NOT need this. Those effects run in CompositionPass
 * over a viewport-sized LAYER_TARGET, so their halos already have room; padding
 * them would only grow textures for nothing.
 *
 * Gated on `layerIsBaked` — the SAME predicate Canvas2DVectorRasterizer
 * bakes on and `snapshotToFrameScene` drops GPU effects on. All three must
 * agree. Asking the narrower `effectsNeedCpuBake` here meant a layer baked for
 * FILL OPACITY alone got no padding at all, so its stroke ring was clipped
 * square at the layer box (golden scene: fill-opacity-zero-stroke).
 */
function bakedEffectSpread(layer: RenderLayer): number {
  if (!layerIsBaked(layer)) return 0;
  // `layerIsBaked` is true for FILL OPACITY alone, and such a layer has no
  // effect stack at all — the exact shape that used to crash `applyEffectChain`
  // (`for (const e of undefined)`). Fading spreads nothing anyway, so an absent
  // or empty stack is zero padding, not an iteration.
  const effects = layer.effects;
  if (!effects || effects.length === 0) return 0;
  let spread = 0;
  for (const e of effects) {
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
      // Vegas strokes the alpha CONTOUR, so half its width falls outside the
      // layer's own alpha, plus the hardness feather on top of that. It belongs
      // with `stroke` above and NOT with the two below: the lights are placed by
      // arc length along a contour that moves with the padding, so padding
      // translates the whole result and changes nothing about it. The displacement
      // effects below index absolute canvas coordinates, which is what makes them
      // different.
      case 'vegas':
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
    // Clamped AFTER the rounding nudge, or the cap is not a cap: ceil(512 + 1)
  // is 513, and MAX_GLYPH_PAD exists precisely to bound the allocation.
  return pad > 0 ? Math.min(MAX_GLYPH_PAD, Math.ceil(pad + 1)) : 0;
  }
  const strokes = layer.strokes && layer.strokes.length > 0 ? layer.strokes : layer.stroke ? [layer.stroke] : [];
  let strokeOvershoot = 0;
  for (const s of strokes) {
    if (!s || s.width <= 0) continue;
    // center/miter: a full width covers the half-width band + a 90° miter tip
    // (~0.71×w). outside: the band sits fully outside (~1×w) + miter → 2×w.
    const overshoot = s.align === 'outside' ? s.width * 2 : s.align === 'inside' ? 0 : s.width;
    if (overshoot > strokeOvershoot) strokeOvershoot = overshoot;
  }
  if (strokeOvershoot > pad) pad = strokeOvershoot;
  // How far the PATH ITSELF escapes the layer's box, plus the stroke drawn on
  // top of wherever it went.
  //
  // A path operator moves points: Zigzag displaces them perpendicular by its
  // `amount`, so the geometry provably leaves the w×h box, and this function
  // measured only the stroke. The raster was sized for an 8px stroke while the
  // outline had travelled 16px further out, and the mitred spike tips were
  // sliced off at the texture edge — measured on `shape-path-op-zigzag`, whose
  // inked extent came out 238px against the reference's 262px, losing 22% of
  // the stroke's pixels. Reading the resolved points covers every operator
  // (and any future one) instead of special-casing Zigzag's parameter.
  //
  // Every RUN is measured, not just the first: a trim that wraps past the end of
  // the path produces two arcs, and the one that escapes the box is as likely to
  // be the second as the first.
  const runs = layerSubpaths(layer);
  if (runs.length > 0) {
    const hw = layer.width / 2;
    const hh = layer.height / 2;
    let escape = 0;
    for (const run of runs) {
      for (const p of run.points) {
        // Handles too: a bezier bulges toward them, so an anchor inside the box
        // with a handle outside it still paints outside.
        //
        // Handles are ABSOLUTE positions, not offsets — `inX` equals `x` for a
        // corner (BezierPoint.ts:7), which is what `shapePath` relies on when it
        // hands them straight to `bezierCurveTo`. This read them as offsets and
        // computed `x + inX`, doubling every corner's coordinate: a point at
        // x=126 measured as 252, so a 220px-wide layer padded 151px instead of
        // 25 and rasterized a 522² texture where 270² was enough — 3.7× the
        // pixels, on every shape carrying a path operator. Every other reader in
        // the codebase (mask.ts, mergePaths.ts, rig/mesh.ts, lottieImport.ts,
        // lottiePreview.ts) already treated them as absolute; this was the lone
        // outlier. Over-padding is only transparent margin, so it never showed
        // up as a wrong image — see F17.
        const xs = [p.x, p.inX ?? p.x, p.outX ?? p.x];
        const ys = [p.y, p.inY ?? p.y, p.outY ?? p.y];
        for (const x of xs) escape = Math.max(escape, Math.abs(x) - hw);
        for (const y of ys) escape = Math.max(escape, Math.abs(y) - hh);
      }
    }
    if (escape > 0) {
      const total = Math.min(MAX_GLYPH_PAD, escape + strokeOvershoot);
      if (total > pad) pad = total;
    }
  }
  if (layer.paint && layer.paint.strokes.length > 0) {
    let maxStroke = 0;
    for (const s of layer.paint.strokes) {
      if (s.size > maxStroke) maxStroke = s.size;
    }
    if (maxStroke / 2 > pad) pad = maxStroke / 2;
  }
  // Clamped AFTER the rounding nudge, or the cap is not a cap: ceil(512 + 1)
  // is 513, and MAX_GLYPH_PAD exists precisely to bound the allocation.
  return pad > 0 ? Math.min(MAX_GLYPH_PAD, Math.ceil(pad + 1)) : 0;
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

/**
 * Sample the layer's fill outline into a polyline — the input Trim Paths cuts.
 *
 * Called from `buildSnapshot`, not from the draw loop: trim resolves to
 * geometry now, so the sampling happens once per frame when the snapshot is
 * built rather than once per stroke when it is drawn.
 *
 * Known gap: a rect's rounded corners are NOT sampled — the outline is the four
 * hard corners. That was already true when only the stroke was trimmed; the fill
 * now inherits it, so a trimmed rounded rect cuts along the square outline.
 */
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
  // The FIRST run only. This function samples an outline in order to trim it,
  // and a layer that already carries multiple runs has already been cut — there
  // is nothing left for it to sample. (Phase 2 removes the trim-time caller
  // entirely; the text-on-a-path caller still wants one continuous outline.)
  const runs = layerSubpaths(layer);
  if (layer.primitive === 'path' && runs.length > 0 && runs[0]!.points.length > 1) {
    const first = runs[0]!;
    return { pts: first.points.map((p) => ({ x: p.x, y: p.y })), closed: first.open !== true };
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

/** Trace one run into the CURRENT path (no `beginPath`). Extracted from
 *  `shapePath` so a batch can trace a subset with identical geometry. */
function traceRun(ctx: CanvasRenderingContext2D, run: Subpath): void {
  const pts = run.points;
  if (pts.length === 0) return;
  // Open runs (line / freehand pencil / a trimmed arc) stop at the last point;
  // closed shapes wrap the final segment back to the first and close.
  const open = run.open === true;
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  const lastSeg = open ? pts.length - 1 : pts.length;
  for (let i = 0; i < lastSeg; i++) {
    const curr = pts[i]!;
    const next = pts[(i + 1) % pts.length]!;
    ctx.bezierCurveTo(curr.outX, curr.outY, next.inX, next.inY, next.x, next.y);
  }
  if (!open) ctx.closePath();
}

/** A group of runs sharing one paint, traced as a single path. */
export interface SubpathBatch {
  runs: ReadonlyArray<Subpath>;
  /** Undefined = paint with the LAYER's own fill/stroke. */
  paint?: SubpathPaint;
}

/**
 * Group a layer's runs for drawing, or NULL when no run carries paint.
 *
 * Null is the load-bearing half of this contract. Runs are normally traced into
 * ONE path so `fill()` sees them as a single nonzero-winding region — that is
 * what lets a reverse-wound run cut a HOLE instead of painting over the shape.
 * Separately-filled runs cannot cut holes in each other, so batching is not a
 * free refactor: it changes what a multi-run path looks like.
 *
 * Returning null when nothing is painted means every layer that exists today
 * takes the unchanged path and renders byte-identically. Only a layer actually
 * using the feature pays for it, and only that layer gives up cross-run holes —
 * which it must, because the two behaviours are genuinely exclusive.
 *
 * Unpainted runs stay TOGETHER in one batch rather than being split, so a path
 * mixing painted and unpainted runs still gets holes among the unpainted ones.
 *
 * Batch order puts the unpainted group FIRST, then painted runs in their
 * original order — so a painted run still draws over the plain body, which is
 * the stacking a repeater's later copies need.
 */
export function subpathBatches(layer: RenderLayer): SubpathBatch[] | null {
  if (layer.primitive !== 'path') return null;
  const runs = layerSubpaths(layer);
  if (runs.length === 0 || !runs.some((r) => r.paint)) return null;

  const batches: SubpathBatch[] = [];
  const plain = runs.filter((r) => !r.paint);
  if (plain.length > 0) batches.push({ runs: plain });
  for (const r of runs) if (r.paint) batches.push({ runs: [r], paint: r.paint });
  return batches;
}

/** Trace one batch's runs into a fresh path. */
export function traceBatch(ctx: CanvasRenderingContext2D, batch: SubpathBatch): void {
  ctx.beginPath();
  for (const run of batch.runs) traceRun(ctx, run);
}

/** Trace the layer's fill outline (centred at 0,0) without painting it. */
export function shapePath(ctx: CanvasRenderingContext2D, layer: RenderLayer): void {
  const w = layer.width;
  const h = layer.height;
  if (layer.primitive === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (layer.primitive === 'path' && hasPathGeometry(layer)) {
    // ONE Canvas path built from every run. Sub-paths in a single `beginPath`
    // is how both operations want it: `fill()` treats the runs as one region
    // (nonzero winding, so a hole cut the opposite way is a hole), and
    // `stroke()` draws each run independently. Calling beginPath per run would
    // give the stroke the same result and the fill a different one.
    ctx.beginPath();
    for (const run of layerSubpaths(layer)) traceRun(ctx, run);
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
