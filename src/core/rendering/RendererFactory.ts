export type BackendKind = 'webgpu' | 'webgl2' | 'canvas2d';

export async function detectBestBackend(): Promise<BackendKind> {
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch {
      // WebGPU not fully supported or context failed
    }
  }
  if (typeof window !== 'undefined' && window.WebGL2RenderingContext) {
    return 'webgl2';
  }
  return 'canvas2d';
}
