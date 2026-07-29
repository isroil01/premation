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
 * If GPU context creation fails, MotionRendererBackend itself steps down:
 * it disposes the failed backend and re-initializes on the next tier
 * (WebGPU → WebGL2 → delayed WebGL2 retry), emitting 'EngineError' /
 * 'EngineReady' events that renderBackendStore.ts mirrors into the tier badge.
 * If every tier fails, the backend resolves readyPromise with initFailed set
 * and the workspace shows a visible error instead of a blank stage.
 */

import type { RenderBackend } from './RenderBackend';
import { MotionRendererBackend, type RendererBackendKind } from './MotionRendererBackend';

export type BackendChoice = 'webgl2' | 'webgpu' | 'null' | 'auto';

/** Resolve the best GPU backend available in this environment. */
function resolveGpuKind(): RendererBackendKind {
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
export function createRenderBackend(
  choice: BackendChoice = 'auto',
  role: 'viewport' | 'auxiliary' = 'viewport',
): RenderBackend {
  const kind: RendererBackendKind =
    choice === 'auto' ? resolveGpuKind() :
    choice === 'null'  ? 'null' :
    choice;
  return new MotionRendererBackend(kind, role);
}
