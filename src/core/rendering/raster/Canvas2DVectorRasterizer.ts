import type { ResourceManager, TextureHandle } from '@motion/renderer';
import {
  VectorRasterizer,
  RasterRequest,
  RasterResult,
  rasterCacheKey,
  displayReferredUploadFormat,
  DEFAULT_MAX_RASTER_DIMENSION,
} from '@motion/renderer';
import { paintMaskMatte } from '@core/effects/mask';
import { applyEffectChain, layerIsBaked } from '@core/effects/effectBake';
import { scaleEffectLengths } from '@core/effects/effects';
import {
  drawPaintStack,
  fillStyleFor,
  hasOrderedPaint,
  paintRenderOrder,
  shapePath,
  strokeShape,
  strokeShapeProfiled,
  subpathBatches,
  traceBatch,
} from './vectorDraw';
import type { Stroke } from '@core/paint/stroke';
import { paintTextInBox } from './textPaint';
import { drawPaint, hasPaintStrokes } from '@core/paint/paintRaster';
import { rasterCapture } from './rasterCapture';

/** Cache statistics reported by the rasterizer (defined locally — not in @motion/renderer). */
export interface RasterStats {
  textures: number;
  bytes: number;
  hits: number;
  misses: number;
}

/** Pool key under which a cache entry's texture is registered. Must match the
 *  string handed to `resources.texture` — freeing by anything else is a
 *  silent no-op (see the note in `releaseEntry`). */
function poolKeyFor(cacheKey: string): string {
  return `raster:${cacheKey}`;
}

/** Supersample factor applied on top of the resolution tier. */
const SUPERSAMPLE = 2;

/**
 * Largest raster canvas we will ask for, per axis.
 *
 * The bake chain allocates SEVERAL scratch canvases of the same size, and the
 * result still has to become a GPU texture — 8192 is the floor of what WebGL2
 * and WebGPU guarantee, so staying under half of it leaves room for the
 * scratches without risking an allocation that simply fails.
 */
const MAX_RASTER_DIM = 4096;

/**
 * How much to oversample the layer's box, given the resolution tier.
 *
 * The BAKE path deliberately gets no supersample. Not supersampling it does
 * cost edge quality — the same text is measurably softer with a layer style on
 * it than without — but supersampling it was tried and is worse overall:
 *
 *  · It changes what pixel-density-dependent effects LOOK like. Noise and
 *    turbulence are generated per pixel, so drawing at 2x and averaging back
 *    down makes grain finer and flatter; `effect-noise` moved 38% against its
 *    reference, which is a different effect, not a better-sampled one.
 *  · Interior styles shift with it too (`interior-bevel`, 6.7%), because their
 *    alpha algebra runs over a different number of samples.
 *  · It costs 4x the pixels on every styled layer, and the bake allocates
 *    several scratch canvases of that size.
 *
 * Measured against a small anti-aliasing gain that only showed up at the very
 * bottom of a scale animation. Filed, not taken.
 *
 * The clamp IS new: a large box at a high tier could ask for a canvas nothing
 * can allocate. It only engages where the request would have failed outright.
 *
 * The clamp is a HARD cap, allowed to go below the tier — even below 1. The
 * previous form `max(min(tier, want), min(want, MAX/longest))` could never
 * return less than `tier` (want ≥ tier always), so a text box longer than
 * MAX_RASTER_DIM/tier px sailed past the cap: the canvas allocated (Chrome
 * allows far larger) but the GPU texture upload exceeded the device limit and
 * failed, and the layer VANISHED. That is the "text disappears as it gets
 * bigger" report — a big font size, a wide box, or zooming in pushed the
 * request over the cap and the whole layer dropped instead of going soft. A
 * softer raster stretched up is the correct degradation; a missing layer is
 * not a degradation at all.
 */
