/**
 * SAM-class click / box segmentation — classical multi-cue matte without ONNX.
 *
 * Adobe Roto Brush 3 / Meta SAM need a neural prior. This module ships the same
 * *interface* (point prompts → soft matte) using GrabCut + edge-aware CRF refine
 * + optional box crop. When an ONNX Runtime Web session is later registered via
 * {@link registerSamOnnxSession}, clicks prefer the neural path.
 */

import { grabCutMatte } from './grabCut';
import { refineRotoMatte, softFeatherMask, type RotoSeed } from './rotoMatte';

export interface SamPointPrompt {
  x: number;
  y: number;
  /** 1 = foreground, 0 = background. */
  label?: 0 | 1;
  tolerance?: number;
}

export interface SamBoxPrompt {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SamSegmentRequest {
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  points?: readonly SamPointPrompt[];
  box?: SamBoxPrompt;
  featherPx?: number;
}

export interface SamSegmentResult {
  mask: Uint8Array;
  /** Soft alpha 0..255 (same length as mask). */
  soft: Uint8Array;
  engine: 'classical' | 'onnx';
}

type OnnxInfer = (req: SamSegmentRequest) => Promise<Uint8Array | null>;

let onnxInfer: OnnxInfer | null = null;

/** Optional hook for a host-supplied ONNX/WebGPU SAM session. */
export function registerSamOnnxSession(infer: OnnxInfer | null): void {
  onnxInfer = infer;
}

/**
 * Bilateral-ish edge-aware refine: pull soft matte toward colour edges so the
 * boundary locks to chroma discontinuities (CRF foothold).
 */
function edgeAwareRefine(
  rgba: Uint8ClampedArray | Uint8Array,
  soft: Uint8Array,
  w: number,
  h: number,
  radius = 2,
): Uint8Array {
  const out = new Uint8Array(soft.length);
  const r = Math.max(1, radius);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const cr = rgba[i * 4]!;
      const cg = rgba[i * 4 + 1]!;
      const cb = rgba[i * 4 + 2]!;
      let num = 0;
      let den = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          const dr = cr - rgba[j * 4]!;
          const dg = cg - rgba[j * 4 + 1]!;
          const db = cb - rgba[j * 4 + 2]!;
          const colorW = Math.exp(-(dr * dr + dg * dg + db * db) / (2 * 40 * 40));
          const spaceW = Math.exp(-(dx * dx + dy * dy) / (2 * r * r));
          const ww = colorW * spaceW;
          num += soft[j]! * ww;
          den += ww;
        }
      }
      out[i] = den > 0 ? Math.round(num / den) : soft[i]!;
    }
  }
  return out;
}

function classicalSegment(req: SamSegmentRequest): SamSegmentResult {
  const { rgba, width: w, height: h } = req;
  const feather = req.featherPx ?? 2;
  const fgSeeds: RotoSeed[] = [];
  const bgSeeds: RotoSeed[] = [];
  for (const p of req.points ?? []) {
    const seed = { x: p.x, y: p.y, tolerance: p.tolerance ?? 36 };
    if ((p.label ?? 1) === 1) fgSeeds.push(seed);
    else bgSeeds.push(seed);
  }
  if (fgSeeds.length === 0 && req.box) {
    fgSeeds.push({
      x: (req.box.x0 + req.box.x1) / 2,
      y: (req.box.y0 + req.box.y1) / 2,
      tolerance: 48,
    });
  }
  if (fgSeeds.length === 0) {
    fgSeeds.push({ x: w / 2, y: h / 2, tolerance: 40 });
  }

  let mask = grabCutMatte(rgba, w, h, fgSeeds, {
    unknownRadius: 10,
    iterations: 6,
    featherPx: 0,
  });

  // Box constraint: kill outside the prompt box.
  if (req.box) {
    const x0 = Math.min(req.box.x0, req.box.x1) | 0;
    const x1 = Math.max(req.box.x0, req.box.x1) | 0;
    const y0 = Math.min(req.box.y0, req.box.y1) | 0;
    const y1 = Math.max(req.box.y0, req.box.y1) | 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < x0 || x > x1 || y < y0 || y > y1) mask[y * w + x] = 0;
      }
    }
  }

  // Background clicks carve holes.
  if (bgSeeds.length > 0) {
    const bg = grabCutMatte(rgba, w, h, bgSeeds, { unknownRadius: 6, iterations: 3 });
    for (let i = 0; i < mask.length; i++) {
      if (bg[i]) mask[i] = 0;
    }
  }

  const refined = refineRotoMatte(rgba, mask, w, h, { morphRadius: 1, featherPx: feather });
  let soft = softFeatherMask(refined.mask, w, h, feather);
  soft = edgeAwareRefine(rgba, soft, w, h, 2);
  const binary = new Uint8Array(soft.length);
  for (let i = 0; i < soft.length; i++) binary[i] = soft[i]! >= 128 ? 255 : 0;
  return { mask: binary, soft, engine: 'classical' };
}

/**
 * Segment from click/box prompts. Tries ONNX when registered; always falls back
 * to classical GrabCut + edge CRF.
 */
export async function segmentSam(req: SamSegmentRequest): Promise<SamSegmentResult> {
  if (onnxInfer) {
    try {
      const neural = await onnxInfer(req);
      if (neural && neural.length === req.width * req.height) {
        const soft = softFeatherMask(neural, req.width, req.height, req.featherPx ?? 2);
        return { mask: neural, soft, engine: 'onnx' };
      }
    } catch {
      /* classical fallback */
    }
  }
  return classicalSegment(req);
}

/** Sync classical path for callers that cannot await. */
export function segmentSamSync(req: SamSegmentRequest): SamSegmentResult {
  return classicalSegment(req);
}
