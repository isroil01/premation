/**
 * Gallery preview rendering — turns a template/preset's REAL render snapshot
 * (buildSnapshot: same pipeline the editor uses, so transforms, per-glyph text
 * animators, 3D projection and motion are already resolved) into pixels on a
 * small 2D canvas.
 *
 * Why Canvas2D and not the GPU backend: gallery cards animate CONTINUOUSLY and
 * there can be dozens on screen. One WebGL/WebGPU context per card would blow the
 * browser's ~16-context limit; the NullBackend produces no pixels. A 2D draw of
 * the already-resolved snapshot is unlimited-scale, deterministic, and faithful
 * to layout/type/colour/gradient/motion (it omits GPU-only blur/glow effects,
 * which gallery thumbnails don't need). Everything renders into a THROWAWAY
 * SceneGraph so the user's live scene is never touched.
 */

import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import type { RenderLayer, RenderSnapshot } from '@core/rendering/RenderBackend';
import type { FillPaint } from '@core/paint/fill';
import type { TemplateDefinition } from './templateTypes';
import { mountPreview } from './previewController';
import { liveKf } from './templates/builders';
import { clamp01 } from '@utils/lang';

/** Longest edge of a still thumbnail, in CSS px (rendered at 2× for crispness). */
const THUMB_MAX = 176;

// ── Image cache (async decode; a load re-triggers the caller's next frame) ──
const imgCache = new Map<string, HTMLImageElement>();
function getImage(src: string): HTMLImageElement | null {
  if (!src) return null;
  const hit = imgCache.get(src);
  if (hit) return hit;
  if (typeof Image === 'undefined') return null;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  imgCache.set(src, img);
  return img;
}

/*
 * `clamp01` is imported from `@utils/lang` now.
 *
 * The local copy differed only in what it did with NaN — it PASSED it through,
 * where the shared one returns 0. That was never a deliberate difference, and
 * the shared behaviour is the safer of the two here: a NaN offset reaching
 * `addColorStop` throws, and a NaN alpha reaching `globalAlpha` is silently
 * ignored, so a bad number upstream became either a crash or an invisible
 * no-op. Clamping to 0 puts it in the picture instead.
 */

/** Build a Canvas2D paint for a resolved fill, in the layer's LOCAL centred box
 *  (w×h, origin at centre). */
