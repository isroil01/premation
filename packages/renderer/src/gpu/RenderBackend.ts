/**
 * The backend abstraction. Everything above this interface is GPU-API-agnostic.
 * Concrete backends: WebGPUBackend (primary), WebGL2Backend (fallback),
 * NullBackend (headless, for tests & server-side).
 *
 * SOLID: this is the single seam the renderer depends on (Dependency Inversion).
 * The renderer is constructed with a `RenderBackend`; it never imports one.
 */

import type {
  BackendCapabilities,
  BindGroupDescriptor,
  BindGroupHandle,
  BufferDescriptor,
  BufferHandle,
  IndexFormat,
  PipelineDescriptor,
  PipelineHandle,
  RenderPassDescriptor,
  RenderTargetDescriptor,
  RenderTargetHandle,
  SamplerDescriptor,
  SamplerHandle,
  ShaderModuleDescriptor,
  ShaderModuleHandle,
  TextureDescriptor,
  TextureHandle,
  TextureSource,
} from './types';

/** The drawing surface a backend renders into (a canvas in the browser). */
export interface RenderSurface {
  canvas: HTMLCanvasElement | OffscreenCanvas;
}

/** Records draw state for one render pass; ended before the next pass begins. */
export interface RenderPassEncoder {
  setPipeline(pipeline: PipelineHandle): void;
  setBindGroup(index: number, group: BindGroupHandle): void;
  setVertexBuffer(slot: number, buffer: BufferHandle): void;
  setIndexBuffer(buffer: BufferHandle, format: IndexFormat): void;
  /** Viewport in framebuffer pixels. */
  setViewport(x: number, y: number, width: number, height: number): void;
  setScissor(x: number, y: number, width: number, height: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number): void;
  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number): void;
  end(): void;
}

export interface RenderBackend {
  readonly kind: BackendCapabilities['kind'];
  readonly capabilities: BackendCapabilities;

  /** Acquire the GPU device/context. Idempotent; resolves when ready. */
  initialize(surface?: RenderSurface): Promise<void>;

  // ── Resource creation ───────────────────────────────────────────
  createBuffer(desc: BufferDescriptor): BufferHandle;
  writeBuffer(buffer: BufferHandle, byteOffset: number, data: ArrayBufferView): void;
  destroyBuffer(buffer: BufferHandle): void;

  createTexture(desc: TextureDescriptor): TextureHandle;
  writeTexture(texture: TextureHandle, source: TextureSource): void;
  destroyTexture(texture: TextureHandle): void;

  createSampler(desc: SamplerDescriptor): SamplerHandle;
  destroySampler(sampler: SamplerHandle): void;

  createShaderModule(desc: ShaderModuleDescriptor): ShaderModuleHandle;
  destroyShaderModule(shader: ShaderModuleHandle): void;

  createPipeline(desc: PipelineDescriptor): PipelineHandle;
  destroyPipeline(pipeline: PipelineHandle): void;

  createBindGroup(desc: BindGroupDescriptor): BindGroupHandle;
  destroyBindGroup(group: BindGroupHandle): void;

  createRenderTarget(desc: RenderTargetDescriptor): RenderTargetHandle;
  /** The color texture of a render target, for sampling in a later pass. */
  renderTargetTexture(target: RenderTargetHandle): TextureHandle;
  destroyRenderTarget(target: RenderTargetHandle): void;

  // ── Frame lifecycle ─────────────────────────────────────────────
  beginFrame(): void;
  beginRenderPass(desc: RenderPassDescriptor): RenderPassEncoder;
  endFrame(): void;
  /** Present the frame to the surface (no-op for offscreen/null). */
  present(): void;

  resize(width: number, height: number, devicePixelRatio: number): void;

  dispose(): void;
}
