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
import type { Stroke, StrokeCap } from '@core/paint/stroke';
import type { Pt } from '@core/scene/trimPath';
import { layerSubpaths, hasPathGeometry } from './subpaths';
import { flattenOutline, ADAPTIVE } from '@core/scene/mergePaths';
import { offsetAlongNormals, closedRibbon, type OffsetSides } from '@motion/scene';
import {
  taperWidthFactorAt, waveOffsetAt, isIdentityTaper, isIdentityWave,
  type StrokeWave,
} from '@core/scene/strokeProfile';

/**
 * Bezier sampling for a profiled stroke: ADAPTIVE, sized per segment.
 *
 * It used to be a flat 8 — "the boolean-ops default", on the reasoning that a
 * tapered edge is a fill boundary and wants the same smoothness. That reasoning
 * held for the operands of a boolean (whole shapes, comparable sizes) and not
 * here: eight samples is plenty across a 20px curve and is a visible chain of
 * facets across a 400px one. A tapered stroke is the polyline, so its facets
 * are the picture — which is what "path with taper looks choppy" was.
 */
const TAPER_FLATTEN_PER_SEG = ADAPTIVE;

/**
 * Bezier samples per segment when a WAVE is active.
 *
 * A wave needs far more samples than a taper: taper varies slowly along the
 * path, while a wave has to resolve every crest. At the taper default of 8, a
 * two-segment curve gives ~16 points over ~400px of arc — under eight samples
 * per period at a 190px wavelength, which reads as a chain of facets.
 *
 * HONEST CORRECTION: this was first written claiming it fixed a folded golden.
 * It did not. That folding was the offset self-intersection limit documented on
 * `strokeShapeProfiled`, and raising this changed the picture not at all. It is
 * kept because it genuinely improves wave smoothness, not because it fixed that.
 */
const WAVE_FLATTEN_PER_SEG = 64;
import { effectNumber } from '@core/effects/effects';
import { layerIsBaked } from '@core/effects/effectBake';
import { clamp01 } from '@utils/lang';


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
      // NOT bezier-warp either, and for a sharper version of the same reason.
      // Its patch is built by `defaultWarpPoints(w, h)` from the dimensions the
      // effect is HANDED, which are the padded canvas's — so padding does not
      // merely shift the result, it rebuilds the rest patch around a larger box
      // and the same offsets then describe a different warp. A 200x200 layer
      // padded by 50 would put the patch corners 50px outside the content, and
      // the visible deformation would weaken as the padding grew. Leaving it
      // unpadded keeps the warp correct and costs only content pushed past the
      // layer box. The exit is the same as for the two below: an origin and
      // extent threaded into the warp math so the patch can be built on the
      // layer's own rectangle regardless of the canvas it is drawn into.
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
  /**
   * A stroke with no stated opacity is OPAQUE — said here rather than implied.
   *
   * This line was `clamp01(stroke.opacity)` and depended on two unrelated
   * leniencies cancelling out. `Stroke.opacity` is typed `number`, but a stroke
   * rebuilt from a stored document can carry `undefined` at runtime — and
   * `undefined` satisfies neither comparison in the local `clamp01`, so it came
   * back untouched. `globalAlpha *= undefined` is NaN, and the Canvas2D spec
   * IGNORES a non-finite assignment to `globalAlpha`, so the previous value
   * stood and the stroke drew opaque. Right output, for two reasons nobody
   * chose.
   *
   * It matters because it made an ordinary cleanup dangerous: normalising the
   * ~17 hand-written `clamp01` copies onto a NaN-safe form maps `undefined` to
   * 0 instead — alpha 0, stroke gone — which moved 112 render-test scenes and
   * lost fidelity on 49. See `strokeOpacityGuard.test.ts` and EDITOR_REFERENCE
   * §5. Stating the default here is what makes that cleanup safe.
   */
  const opacity = Number.isFinite(stroke.opacity) ? stroke.opacity : 1;
  ctx.globalAlpha *= clamp01(opacity);
  ctx.strokeStyle =
    stroke.paint && stroke.paint.type !== 'solid'
      ? fillStyleFor(ctx, stroke.paint, stroke.color, w, h)
      : (stroke.paint?.type === 'solid' ? stroke.paint.color : stroke.color);
  ctx.lineWidth = stroke.width;
  ctx.lineCap = stroke.cap;
  ctx.lineJoin = stroke.join;
  ctx.setLineDash(stroke.dash.length ? stroke.dash : []);
  // Dash offset is ARC LENGTH along the path, which is exactly what Canvas2D's
  // `lineDashOffset` already means — so this reuses the rasterizer's own dashing
  // rather than cutting the path up first.
  //
  // The alternative considered and rejected: walk the path with
  // `trimSegments`/`trimPolyline` and emit each dash as its own subpath. Those
  // do provide arc length, but they provide it over a POLYLINE SAMPLING of the
  // curve — so dashes on a circle or a bezier would land at subtly wrong
  // distances, every dash would get butt ends regardless of `cap`, and joins
  // inside a dash would be lost. It would also be a second dashing
  // implementation sitting next to the one the canvas already applies for the
  // static pattern, which is §2·0's shape. Trim's polyline walk is the right
  // mechanism for CUTTING a path; it is the wrong one for phase-shifting a
  // pattern the rasterizer is already laying down.
  //
  // Always assigned, never left to persist: `ctx` is shared across every layer
  // in a frame, so skipping the write when the offset is 0 would inherit the
  // previous layer's phase.
  ctx.lineDashOffset = stroke.dashOffset ?? 0;
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
    roundRect(ctx, -w / 2, -h / 2, w, h, layer.cornerRadii ?? layer.cornerRadius ?? 0, layer.cornerRadiusScale);
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
  ctx.lineDashOffset = 0;
  ctx.restore();
}

