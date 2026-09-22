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

  /**
   * Receive the GPU's own time for a frame, in milliseconds, once the device
   * has reported it.
   *
   * Optional because only WebGPU with the `timestamp-query` feature can
   * measure it (`capabilities.timestampQueries`); WebGL2 has no portable
   * equivalent and the null backend has no GPU. A backend that cannot measure
   * never calls the handler, and the caller must read silence as "not
   * measured", never as zero.
   *
   * The value arrives ASYNCHRONOUSLY: it is read back from a mapped buffer
   * after the frame's commands complete, so a handler runs one to a few
   * frames after the frame it describes was submitted. It is never called
   * from inside `beginFrame`/`endFrame`.
   */
  onGpuFrameTime?(handler: (ms: number) => void): void;

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

  /**
   * Compile a source now and return the driver's error messages, if the backend
   * can ask. An empty array means it compiled cleanly.
   *
   * Optional, and the absence is meaningful: a backend that cannot report
   * diagnostics returns nothing here, and a caller must read that as "not
   * checked" rather than "fine". It exists for host-supplied shaders — a
   * plugin effect's WGSL is untrusted text, and without this the first news of
   * a bad one is a pipeline failing inside a frame, where the error is
   * unattributable and the frame is already lost.
   */
  shaderDiagnostics?(label: string, wgsl: string): Promise<string[]>;
  /**
   * The GLSL twin of {@link shaderDiagnostics}, for a plugin effect's GLSL ES
   * 3.0 kernel on the WebGL2 tier.
   *
   * Takes both stages because it LINKS them: a fragment stage reading a varying
   * the vertex stage does not write is two sources that each compile and one
   * program that does not.
   */
  glslDiagnostics?(label: string, vertex: string, fragment: string): Promise<string[]>;

  createPipeline(desc: PipelineDescriptor): PipelineHandle;
  destroyPipeline(pipeline: PipelineHandle): void;

  createBindGroup(desc: BindGroupDescriptor): BindGroupHandle;
  destroyBindGroup(group: BindGroupHandle): void;

  createRenderTarget(desc: RenderTargetDescriptor): RenderTargetHandle;
  /** The color texture of a render target, for sampling in a later pass. */
  renderTargetTexture(target: RenderTargetHandle): TextureHandle;
  /**
   * Sampleable depth texture when the target was created with `depth: true` and
   * without MSAA (or MSAA fell back to 1×). Multisampled depth is not sampleable
   * on either backend — returns null in that case. Used by future scene-wide
   * DOF; planar CoC does not require it.
   */
  renderTargetDepthTexture?(target: RenderTargetHandle): TextureHandle | null;
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
  /**
   * End a render pass that was begun and never ended, because the code drawing
   * into it threw.
   *
   * Optional: only WebGPU needs it. A GPURenderPassEncoder left open makes the
   * frame's `encoder.finish()` invalid, so ONE throwing pass would otherwise
   * lose every pass before it too — the per-pass error guard in RenderGraph
   * would skip the failing pass and still present nothing. WebGL2 has no pass
   * object to close (the next pass simply rebinds its framebuffer).
   */
  abortOpenPass?(): void;
  /**
   * Optional float readback of a render target (linear working-space RGBA).
   * Used by EXR export. Backends without float RT support return null.
   */
  readRenderTargetFloat?(
    target: RenderTargetHandle,
    width: number,
    height: number,
  ): Float32Array | null;
  /** Async float readback (WebGPU). Prefer this from export loops. */
  readRenderTargetFloatAsync?(
    target: RenderTargetHandle,
    width: number,
    height: number,
  ): Promise<Float32Array | null>;

  resize(width: number, height: number, devicePixelRatio: number): void;

  dispose(): void;
}
