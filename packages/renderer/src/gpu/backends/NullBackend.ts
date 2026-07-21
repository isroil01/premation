/**
 * Headless backend. Implements the full `RenderBackend` contract by *recording*
 * operations instead of touching a GPU. It powers unit tests (assert draw calls,
 * pass order, resource lifecycles) and server-side/offscreen scenarios where no
 * GPU exists. Every created resource is tracked so leaks are observable.
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
} from '../types';
import { nextId } from '../../utils/ids';

export interface RecordedDraw {
  pass: string;
  pipeline: number;
  vertexCount: number;
  instanceCount: number;
  indexed: boolean;
}

export interface NullBackendStats {
  frames: number;
  passes: number;
  draws: number;
  liveBuffers: number;
  liveTextures: number;
  livePipelines: number;
  liveBindGroups: number;
  liveRenderTargets: number;
  bufferBytesWritten: number;
}

function handle<K extends string>(kind: K): ResourceHandle<K> {
  return { kind, id: nextId() };
}

class NullPassEncoder implements RenderPassEncoder {
  boundPipeline = 0;
  constructor(
    private readonly label: string,
    private readonly onDraw: (d: RecordedDraw) => void,
  ) {}
  setPipeline(pipeline: PipelineHandle): void {
    this.boundPipeline = pipeline.id;
  }
  setBindGroup(_index: number, _group: BindGroupHandle): void {}
  setVertexBuffer(_slot: number, _buffer: BufferHandle): void {}
  setIndexBuffer(_buffer: BufferHandle, _format: IndexFormat): void {}
  setViewport(): void {}
  setScissor(): void {}
  draw(vertexCount: number, instanceCount = 1): void {
    this.onDraw({ pass: this.label, pipeline: this.boundPipeline, vertexCount, instanceCount, indexed: false });
  }
  drawIndexed(indexCount: number, instanceCount = 1): void {
    this.onDraw({ pass: this.label, pipeline: this.boundPipeline, vertexCount: indexCount, instanceCount, indexed: true });
  }
  end(): void {}
}

export class NullBackend implements RenderBackend {
  readonly kind = 'null' as const;
  /** No pixels are produced; value is irrelevant but must exist. */
  readonly renderTargetFlipV = false;
  readonly capabilities: BackendCapabilities = {
    kind: 'null',
    maxTextureSize: 16384,
    instancing: true,
    storageBuffers: true,
    float16Textures: true,
    timestampQueries: false,
  };

  readonly draws: RecordedDraw[] = [];
  readonly passLog: string[] = [];
  private frameCount = 0;
  private passCount = 0;
  private bufferBytes = 0;

  private readonly live = {
    buffer: new Set<number>(),
    texture: new Set<number>(),
    pipeline: new Set<number>(),
    bindgroup: new Set<number>(),
    'render-target': new Set<number>(),
    sampler: new Set<number>(),
    shader: new Set<number>(),
  };

  async initialize(_surface?: RenderSurface): Promise<void> {}

  createBuffer(desc: BufferDescriptor): BufferHandle {
    const h = handle('buffer');
    this.live.buffer.add(h.id);
    if (desc.data) this.bufferBytes += desc.data.byteLength;
    return h;
  }
  writeBuffer(_buffer: BufferHandle, _byteOffset: number, data: ArrayBufferView): void {
    this.bufferBytes += data.byteLength;
  }
  destroyBuffer(buffer: BufferHandle): void {
    this.live.buffer.delete(buffer.id);
  }

  createTexture(_desc: TextureDescriptor): TextureHandle {
    const h = handle('texture');
    this.live.texture.add(h.id);
    return h;
  }
  writeTexture(_texture: TextureHandle, _source: TextureSource): void {}
  destroyTexture(texture: TextureHandle): void {
    this.live.texture.delete(texture.id);
  }

  createSampler(_desc: SamplerDescriptor): SamplerHandle {
    const h = handle('sampler');
    this.live.sampler.add(h.id);
    return h;
  }
  destroySampler(sampler: SamplerHandle): void {
    this.live.sampler.delete(sampler.id);
  }

  createShaderModule(_desc: ShaderModuleDescriptor): ShaderModuleHandle {
    const h = handle('shader');
    this.live.shader.add(h.id);
    return h;
  }
  destroyShaderModule(shader: ShaderModuleHandle): void {
    this.live.shader.delete(shader.id);
  }

  createPipeline(_desc: PipelineDescriptor): PipelineHandle {
    const h = handle('pipeline');
    this.live.pipeline.add(h.id);
    return h;
  }
  destroyPipeline(pipeline: PipelineHandle): void {
    this.live.pipeline.delete(pipeline.id);
  }

  createBindGroup(_desc: BindGroupDescriptor): BindGroupHandle {
    const h = handle('bindgroup');
    this.live.bindgroup.add(h.id);
    return h;
  }
  destroyBindGroup(group: BindGroupHandle): void {
    this.live.bindgroup.delete(group.id);
  }

  private readonly rtTexture = new Map<number, TextureHandle>();
  createRenderTarget(_desc: RenderTargetDescriptor): RenderTargetHandle {
    const h = handle('render-target');
    this.live['render-target'].add(h.id);
    const tex = handle('texture');
    this.live.texture.add(tex.id);
    this.rtTexture.set(h.id, tex);
    return h;
  }
  renderTargetTexture(target: RenderTargetHandle): TextureHandle {
    const tex = this.rtTexture.get(target.id);
    if (!tex) throw new Error(`Unknown render target ${target.id}`);
    return tex;
  }
  destroyRenderTarget(target: RenderTargetHandle): void {
    this.live['render-target'].delete(target.id);
    const tex = this.rtTexture.get(target.id);
    if (tex) this.live.texture.delete(tex.id);
    this.rtTexture.delete(target.id);
  }

  beginFrame(): void {
    this.frameCount += 1;
  }
  beginRenderPass(desc: RenderPassDescriptor): RenderPassEncoder {
    this.passCount += 1;
    const label = desc.label ?? 'pass';
    this.passLog.push(label);
    return new NullPassEncoder(label, (d) => this.draws.push(d));
  }
  endFrame(): void {}
  present(): void {}
  resize(_width: number, _height: number, _dpr: number): void {}

  dispose(): void {
    for (const set of Object.values(this.live)) set.clear();
    this.rtTexture.clear();
  }

  // ── Test/introspection helpers ──────────────────────────────────
  stats(): NullBackendStats {
    return {
      frames: this.frameCount,
      passes: this.passCount,
      draws: this.draws.length,
      liveBuffers: this.live.buffer.size,
      liveTextures: this.live.texture.size,
      livePipelines: this.live.pipeline.size,
      liveBindGroups: this.live.bindgroup.size,
      liveRenderTargets: this.live['render-target'].size,
      bufferBytesWritten: this.bufferBytes,
    };
  }
  resetLog(): void {
    this.draws.length = 0;
    this.passLog.length = 0;
  }
}