function toCanvasFill(
  ctx: CanvasRenderingContext2D, paint: FillPaint | undefined, fallback: string, w: number, h: number,
): string | CanvasGradient {
  if (!paint) return fallback;
  if (paint.type === 'solid') return paint.color;
  if (paint.type === 'linear') {
    const a = ((paint.angle ?? 0) * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    const g = ctx.createLinearGradient((-dx * w) / 2, (-dy * h) / 2, (dx * w) / 2, (dy * h) / 2);
    for (const s of paint.stops) g.addColorStop(clamp01(s.offset), s.color);
    return g;
  }
  // radial
  const cx = (paint.cx - 0.5) * w;
  const cy = (paint.cy - 0.5) * h;
  const r = Math.max(1, paint.radius * 0.5 * Math.hypot(w, h));
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (const s of paint.stops) g.addColorStop(clamp01(s.offset), s.color);
  return g;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawTextLayer(ctx: CanvasRenderingContext2D, layer: RenderLayer, s: number): void {
  const size = Math.max(4, (layer.fontSize ?? 32) * s);
  const weight = layer.fontWeight ?? 600;
  const family = layer.fontFamily ?? 'Inter, system-ui, sans-serif';
  const style = layer.fontStyle === 'italic' ? 'italic ' : '';
  ctx.font = `${style}${weight} ${size}px ${family}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = layer.fill || '#ffffff';
  const tracking = (layer.letterSpacing ?? 0) * s;

  // Per-glyph path — the layer carries resolved text-animator transforms.
  if (layer.glyphs && layer.glyphs.length) {
    const glyphs = layer.glyphs;
    const widths = glyphs.map((g) => ctx.measureText(g.char).width);
    let total = 0;
    for (let i = 0; i < glyphs.length; i++) total += widths[i]! + tracking + glyphs[i]!.tracking * s;
    let pen = layer.align === 'left' ? 0 : layer.align === 'right' ? -total : -total / 2;
    ctx.textAlign = 'left';
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      const adv = widths[i]! + tracking + g.tracking * s;
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * clamp01(g.opacity);
      ctx.translate(pen + adv / 2 + g.dx * s, g.dy * s);
      if (g.rotation) ctx.rotate((g.rotation * Math.PI) / 180);
      if (g.skew) ctx.transform(1, 0, Math.tan((g.skew * Math.PI) / 180), 1, 0, 0);
      if (g.scale !== 1) ctx.scale(g.scale, g.scale);
      if (g.color && g.colorMix) ctx.fillStyle = g.color;
      ctx.fillText(g.char, -widths[i]! / 2, 0);
      ctx.restore();
      pen += adv;
    }
    return;
  }

  // Plain runs — support multi-line + alignment + letter spacing.
  const lines = String(layer.text ?? '').split('\n');
  const lineH = (layer.lineHeight ?? 1.2) * size;
  const y0 = -((lines.length - 1) * lineH) / 2;
  ctx.textAlign = 'left';
  lines.forEach((line, li) => {
    const chars = [...line];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b + tracking, 0);
    let pen = layer.align === 'left' ? 0 : layer.align === 'right' ? -total : -total / 2;
    const y = y0 + li * lineH;
    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i]!, pen, y);
      pen += widths[i]! + tracking;
    }
  });
}

/** Render one resolved snapshot into a 2D canvas (already sized in device px). */
export function drawSnapshot(canvas: HTMLCanvasElement, snapshot: RenderSnapshot, background = '#0e0e12'): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);
  const bg = snapshot.transparent ? null : (snapshot.background || background);
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);
  }
  const s = cw / snapshot.width;

  for (const layer of snapshot.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    ctx.save();
    ctx.globalAlpha = clamp01(layer.opacity);
    ctx.translate(layer.x * s, layer.y * s);
    if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180);
    if (layer.scaleX !== 1 || layer.scaleY !== 1) ctx.scale(layer.scaleX || 1, layer.scaleY || 1);
    if (layer.anchorX || layer.anchorY) ctx.translate(-(layer.anchorX ?? 0) * s, -(layer.anchorY ?? 0) * s);

    if (layer.kind === 'text') {
      drawTextLayer(ctx, layer, s);
    } else if (layer.kind === 'image') {
      const w = (layer.width || 200) * s, h = (layer.height || 200) * s;
      const img = layer.src ? getImage(layer.src) : null;
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        roundRectPath(ctx, -w / 2, -h / 2, w, h, 8 * s);
        ctx.fill();
      }
    } else {
      // shape
      const w = (layer.width || 100) * s, h = (layer.height || 100) * s;
      ctx.fillStyle = toCanvasFill(ctx, layer.fillPaint, layer.fill || '#3b82f6', w, h);
      if (layer.primitive === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(0, 0, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, 2 * Math.PI);
        ctx.fill();
      } else if (layer.cornerRadius && layer.cornerRadius > 0) {
        roundRectPath(ctx, -w / 2, -h / 2, w, h, layer.cornerRadius * s);
        ctx.fill();
      } else {
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
    }
    ctx.restore();
  }
}

/**
 * Render a graph-building function to a PNG dataURL (null when canvas is
 * unavailable, e.g. tests). `anim`/`time` optionally sample a motion frame.
 */
export function renderThumbnail(
  layout: (g: SceneGraph) => void,
  W: number,
  H: number,
  opts?: { rootId?: string; anim?: AnimationEngine; time?: number; background?: string },
): string | null {
  try {
    const scale = THUMB_MAX / Math.max(W, H);
    const tw = Math.max(1, Math.round(W * scale));
    const th = Math.max(1, Math.round(H * scale));

    const graph = new SceneGraph();
    layout(graph);

    const snapshot = buildSnapshot(
      graph, opts?.anim ?? new AnimationEngine(), opts?.time ?? 0, undefined, undefined,
      { scale: tw / W, offsetX: 0, offsetY: 0 }, undefined,
      { rootId: opts?.rootId ?? 'tpl_root', width: W, height: H, background: opts?.background ?? 'rgba(20,20,25,1)' },
    );

    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    drawSnapshot(canvas, snapshot, opts?.background || '#0e0e12');
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

const templateCache = new Map<string, string>();

/** A full-scene template's thumbnail (poster frame), cached per id. */
export function templateThumbnail(t: TemplateDefinition): string | null {
  const hit = templateCache.get(t.id);
  if (hit) return hit;
  // Sample a representative motion pose so the still isn't a dead resting frame.
  const anim = new AnimationEngine();
  if (t.animate) t.animate((id, prop, time, value, ease) => anim.setKeyframe(id, prop, time, value, ease ?? 'easeInOut'));
  const url = renderThumbnail((g) => t.layout(g), t.width, t.height, {
    anim, time: t.previewTime ?? 0,
  });
  if (url) templateCache.set(t.id, url);
  return url;
}

/**
 * Play a template's animation live into `canvas`, looping continuously. Builds
 * an isolated throwaway graph + preview engine (never touches the live scene)
 * and replays the template's own `animate` choreography.
 */
export function createTemplatePlayer(canvas: HTMLCanvasElement, template: TemplateDefinition): { stop: () => void } {
  return mountPreview(canvas, {
    build: (g) => template.layout(g),
    animate: template.animate,
    width: template.width,
    height: template.height,
    background: '#0e0e12',
  });
}

/** Re-export so callers that force the live keyframe setter keep one import. */
export { liveKf };
