/**
 * The pictures the footage tools attach over MCP (mcpHost.ts): a subject's
 * matte preview — the layer cropped from the real frame with the outline(s)
 * drawn and labelled — and an asset's contact sheet, decoded by the engine
 * without placing it. Drawing only; the geometry comes from mediaTools.ts
 * (`SubjectView`, `AssetDescription`).
 */

import { engineCompStill, engineFootageStill } from '@core/engine/engineStill';
import { useCompositionStore } from '@stores/compositionStore';
import type { AiImage } from '@motion/ai-tools';
import type { SubjectView } from './mediaTools';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const h = setTimeout(() => resolve(null), ms);
    p.then((v) => { clearTimeout(h); resolve(v); }, () => { clearTimeout(h); resolve(null); });
  });
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; c2d: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const c2d = canvas.getContext('2d');
  return c2d ? { canvas, c2d } : null;
}

function toImage(canvas: HTMLCanvasElement): AiImage | null {
  const url = canvas.toDataURL('image/png');
  const i = url.indexOf(',');
  return i > 0 ? { mediaType: 'image/png', dataBase64: url.slice(i + 1) } : null;
}

const OUTLINE_COLOURS = ['#ff3fd4', '#ffb547', '#34d1bf', '#7fb2ff', '#a6e22e', '#ff6b6b', '#c792ea', '#f2f2f2'];

/** The layer cropped from the frame at `view.time`, each outline (layer-local x y pairs) drawn and labelled. */
export async function renderSubjectView(view: SubjectView): Promise<AiImage | null> {
  try {
    const c = useCompositionStore.getState().comp();
    const fps = c.fps || 30;
    const frame = Math.max(0, Math.min(Math.round(view.time * fps), Math.round(c.durationSeconds * fps) - 1));
    const blob = await withTimeout(engineCompStill(c.id, frame / fps, 2048), 8000);
    if (!blob) return null;
    const bitmap = await withTimeout(createImageBitmap(blob), 4000);
    if (!bitmap) return null;
    const px = bitmap.width / Math.max(1, c.width);
    const { crop } = view;
    const S = 1100 / Math.max(crop.width, crop.height);
    const made = makeCanvas(crop.width * S, crop.height * S);
    if (!made) return null;
    const { canvas, c2d } = made;
    c2d.fillStyle = '#1a1a1e';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    c2d.drawImage(bitmap, crop.x * px, crop.y * px, crop.width * px, crop.height * px, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const { o, ex, ey } = view.affine;
    const toCanvas = (lx: number, ly: number): { x: number; y: number } => ({
      x: (o.x + lx * ex.x + ly * ey.x - crop.x) * S,
      y: (o.y + lx * ex.y + ly * ey.y - crop.y) * S,
    });
    c2d.lineWidth = 3;
    c2d.font = 'bold 14px system-ui, sans-serif';
    view.outlines.forEach((outline, idx) => {
      const pts = outline.points;
      if (pts.length < 4) return;
      const colour = OUTLINE_COLOURS[idx % OUTLINE_COLOURS.length]!;
      c2d.strokeStyle = colour;
      c2d.fillStyle = `${colour}33`;
      c2d.beginPath();
      let top = { x: Infinity, y: Infinity };
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const p = toCanvas(pts[i]!, pts[i + 1]!);
        if (i === 0) c2d.moveTo(p.x, p.y); else c2d.lineTo(p.x, p.y);
        if (p.y < top.y) top = p;
      }
      c2d.closePath();
      c2d.fill();
      c2d.stroke();
      c2d.fillStyle = colour;
      c2d.fillText(outline.label, Math.max(2, Math.min(canvas.width - 60, top.x + 4)), Math.max(14, top.y - 6));
    });
    return toImage(canvas);
  } catch {
    return null;
  }
}

/**
 * `cells` frames of a footage ITEM spread over its length (one for a still),
 * decoded by the engine, as one labelled contact sheet.
 */
export async function renderAssetSheet(itemId: string, durationSec: number, cells: number): Promise<AiImage | null> {
  try {
    const n = durationSec > 0.05 ? Math.max(1, Math.min(12, Math.round(cells))) : 1;
    const times = Array.from({ length: n }, (_, i) => (n === 1 ? 0 : (durationSec * (i + 0.5)) / n));
    const stills: Array<{ t: number; bitmap: ImageBitmap | null }> = [];
    for (const t of times) {
      const blob = await withTimeout(engineFootageStill(itemId, t, n === 1 ? 1024 : 640), 8000);
      const bitmap = blob ? await withTimeout(createImageBitmap(blob), 4000) : null;
      stills.push({ t, bitmap });
    }
    const first = stills.find((s) => s.bitmap)?.bitmap;
    if (!first) return null;
    const cols = Math.min(n, n <= 4 ? n : 3);
    const rows = Math.ceil(n / cols);
    const cellW = n === 1 ? first.width : Math.min(480, first.width);
    const cellH = Math.round(cellW * (first.height / Math.max(1, first.width)));
    const pad = 6, labelH = n === 1 ? 0 : 18;
    const made = makeCanvas(cols * (cellW + pad) + pad, rows * (cellH + labelH + pad) + pad);
    if (!made) return null;
    const { canvas, c2d } = made;
    c2d.fillStyle = '#1a1a1e';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    c2d.font = '12px system-ui, sans-serif';
    stills.forEach((s, i) => {
      const x = pad + (i % cols) * (cellW + pad);
      const y = pad + Math.floor(i / cols) * (cellH + labelH + pad);
      if (s.bitmap) {
        c2d.drawImage(s.bitmap, 0, 0, s.bitmap.width, s.bitmap.height, x, y, cellW, cellH);
        s.bitmap.close?.();
      } else {
        c2d.fillStyle = '#333';
        c2d.fillRect(x, y, cellW, cellH);
      }
      if (labelH) {
        c2d.fillStyle = '#e6e6e6';
        c2d.fillText(`${s.t.toFixed(2)}s`, x + 2, y + cellH + 13);
      }
    });
    return toImage(canvas);
  } catch {
    return null;
  }
}

/** Crop `region` (comp px) out of a comp still and scale it so its long side is `maxSize`. */
export async function cropStill(blob: Blob, compWidth: number, region: { x: number; y: number; w: number; h: number }, maxSize: number): Promise<Blob | null> {
  try {
    const bitmap = await withTimeout(createImageBitmap(blob), 4000);
    if (!bitmap) return null;
    const px = bitmap.width / Math.max(1, compWidth);
    const sx = Math.max(0, region.x * px), sy = Math.max(0, region.y * px);
    const sw = Math.min(bitmap.width - sx, region.w * px), sh = Math.min(bitmap.height - sy, region.h * px);
    if (!(sw > 0) || !(sh > 0)) return null;
    const scale = maxSize / Math.max(sw, sh);
    const made = makeCanvas(sw * scale, sh * scale);
    if (!made) return null;
    made.c2d.drawImage(bitmap, sx, sy, sw, sh, 0, 0, made.canvas.width, made.canvas.height);
    bitmap.close?.();
    return await new Promise<Blob | null>((resolve) => made.canvas.toBlob((b) => resolve(b), 'image/png'));
  } catch {
    return null;
  }
}
