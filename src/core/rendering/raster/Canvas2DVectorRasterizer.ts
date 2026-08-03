import type { ResourceManager, TextureHandle } from '@motion/renderer';
import {
  VectorRasterizer,
  RasterRequest,
  RasterResult,
  rasterCacheKey
} from '@motion/renderer';
import { layoutText } from '@core/text/textLayout';
import { applyTextPath } from '@core/text/textPath';
import { arcTable } from '@core/scene/trimPath';
import { mixHex } from '@core/text/textAnimators';
import { paintMaskMatte } from '@core/effects/mask';
import { applyEffectChain, layerIsBaked } from '@core/effects/effectBake';
import { scaleEffectLengths } from '@core/effects/effects';
import {
  fillStyleFor,
  shapePath,
  strokeShape,
  strokeTrimmed,
} from './vectorDraw';
import { textCssFont } from '../AppTextureProvider';

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
 */
function supersampleFor(tier: number, boxW: number, boxH: number, bake: boolean): number {
  const want = bake ? tier : tier * SUPERSAMPLE;
  const longest = Math.max(1, boxW, boxH);
  return Math.max(Math.min(tier, want), Math.min(want, MAX_RASTER_DIM / longest));
}

export class Canvas2DVectorRasterizer implements VectorRasterizer {
  private cache = new Map<string, { texture: TextureHandle; bytes: number; w: number; h: number }>();
  private currentBytes = 0;
  private maxBytes = 512 * 1024 * 1024; // 512 MB
  private hits = 0;
  private misses = 0;

  constructor(private readonly resources: ResourceManager) {}

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

    const canvas = this.drawToCanvas(drawable, resolutionScale, padding);