/**
 * Stroke a path as a FILLED variable-width ribbon — AE's Taper and Wave.
 *
 * Canvas2D strokes at a single `lineWidth` and cannot vary it, so a tapered or
 * waved stroke is not a parameter change but a change of DRAWING OPERATION:
 * flatten the path, walk it by arc length, offset it, and fill the outline.
 *
 * ## The primitive is used TWICE, which is DECISION D4 landing
 *
 * D4 predicted that taper and wave differ only in what they do with the two
 * offset sides — wave moves them TOGETHER (it displaces the centreline), taper
 * moves them OPPOSITELY (it varies the width). That is literally the code:
 *
 *   centre = offsetAlongNormals(poly, waveOffset).left     ← one side
 *   ring   = closedRibbon(offsetAlongNormals(centre, halfWidth))  ← both sides
 *
 * ## Returns FALSE rather than drawing, for cases it does not own
 *
 * The caller then strokes normally. Refusing loudly in code beats a silent
 * near-miss, and each refusal is a scope boundary rather than a bug:
 *
 *   • identity profiles — nothing to do, and skipping keeps an untapered stroke
 *     BYTE-identical rather than merely numerically equal (§2·0);
 *   • non-path primitives — rect/ellipse taper is not modelled yet;
 * ## A GEOMETRIC LIMIT this shares with every naive offset
 *
 * Offsetting a curve along its normals SELF-INTERSECTS wherever the local radius
 * of curvature is smaller than the offset distance — here, half the stroke
 * width. A tight wave on a wide stroke therefore folds into a knot rather than
 * bending. Measured, not theorised: amplitude 14 over a 70px wavelength on an
 * 18px stroke folds; amplitude 8 over 190px does not. Trimming the
 * self-intersections is the proper cure and is NOT built — the limit is recorded
 * here and in the golden scene so the next reader does not chase it through the
 * sampling code, which is where I chased it.
 *
 *   • DASHED strokes — dash + taper is a real AE combination and a deferred one
 *     here. Dashing is shipped behaviour; silently dropping it to apply a new
 *     feature would be the worse trade. The UI step must surface this rather
 *     than leaving a control that quietly does nothing.
 */
/**
 * Samples per wave PERIOD. Below about eight, a sine reads as a polygon.
 *
 * A backstop for LONG STRAIGHT runs, where bezier sampling adds nothing because
 * there is no curve to subdivide: a 400px straight segment carrying a 190px
 * wave would otherwise get two samples across two periods.
 *
 * Not the cure for the faceted first golden — see the note on
 * `WAVE_FLATTEN_PER_SEG`; that was the offset limit.
 */
