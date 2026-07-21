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
  TextureHandle,
  TextureSource,
  BlendMode,
  BufferUsage,
  ShaderStage,
} from '../types';
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

  async initialize(surface?: RenderSurface): Promise<void> {
    const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
    if (!gpu) throw new Error('WebGPU is not available');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    this.device = await adapter.requestDevice();
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
      this.device.queue.copyExternalImageToTexture({ source: src }, { texture: tex }, { width, height });
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
    const texture = this.device.createTexture({
      label: desc.label,
      size: { width: desc.width, height: desc.height },
      format: desc.format,
      usage: TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING,
    });
    return { kind: 'render-target', id: nextId(), native: { texture, view: texture.createView() } };
  }
  renderTargetTexture(target: RenderTargetHandle): TextureHandle {
    const { texture } = target.native as { texture: GPUTexture };
    return { kind: 'texture', id: target.id, native: texture };
  }
  destroyRenderTarget(target: RenderTargetHandle): void {
    (target.native as { texture: GPUTexture }).texture.destroy();
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
    const view = toSurface
      ? this.context.getCurrentTexture().createView()
      : (attach.target.native as { view: GPUTextureView }).view;
    const clear = attach.clear;
    const pass = this.encoder.beginRenderPass({
      label: desc.label,
      colorAttachments: [
        {
          view,
          clearValue: clear ? { r: clear.r, g: clear.g, b: clear.b, a: clear.a } : undefined,
          loadOp: clear ? 'clear' : 'load',
          storeOp: 'store',
        },
      ],
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
    return new WebGPUPassEncoder(pass);
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
    this.device?.destroy();
  }
}

class WebGPUPassEncoder implements RenderPassEncoder {
  private pipeline: GPURenderPipeline | null = null;
  constructor(private readonly pass: GPURenderPassEncoder) {}
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
