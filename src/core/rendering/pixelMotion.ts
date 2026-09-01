/**
 * Pixel Motion — canvas plumbing over `pixelMotionFlow.ts`.
 *
 * The backend hands this the two decoded bracket canvases (from the exact
 * WebCodecs path) and the sub-frame weight; it returns the motion-compensated
 * in-between as a canvas ready for `setFrame`.
 *
 * ── Cost model, and where the caching goes ──────────────────────────────────
 *
 * Flow ESTIMATION is the expensive half (a search per grid block), but it is a
 * function of the FRAME PAIR alone — every comp frame inside the same source
 * bracket reuses it. So flow is cached per (pairKey), a tiny LRU: slowed
 * footage sits inside one bracket for many comp frames, and playback touches
 * at most a couple of pairs at once.
 *
 * The WARP is a function of (pair, weight) and runs per rendered frame — one
 * bilinear pass over the output. At 1080p that is real CPU work (tens of ms);
 * Pixel Motion is an opt-in per-layer mode, exactly as heavy as it looks in
 * AE, and the render loop's caches (RAM + disk frame cache, export staging)
 * absorb repeats.
 *
 * Estimation runs at a DOWNSCALED size (max dim ~384): adjacent-frame motion
 * is small and smooth, so a coarse grid catches it, and the 25× area saving is
 * what makes the whole thing interactive. The warp runs at full resolution.
 *
 * Estimation itself prefers the GPU (`pixelMotionFlowGpu.ts`): an integer
 * WebGL2 twin of the CPU search that proves itself BIT-EQUAL at init, so the
 * choice of backend — decided once per session, or even flapping on a context
 * loss — can never make preview and export disagree. No WebGL2, or a failed
 * self-check, and every pair runs the CPU search below, exactly as before.
 */

import { computeFlow, lumaIntOf, warpBlend, type FlowField } from './pixelMotionFlow';
import { getGpuFlowEstimator } from './pixelMotionFlowGpu';

/** Max dimension of the flow-estimation raster. */
const FLOW_MAX_DIM = 384;

/** Flow pairs kept. Two is enough for a moving playhead (current + next
 *  bracket); four covers a scrub dithering across a boundary. */
const FLOW_CACHE_MAX = 4;

interface FlowEntry {
  flow: FlowField;
  fw: number;
  fh: number;
}

const flowCache = new Map<string, FlowEntry>();

/** Reused surfaces — the setVideo/setParticles pattern: allocate once, rewrite. */
let scaleCanvas: HTMLCanvasElement | null = null;
let readCanvasA: HTMLCanvasElement | null = null;
let readCanvasB: HTMLCanvasElement | null = null;

function canvas2d(c: HTMLCanvasElement | null, w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = c ?? document.createElement('canvas');
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx ? { canvas, ctx } : null;
}

function imageDataOf(
  slot: 'a' | 'b',
  src: HTMLCanvasElement,
  w: number,
  h: number,
): ImageData | null {
  const surf = canvas2d(slot === 'a' ? readCanvasA : readCanvasB, w, h);
  if (!surf) return null;
  if (slot === 'a') readCanvasA = surf.canvas;
  else readCanvasB = surf.canvas;
  surf.ctx.clearRect(0, 0, w, h);
  surf.ctx.drawImage(src, 0, 0, w, h);
  try {
    return surf.ctx.getImageData(0, 0, w, h);
  } catch {
    return null;
  }
}

function flowFor(pairKey: string, a: HTMLCanvasElement, b: HTMLCanvasElement): FlowEntry | null {
  const hit = flowCache.get(pairKey);
  if (hit) {
    // Refresh recency (Map iterates in insertion order — delete/set is the LRU).
    flowCache.delete(pairKey);
    flowCache.set(pairKey, hit);
    return hit;
  }
  const w = a.width;
  const h = a.height;
  if (w < 8 || h < 8) return null;
  const scale = Math.min(1, FLOW_MAX_DIM / Math.max(w, h));
  const fw = Math.max(8, Math.round(w * scale));
  const fh = Math.max(8, Math.round(h * scale));
  // GPU search first — bit-equal to the CPU one below (enforced by its init
  // self-check), so a null here (no WebGL2, lost context, failed check) can
  // fall through mid-session without preview and export ever diverging.
  let flow = getGpuFlowEstimator()?.compute(a, b, fw, fh) ?? null;
  if (!flow) {
    const surf = canvas2d(scaleCanvas, fw, fh);
    if (!surf) return null;
    scaleCanvas = surf.canvas;
    let lumA: Int32Array;
    let lumB: Int32Array;
    try {
      surf.ctx.clearRect(0, 0, fw, fh);
      surf.ctx.drawImage(a, 0, 0, fw, fh);
      lumA = lumaIntOf(surf.ctx.getImageData(0, 0, fw, fh).data, fw, fh);
      surf.ctx.clearRect(0, 0, fw, fh);
      surf.ctx.drawImage(b, 0, 0, fw, fh);
      lumB = lumaIntOf(surf.ctx.getImageData(0, 0, fw, fh).data, fw, fh);
    } catch {
      return null;
    }
    flow = computeFlow(lumA, lumB, fw, fh);
  }
  const entry: FlowEntry = { flow, fw, fh };
  flowCache.set(pairKey, entry);
  while (flowCache.size > FLOW_CACHE_MAX) {
    const oldest = flowCache.keys().next();
    if (oldest.done) break;
    flowCache.delete(oldest.value);
  }
  return entry;
}

/**
 * The motion-compensated in-between of two decoded frames, at `weight` 0..1.
 *
 * `pairKey` must identify the FRAME PAIR (the backend uses the decoder's
 * presentation indices), because it keys the flow cache. Writes into `out`
 * (resized as needed) and returns it, or null when any canvas step fails —
 * the caller then falls back to Frame Mix, which is the correct degradation.
 */
export function renderPixelMotion(
  pairKey: string,
  a: HTMLCanvasElement,
  b: HTMLCanvasElement,
  weight: number,
  out: HTMLCanvasElement,
): HTMLCanvasElement | null {
  const w = a.width;
  const h = a.height;
  if (w < 1 || h < 1 || b.width !== w || b.height !== h) return null;
  const entry = flowFor(pairKey, a, b);
  if (!entry) return null;
  const da = imageDataOf('a', a, w, h);
  const db = imageDataOf('b', b, w, h);
  if (!da || !db) return null;
  const surf = canvas2d(out, w, h);
  if (!surf) return null;
  const result = surf.ctx.createImageData(w, h);
  warpBlend(
    da.data, db.data, w, h,
    entry.flow, w / entry.fw, h / entry.fh,
    Math.max(0, Math.min(1, weight)),
    result.data,
  );
  surf.ctx.putImageData(result, 0, 0);
  return surf.canvas;
}

/** Test seam: drop cached flow (the cache is module-global on purpose — one
 *  render loop, one playhead). */
export function clearPixelMotionCache(): void {
  flowCache.clear();
}
