// Ambient global declarations. An `import` of a globals-only .d.ts is elided
// by tsc, so the reference directive is the only spelling that works here.
/* eslint-disable-next-line @typescript-eslint/triple-slash-reference */
/// <reference path="./webgpu.d.ts" />
/**
 * WebGPU backend (primary). Maps the backend-independent descriptors to WebGPU
 * objects. Native GPU objects are carried on `handle.native`. This file is the
 * only place that speaks WebGPU; everything above it stays API-agnostic.
 *
 * Not exercised by the headless test suite (needs a GPU device); it compiles
 * against a minimal local ambient WebGPU surface and implements the core path
 * (buffers, textures, pipelines, render passes, draws, render targets).
 */

import type { RenderBackend, RenderPassEncoder, RenderSurface } from '../RenderBackend';
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
  ResourceHandle,
  SamplerDescriptor,
  SamplerHandle,
  ShaderModuleDescriptor,
  ShaderModuleHandle,
  TextureDescriptor,
  TextureFormat,
  TextureHandle,
  TextureSource,
  BlendMode,
  BufferUsage,
  ShaderStage,
} from '../types';
import { sourcePassesThrough } from '../types';
import { nextId } from '../../utils/ids';

// WebGPU bit-flag constants (not in the ambient surface).
const BUF = { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
const TEX = { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
const STAGE = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

function h<K extends string>(kind: K, native: unknown): ResourceHandle<K> {
  return { kind, id: nextId(), native };
}

function bufferUsageBits(usage: BufferUsage[]): number {
  let bits = 0;
  for (const u of usage) {
    if (u === 'vertex') bits |= BUF.VERTEX;
    else if (u === 'index') bits |= BUF.INDEX;
    else if (u === 'uniform') bits |= BUF.UNIFORM | BUF.COPY_DST;
    else if (u === 'storage') bits |= BUF.STORAGE | BUF.COPY_DST;
    else if (u === 'copy') bits |= BUF.COPY_DST | BUF.COPY_SRC;
  }
  if (usage.includes('vertex') || usage.includes('index')) bits |= BUF.COPY_DST;
  return bits;
}

function stageBits(stages: ShaderStage[]): number {
  let bits = 0;
  for (const s of stages) bits |= s === 'vertex' ? STAGE.VERTEX : s === 'fragment' ? STAGE.FRAGMENT : STAGE.COMPUTE;
  return bits;
}

function blendState(mode: BlendMode): Record<string, unknown> | undefined {
  const over = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
  switch (mode) {
    case 'none':
      return undefined;
    case 'add':
      return { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: over };
    case 'multiply':
      return { color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' }, alpha: over };
    case 'screen':
      return { color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' }, alpha: over };
    case 'subtract':
      return { color: { srcFactor: 'one', dstFactor: 'one', operation: 'reverse-subtract' }, alpha: over };
    case 'darken':
      return { color: { srcFactor: 'one', dstFactor: 'one', operation: 'min' }, alpha: over };
    case 'lighten':
      return { color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' }, alpha: over };
    default:
      return { color: over, alpha: over };
  }
}

const FILTER = { nearest: 'nearest', linear: 'linear' } as const;
const ADDRESS = { clamp: 'clamp-to-edge', repeat: 'repeat', mirror: 'mirror-repeat' } as const;

export class WebGPUBackend implements RenderBackend {
  readonly kind = 'webgpu' as const;
  /** WebGPU render targets are written top-down (clip +Y → row 0 → V=0), so
   *  full-screen samples of a target must NOT flip V. */
  readonly renderTargetFlipV = false;
  capabilities: BackendCapabilities = {
    kind: 'webgpu',
    maxTextureSize: 8192,
    instancing: true,
    storageBuffers: true,
    float16Textures: true,
    timestampQueries: false,
  };

  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private surfaceFormat = 'bgra8unorm';
  private encoder: GPUCommandEncoder | null = null;
  private deviceLostHandler: ((reason: string) => void) | null = null;

  /** See `RenderBackend.onDeviceLost`. Attach before `initialize`. */
  onDeviceLost(handler: (reason: string) => void): void {
    this.deviceLostHandler = handler;
  }

  async initialize(surface?: RenderSurface): Promise<void> {
    const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
    if (!gpu) throw new Error('WebGPU is not available');
    let adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      // Fall back to default adapter if discrete/high-performance request is null
      adapter = await gpu.requestAdapter();
    }
    if (!adapter) throw new Error('No WebGPU adapter');
    this.device = await adapter.requestDevice();

    /*
      `device.lost` RESOLVES on a device reset — it does not reject. A `.catch`
      here would never fire, and the handler would look wired while being dead.

      Attached immediately after the device is acquired and before anything is
      created on it: a device lost during initialisation is exactly the case a
      later attachment would miss.
    */
    void this.device.lost.then((info: { reason?: string; message?: string }) => {
      const reason = `${info?.reason ?? 'unknown'}: ${info?.message ?? ''}`.trim();
      this.deviceLostHandler?.(reason);
    });

    /*
      Surface validation errors instead of letting them be swallowed.

      WebGPU reports a bad pipeline, bind group or draw ASYNCHRONOUSLY: the call
      returns an object, the draw becomes a no-op, and nothing throws. The
      visible result is a target that stayed cleared — which reads as "the
      effect erased my layer" rather than as an error, and is indistinguishable
      from the layer legitimately rendering nothing.

      `addEventListener` rather than `onuncapturederror`, so this cannot silently
      replace a handler set elsewhere. Optional-chained because the property is
      absent on implementations predating the event, where the browser's own
      console reporting is the only channel.
    */
    (this.device as unknown as {
      addEventListener?: (t: string, f: (e: { error?: { message?: string } }) => void) => void;
    }).addEventListener?.('uncapturederror', (e) => {
      console.error(`[webgpu] validation error: ${e.error?.message ?? 'unknown'}`);
    });

    this.surfaceFormat = gpu.getPreferredCanvasFormat();
    if (surface) {
      const ctx = surface.canvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
      if (!ctx) throw new Error('Could not acquire a WebGPU canvas context');
      this.context = ctx;
      this.context.configure({ device: this.device, format: this.surfaceFormat, alphaMode: 'premultiplied' });
    }
  }

  createBuffer(desc: BufferDescriptor): BufferHandle {
    const buffer = this.device.createBuffer({ label: desc.label, size: align4(desc.sizeBytes), usage: bufferUsageBits(desc.usage) });
    if (desc.data) this.device.queue.writeBuffer(buffer, 0, desc.data);
    return h('buffer', buffer);
  }
  writeBuffer(buffer: BufferHandle, byteOffset: number, data: ArrayBufferView): void {
    this.device.queue.writeBuffer(buffer.native as GPUBuffer, byteOffset, data);
  }
  destroyBuffer(buffer: BufferHandle): void {
    (buffer.native as GPUBuffer).destroy();
  }

  createTexture(desc: TextureDescriptor): TextureHandle {
    // copyExternalImageToTexture (bitmap/canvas/video uploads) requires the
    // destination texture to have RENDER_ATTACHMENT usage per the WebGPU spec,
    // so `externalCopy` textures get it too — not just render targets.
    const usage =
      TEX.TEXTURE_BINDING | TEX.COPY_DST | (desc.renderable || desc.externalCopy ? TEX.RENDER_ATTACHMENT : 0);
    const texture = this.device.createTexture({
      label: desc.label,
      size: { width: desc.width, height: desc.height },
      format: desc.format,
      mipLevelCount: desc.mipmapped ? mipCount(desc.width, desc.height) : 1,
      usage,
    });
    return h('texture', texture);
  }
  writeTexture(texture: TextureHandle, source: TextureSource): void {
    const tex = texture.native as GPUTexture;
    if (source.type === 'buffer') {
      this.device.queue.writeTexture(
        { texture: tex },
        source.data,
        { bytesPerRow: source.width * 4, rowsPerImage: source.height },
        { width: source.width, height: source.height },
      );
    } else {
      const src = source.type === 'bitmap' ? source.bitmap : source.type === 'video' ? source.video : source.canvas;
      let width = 0;
      let height = 0;
      if (source.type === 'bitmap') {
        width = source.bitmap.width;
        height = source.bitmap.height;
      } else if (source.type === 'video') {
        width = source.video.videoWidth;
        height = source.video.videoHeight;
      } else if (source.type === 'canvas') {
        width = source.canvas.width;
        height = source.canvas.height;
      }
      // THE ALPHA INVARIANT (see TextureSource in ../types.ts): premultiplied
      // alpha, every source kind, both backends.
      //
      // `premultipliedAlpha` describes the DESTINATION, and the browser converts
      // from whatever the source's own state is. So `true` is the right request
      // for a straight source — multiply it — and `false` is right for a source
      // whose bytes are already multiplied, because then there is nothing to do
      // and asking for a conversion would multiply a second time.
      //
      // Spelled out rather than left to the spec default so a future default flip
      // cannot silently change the alpha space on the primary backend.
      this.device.queue.copyExternalImageToTexture(
        { source: src },
        { texture: tex, premultipliedAlpha: !sourcePassesThrough(source) },
        { width, height },
      );
    }
  }
  destroyTexture(texture: TextureHandle): void {
    (texture.native as GPUTexture).destroy();
  }

  createSampler(desc: SamplerDescriptor): SamplerHandle {
    const sampler = this.device.createSampler({
      label: desc.label,
      magFilter: FILTER[desc.mag ?? 'linear'],
      minFilter: FILTER[desc.min ?? 'linear'],
      addressModeU: ADDRESS[desc.addressU ?? 'clamp'],
      addressModeV: ADDRESS[desc.addressV ?? 'clamp'],
    });
    return h('sampler', sampler);
  }
  destroySampler(_sampler: SamplerHandle): void {
    // WebGPU samplers are GC'd; nothing explicit to release.
  }

  createShaderModule(desc: ShaderModuleDescriptor): ShaderModuleHandle {
    if (!desc.wgsl) throw new Error('WebGPU requires WGSL source');
    return h('shader', this.device.createShaderModule({ label: desc.label, code: desc.wgsl }));
  }
  destroyShaderModule(_shader: ShaderModuleHandle): void {}

  /**
   * Compile a source now and hand back what the driver complained about.
   *
   * Errors only. A warning is the driver's opinion about a shader it accepted,
   * and refusing a plugin's effect over one would make the set of effects that
   * work depend on which GPU vendor the user happens to have.
   */
  async shaderDiagnostics(label: string, wgsl: string): Promise<string[]> {
    const module = this.device.createShaderModule({ label, code: wgsl });
    // Absent on an implementation predating the method. "Nothing to report" is
    // the only honest answer there, and matches the optional-method contract.
    if (!module.getCompilationInfo) return [];
    const info = await module.getCompilationInfo();
    return info.messages
      .filter((m) => m.type === 'error')
      .map((m) => `line ${m.lineNum}: ${m.message.trim()}`);
  }

  createPipeline(desc: PipelineDescriptor): PipelineHandle {
    const bgl = this.device.createBindGroupLayout({
      entries: desc.layout.map((e) => {
        const entry: Record<string, unknown> = { binding: e.binding, visibility: stageBits(e.stages) };
        if (e.type === 'uniform-buffer') entry.buffer = { type: 'uniform' };
        else if (e.type === 'storage-buffer') entry.buffer = { type: 'read-only-storage' };
        else if (e.type === 'texture') entry.texture = {};
        else entry.sampler = {};
        return entry;
      }),
    });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const pipeline = this.device.createRenderPipeline({
      label: desc.label,
      layout,
      vertex: {
        module: desc.shader.native as GPUShaderModule,
        entryPoint: desc.vertexEntry ?? 'vs',
        buffers: desc.buffers.map((b) => ({
          arrayStride: b.strideBytes,
          stepMode: b.stepMode,
          attributes: b.attributes.map((a) => ({ shaderLocation: a.shaderLocation, offset: a.offsetBytes, format: a.format })),
        })),
      },
      fragment: {
        module: desc.shader.native as GPUShaderModule,
        entryPoint: desc.fragmentEntry ?? 'fs',
        targets: [{ format: desc.colorFormat, blend: blendState(desc.blend) }],
      },
      primitive: { topology: desc.topology },
      // WebGPU validates the pipeline's sample count against the pass's
      // attachments, unlike WebGL2 where multisampling lives entirely in the
      // framebuffer. A mismatch is a validation error, not a silent fallback.
      ...(desc.samples && desc.samples > 1 ? { multisample: { count: desc.samples } } : {}),
      // Depth state is baked into WebGPU pipelines; a depth-tested pipeline is
      // only valid inside a pass carrying a depth attachment (and vice versa).
      ...(desc.depthTest
        ? {
            depthStencil: {
              format: desc.depthFormat ?? 'depth24plus',
              depthWriteEnabled: desc.depthWrite ?? true,
              depthCompare: 'less-equal',
            },
          }
        : {}),
    });
    return h('pipeline', { pipeline, bgl });
  }
  destroyPipeline(_pipeline: PipelineHandle): void {}

  createBindGroup(desc: BindGroupDescriptor): BindGroupHandle {
    const { bgl } = desc.pipeline.native as { pipeline: GPURenderPipeline; bgl: GPUBindGroupLayout };
    const entries = desc.entries.map((e) => {
      if ('buffer' in e) return { binding: e.binding, resource: { buffer: e.buffer.native as GPUBuffer, offset: e.offsetBytes ?? 0, size: e.sizeBytes } };
      if ('texture' in e) return { binding: e.binding, resource: (e.texture.native as GPUTexture).createView() };
      return { binding: e.binding, resource: e.sampler.native as GPUSampler };
    });
    return h('bindgroup', this.device.createBindGroup({ layout: bgl, entries }));
  }
  destroyBindGroup(_group: BindGroupHandle): void {}

  createRenderTarget(desc: RenderTargetDescriptor): RenderTargetHandle {
    // MSAA in WebGPU is a texture property, and a multisampled texture is NOT
    // sampleable — so a multisampled target is a pair: the multisample
    // attachment drawn into, and a single-sample texture the pass resolves
    // into, which is the one everything else binds. Callers stay unaware, in
    // keeping with `RenderTargetDescriptor.samples`.
    const samples = Math.max(1, Math.floor(desc.samples ?? 1));
    // WebGPU guarantees only 1 and 4.
    const sampleCount = samples >= 4 ? 4 : 1;

    const texture = this.device.createTexture({
      label: desc.label,
      size: { width: desc.width, height: desc.height },
      format: desc.format,
      usage: TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING,
    });
    let msaaTexture: GPUTexture | undefined;
    let msaaView: GPUTextureView | undefined;
    if (sampleCount > 1) {
      msaaTexture = this.device.createTexture({
        label: desc.label ? `${desc.label}/msaa` : 'render-target-msaa',
        size: { width: desc.width, height: desc.height },
        format: desc.format,
        sampleCount,
        // Never TEXTURE_BINDING: a multisampled texture cannot be sampled.
        usage: TEX.RENDER_ATTACHMENT,
      });
      msaaView = msaaTexture.createView();
    }
    // Depth attachment for 3D group rendering (created only when asked for —
    // effect scratch targets stay colour-only). Its sample count must match the
    // colour attachment's.
    let depthTexture: GPUTexture | undefined;
    let depthView: GPUTextureView | undefined;
    if (desc.depth) {
      depthTexture = this.device.createTexture({
        label: desc.label ? `${desc.label}/depth` : 'render-target-depth',
        size: { width: desc.width, height: desc.height },
        format: 'depth24plus',
        ...(sampleCount > 1 ? { sampleCount } : {}),
        usage: TEX.RENDER_ATTACHMENT,
      });
      depthView = depthTexture.createView();
    }
    return {
      kind: 'render-target',
      id: nextId(),
      native: { texture, view: texture.createView(), msaaTexture, msaaView, sampleCount, depthTexture, depthView, format: desc.format },
    };
  }
  renderTargetTexture(target: RenderTargetHandle): TextureHandle {
    const { texture } = target.native as { texture: GPUTexture };
    return { kind: 'texture', id: target.id, native: texture };
  }
  destroyRenderTarget(target: RenderTargetHandle): void {
    const native = target.native as { texture: GPUTexture; msaaTexture?: GPUTexture; depthTexture?: GPUTexture };
    native.texture.destroy();
    native.msaaTexture?.destroy();
    native.depthTexture?.destroy();
  }

  beginFrame(): void {
    this.encoder = this.device.createCommandEncoder();
  }
  /** Surface clip rect (surface px, top-left origin), or null. */
  private frameClip: { x: number; y: number; width: number; height: number } | null = null;
  /** Surface size, tracked at resize (GPUTexture doesn't expose dimensions in
   *  this project's WebGPU type set). */
  private surfaceW = 0;
  private surfaceH = 0;

  setFrameClip(rect: { x: number; y: number; width: number; height: number } | null): void {
    this.frameClip = rect;
  }

  beginRenderPass(desc: RenderPassDescriptor): RenderPassEncoder {
    if (!this.encoder) throw new Error('beginRenderPass outside a frame');
    const attach = desc.color;
    const toSurface = attach.target === 'surface';
    // A multisampled target renders into its MSAA attachment and RESOLVES into
    // the single-sample texture everything else binds — the resolve is what
    // makes the extra samples visible downstream, and skipping it would leave
    // the bound texture empty.
    const native = toSurface
      ? null
      : (attach.target.native as {
          view: GPUTextureView;
          msaaView?: GPUTextureView;
          sampleCount?: number;
          depthView?: GPUTextureView;
          format?: TextureFormat;
        });
    const sampleCount = native?.sampleCount ?? 1;
    // The pass's colour-attachment format — the pipelines drawing into it must
    // match (WebGPU validates it). Surface passes use the swapchain format.
    const format = (toSurface ? this.surfaceFormat : native!.format) as TextureFormat;
    const view = toSurface
      ? this.context.getCurrentTexture().createView()
      : (native!.msaaView ?? native!.view);
    const resolveTarget = !toSurface && native!.msaaView ? native!.view : undefined;
    const clear = attach.clear;
    // Depth attachment only when the pass asks for it AND the target carries
    // one — the surface has no depth texture, and a depth-tested pipeline is
    // never routed at it (CompositionPass only forms 3D groups on offscreen
    // targets created with depth).
    const depthView = !toSurface && desc.depth ? native!.depthView : undefined;
    const pass = this.encoder.beginRenderPass({
      label: desc.label,
      colorAttachments: [
        {
          view,
          ...(resolveTarget ? { resolveTarget } : {}),
          clearValue: clear ? { r: clear.r, g: clear.g, b: clear.b, a: clear.a } : undefined,
          loadOp: clear ? 'clear' : 'load',
          // ALWAYS store, even when resolving. It is tempting to discard the
          // multisample samples once they are resolved — nothing samples them —
          // but the composition re-opens the same target with `loadOp: 'load'`
          // to keep drawing into it (CompositionPass flushes and continues per
          // layer group). Discarding would hand that next pass an undefined
          // attachment and silently drop everything drawn so far, leaving only
          // whatever the final pass wrote.
          storeOp: 'store',
        },
      ],
      ...(depthView
        ? {
            depthStencilAttachment: {
              view: depthView,
              depthClearValue: desc.depth?.clearDepth ?? 1,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
            },
          }
        : {}),
    });
    // The clear above is full-canvas (loadOp runs before the scissor applies);
    // draws after this are clipped to the comp rect. Surface only —
    // intermediate targets legitimately hold full content.
    const clip = toSurface && this.surfaceW > 0 && this.surfaceH > 0 ? this.frameClip : null;
    if (clip) {
      // setScissorRect throws on out-of-bounds rects — clamp to the surface.
      const x = Math.max(0, Math.min(this.surfaceW, Math.round(clip.x)));
      const y = Math.max(0, Math.min(this.surfaceH, Math.round(clip.y)));
      const w = Math.max(0, Math.min(this.surfaceW - x, Math.round(clip.width)));
      const h = Math.max(0, Math.min(this.surfaceH - y, Math.round(clip.height)));
      pass.setScissorRect(x, y, w, h);
    }
    return new WebGPUPassEncoder(pass, sampleCount, format);
  }
  endFrame(): void {
    if (!this.encoder) return;
    this.device.queue.submit([this.encoder.finish()]);
    this.encoder = null;
  }
  present(): void {
    // WebGPU presents implicitly on submit.
  }
  resize(width: number, height: number, devicePixelRatio = 1): void {
    // Physical pixels: the canvas backing store is CSS×dpr, and the frame clip
    // (setFrameClip) arrives in device px — surfaceW/H clamp against it, so
    // they must be in the same space.
    this.surfaceW = Math.max(1, Math.round(width * devicePixelRatio));
    this.surfaceH = Math.max(1, Math.round(height * devicePixelRatio));
    if (this.context) this.context.configure({ device: this.device, format: this.surfaceFormat, alphaMode: 'premultiplied', size: { width: this.surfaceW, height: this.surfaceH } });
  }
  dispose(): void {
    // Drop any half-built frame, detach from the canvas, then destroy the
    // device. destroy releases every resource created from it (buffers,
    // textures, pipelines — WebGPU's ownership model), so per-resource
    // teardown is unnecessary; unconfigure frees the canvas' swap chain so a
    // fresh backend can reconfigure the same canvas on re-entry.
    this.encoder = null;
    try {
      (this.context as unknown as { unconfigure?: () => void } | undefined)?.unconfigure?.();
    } catch {
      /* best-effort — context may already be lost */
    }
    this.device?.destroy();
    this.device = undefined as unknown as GPUDevice;
    this.context = undefined as unknown as GPUCanvasContext;
  }
}

class WebGPUPassEncoder implements RenderPassEncoder {
  private pipeline: GPURenderPipeline | null = null;
  constructor(
    private readonly pass: GPURenderPassEncoder,
    readonly samples: number = 1,
    readonly format?: TextureFormat,
  ) {}
  setPipeline(pipeline: PipelineHandle): void {
    this.pipeline = (pipeline.native as { pipeline: GPURenderPipeline }).pipeline;
    this.pass.setPipeline(this.pipeline);
  }
  setBindGroup(index: number, group: BindGroupHandle): void {
    this.pass.setBindGroup(index, group.native as GPUBindGroup);
  }
  setVertexBuffer(slot: number, buffer: BufferHandle): void {
    this.pass.setVertexBuffer(slot, buffer.native as GPUBuffer);
  }
  setIndexBuffer(buffer: BufferHandle, format: IndexFormat): void {
    this.pass.setIndexBuffer(buffer.native as GPUBuffer, format);
  }
  setViewport(x: number, y: number, width: number, height: number): void {
    this.pass.setViewport(x, y, width, height, 0, 1);
  }
  setScissor(x: number, y: number, width: number, height: number): void {
    this.pass.setScissorRect(x, y, width, height);
  }
  draw(vertexCount: number, instanceCount = 1, firstVertex = 0): void {
    this.pass.draw(vertexCount, instanceCount, firstVertex);
  }
  drawIndexed(indexCount: number, instanceCount = 1, firstIndex = 0): void {
    this.pass.drawIndexed(indexCount, instanceCount, firstIndex);
  }
  end(): void {
    this.pass.end();
  }
}

function align4(n: number): number {
  return (n + 3) & ~3;
}
function mipCount(w: number, h: number): number {
  return 1 + Math.floor(Math.log2(Math.max(w, h)));
}
