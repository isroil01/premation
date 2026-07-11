/**
 * Canvas2DBackend — the reference RenderBackend (TAD §6.4.1).
 *
 * Composites the snapshot's layers into a 2D canvas: fits the composition into
 * the surface (contain), fills the comp background, clips to it, then draws each
 * layer with its transform (translate/rotate/scale) and opacity. Zero document
 * authority, zero React. WebGL/WebGPU backends implement the same interface.
 */

import type { RenderBackend, RenderSnapshot, RenderLayer } from './RenderBackend';
import { blendToComposite } from '@core/effects/blendMode';
import { maskSegments, type LayerMask } from '@core/effects/mask';

/** Build a clip path (layer-local space) from a layer's vector mask. Inverted
 *  masks clip to the OUTSIDE by adding the layer rect and relying on even-odd. */
function buildMaskPath(mask: LayerMask, width: number, height: number): Path2D {
  const p = new Path2D();
  const inverted = mask.paths.some((m) => m.inverted);
  if (inverted) p.rect(-width / 2, -height / 2, width, height);
  for (const path of mask.paths) {
    const segs = maskSegments(path);
    if (segs.length === 0) continue;
    p.moveTo(segs[0]!.x0, segs[0]!.y0);
    for (const s of segs) p.bezierCurveTo(s.cx1, s.cy1, s.cx2, s.cy2, s.x1, s.y1);
    p.closePath();
  }
  return p;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Rewrite a canvas's alpha channel from its luminance (for luma track mattes),
 *  scaled by the existing alpha; `invert` uses the inverse luminance. */
function lumaToAlpha(ctx: CanvasRenderingContext2D, w: number, h: number, invert: boolean): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    const a = invert ? 255 - lum : lum;
    d[i + 3] = (a * d[i + 3]!) / 255;
  }
  ctx.putImageData(img, 0, 0);
}

export class Canvas2DBackend implements RenderBackend {
  readonly kind = 'canvas2d';
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  resize(width: number, height: number, dpr: number): void {
    if (!this.canvas) return;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  renderFrame(snapshot: RenderSnapshot): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const cw = canvas.width;
    const ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // Comp → device transform. Prefer the Workspace camera's view (pan/zoom);
    // fall back to fit-to-surface when no camera is driving the viewport.
    let scale: number;
    let offX: number;
    let offY: number;
    if (snapshot.view) {
      scale = snapshot.view.scale * this.dpr;
      offX = snapshot.view.offsetX * this.dpr;
      offY = snapshot.view.offsetY * this.dpr;
    } else {
      scale = Math.min(cw / snapshot.width, ch / snapshot.height) * 0.92;
      offX = (cw - snapshot.width * scale) / 2;
      offY = (ch - snapshot.height * scale) / 2;
    }

    // Drop shadow under the composition (device space, before the transform)
    // so the comp visibly floats off the workspace void (spec v2.1).
    const devW = snapshot.width * scale;
    const devH = snapshot.height * scale;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = snapshot.background;
    ctx.fillRect(offX, offY, devW, devH);
    ctx.restore();

    ctx.translate(offX, offY);
    ctx.scale(scale, scale);

    // Composition background + border.
    ctx.fillStyle = snapshot.background;
    ctx.fillRect(0, 0, snapshot.width, snapshot.height);

    // Clip to the composition frame.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, snapshot.width, snapshot.height);
    ctx.clip();

    this.drawLayers(ctx, snapshot.layers, offX, offY, scale, cw, ch, devW, devH);

    ctx.restore(); // comp clip
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 1px composition frame (device space — crisp at any zoom).
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(offX + 0.5, offY + 0.5, devW - 1, devH - 1);

    // Guide overlays (grid, safe areas, rulers) in device space.
    if (snapshot.overlays) this.drawOverlays(ctx, snapshot, offX, offY, devW, devH);
  }

  // ── Layer compositing (with track mattes) ───────────────────────
  private scratchA: HTMLCanvasElement | null = null;
  private scratchB: HTMLCanvasElement | null = null;