    const tex = this.resources.texture(
      poolKeyFor(key),
      { label: `raster:${drawable.contentHash}`, width: canvas.width, height: canvas.height, format: 'rgba8unorm', externalCopy: true },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });

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
    const ss = supersampleFor(tier, bw, bh, bake);
    const w = Math.max(1, Math.round(bw * ss));
    const h = Math.max(1, Math.round(bh * ss));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
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
    ctx.font = textCssFont(spec);
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = spec.letterSpacing ? `${spec.letterSpacing}px` : '0px';
    ctx.fillStyle = spec.color;

    const text = spec.text || 'Text';

    const hasGlyphWork =
      (spec.runs && spec.runs.length > 0) ||
      (spec.glyphs && spec.glyphs.length > 0) ||
      !!spec.textPath;

    if (!hasGlyphWork) {
      const size = spec.fontSize;
      const align = spec.align ?? 'left';
      const padX = 12;
      let anchorX = spec.width / 2;
      if (align === 'left' || align === 'justify') { ctx.textAlign = 'left'; anchorX = padX; }
      else if (align === 'right') { ctx.textAlign = 'right'; anchorX = spec.width - padX; }
      else { ctx.textAlign = 'center'; anchorX = spec.width / 2; }

      const lines = text.split('\n');
      const lh = (spec.lineHeight ?? 1.2) * size;
      const gap = lh + (spec.paragraphSpacing ?? 0);
      const startY = spec.height / 2 - ((lines.length - 1) * gap) / 2;
      lines.forEach((line: string, i: number) => ctx.fillText(line, anchorX, startY + i * gap));
      return finishBake();
    }

    ctx.letterSpacing = '0px';
    const measureCache = new Map<string, number>();
    const measure: any = (char: string, style: any) => {
      const font = textCssFont(style);
      const key = `${font} ${char}`;
      const hit = measureCache.get(key);
      if (hit !== undefined) return hit;
      ctx.font = font;
      const width = ctx.measureText(char).width;
      measureCache.set(key, width);
      return width;
    };

    const laid = layoutText(
      text,
      {
        fontSize: spec.fontSize,
        fontFamily: spec.fontFamily,
        fontWeight: spec.fontWeight,
        fontStyle: spec.fontStyle,
        letterSpacing: spec.letterSpacing,
        fill: spec.color,
        align: spec.align,
        lineHeight: spec.lineHeight,
        paragraphSpacing: spec.paragraphSpacing,
      },
      measure,
      {
        runs: spec.runs,
        transforms: spec.glyphs,
        boxWidth: spec.width,
        // Kerned measurement, so this per-glyph path lands on exactly the same
        // pixels as the whole-string fast path above. Without it the two
        // disagreed by 8px over a 19-character headline, and any frame that
        // composited both showed the string twice at two spacings — a picket
        // fence of 1px vertical bars through the letterforms.
        measureRun: (run: string, style: any) => {
          const font = textCssFont(style);
          const key = `run|${font}|${style.letterSpacing ?? 0}|${run}`;
          const hit = measureCache.get(key);
          if (hit !== undefined) return hit;
          // Spacing ON for this measurement: the advance it returns is what the
          // fast path would actually produce.
          ctx.letterSpacing = style.letterSpacing ? `${style.letterSpacing}px` : '0px';
          ctx.font = font;
          const w = ctx.measureText(run).width;
          ctx.letterSpacing = '0px';
          measureCache.set(key, w);
          return w;
        },
      },
    );

    const placed = spec.textPath
      ? applyTextPath(laid, {
          table: arcTable(spec.textPath.points, spec.textPath.closed),
          firstMargin: spec.textPath.firstMargin,
          reversed: spec.textPath.reversed,
          perpendicular: spec.textPath.perpendicular,
          align: spec.align,
        })
      : laid.glyphs;

    ctx.textAlign = 'center';
    const cx = spec.width / 2;
    const cy = spec.height / 2;
    for (const g of placed) {
      const tr = g.transform;
      const ch = tr?.displayChar ?? g.char;
      if (ch.trim() === '') continue;

      // The cheap path stays cheap: a glyph with no animator transform and no
      // path angle draws exactly as it did before, with no save/restore.
      const plain = !tr && g.angle === undefined;
      if (plain) {
        ctx.font = textCssFont(g.style);
        ctx.fillStyle = g.style.fill ?? spec.color;
        // Centred on the glyph's own advance box (`PlacedGlyph.x` is that
        // centre). Drawing left-aligned from `x - inkWidth / 2` was tried and is
        // the identical span, so it changed nothing — measured, both give 42 ink
        // runs. The residual difference against the whole-string path is font
        // SHAPING (ligatures, contextual alternates), which no amount of
        // positioning reproduces glyph-by-glyph.
        ctx.fillText(ch, cx + g.x, cy + g.y);
        continue;
      }

      ctx.save();
      // Order matters and mirrors AE: translate to the glyph's own origin,
      // then rotate / skew / scale ABOUT it, so a rotating character spins in
      // place rather than swinging around the layer's anchor.
      ctx.translate(cx + g.x + (tr?.dx ?? 0), cy + g.y + (tr?.dy ?? 0) + (tr?.lineSpacing ?? 0) * g.line);
      if (g.angle) ctx.rotate(g.angle);
      if (tr) {
        if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
        if (tr.skew) ctx.transform(1, 0, Math.tan((-tr.skew * Math.PI) / 180), 1, 0, 0);
        if (tr.scale !== 1 || tr.scaleY !== 1) ctx.scale(tr.scale, tr.scaleY);
        // Opacity multiplies the layer's own — an animator fading a character
        // to 0 must not brighten a layer that is already half transparent.
        if (tr.opacity !== 1) ctx.globalAlpha = ctx.globalAlpha * Math.max(0, tr.opacity);
        if (tr.blur > 0) ctx.filter = `blur(${tr.blur}px)`;
      }

      ctx.font = textCssFont(g.style);
      const baseFill = g.style.fill ?? spec.color;
      const fill =
        tr?.color && (tr.colorMix ?? 0) > 0
          ? mixHex(baseFill, tr.color, tr.colorMix ?? 1)
          : baseFill;

      // AE's Fill & Stroke order, per layer. UNDER is the default: a stroke
      // centres on the outline, so painting it over the fill eats half its
      // width out of the glyph and an animated stroke appears to thin the
      // letterforms. Over is still worth having — it is how you get a hard
      // outline that stays crisp against a busy background.
      const strokeGlyph = (): void => {
        if (!tr || tr.strokeWidth <= 0) return;
        ctx.lineWidth = tr.strokeWidth;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = tr.strokeColor ?? fill;
        ctx.strokeText(ch, 0, 0);
      };
      const fillGlyph = (): void => {
        const fillAlpha = tr ? Math.max(0, tr.fillOpacity) : 1;
        if (fillAlpha <= 0) return;
        const prev = ctx.globalAlpha;
        if (fillAlpha < 1) ctx.globalAlpha = prev * fillAlpha;
        ctx.fillStyle = fill;
        ctx.fillText(ch, 0, 0);
        ctx.globalAlpha = prev;
      };

      if (spec.strokeOverFill) {
        fillGlyph();
        strokeGlyph();
      } else {
        strokeGlyph();
        fillGlyph();
      }
      ctx.restore();
    }
    return finishBake();
  }

  private drawPath(layer: any, tier: number, pad: number): HTMLCanvasElement {
    const bake = layerIsBaked(layer);
    const bw = layer.width + 2 * pad;
    const bh = layer.height + 2 * pad;
    const ss = supersampleFor(tier, bw, bh, bake);
    const w = Math.max(1, Math.round(bw * ss));
    const h = Math.max(1, Math.round(bh * ss));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    ctx.scale(ss, ss);
    ctx.translate(bw / 2, bh / 2);

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
    const strokeStack =
      layer.strokes && layer.strokes.length > 0 ? layer.strokes : layer.stroke ? [layer.stroke] : [];
    for (const s of strokeStack) {
      if (layer.trim) strokeTrimmed(ctx, layer, s);
      else strokeShape(ctx, s, () => shapePath(ctx, layer), layer.width, layer.height);
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

  private drawPaint(ctx: CanvasRenderingContext2D, layer: any): void {
    const strokes = layer.paint?.strokes;
    if (!strokes || strokes.length === 0) return;
    ctx.save();
    for (const s of strokes) {
      if (s.points.length === 0 || s.size <= 0 || s.opacity <= 0) continue;
      ctx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
      ctx.globalAlpha = Math.max(0, Math.min(1, s.opacity));
      ctx.strokeStyle = s.mode === 'erase' ? '#000' : s.color;
      ctx.lineWidth = s.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.filter = s.hardness < 1 ? `blur(${((1 - s.hardness) * s.size) / 3}px)` : 'none';
      if (s.points.length === 1) {
        const p = s.points[0]!;
        ctx.beginPath();
        ctx.fillStyle = s.mode === 'erase' ? '#000' : s.color;
        ctx.arc(p.x, p.y, s.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(s.points[0]!.x, s.points[0]!.y);
        for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i]!.x, s.points[i]!.y);
        ctx.stroke();
      }
    }
    ctx.filter = 'none';
    ctx.restore();
  }


  private drawMask(layer: any, _tier: number): HTMLCanvasElement {
    const ss = 2; // TEXT_SUPERSAMPLE = 2
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
