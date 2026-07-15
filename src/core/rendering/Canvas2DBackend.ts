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
import { sortedStops, type FillPaint } from '@core/paint/fill';
import type { Stroke } from '@core/paint/stroke';
import { mixHex, type GlyphTransform } from '@core/text/textAnimators';
import { trimPolyline, type Pt } from '@core/scene/trimPath';
import { getMatteMode, getMatteSourceId } from '@core/effects/matte';
import { getEventBus } from '@core/events/EventBus';

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

/** Resolve a layer's fill into a Canvas fillStyle. Gradients are built in the
 *  layer's centred local space ([-w/2..w/2]); falls back to the solid string. */
function fillStyleFor(
  ctx: CanvasRenderingContext2D,
  paint: FillPaint | undefined,
  fallback: string,
  w: number,
  h: number,
): string | CanvasGradient {
  if (!paint || paint.type === 'solid') return fallback;
  let grad: CanvasGradient;
  if (paint.type === 'linear') {
    // Endpoints span the box along the angle (0°=→, 90°=↓).
    const a = (paint.angle * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    grad = ctx.createLinearGradient(-dx * half, -dy * half, dx * half, dy * half);
  } else {
    const cx = (paint.cx - 0.5) * w;
    const cy = (paint.cy - 0.5) * h;
    const r = Math.max(0.01, paint.radius) * Math.hypot(w, h) / 2;
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  }
  for (const s of sortedStops(paint.stops)) grad.addColorStop(clamp01(s.offset), s.color);
  return grad;
}

/** Apply a stroke's paint state (colour+opacity, width, dash, cap, join). */
function applyStrokeStyle(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  ctx.globalAlpha *= clamp01(stroke.opacity);
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = stroke.cap;
  ctx.lineJoin = stroke.join;
  ctx.setLineDash(stroke.dash.length ? stroke.dash : []);
}

/** Paint a transparency checkerboard over a device-space rect (comp is
 *  transparent — this stands in for "no background", like AE/Photoshop). */
function drawCheckerboard(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  const cell = 12;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = '#3a3a3e';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#2a2a2e';
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r + c) % 2 === 0) ctx.fillRect(x + c * cell, y + r * cell, cell, cell);
    }
  }
  ctx.restore();
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
  readonly readyPromise = Promise.resolve();
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  /** Preview-only chrome (float shadow + transparency checkerboard). Off for
   *  export so a transparent comp yields real alpha, not a baked checkerboard. */
  private previewChrome = false;
  private imgCache = new Map<string, HTMLImageElement>();
  private videoCache = new Map<string, HTMLVideoElement>();
  private currentTime = 0;

  private resolveSrc(src: string | undefined): string {
    if (!src) return '';
    if (src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('http') || src.startsWith('local-file:')) {
      return src;
    }
    if (typeof window !== 'undefined' && ((window as any).motionEditor || (window as any).electronAPI)) {
      return `local-file://${src.replace(/\\/g, '/')}`;
    }
    return src;
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  setPreviewChrome(on: boolean): void {
    this.previewChrome = on;
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
    if (snapshot.time !== undefined) this.currentTime = snapshot.time;
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

    const devW = snapshot.width * scale;
    const devH = snapshot.height * scale;

    // Preview chrome only: a drop shadow so the comp floats off the workspace
    // void (spec v2.1), plus a transparency checkerboard for transparent comps.
    // Skipped for export so transparent → true alpha (no baked plate/checker).
    if (this.previewChrome) {
      ctx.save();
      // No drop shadow per user request
      ctx.fillStyle = snapshot.transparent ? '#2a2a2e' : snapshot.background;
      ctx.fillRect(offX, offY, devW, devH);
      ctx.restore();
      if (snapshot.transparent) drawCheckerboard(ctx, offX, offY, devW, devH);
    }

    ctx.translate(offX, offY);
    ctx.scale(scale, scale);

    // Composition background (skipped when transparent — layers draw over the
    // checkerboard so the user sees exactly what an alpha export will contain).
    if (!snapshot.transparent) {
      ctx.fillStyle = snapshot.background;
      ctx.fillRect(0, 0, snapshot.width, snapshot.height);
    }

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

  private scratchA: HTMLCanvasElement | null = null;
  private scratchB: HTMLCanvasElement | null = null;
  private scratchC: HTMLCanvasElement | null = null;

  private scratch(which: 'A' | 'B' | 'C', w: number, h: number): HTMLCanvasElement {
    let c = which === 'A' ? this.scratchA : (which === 'B' ? this.scratchB : this.scratchC);
    if (!c) {
      c = document.createElement('canvas');
      if (which === 'A') this.scratchA = c;
      else if (which === 'B') this.scratchB = c;
      else this.scratchC = c;
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
      // Precomp: render the nested layers to a texture and composite as a unit.
      if (layer.precompLayers) {
        this.drawPrecomp(ctx, layer, offX, offY, scale, cw, ch, devW, devH);
        continue;
      }
      // Light: a radial glow brightening the layers beneath (screen blend).
      if (layer.light) {
        this.drawLight(ctx, layer);
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
      if (layer.matte) {
        const sourceId = getMatteSourceId(layer.matte);
        const sourceLayer = sourceId ? layers.find((l) => l.id === sourceId) : (i > 0 ? layers[i - 1] : undefined);
        if (sourceLayer) {
          this.drawMatted(ctx, sourceLayer, layer, offX, offY, scale, cw, ch);
          continue;
        }
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

  /** Point light (Prompt 12): a radial colour→transparent gradient at the
   *  light's position, composited with a screen blend so it brightens the
   *  layers beneath. Intensity scales the alpha, radius the falloff. */
  private drawLight(ctx: CanvasRenderingContext2D, layer: RenderLayer): void {
    if (!layer.visible || !layer.light) return;
    const { color, intensity, radius } = layer.light;
    const r = Math.max(1, radius);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = clamp01(intensity / 100);
    const g = ctx.createRadialGradient(layer.x, layer.y, 0, layer.x, layer.y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(layer.x - r, layer.y - r, r * 2, r * 2);
    ctx.restore();
  }

  /** Precomp (Prompt 10): render the nested layers to an offscreen texture that
   *  matches the main comp→device transform, then composite that texture as one
   *  unit — the precomp's opacity / blend / filter apply to the whole nested
   *  result (overlapping semi-transparent children composite correctly inside).
   *  (Precomp mask is a documented follow-up.) */
  private drawPrecomp(
    ctx: CanvasRenderingContext2D,
    layer: RenderLayer,
    offX: number,
    offY: number,
    scale: number,
    cw: number,
    ch: number,
    devW: number,
    devH: number,
  ): void {
    if (!layer.visible || !layer.precompLayers || layer.precompLayers.length === 0) return;
    const main = ctx.canvas;
    const off = document.createElement('canvas');
    off.width = main.width;
    off.height = main.height;
    const octx = off.getContext('2d');
    if (!octx) return;
    // Match the composition→device transform so nested layers align.
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.translate(offX, offY);
    octx.scale(scale, scale);
    this.drawLayers(octx, layer.precompLayers, offX, offY, scale, cw, ch, devW, devH);
    // Composite the texture (device space) with the precomp's own opacity/blend/
    // filter — and its mask. The mask is clipped in comp space; a Path2D clip is
    // stored in device space, so it still applies after we reset the transform
    // to draw the device-aligned texture.
    ctx.save();
    if (layer.mask && layer.mask.paths.length > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(offX, offY);
      ctx.scale(scale, scale);
      ctx.translate(layer.x, layer.y);
      ctx.clip(buildMaskPath(layer.mask, layer.width, layer.height), 'evenodd');
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = clamp01(layer.opacity);
    if (layer.blend && layer.blend !== 'normal') ctx.globalCompositeOperation = blendToComposite(layer.blend);
    if (layer.filter) ctx.filter = layer.filter;
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }

  /** Draw one layer with its transform, opacity, blend, filter and mask, in the
   *  current (composition-space) transform.
   *  Enforces AE order (`masks` -> `effects` (`filter`) -> `transform`):
   *  when a filter is present, the raw layer (and mask clip) is rendered to an offscreen
   *  texture (`scratchC`) at native dimensions, then drawn through the filter and spatial transform. */
  private drawComposited(ctx: CanvasRenderingContext2D, layer: RenderLayer, useBlend = true): void {
    if (layer.filter) {
      const w = Math.max(1, Math.ceil(layer.width || 100));
      const h = Math.max(1, Math.ceil(layer.height || 100));
      const off = this.scratch('C', w, h);
      const oc = off.getContext('2d');
      if (oc) {
        oc.setTransform(1, 0, 0, 1, 0, 0);
        oc.clearRect(0, 0, w, h);
        oc.setTransform(1, 0, 0, 1, w / 2, h / 2);
        if (layer.mask && layer.mask.paths.length > 0) {
          oc.save();
          oc.clip(buildMaskPath(layer.mask, layer.width, layer.height), 'evenodd');
        }
        this.drawLayer(oc, layer);
        if (layer.mask && layer.mask.paths.length > 0) {
          oc.restore();
        }

        ctx.save();
        ctx.globalAlpha = clamp01(layer.opacity);
        if (useBlend && layer.blend && layer.blend !== 'normal') {
          ctx.globalCompositeOperation = blendToComposite(layer.blend);
        }
        ctx.filter = layer.filter;
        if (layer.matrix) {
          const m = layer.matrix;
          ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        } else {
          ctx.translate(layer.x, layer.y);
          ctx.rotate((layer.rotation * Math.PI) / 180);
          ctx.scale(layer.scaleX || 1, layer.scaleY || 1);
        }
        if (layer.anchorX || layer.anchorY) ctx.translate(-(layer.anchorX ?? 0), -(layer.anchorY ?? 0));
        ctx.drawImage(off, -w / 2, -h / 2, w, h);
        ctx.restore();
        return;
      }
    }

    ctx.save();
    ctx.globalAlpha = clamp01(layer.opacity);
    if (useBlend && layer.blend && layer.blend !== 'normal') {
      ctx.globalCompositeOperation = blendToComposite(layer.blend);
    }
    if (layer.filter) ctx.filter = layer.filter;
    if (layer.matrix) {
      // 3D: full projected affine (perspective tilt / shear) in comp space.
      const m = layer.matrix;
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    } else {
      ctx.translate(layer.x, layer.y);
      ctx.rotate((layer.rotation * Math.PI) / 180);
      ctx.scale(layer.scaleX || 1, layer.scaleY || 1);
    }
    // Anchor: offset the content so the anchor point sits at the pivot, so
    // rotation/scale spin around it (applied inside the transform, before mask).
    if (layer.anchorX || layer.anchorY) ctx.translate(-(layer.anchorX ?? 0), -(layer.anchorY ?? 0));
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

    const type = getMatteMode(matted.matte);
    if (!type) return;
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
      const div = Math.max(2, Math.min(64, Math.round(o.gridDivisions ?? 3)));
      for (let i = 1; i < div; i++) {
        const x = offX + (devW * i) / div;
        const y = offY + (devH * i) / div;
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
    ctx.fillStyle = fillStyleFor(ctx, layer.fillPaint, layer.fill, w, h);

    switch (layer.kind) {
      case 'shape': {
        this.shapePath(ctx, layer);
        ctx.fill();
        if (layer.stroke) {
          if (layer.trim) this.strokeTrimmed(ctx, layer, layer.stroke);
          else this.strokeShape(ctx, layer.stroke, () => this.shapePath(ctx, layer));
        }
        break;
      }
      case 'image': {
        if (layer.src) {
          const resolvedSrc = this.resolveSrc(layer.src);
          let img = this.imgCache.get(resolvedSrc);
          if (!img) {
            img = new Image();
            img.onload = () => {
              getEventBus().emit('AnimationChanged', { nodeId: layer.id });
            };
            img.src = resolvedSrc;
            this.imgCache.set(resolvedSrc, img);
          }
          if (img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
          } else {
            this.roundRect(ctx, -w / 2, -h / 2, w, h, 10);
            ctx.fill();
          }
        } else {
          this.roundRect(ctx, -w / 2, -h / 2, w, h, 10);
          ctx.fill();
        }
        // frame outline
        ctx.globalAlpha *= 0.6;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.stroke();
        break;
      }
      case 'video': {
        if (layer.src) {
          const resolvedSrc = this.resolveSrc(layer.src);
          let vid = this.videoCache.get(resolvedSrc);
          if (!vid) {
            vid = document.createElement('video');
            vid.muted = true;
            vid.autoplay = false;
            vid.loop = true;
            vid.src = resolvedSrc;
            vid.onseeked = () => getEventBus().emit('AnimationChanged', { nodeId: layer.id });
            vid.oncanplay = () => getEventBus().emit('AnimationChanged', { nodeId: layer.id });
            this.videoCache.set(resolvedSrc, vid);
          }
          
          if (vid.readyState >= 2) { // HAVE_CURRENT_DATA
            // Only set currentTime if it differs significantly, to avoid infinite seeking loops
            const targetTime = layer.sourceTime !== undefined ? layer.sourceTime : this.currentTime;
            if (Math.abs(vid.currentTime - targetTime) > 0.05) {
              vid.currentTime = targetTime;
            }
            ctx.drawImage(vid, -w / 2, -h / 2, w, h);
          } else {
            this.roundRect(ctx, -w / 2, -h / 2, w, h, 10);
            ctx.fill();
          }
        } else {
          this.roundRect(ctx, -w / 2, -h / 2, w, h, 10);
          ctx.fill();
        }
        // frame outline
        ctx.globalAlpha *= 0.6;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.stroke();
        break;
      }
      case 'text': {
        const size = layer.fontSize ?? 48;
        const weight = layer.fontWeight ?? '600';
        const style = layer.fontStyle === 'italic' ? 'italic ' : '';
        const family = layer.fontFamily ?? 'Inter';
        ctx.font = `${style}${weight} ${size}px "${family}", Inter, system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        // Letter spacing (supported in Chromium/Electron).
        ctx.letterSpacing = layer.letterSpacing ? `${layer.letterSpacing}px` : '0px';
        const text = layer.text ?? 'Text';
        if (layer.glyphs && layer.glyphs.length > 0) {
          const baseColor = typeof ctx.fillStyle === 'string' ? ctx.fillStyle : '#ffffff';
          this.drawGlyphs(ctx, layer, layer.glyphs, baseColor);
        } else {
          // Alignment: anchor within the layer box (centred at 0,0).
          const align = layer.align ?? 'left';
          const halfW = layer.width / 2;
          let anchorX = 0;
          if (align === 'left' || align === 'justify') { ctx.textAlign = 'left'; anchorX = -halfW; }
          else if (align === 'right') { ctx.textAlign = 'right'; anchorX = halfW; }
          else { ctx.textAlign = 'center'; anchorX = 0; }
          // Multi-line: split on newlines, offset each line by lineHeight.
          const lines = text.split('\n');
          const lh = (layer.lineHeight ?? 1.2) * size;
          const startY = -((lines.length - 1) * lh) / 2;
          lines.forEach((line, i) => {
            const ly = startY + i * lh;
            ctx.fillText(line, anchorX, ly);
            if (layer.stroke && layer.stroke.width > 0) {
              ctx.save();
              applyStrokeStyle(ctx, layer.stroke);
              ctx.strokeText(line, anchorX, ly);
              ctx.restore();
            }
          });
        }
        ctx.letterSpacing = '0px';
        break;
      }
    }
  }

  /**
   * Draw text glyph-by-glyph with per-glyph animator transforms (MG Phase D).
   * The run is laid out on the baseline and centred (matching the whole-string
   * path), then each glyph is translated/rotated/scaled/faded individually.
   * Gradient fills fall back to a solid per glyph (documented limitation).
   */
  private drawGlyphs(
    ctx: CanvasRenderingContext2D,
    layer: RenderLayer,
    glyphs: ReadonlyArray<GlyphTransform>,
    baseColor: string,
  ): void {
    ctx.textAlign = 'center';
    const widths = glyphs.map((g) => ctx.measureText(g.char).width);
    let total = 0;
    for (let i = 0; i < glyphs.length; i++) total += (widths[i] ?? 0) + glyphs[i]!.tracking;
    let pen = -total / 2;
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      const advance = (widths[i] ?? 0) + g.tracking;
      const cx = pen + advance / 2;
      pen += advance;
      if (g.char.trim() === '') continue; // spaces advance but paint nothing
      ctx.save();
      ctx.translate(cx + g.dx, g.dy);
      if (g.rotation) ctx.rotate((g.rotation * Math.PI) / 180);
      if (g.scale !== 1) ctx.scale(g.scale, g.scale);
      ctx.globalAlpha *= Math.max(0, Math.min(1, g.opacity));
      ctx.fillStyle = g.colorMix && g.color ? mixHex(baseColor, g.color, g.colorMix) : baseColor;
      ctx.fillText(g.char, 0, 0);
      if (layer.stroke && layer.stroke.width > 0) {
        applyStrokeStyle(ctx, layer.stroke);
        ctx.strokeText(g.char, 0, 0);
      }
      ctx.restore();
    }
  }

  /** The layer's outline sampled to a polyline (local space, centred at 0,0),
   *  for trim-path stroking. Rect → 4 corners; ellipse → 64-gon; path → its
   *  bezier anchors (approx; fine for trim). */
  private outlinePolyline(layer: RenderLayer): { pts: Pt[]; closed: boolean } {
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
  private strokeTrimmed(ctx: CanvasRenderingContext2D, layer: RenderLayer, stroke: Stroke): void {
    const { pts, closed } = this.outlinePolyline(layer);
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
  private shapePath(ctx: CanvasRenderingContext2D, layer: RenderLayer): void {
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
      this.roundRect(ctx, -w / 2, -h / 2, w, h, layer.cornerRadius ?? 0);
    }
  }

  /** Stroke a shape honouring width/colour/opacity/dash/cap/join + alignment.
   *  'center' straddles the edge; 'inside'/'outside' clip one half away. */
  private strokeShape(ctx: CanvasRenderingContext2D, stroke: Stroke, trace: () => void): void {
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
      applyStrokeStyle(ctx, { ...stroke, width: stroke.width * 2 });
    } else {
      applyStrokeStyle(ctx, stroke);
    }
    trace();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
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
