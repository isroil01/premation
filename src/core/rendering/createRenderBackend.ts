/**
 * Render-backend factory (Phase 5: unified GPU engine).
 *
 * The product now has exactly ONE rendering engine: the GPU-backed
 * MotionRendererBackend. Canvas2D was the reference oracle during the
 * engine-unification project (Phases 0–4); it now lives only as the
 * Canvas2DVectorRasterizer component that produces textures for the GPU
 * compositor — it is not a backend.
 *
 * Selection order within the GPU engine:
 *   WebGPU (when available) → WebGL2 → Null (headless / test)
 *
 * If GPU context creation fails, the engine emits an 'EngineError' event
 * which renderBackendStore.ts catches and steps down gracefully (WebGPU → WebGL2
 * → software badge).  That is error handling, not a second engine.
 */

import type { RenderBackend } from './RenderBackend';
import { MotionRendererBackend, type RendererBackendKind } from './MotionRendererBackend';

export type BackendChoice = 'webgl2' | 'webgpu' | 'null' | 'auto';

/** Resolve the best GPU backend available in this environment. */
export function resolveGpuKind(): RendererBackendKind {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) return 'webgpu';
  if (typeof window !== 'undefined' && 'WebGL2RenderingContext' in window) return 'webgl2';
  return 'null';
}

/**
 * Create the single GPU render backend.
 *
 * Pass `'null'` for headless/test environments where no GPU is available.
 * Omit the argument (or pass `'auto'`) to let the factory pick the best
 * available GPU tier.
 */
export function createRenderBackend(choice: BackendChoice = 'auto'): RenderBackend {
  const kind: RendererBackendKind =
    choice === 'auto' ? resolveGpuKind() :
    choice === 'null'  ? 'null' :
    choice;
  return new MotionRendererBackend(kind);
}