function supersampleFor(
  tier: number,
  boxW: number,
  boxH: number,
  bake: boolean,
  /** Device texture cap for the plain path; the bake path stays on
   *  MAX_RASTER_DIM because it allocates several same-size scratches. */
  deviceMax: number = DEFAULT_MAX_RASTER_DIMENSION,
): number {
  const want = bake ? tier : tier * SUPERSAMPLE;
  const longest = Math.max(1, boxW, boxH);
  // The device cap always binds (a texture past it fails outright). The bake
  // path additionally stays under MAX_RASTER_DIM for its scratch canvases.
  const cap = bake ? Math.min(MAX_RASTER_DIM, deviceMax) : deviceMax;
  return Math.min(want, cap / longest);
}


/**
 * A BAKED layer's canvas is drawn on the CPU on purpose.
 *
 * The effect chain reads the canvas back (`getImageData`) for every pixel
 * pass, which is what `willReadFrequently` exists for — but the reason here
 * is determinism, not speed. With hardware acceleration on, Chrome rasterises
 * a 2D canvas on the GPU, and a GPU's antialiasing and 8-bit blend rounding
 * are the adapter's own: thousands of overlapping translucent fills (a plexus
 * mesh, an additive particle field) drift by whole levels from one GPU to the
 * next, and from the CPU raster the WebGL2 golden run uses. A bake that reads
 * the same on every machine is worth more than a faster one that does not;
 * the plain (unbaked) path keeps the accelerated canvas.
 */
function bakeContextOptions(bake: boolean): CanvasRenderingContext2DSettings | undefined {
  return bake ? { willReadFrequently: true } : undefined;
}

export class Canvas2DVectorRasterizer implements VectorRasterizer {
  private cache = new Map<string, { texture: TextureHandle; bytes: number; w: number; h: number }>();
  private currentBytes = 0;
  private maxBytes = 512 * 1024 * 1024; // 512 MB
  private hits = 0;
  private misses = 0;

  constructor(private readonly resources: ResourceManager) {}

  /** The attached GPU's real max texture dimension (see setMaxDimension). */
  private deviceMax = DEFAULT_MAX_RASTER_DIMENSION;

  /** Adopt the backend's real texture cap so the raster clamp matches the
   *  device instead of the conservative default. */
  setMaxDimension(px: number): void {
    this.deviceMax = px > 0 && Number.isFinite(px) ? px : DEFAULT_MAX_RASTER_DIMENSION;
  }

  stats(): RasterStats {
    return {
      textures: this.cache.size,
      bytes: this.currentBytes,
      hits: this.hits,
      misses: this.misses,
    };
  }

  /**
   * Drop a cache entry and actually release its GPU texture.
   *
   * Both eviction paths used to call `freeTexture(entry.texture.id.toString)`.
   * `TextureHandle.id` is a plain allocation counter, but the ResourceManager
   * pool is keyed by the STRING passed to `texture` — here `raster:<cacheKey>`.
   * So `freeTexture("137")` missed the pool and returned silently: `currentBytes`
   * dropped below the 512 MB cap (so eviction stopped) while not one WebGL
   * texture was ever deleted. Combined with `pinned: true`, which excludes the
   * entry from the pool's own idle GC, every distinct
   * (contentHash, resolutionScale, padding) leaked a full-resolution texture for
   * the whole session — typing in a text layer, animating a morphing path, or
   * just zooming (which changes resolutionScale) allocated a permanent one each.
   */
  private releaseEntry(cacheKey: string): void {
    const entry = this.cache.get(cacheKey);
    if (entry) {
      this.currentBytes -= entry.bytes;
      this.resources.freeTexture(poolKeyFor(cacheKey));
    }
    this.cache.delete(cacheKey);
  }