  private scratch(which: 'A' | 'B', w: number, h: number): HTMLCanvasElement {
    let c = which === 'A' ? this.scratchA : this.scratchB;
    if (!c) {
      c = document.createElement('canvas');
      if (which === 'A') this.scratchA = c;
      else this.scratchB = c;
    }
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return c;
  }

  /**
   * Draw the layer list, resolving track mattes: a matted layer is composited
   * against the layer directly above it (its matte source), which is otherwise
   * not drawn on its own.
   */
  private drawLayers(
    ctx: CanvasRenderingContext2D,
    layers: ReadonlyArray<RenderLayer>,
    offX: number,
    offY: number,
    scale: number,
    cw: number,
    ch: number,
    devW: number,
    devH: number,
  ): void {
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      if (layer.isMatteSource) continue; // drawn only as another layer's matte
      // Adjustment layer: apply its filter to everything drawn beneath; it
      // contributes no content of its own.
      if (layer.isAdjustment) {
        if (layer.visible && layer.filter) this.applyAdjustment(ctx, layer.filter, offX, offY, devW, devH);
        continue;
      }
      // Motion blur: accumulate the layer at each sub-frame transform, each at
      // a fraction of its opacity, approximating the shutter-interval average.
      if (layer.motionSamples && layer.motionSamples.length > 1) {
        if (!layer.visible) continue;
        const n = layer.motionSamples.length;
        for (const s of layer.motionSamples) {
          this.drawComposited(ctx, {
            ...layer,
            x: s.x, y: s.y, rotation: s.rotation, scaleX: s.scaleX, scaleY: s.scaleY,
            opacity: s.opacity / n,
            motionSamples: undefined,
          });
        }
        continue;
      }
      if (layer.matte && i > 0) {
        this.drawMatted(ctx, layers[i - 1]!, layer, offX, offY, scale, cw, ch);
        continue;
      }
      if (!layer.visible) continue;
      this.drawComposited(ctx, layer);
    }
  }

  /** Re-composite the composition region drawn so far through a CSS filter (the
   *  adjustment layer's effect stack), affecting everything beneath it. */
  private applyAdjustment(
    ctx: CanvasRenderingContext2D,
    filter: string,
    offX: number,
    offY: number,
    devW: number,
    devH: number,
  ): void {
    const x = Math.round(offX);
    const y = Math.round(offY);
    const w = Math.max(1, Math.round(devW));
    const h = Math.max(1, Math.round(devH));
    let region: ImageData;
    try {
      region = ctx.getImageData(x, y, w, h);
    } catch {
      return; // e.g. a tainted canvas — skip rather than throw into the frame
    }
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const oc = off.getContext('2d');
    if (!oc) return;
    oc.putImageData(region, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(x, y, w, h);
    ctx.filter = filter;
    ctx.drawImage(off, x, y);
    ctx.restore();
  }

  /** Draw one layer with its transform, opacity, blend, filter and mask, in the
   *  current (composition-space) transform. */
  private drawComposited(ctx: CanvasRenderingContext2D, layer: RenderLayer, useBlend = true): void {
    ctx.save();
    ctx.globalAlpha = clamp01(layer.opacity);
    if (useBlend && layer.blend && layer.blend !== 'normal') {
      ctx.globalCompositeOperation = blendToComposite(layer.blend);
    }
    if (layer.filter) ctx.filter = layer.filter;
    ctx.translate(layer.x, layer.y);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.scale(layer.scaleX || 1, layer.scaleY || 1);
    if (layer.mask && layer.mask.paths.length > 0) {
      ctx.clip(buildMaskPath(layer.mask, layer.width, layer.height), 'evenodd');
    }
    this.drawLayer(ctx, layer);
    ctx.restore();
  }

  /** Composite `matted` through `source` as a track matte via offscreen buffers. */
  private drawMatted(
    ctx: CanvasRenderingContext2D,
    source: RenderLayer,
    matted: RenderLayer,
    offX: number,
    offY: number,
    scale: number,
    cw: number,
    ch: number,
  ): void {
    if (!matted.visible) return;

    const applyComp = (c: CanvasRenderingContext2D): void => {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cw, ch);
      c.translate(offX, offY);
      c.scale(scale, scale);
    };

    // A: the matted layer.
    const a = this.scratch('A', cw, ch);
    const ac = a.getContext('2d');
    // B: the matte source (drawn neutrally — its own blend doesn't apply here).
    const b = this.scratch('B', cw, ch);
    const bc = b.getContext('2d');
    if (!ac || !bc) return;

    applyComp(ac);
    this.drawComposited(ac, { ...matted, matte: undefined }, false);
    applyComp(bc);
    this.drawComposited(bc, { ...source, blend: undefined }, false);

    const type = matted.matte!;
    if (type === 'luma' || type === 'luma-inv') {
      lumaToAlpha(bc, cw, ch, type === 'luma-inv');
    }

    // Keep the matted pixels where the (possibly luma-converted) source has
    // alpha; invert for the '-inv' alpha matte.
    ac.setTransform(1, 0, 0, 1, 0, 0);
    ac.globalCompositeOperation = type === 'alpha-inv' ? 'destination-out' : 'destination-in';
    ac.drawImage(b, 0, 0);
    ac.globalCompositeOperation = 'source-over';

    // Blit the matted result to the main surface at device identity (the comp
    // clip on `ctx` is still active). Honor the matted layer's blend mode.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (matted.blend && matted.blend !== 'normal') {
      ctx.globalCompositeOperation = blendToComposite(matted.blend);
    }
    ctx.drawImage(a, 0, 0);
    ctx.restore();
  }

  private drawOverlays(
    ctx: CanvasRenderingContext2D,
    snapshot: RenderSnapshot,
    offX: number,
    offY: number,
    devW: number,
    devH: number,
  ): void {
    const o = snapshot.overlays!;
    ctx.save();

    if (o.grid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 3; i++) {
        const x = offX + (devW * i) / 3;
        const y = offY + (devH * i) / 3;
        ctx.beginPath(); ctx.moveTo(x + 0.5, offY); ctx.lineTo(x + 0.5, offY + devH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(offX, y + 0.5); ctx.lineTo(offX + devW, y + 0.5); ctx.stroke();
      }
    }

    if (o.safeArea) {
      const draw = (inset: number, color: string): void => {
        const ix = offX + devW * inset;
        const iy = offY + devH * inset;
        ctx.strokeStyle = color;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1;
        ctx.strokeRect(ix + 0.5, iy + 0.5, devW * (1 - inset * 2), devH * (1 - inset * 2));
      };
      draw(0.05, 'rgba(255,220,120,0.6)'); // action-safe (90%)
      draw(0.10, 'rgba(255,120,120,0.6)'); // title-safe (80%)
      ctx.setLineDash([]);
    }

    if (o.rulers) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(offX, offY - 16, devW, 16);
      ctx.fillRect(offX - 16, offY, 16, devH);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px monospace';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= 10; i++) {
        const x = offX + (devW * i) / 10;
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillRect(x, offY - 6, 1, 6);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(String(Math.round((snapshot.width * i) / 10)), x + 2, offY - 9);
      }
    }

    ctx.restore();
  }

  private drawLayer(ctx: CanvasRenderingContext2D, layer: RenderLayer): void {
    const w = layer.width;
    const h = layer.height;
    ctx.fillStyle = layer.fill;

    switch (layer.kind) {
      case 'shape': {
        if (layer.primitive === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          this.roundRect(ctx, -w / 2, -h / 2, w, h, 12);
          ctx.fill();
        }
        break;
      }
      case 'image':
      case 'video': {
        this.roundRect(ctx, -w / 2, -h / 2, w, h, 10);
        ctx.fill();
        // frame outline
        ctx.globalAlpha *= 0.6;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.stroke();
        break;
      }
      case 'text': {
        const size = layer.fontSize ?? 48;
        ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(layer.text ?? 'Text', 0, 0);
        break;
      }
    }
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  dispose(): void {
    this.ctx = null;
    this.canvas = null;
  }
}
