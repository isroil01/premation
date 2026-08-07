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
  TextureFormat,
  TextureHandle,
  TextureSource,
} from './types';

/** The drawing surface a backend renders into (a canvas in the browser). */
export interface RenderSurface {
  canvas: HTMLCanvasElement | OffscreenCanvas;
}

/** Records draw state for one render pass; ended before the next pass begins. */
export interface RenderPassEncoder {
  /**
   * MSAA sample count of the attachments this pass writes (1 = single-sample).
   *
   * WebGPU bakes the sample count into the PIPELINE, and a pipeline whose count
   * differs from the pass's attachments is invalid — so a draw has to know what
   * it is rendering into before it picks a pipeline. WebGL2 has no such
   * coupling (multisampling is purely a property of the framebuffer) and simply
   * reports 1; its pipelines ignore the field.
   */
  readonly samples?: number;
  /**
   * Color-attachment format this pass writes. Like `samples`, WebGPU bakes the
   * target format into the PIPELINE and rejects a pipeline whose format differs
   * from the attachment — so a draw must know its target's format before it
   * picks a pipeline. This is what lets the intermediate compositing targets be
   * `rgba16float` (higher-precision, HDR-capable) while the surface stays 8-bit.
   * WebGL2 has no such coupling and simply reports it; its pipelines ignore it.
   */
  readonly format?: TextureFormat;
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

  /** True when render-target textures are written bottom-up (OpenGL convention:
   *  clip +Y lands on texture V=1), so full-screen samples of an offscreen
   *  target must flip V. WebGL2 = true; WebGPU writes top-down (clip +Y → V=0,
   *  matching how sampling reads it) = false. Pass code must consult this via
   *  `targetSampleUv` instead of hardcoding a flip — hardcoding the WebGL
   *  convention vertically mirrors every FBO round-trip on WebGPU. */
  readonly renderTargetFlipV: boolean;

  /** Acquire the GPU device/context. Idempotent; resolves when ready. */
  initialize(surface?: RenderSurface): Promise<void>;

  /**
   * Called once if the GPU device is lost, with whatever the driver said.
   *
   * Optional because only WebGPU can report it this way: `GPUDevice.lost` is a
   * promise that resolves on a device reset. WebGL2's `webglcontextlost` is a
   * different mechanism that this interface does not currently model, and
   * pretending otherwise would mean a handler that silently never fires on one
   * backend.
   *
   * Exists so a device reset can be ATTRIBUTED. Plugin effects run arbitrary
   * WGSL, a GPU cannot be preempted, and a shader that hangs it takes down
   * every context in the process. Without a hook here the app learns that the
   * viewport died and nothing about why — see `core/plugins/pluginEffects.ts`,
   * which turns "something was drawing" into "this effect, from this plugin".
   *
   * Attach BEFORE `initialize`, or the device may already be gone by the time
   * the handler is registered.
   */
  onDeviceLost?(handler: (reason: string) => void): void;

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
  /**
   * Clip every SURFACE draw of subsequent frames to this rect (surface pixels,
   * TOP-LEFT origin), or null to clear. Surface clears stay full-canvas — the
   * area outside the rect keeps the clear (pasteboard) colour, so composition
   * content cannot draw past the comp bounds (AE's comp-panel behaviour, and
   * what Canvas2D's `ctx.clip` has always done). Intermediate render targets
   * are never clipped: blur/matte buffers legitimately hold full content.
   */
  setFrameClip?(rect: { x: number; y: number; width: number; height: number } | null): void;
  /** Present the frame to the surface (no-op for offscreen/null). */
  present(): void;

  resize(width: number, height: number, devicePixelRatio: number): void;

  dispose(): void;
}