const WAVE_SAMPLES_PER_PERIOD = 12;

/**
 * Insert points so no segment spans more than a fraction of the wavelength.
 *
 * Linear interpolation is faithful here because the input is ALREADY flattened
 * — these are chords of the curve, not the curve itself, so subdividing them
 * adds sample density without inventing geometry.
 *
 * Returns the input untouched when there is no wave: taper alone needs no extra
 * density, and densifying regardless would change every tapered ribbon's vertex
 * count for nothing.
 */
function densifyForWave(
  poly: Array<{ x: number; y: number }>,
  wave: StrokeWave | undefined,
): Array<{ x: number; y: number }> {
  if (isIdentityWave(wave) || poly.length < 2) return poly;
  const maxSpan = wave!.wavelength / WAVE_SAMPLES_PER_PERIOD;
  if (!(maxSpan > 0)) return poly;
  const out: Array<{ x: number; y: number }> = [poly[0]!];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / maxSpan);
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
    }
  }
  return out;
}

/**
 * The "on" spans of a dash pattern, in ARC LENGTH along the path.
 *
 * Canvas2D does this internally for `ctx.stroke()`; a filled ribbon has to do it
 * explicitly, because there is no stroking step left to hand the pattern to.
 *
 * Mirrors Canvas2D's own rules so a dashed taper and a dashed plain stroke break
 * the path at the SAME places: an odd-length array is doubled (so [8] means
 * 8 on / 8 off), the offset slides the pattern along the path and is periodic in
 * the pattern's total length, and a negative offset slides the other way.
 */
function dashSpans(
  total: number,
  dash: readonly number[],
  offset: number,
): Array<readonly [number, number]> {
  const pattern = dash.filter((n) => Number.isFinite(n) && n >= 0);
  if (pattern.length === 0) return [[0, total]];
  // Canvas2D doubles an odd-length pattern; without this [8] would be read as
  // 8-on and nothing off, i.e. a solid line.
  const p = pattern.length % 2 === 1 ? [...pattern, ...pattern] : pattern;
  const period = p.reduce((a, b) => a + b, 0);
  if (period <= 0) return [[0, total]];

  const spans: Array<readonly [number, number]> = [];
  // Start one whole period BEFORE zero so a span straddling the origin is not
  // clipped away — the visible result must not depend on where the walk began.
  let cursor = -period + (((-offset % period) + period) % period);
  let idx = 0;
  let guard = 0;
  while (cursor < total && guard++ < 100_000) {
    const len = p[idx % p.length]!;
    const on = idx % 2 === 0;
    const end = cursor + len;
    if (on && end > 0 && cursor < total) {
      spans.push([Math.max(0, cursor), Math.min(total, end)]);
    }
    cursor = end;
    idx++;
  }
  return spans;
}

/**
 * The stretch of a polyline between two arc lengths, with the ends interpolated.
 *
 * `at` returns, per emitted point, its FRACTIONAL index into the original
 * polyline — which is what lets a dash read its taper width from the whole
 * path's arc rather than from its own. Returning positions alone would lose
 * that, and each dash would taper independently.
 */
function subPolyline(
  pts: ReadonlyArray<{ x: number; y: number }>,
  arc: readonly number[],
  s0: number,
  s1: number,
): { pts: Array<{ x: number; y: number }>; at: number[] } {
  const out: Array<{ x: number; y: number }> = [];
  const at: number[] = [];
  const lerpAt = (i: number, f: number): void => {
    const a = pts[i]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    at.push(i + f);
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const a0 = arc[i]!;
    const a1 = arc[i + 1]!;
    if (a1 <= s0 || a0 >= s1) continue;
    const seg = a1 - a0 || 1;
    if (out.length === 0) lerpAt(i, Math.max(0, (s0 - a0) / seg));
    const endF = Math.min(1, (s1 - a0) / seg);
    if (endF >= 1) { out.push({ x: pts[i + 1]!.x, y: pts[i + 1]!.y }); at.push(i + 1); }
    else lerpAt(i, endF);
  }
  return { pts: out, at };
}

