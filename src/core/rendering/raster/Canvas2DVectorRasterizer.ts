import type { ResourceManager, TextureHandle } from '@motion/renderer';
import {
  VectorRasterizer,
  RasterRequest,
  RasterResult,
  rasterCacheKey
} from '@motion/renderer';
import { layoutText } from '@core/text/textLayout';
import { paintMaskMatte } from '@core/effects/mask';
import { applyEffectChain, effectsNeedCpuBake } from '@core/effects/effectBake';
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

  invalidate(contentHash: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(contentHash)) {
        const entry = this.cache.get(key);
        if (entry) {
          this.currentBytes -= entry.bytes;
          this.resources.freeTexture(entry.texture.id.toString());
        }
        this.cache.delete(key);
      }
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

    const sigKey = `raster:${key}`;
    const tex = this.resources.texture(
      sigKey,
      { label: `raster:${drawable.contentHash}`, width: canvas.width, height: canvas.height, format: 'rgba8unorm', externalCopy: true },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });

    // LRU cache insertion & eviction
    const bytes = canvas.width * canvas.height * 4;
    this.cache.set(key, { texture: tex, bytes, w: canvas.width, h: canvas.height });
    this.currentBytes += bytes;

    while (this.currentBytes > this.maxBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestEntry = this.cache.get(oldestKey);
        if (oldestEntry) {
          this.currentBytes -= oldestEntry.bytes;
          this.resources.freeTexture(oldestEntry.texture.id.toString());
        }
        this.cache.delete(oldestKey);
      }
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
      return this.drawText(drawable, resolutionScale);
    } else if (drawable.kind === 'mask') {
      return this.drawMask(drawable, resolutionScale);
    } else {
      return this.drawPath(drawable, resolutionScale, padding);
    }
  }

  private drawText(spec: any, tier: number): HTMLCanvasElement {
    const bake = effectsNeedCpuBake(spec.effects);
    const ss = bake ? tier : tier * 2; // TEXT_SUPERSAMPLE = 2
    const w = Math.max(1, Math.round(spec.width * ss));
    const h = Math.max(1, Math.round(spec.height * ss));
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
            mc.setTransform(1, 0, 0, 1, spec.width / 2, spec.height / 2);
            paintMaskMatte(mc, spec.mask, spec.width, spec.height);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'destination-in';
            ctx.drawImage(matte, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
          }
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        applyEffectChain(ctx, w, h, spec.effects!, (sw, sh) => {
          const s = document.createElement('canvas');
          s.width = sw; s.height = sh;
          return s;
        });
      }
      return canvas;
    };

    ctx.scale(ss, ss);
    ctx.font = textCssFont(spec);
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = spec.letterSpacing ? `${spec.letterSpacing}px` : '0px';
    ctx.fillStyle = spec.color;

    const text = spec.text || 'Text';

    if (!spec.runs || spec.runs.length === 0) {
      const size = spec.fontSize;
      const align = spec.align ?? 'left';
      let anchorX = spec.width / 2;
      if (align === 'left' || align === 'justify') { ctx.textAlign = 'left'; anchorX = 0; }
      else if (align === 'right') { ctx.textAlign = 'right'; anchorX = spec.width; }
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
      { runs: spec.runs, boxWidth: spec.width },
    );

    ctx.textAlign = 'center';
    const cx = spec.width / 2;
    const cy = spec.height / 2;
    for (const g of laid.glyphs) {
      if (g.char.trim() === '') continue;
      ctx.font = textCssFont(g.style);
      ctx.fillStyle = g.style.fill ?? spec.color;
      ctx.fillText(g.char, cx + g.x, cy + g.y);
    }
    return finishBake();
  }

  private drawPath(layer: any, tier: number, pad: number): HTMLCanvasElement {
    const bake = effectsNeedCpuBake(layer.effects);
    const ss = bake ? tier : tier * 2; // TEXT_SUPERSAMPLE = 2
    const bw = layer.width + 2 * pad;
    const bh = layer.height + 2 * pad;
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
          mc.setTransform(1, 0, 0, 1, layer.width / 2, layer.height / 2);
          paintMaskMatte(mc, layer.mask, layer.width, layer.height);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalCompositeOperation = 'destination-in';
          ctx.drawImage(matte, 0, 0);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      applyEffectChain(ctx, w, h, layer.effects!, (sw, sh) => {
        const s = document.createElement('canvas');
        s.width = sw; s.height = sh;
        return s;
      });
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
