/** Optional peer — loaded dynamically when SAM ONNX is enabled. */
declare module 'onnxruntime-web' {
  export const InferenceSession: {
    create: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };
  export class Tensor {
    constructor(type: string, data: Float32Array | Uint8Array, dims: number[]);
  }
}