/** Samples across a round cap's half-circle. 16 is smooth at any stroke width
 *  a cap is visible at, and a cap is a handful of points next to the ribbon. */
const CAP_ARC_STEPS = 16;

/**
 * The points that carry a ribbon's outline AROUND one end, honouring the cap.
 *
 * A filled ribbon has no `lineCap` to set: the outline simply stops, so the end
 * is a butt whatever the Stroke says. That is the bug behind "cap was flat
 * although in properties it was round" — the profiled path silently dropped a
 * property the plain path honours.
 *
 * `leaving` is the side point the walk arrives at, `arriving` the one it
 * continues from; `outward` is the unit tangent pointing OUT of the path at
 * this end. The returned points sit strictly between the two, so the caller
 * concatenates without duplicating either.
 */
function capPoints(
  centre: Pt,
  leaving: Pt,
  arriving: Pt,
  outward: Pt,
  cap: StrokeCap,
): Pt[] {
  const r = Math.hypot(leaving.x - centre.x, leaving.y - centre.y);
  if (!(r > 0)) return [];
  if (cap === 'square') {
    return [
      { x: leaving.x + outward.x * r, y: leaving.y + outward.y * r },
      { x: arriving.x + outward.x * r, y: arriving.y + outward.y * r },
    ];
  }
  // Round: half a circle about the end vertex. Both ends sweep by DECREASING
  // angle — `offsetAlongNormals` puts `left` at +90° from the direction of
  // travel, so leaving→outward→arriving is −90° then −90° at either end.
  const a0 = Math.atan2(leaving.y - centre.y, leaving.x - centre.x);
  const out: Pt[] = [];
  for (let s = 1; s < CAP_ARC_STEPS; s++) {
    const a = a0 - (Math.PI * s) / CAP_ARC_STEPS;
    out.push({ x: centre.x + Math.cos(a) * r, y: centre.y + Math.sin(a) * r });
  }
  return out;
}

/** Unit vector a → b, or null when they coincide. */
function unitFrom(a: Pt, b: Pt): Pt | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len > 0 ? { x: dx / len, y: dy / len } : null;
}

/**
 * The ribbon's closed outline with `cap` applied at both free ends.
 *
 * Falls back to the plain ribbon for a butt cap (byte-identical to the old
 * walk) and for degenerate input.
 */
function cappedRibbon(pts: readonly Pt[], sides: OffsetSides, cap: StrokeCap): Pt[] {
  const n = sides.left.length;
  if (cap === 'butt' || n < 2) return closedRibbon(sides);
  const last = n - 1;
  const outFar = unitFrom(pts[last - 1]!, pts[last]!);
  const outNear = unitFrom(pts[1]!, pts[0]!);
  if (!outFar || !outNear) return closedRibbon(sides);
  const right = [...sides.right].reverse();
  return [
    ...sides.left,
    ...capPoints(pts[last]!, sides.left[last]!, sides.right[last]!, outFar, cap),
    ...right,
    ...capPoints(pts[0]!, sides.right[0]!, sides.left[0]!, outNear, cap),
  ];
}

