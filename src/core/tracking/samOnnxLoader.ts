/**
 * Optional ONNX Runtime Web loader for SAM-class segmentation.
 *
 * Does NOT bundle a model or onnxruntime-web — both are large and optional.
 * Call {@link tryRegisterSamOnnxFromUrl} with a hosted .onnx URL when the host
 * has installed `onnxruntime-web` (dynamic import). On success, clicks go
 * through {@link registerSamOnnxSession}; classical GrabCut remains the fallback.
 */

import { registerSamOnnxSession, type SamSegmentRequest } from './samSegment';

export type SamOnnxLoadResult =
  | { status: 'ok' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string };

type OrtSession = {
  run: (
    feeds: Record<string, unknown>,
    outputs?: string[],
  ) => Promise<Record<string, { data: Float32Array | number[]; dims: number[] }>>;
  inputNames: string[];
  outputNames: string[];
};

type OrtNamespace = {
  InferenceSession: {
    create: (url: string, opts?: Record<string, unknown>) => Promise<OrtSession>;
  };
  Tensor: new (type: string, data: Float32Array | Uint8Array, dims: number[]) => unknown;
};

async function importOrt(): Promise<OrtNamespace | null> {
  try {
    // Optional peer — may be absent in the default install.
    const mod = await import(/* @vite-ignore */ 'onnxruntime-web');
    return mod as unknown as OrtNamespace;
  } catch {
    return null;
  }
}

/**
 * Build a trivial point→mask inferrer around an ORT session.
 * Real SAM needs image embeddings + prompt encoder; this foothold expects a
 * single-input model that takes NCHW float RGB + optional point coords, or
 * falls back if tensor layout is unknown.
 */
function wrapSession(ort: OrtNamespace, session: OrtSession): (req: SamSegmentRequest) => Promise<Uint8Array | null> {
  return async (req) => {
    try {
      const { width: w, height: h, rgba } = req;
      const n = w * h;
      const rgb = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        rgb[i] = rgba[i * 4]! / 255;
        rgb[n + i] = rgba[i * 4 + 1]! / 255;
        rgb[2 * n + i] = rgba[i * 4 + 2]! / 255;
      }
      const inputName = session.inputNames[0];
      if (!inputName) return null;
      const tensor = new ort.Tensor('float32', rgb, [1, 3, h, w]);
      const out = await session.run({ [inputName]: tensor });
      const first = out[session.outputNames[0]!];
      if (!first) return null;
      const data = first.data;
      const mask = new Uint8Array(n);
      const len = Math.min(n, data.length);
      for (let i = 0; i < len; i++) {
        const v = typeof data[i] === 'number' ? (data[i] as number) : 0;
        mask[i] = v > 0.5 ? 255 : 0;
      }
      return mask;
    } catch {
      return null;
    }
  };
}

/**
 * Dynamically load onnxruntime-web + model URL and register the SAM session.
 * Safe to call when ORT is missing — returns `unavailable`.
 */
export async function tryRegisterSamOnnxFromUrl(modelUrl: string): Promise<SamOnnxLoadResult> {
  if (!modelUrl) return { status: 'unavailable', reason: 'No model URL.' };
  const ort = await importOrt();
  if (!ort) {
    return {
      status: 'unavailable',
      reason: 'onnxruntime-web is not installed. npm i onnxruntime-web, then retry.',
    };
  }
  try {
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['webgpu', 'wasm'],
    });
    registerSamOnnxSession(wrapSession(ort, session));
    return { status: 'ok' };
  } catch (e) {
    registerSamOnnxSession(null);
    return {
      status: 'failed',
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Clear any registered ONNX inferrer. */
export function unregisterSamOnnx(): void {
  registerSamOnnxSession(null);
}
