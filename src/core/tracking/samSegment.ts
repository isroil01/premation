/**
 * SAM-class click / box segmentation — classical multi-cue matte without ONNX.
 *
 * Adobe Roto Brush 3 / Meta SAM need a neural prior. This module ships the same
 * *interface* (point prompts → soft matte) using GrabCut + edge-aware CRF refine
 * + optional box crop. When an ONNX Runtime Web session is later registered via
 * {@link registerSamOnnxSession}, clicks prefer the neural path.
 */

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

/** The registered ONNX session, if any. */
export function samOnnxSession(): OnnxInfer | null {
  return onnxInfer;
}