export function strokeShapeProfiled(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  layer: RenderLayer,
  w = 100,
  h = 100,
): boolean {
  if (stroke.width <= 0) return false;
  const taper = stroke.taper;
  const wave = stroke.wave;
  if (isIdentityTaper(taper) && isIdentityWave(wave)) return false;
  if (layer.primitive !== 'path') return false;


  const runs = layerSubpaths(layer);
  if (runs.length === 0) return false;

  ctx.save();
  ctx.globalAlpha *= Math.max(0, Math.min(1, stroke.opacity));
  /*
   * ALIGNMENT, by the same clip `strokeShape` uses.
   *
   * This was the second property the profiled path silently dropped (the first
   * was `cap`): a tapered stroke set to Inside or Outside drew centred, so
   * switching Taper on moved a stroke that the panel said had not changed.
   *
   * The trick transfers unchanged — clip to (or out of) the fill and build the
   * ribbon at DOUBLE width, so exactly the wanted half survives. Doubling the
   * width scales the whole taper profile with it, which is what keeps the
   * clipped half the profile the user authored rather than a flattened one.
   */
  const aligned = stroke.align !== 'center';
  if (aligned) {
    shapePath(ctx, layer);
    if (stroke.align === 'inside') {
      ctx.clip();
    } else {
      ctx.rect(-1e5, -1e5, 2e5, 2e5);
      ctx.clip('evenodd');
    }
  }
  const effectiveWidth = aligned ? stroke.width * 2 : stroke.width;
  // The ribbon is FILLED, so the stroke's paint becomes a fill style. A gradient
  // stroke gets easier here rather than harder: a filled outline takes a fill
  // gradient directly, instead of Canvas2D's stroke-gradient special case.
  ctx.fillStyle =
    stroke.paint && stroke.paint.type !== 'solid'
      ? fillStyleFor(ctx, stroke.paint, stroke.color, w, h)
      : (stroke.paint?.type === 'solid' ? stroke.paint.color : stroke.color);

  let drew = false;
  for (const run of runs) {
    const open = run.open === true;
    // A wave rides the flattened polyline, so the CURVE has to be sampled finely
    // before the wave is applied — densifying chords afterwards only adds points
    // along straight lines between widely-spaced curve samples, which is why the
    // first golden came out faceted. Raise the bezier sampling instead, then
    // densify as a backstop for long straight runs.
    const perSeg = isIdentityWave(wave) ? TAPER_FLATTEN_PER_SEG : WAVE_FLATTEN_PER_SEG;
    const flat = flattenOutline(run.points, perSeg, open);
    // A CLOSED run's flattening stops just before it reaches the first anchor
    // again — the ring is one chord short, and the ribbon built from it opened a
    // wedge at the seam. Closing it here (before densifying, so the closing
    // chord is sampled like every other) is what makes a tapered closed shape
    // meet itself.
    if (!open && flat.length > 1) flat.push({ x: flat[0]!.x, y: flat[0]!.y });
    const poly = densifyForWave(flat, wave);
    if (poly.length < 2) continue;

    // Cumulative arc length. Taper is a FRACTION of it; wave is measured in the
    // same px, so both read off this one walk.
    const arc: number[] = [0];
    for (let i = 1; i < poly.length; i++) {
      arc.push(arc[i - 1]! + Math.hypot(poly[i]!.x - poly[i - 1]!.x, poly[i]!.y - poly[i - 1]!.y));
    }
    const total = arc[arc.length - 1] || 1;

    const centre = isIdentityWave(wave)
      ? poly
      : offsetAlongNormals(poly, (i) => waveOffsetAt(wave!, arc[i]!)).left;

    // Dash splits the path into spans; each span becomes its OWN ribbon, and
    // every vertex still reads its width from the GLOBAL arc position — so a
    // taper runs across the whole stroke and the dashes sample it, rather than
    // each dash tapering to itself. That is AE's behaviour and the only reading
    // under which "dash" and "taper" compose rather than fight.
    const dashed = stroke.dash.length > 0;
    const spans = dashed
      ? dashSpans(total, stroke.dash, stroke.dashOffset ?? 0)
      : [[0, total] as const];
    // A closed run drawn whole has no ends to cap; every other piece does — a
    // dash cuts real ends even out of a closed outline, which is what Canvas2D
    // caps too.
    const spanCap: StrokeCap = open || dashed ? stroke.cap : 'butt';

    const halfWidthAt = (i: number): number => {
      const factor = taper ? taperWidthFactorAt(taper, arc[i]! / total) : 1;
      return (effectiveWidth * factor) / 2;
    };

    for (const [s0, s1] of spans) {
      const piece = subPolyline(centre, arc, s0, s1);
      if (piece.pts.length < 2) continue;
      const sides = offsetAlongNormals(piece.pts, (i) => {
        // `at` maps a piece vertex back onto the WHOLE path's arc, so the
        // width comes from where the dash SITS, not from its own extent.
        const a = piece.at[i]!;
        const lo = Math.max(0, Math.min(arc.length - 1, Math.floor(a)));
        const hi = Math.max(0, Math.min(arc.length - 1, Math.ceil(a)));
        const f = a - lo;
        return halfWidthAt(lo) * (1 - f) + halfWidthAt(hi) * f;
      });
      const ring = cappedRibbon(piece.pts, sides, spanCap);
      if (ring.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(ring[0]!.x, ring[0]!.y);
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i]!.x, ring[i]!.y);
      ctx.closePath();
      ctx.fill();
      drew = true;
    }
  }
  ctx.restore();
  return drew;
}