  invalidate(contentHash: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(contentHash)) this.releaseEntry(key);
    }
  }

  /**
   * A cache hit without a request: refresh `cacheKey` in the LRU and count the
   * hit, exactly as `rasterize` does when it finds the key. False when the
   * entry has been evicted — the caller must then take the full `rasterize`
   * path. Lets a provider that already knows its key is unchanged skip
   * rebuilding the request (see AppTextureProvider's reuse records).
   */
  touch(cacheKey: string): boolean {
    const cached = this.cache.get(cacheKey);
    if (!cached) return false;
    this.hits++;
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, cached);
    return true;
  }

  rasterize(req: RasterRequest): RasterResult {
    const { drawable, resolutionScale, padding } = req;
    const key = rasterCacheKey(drawable.contentHash, resolutionScale, padding);

    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      // Refresh key in LRU by deleting and re-inserting
      this.cache.delete(key);
      this.cache.set(key, cached);

      return {
        texture: {
          id: cached.texture.id.toString(),
          width: cached.w,
          height: cached.h,
        } as RasterResult['texture'],
        uvRect: {
          x: -padding,
          y: -padding,
          width: drawable.width + 2 * padding,
          height: drawable.height + 2 * padding,
        },
        resolutionScale,
      };
    }

    this.misses++;

    // E3 parity harness (rasterCapture.ts): null outside the harness.
    const capture = rasterCapture();
    capture?.begin({
      kind: String((drawable as { kind?: unknown }).kind ?? 'path'), cacheKey: key, drawable, resolutionScale, padding,
      deviceMax: this.deviceMax,
    });
    const canvas = this.drawToCanvas(drawable, resolutionScale, padding);
    capture?.drawn?.();

    const tex = this.resources.texture(
      poolKeyFor(key),
      { label: `raster:${drawable.contentHash}`, width: canvas.width, height: canvas.height, format: displayReferredUploadFormat(), displayReferred: true, externalCopy: true },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    capture?.end({ canvas, texture: tex });

    // LRU cache insertion & eviction
    const bytes = canvas.width * canvas.height * 4;
    this.cache.set(key, { texture: tex, bytes, w: canvas.width, h: canvas.height });
    this.currentBytes += bytes;

    // `> 1` keeps the entry we just inserted — evicting the only entry would free
    // the texture the caller is about to draw with.
    while (this.currentBytes > this.maxBytes && this.cache.size > 1) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.releaseEntry(oldestKey);
    }

    return {
      texture: {
        id: tex.id.toString(),
        width: canvas.width,
        height: canvas.height,
      } as RasterResult['texture'],
      uvRect: {
        x: -padding,
        y: -padding,
        width: drawable.width + 2 * padding,
        height: drawable.height + 2 * padding,
      },
      resolutionScale,
    };
  }

  private drawToCanvas(drawable: any, resolutionScale: number, padding: number): HTMLCanvasElement {
    if (drawable.kind === 'text') {
      return this.drawText(drawable, resolutionScale, padding);
    } else if (drawable.kind === 'mask') {
      return this.drawMask(drawable, resolutionScale);
    } else {
      return this.drawPath(drawable, resolutionScale, padding);
    }
  }

  private drawText(spec: any, tier: number, pad = 0): HTMLCanvasElement {
    // Fill opacity is applied by the bake chain, so a layer using it must
    // enter that branch even with no CPU-only effect in its stack.
    const bake = layerIsBaked(spec);
    // Padded box, so a baked drop shadow / glow / blur has somewhere to fade
    // out instead of being sliced at the texture edge. `pad` is 0 for every
    // stack the GPU handles natively, which is the overwhelming majority.
    const bw = spec.width + 2 * pad;
    const bh = spec.height + 2 * pad;
    const ss = supersampleFor(tier, bw, bh, bake, this.deviceMax);
    const w = Math.max(1, Math.round(bw * ss));
    const h = Math.max(1, Math.round(bh * ss));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', bakeContextOptions(bake));
    if (!ctx) return canvas;

    const finishBake = (): HTMLCanvasElement => {
      if (bake) {
        if (spec.mask && spec.mask.paths.length > 0) {
          const matte = document.createElement('canvas');
          matte.width = w; matte.height = h;
          const mc = matte.getContext('2d');
          if (mc) {
            // Centre of the PADDED box — the same origin the glyphs were drawn
            // around, or the matte slides by `pad` against the content.
            mc.setTransform(1, 0, 0, 1, bw / 2, bh / 2);
            paintMaskMatte(mc, spec.mask, spec.width, spec.height);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'destination-in';
            ctx.drawImage(matte, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
          }
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // Lengths scaled with the raster: the chain runs in DEVICE px while the
        // glyphs were drawn through ctx.scale(ss, ss), so unscaled parameters
        // make a style's size relative to its content depend on the raster
        // resolution — which the tier cache then freezes and stretches. See
        // scaleEffectLengths.
        applyEffectChain(ctx, w, h, scaleEffectLengths(spec.effects, ss), (sw, sh) => {
          const s = document.createElement('canvas');
          s.width = sw; s.height = sh;
          return s;
        }, spec.fillOpacity ?? 1, spec.mask);
      }
      return canvas;
    };

    ctx.scale(ss, ss);
    // Everything below lays out in the UNPADDED box, so shift into it once.
    ctx.translate(pad, pad);
    paintTextInBox(ctx, spec);
    if (hasPaintStrokes(spec.paint)) {
      // Paint over the glyphs, before the bake's mask and chain — the path
      // raster's order. Strokes live in the box's CENTRED space.
      ctx.save();
      ctx.translate(spec.width / 2, spec.height / 2);
      drawPaint(ctx, spec.paint);
      ctx.restore();
    }
    return finishBake();
  }

  private drawPath(layer: any, tier: number, pad: number): HTMLCanvasElement {
    const bake = layerIsBaked(layer);
    const bw = layer.width + 2 * pad;
    const bh = layer.height + 2 * pad;
    const ss = supersampleFor(tier, bw, bh, bake, this.deviceMax);
    const w = Math.max(1, Math.round(bw * ss));
    const h = Math.max(1, Math.round(bh * ss));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', bakeContextOptions(bake));
    if (!ctx) return canvas;

    ctx.scale(ss, ss);
    ctx.translate(bw / 2, bh / 2);

    const strokeStack =
      layer.strokes && layer.strokes.length > 0 ? layer.strokes : layer.stroke ? [layer.stroke] : [];

    // PER-RUN PAINT. `subpathBatches` returns null unless some run carries its
    // own paint, so every layer not using the feature takes the original
    // single-path branch and renders byte-identically. That matters: separately
    // filled runs cannot cut holes in each other, so batching unconditionally
    // would silently change every multi-run path in every existing project.
    const batches = subpathBatches(layer);
    if (batches) {
      for (const batch of batches) {
        const trace = (): void => traceBatch(ctx, batch);
        ctx.save();
        // MULTIPLIES the run's paint rather than replacing it — which is what a
        // repeater's per-copy offsetOpacity means, and why it is a separate
        // field from fill/stroke rather than folded into them.
        const alpha = batch.paint?.opacity ?? 1;
        if (alpha < 1) ctx.globalAlpha *= alpha;
        const batchFills = [batch.paint?.fill ?? layer.fillPaint];
        const batchStrokes: Stroke[] = batch.paint?.stroke ? [batch.paint.stroke] : strokeStack;
        // AE Composite / per-paint blend: the ordered stack, only when a paint
        // asks for it — see the note on the unbatched branch below.
        if (hasOrderedPaint(batchFills, batchStrokes)) {
          drawPaintStack(
            ctx, paintRenderOrder(batchFills, batchStrokes), trace,
            (f) => fillStyleFor(ctx, f, layer.fill, layer.width, layer.height),
            (s) => {
              if (strokeShapeProfiled(ctx, s, layer, layer.width, layer.height, batch.runs)) return;
              strokeShape(ctx, s, trace, layer.width, layer.height);
            },
          );
          ctx.restore();
          continue;
        }
        trace();
        ctx.fillStyle = fillStyleFor(
          ctx, batch.paint?.fill ?? layer.fillPaint, layer.fill, layer.width, layer.height,
        );
        ctx.fill();
        for (const s of batchStrokes) {
          // Taper/Wave fill a variable-width ribbon instead of stroking; the
          // call returns false for anything it does not own (identity profile)
          // and the ordinary stroke runs. It gets THIS batch's runs — given
          // none it would ribbon every run once per batch, in each batch's
          // paint.
          if (strokeShapeProfiled(ctx, s, layer, layer.width, layer.height, batch.runs)) continue;
          strokeShape(ctx, s, trace, layer.width, layer.height);
        }
        ctx.restore();
      }
    } else if (hasOrderedPaint(
      layer.fillPaints && layer.fillPaints.length > 0 ? layer.fillPaints : [layer.fillPaint],
      strokeStack,
    )) {
      // AE's ORDERED paint stack: a paint set to Composite Above, or with its
      // own blend mode, interleaves fills and strokes in Contents order. Taken
      // ONLY when a paint asks for it — the branch below draws the same order
      // for the all-default case with a different call sequence (one trace for
      // every fill), and keeping it is what keeps those layers byte-identical.
      const fills = layer.fillPaints && layer.fillPaints.length > 0 ? layer.fillPaints : [layer.fillPaint];
      drawPaintStack(
        ctx, paintRenderOrder(fills, strokeStack), () => shapePath(ctx, layer),
        (f) => fillStyleFor(ctx, f, layer.fill, layer.width, layer.height),
        (s) => {
          if (strokeShapeProfiled(ctx, s, layer, layer.width, layer.height)) return;
          strokeShape(ctx, s, () => shapePath(ctx, layer), layer.width, layer.height);
        },
      );
    } else {
      shapePath(ctx, layer);
      if (layer.fillPaints && layer.fillPaints.length > 0) {
        for (const p of layer.fillPaints) {
          ctx.fillStyle = fillStyleFor(ctx, p, layer.fill, layer.width, layer.height);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = fillStyleFor(ctx, layer.fillPaint, layer.fill, layer.width, layer.height);
        ctx.fill();
      }
      for (const s of strokeStack) {
        // No trim branch. Trim is baked into the layer's geometry by
        // buildSnapshot, so the ordinary trace already describes the cut path —
        // which is the point: the fill above traces the SAME path and now follows
        // the trim, as it does in AE.
        if (strokeShapeProfiled(ctx, s, layer, layer.width, layer.height)) continue;
        strokeShape(ctx, s, () => shapePath(ctx, layer), layer.width, layer.height);
      }
    }

    if (layer.paint) {
      this.drawPaint(ctx, layer);
    }

    if (bake) {
      if (layer.mask && layer.mask.paths.length > 0) {
        const matte = document.createElement('canvas');
        matte.width = w; matte.height = h;
        const mc = matte.getContext('2d');
        if (mc) {
          // Centre of the PADDED box — matches the content's `translate(bw/2,
          // bh/2)` above. Using the unpadded centre slid the matte by `pad`.
          mc.setTransform(1, 0, 0, 1, bw / 2, bh / 2);
          paintMaskMatte(mc, layer.mask, layer.width, layer.height);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalCompositeOperation = 'destination-in';
          ctx.drawImage(matte, 0, 0);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Same device-px/raster-scale correction as the text path.
      applyEffectChain(ctx, w, h, scaleEffectLengths(layer.effects, ss), (sw, sh) => {
        const s = document.createElement('canvas');
        s.width = sw; s.height = sh;
        return s;
      }, layer.fillOpacity ?? 1, layer.mask);
    }

    return canvas;
  }

  /** The layer's paint over its content, in the path raster's centred local
   *  transform. The pass itself is shared with the text raster and the
   *  image/video bakes — see `drawPaint` in paintRaster. */
  private drawPaint(ctx: CanvasRenderingContext2D, layer: any): void {
    if (hasPaintStrokes(layer.paint)) drawPaint(ctx, layer.paint);
  }

  private drawMask(layer: any, _tier: number): HTMLCanvasElement {
    // Same hard cap as supersampleFor: a comp-sized mask at 2× must not ask
    // for a texture the GPU rejects (which drops the matte entirely).
    const ss = Math.min(2, MAX_RASTER_DIM / Math.max(1, layer.width, layer.height));
    const w = Math.max(1, Math.round(layer.width * ss));
    const h = Math.max(1, Math.round(layer.height * ss));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    ctx.scale(ss, ss);
    ctx.translate(layer.width / 2, layer.height / 2);

    paintMaskMatte(ctx, layer.mask, layer.width, layer.height);

    return canvas;
  }
}
