/**
 * A render pass: a self-contained unit of GPU work with declared resource
 * dependencies. The Render Graph orders passes from these declarations, so
 * adding a pass never requires editing the others (Open/Closed).
 *
 *   - `reads`: named resources this pass samples (creates a dependency on the
 *                pass that writes them).
 *   - `writes`: named resources this pass renders into.
 *   - `after`: explicit ordering by pass name (for non-resource ordering).
 *
 * The reserved resource name `"surface"` is the swapchain/backbuffer.
 */

import type { RenderBackend } from '../gpu/RenderBackend';
import type { ResourceManager } from '../gpu/ResourceManager';
import type { RenderTargetHandle, TextureFormat } from '../gpu/types';
import type { FrameInfo } from '../core/Frame';
import type { FrameScene } from '../scene/FrameScene';
import type { Viewport } from '../viewport/Viewport';
import type { RenderDiagnostics } from '../core/renderer/RenderDiagnostics';
import type { CommandBuffer } from '../commands/DrawCommand';
import type { QuadRenderer } from '../pipeline/QuadRenderer';
import type { MaterialSystem } from '../shaders/Material';
import type { TextureProvider } from '../resources/TextureProvider';

export const SURFACE = 'surface';

/** Shared services injected into every pass (Dependency Injection). */
export interface RenderServices {
  backend: RenderBackend;
  resources: ResourceManager;
  materials: MaterialSystem;
  quad: QuadRenderer;
  textures: TextureProvider;
  colorFormat: TextureFormat;
  /** A reusable command buffer, cleared between passes. */
  commands: CommandBuffer;
  /** Per-frame sink for compositing operations the renderer could not honour.
   *  Passes STATE what happened; the host decides (warn in preview, fail on
   *  export). See core/renderer/RenderDiagnostics.ts. */
  diagnostics: RenderDiagnostics;
}

export interface RenderPassContext {
  services: RenderServices;
  frame: FrameInfo;
  viewport: Viewport;
  scene: FrameScene;
  /** Resolve a declared named render target to its handle (`null` = surface). */
  target(name: string): RenderTargetHandle | null;
}

export abstract class RenderPass {
  abstract readonly name: string;
  readonly reads: readonly string[] = [];
  get writes(): readonly string[] {
    return [SURFACE];
  }
  readonly after: readonly string[] = [];
  enabled = true;

  abstract execute(ctx: RenderPassContext): void;
}