/**
 * Trace a rounded rectangle whose corners are the AUTHORED radius in
 * COMPOSITION pixels, not in the layer's own stretched ones.
 *
 * `axisScale` is the |scaleX|,|scaleY| the compositor will draw this raster at
 * (`RenderLayer.cornerRadiusScale`). Dividing by it makes the corner an ellipse
 * HERE so that it comes out a circle THERE — which is the whole point: a
 * "Corners: 50 px" field that reads 50 and draws 100 the moment the layer is
 * scaled is a control that does not mean what it says, and under a non-uniform
 * scale the corner stopped being round at all.
 *
 * Only the corners are compensated; the artwork still scales. The default
 * [1, 1] is the identity path and still emits `arcTo`, so an unscaled layer's
 * command stream is byte-identical to before this existed.
 */
export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number | readonly [number, number, number, number],
  axisScale: readonly [number, number] = [1, 1],
): void {
  const raw = typeof r === 'number' ? [r, r, r, r] as const : r;
  // Comp px -> local px, per axis. A degenerate scale falls back to 1 rather
  // than dividing by zero.
  const kx = axisScale[0] > 1e-6 ? 1 / axisScale[0] : 1;
  const ky = axisScale[1] > 1e-6 ? 1 / axisScale[1] : 1;
  // The clamp is applied to the LOCAL extents, one axis at a time: with an
  // anisotropic corner, "the two radii on this edge must fit it" is two
  // different sums.
  const scale = (a: number, b: number, k: number, limit: number): number => {
    const sum = (a + b) * k;
    if (sum <= limit || sum <= 1e-6) return 1;
    return limit / sum;
  };
  let [tl, tr, br, bl] = raw.map((v) => Math.max(0, v)) as [number, number, number, number];
  const s = Math.min(
    scale(tl, tr, kx, w),
    scale(tr, br, ky, h),
    scale(br, bl, kx, w),
    scale(bl, tl, ky, h),
    1,
  );
  tl *= s; tr *= s; br *= s; bl *= s;
  // Local half-axes per corner.
  const ax = (v: number): number => v * kx;
  const ay = (v: number): number => v * ky;
  const visible = (v: number): boolean => ax(v) > 0.5 || ay(v) > 0.5;
  ctx.beginPath();
  if (!visible(tl) && !visible(tr) && !visible(br) && !visible(bl)) {
    ctx.rect(x, y, w, h);
    return;
  }
  const isotropic = Math.abs(kx - ky) < 1e-9;
  /** One corner arc: `arcTo` while the corner is a circle, `ellipse` when not. */
  const corner = (
    v: number, cx: number, cy: number, a0: number,
    cornerX: number, cornerY: number, toX: number, toY: number,
  ): void => {
    if (isotropic) ctx.arcTo(cornerX, cornerY, toX, toY, ax(v));
    else ctx.ellipse(cx, cy, ax(v), ay(v), 0, a0, a0 + Math.PI / 2, false);
  };
  const HALF_PI = Math.PI / 2;
  ctx.moveTo(x + ax(tl), y);
  ctx.lineTo(x + w - ax(tr), y);
  if (visible(tr)) corner(tr, x + w - ax(tr), y + ay(tr), -HALF_PI, x + w, y, x + w, y + ay(tr));
  else ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - ay(br));
  if (visible(br)) corner(br, x + w - ax(br), y + h - ay(br), 0, x + w, y + h, x + w - ax(br), y + h);
  else ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + ax(bl), y + h);
  if (visible(bl)) corner(bl, x + ax(bl), y + h - ay(bl), HALF_PI, x, y + h, x, y + h - ay(bl));
  else ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + ay(tl));
  if (visible(tl)) corner(tl, x + ax(tl), y + ay(tl), Math.PI, x, y, x + ax(tl), y);
  else ctx.lineTo(x, y);
  ctx.closePath();
}
