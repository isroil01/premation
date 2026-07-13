/**
 * Render-backend factory + the runtime switch between the reference Canvas2D
 * backend and the GPU @motion/renderer. Defaults to Canvas2D so nothing changes
 * unless the user opts in — the GPU path is additive.
 *
 * Selection order: an explicit argument › the `rendering.backend` setting ›
 * Canvas2D. Set it at runtime with `setRenderBackendChoice('webgl2')` (persists
 * via SettingsManager) and re-mount the viewport, or read it in tests.
 */

import type { RenderBackend } from './RenderBackend';
import { Canvas2DBackend } from './Canvas2DBackend';
import { MotionRendererBackend } from './MotionRendererBackend';
import { getSettingsManager } from '@core/services/coreServices';

export type BackendChoice = 'canvas2d' | 'webgl2' | 'webgpu' | 'null' | 'auto';

export const RENDER_BACKEND_SETTING = 'rendering.backend';

const CHOICES: ReadonlySet<string> = new Set(['canvas2d', 'webgl2', 'webgpu', 'null', 'auto']);

/** The configured backend choice (defaults to canvas2d; tolerant of no settings). */
export function resolveBackendChoice(): BackendChoice {
  try {
    const v = getSettingsManager().get<string>(RENDER_BACKEND_SETTING, 'auto');
    if (v === 'auto') {
      if (typeof navigator !== 'undefined' && 'gpu' in navigator) return 'webgpu';
      if (typeof window !== 'undefined' && 'WebGL2RenderingContext' in window) return 'webgl2';
      return 'canvas2d';
    }
    if (CHOICES.has(v)) return v as BackendChoice;
  } catch {
    /* settings not booted (e.g. tests) — fall through to the default */
  }
  return 'canvas2d';
}

/** Persist the backend choice; takes effect the next time a viewport mounts. */
export function setRenderBackendChoice(choice: BackendChoice): void {
  getSettingsManager().set(RENDER_BACKEND_SETTING, choice);
}

export function createRenderBackend(choice: BackendChoice = resolveBackendChoice()): RenderBackend {
  switch (choice) {
    case 'webgl2':
      return new MotionRendererBackend('webgl2');
    case 'webgpu':
      return new MotionRendererBackend('webgpu');
    case 'null':
      return new MotionRendererBackend('null');
    case 'canvas2d':
    default:
      return new Canvas2DBackend();
  }
}
