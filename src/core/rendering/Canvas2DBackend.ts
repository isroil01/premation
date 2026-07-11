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

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
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

    for (const layer of snapshot.layers) {
      if (!layer.visible) continue;
      ctx.save();
      ctx.globalAlpha = clamp01(layer.opacity);
      // Compositing mode against the layers already drawn.
      if (layer.blend && layer.blend !== 'normal') {
        ctx.globalCompositeOperation = blendToComposite(layer.blend);
      }
      // Per-layer visual effects (blur / glow / color) via the 2D filter.
      if (layer.filter) ctx.filter = layer.filter;
      ctx.translate(layer.x, layer.y);
      ctx.rotate((layer.rotation * Math.PI) / 180);
      ctx.scale(layer.scaleX || 1, layer.scaleY || 1);
      this.drawLayer(ctx, layer);
      ctx.restore();
    }

    ctx.restore(); // comp clip
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 1px composition frame (device space — crisp at any zoom).
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(offX + 0.5, offY + 0.5, devW - 1, devH - 1);

    // Guide overlays (grid, safe areas, rulers) in device space.
    if (snapshot.overlays) this.drawOverlays(ctx, snapshot, offX, offY, devW, devH);
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
