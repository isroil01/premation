/**
 * Central GPU resource allocator. Two jobs:
 *   1. **Dedup** — resources are acquired by a stable string key; identical keys
 *      return the same handle instead of allocating again.
 *   2. **Automatic disposal** — every acquire stamps the current frame; a GC pass
 *      disposes anything not touched within `maxIdleFrames` (LRU by last-use).
 *
 * The renderer never calls `backend.createX` directly for cacheable resources —
 * it goes through here, so duplicate allocations are structurally impossible.
 */

import type { RenderBackend } from './RenderBackend';
import type {
  BindGroupDescriptor,
  BindGroupHandle,
  BufferDescriptor,
  BufferHandle,
  PipelineDescriptor,
  PipelineHandle,
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
} from './types';
import {
  GpuMemoryMeter,
  estimateBufferBytes,
  estimateRenderTargetBytes,
  estimateTextureBytes,
} from './gpuMemory';

interface Entry<H> {
  handle: H;
  lastFrame: number;
  pinned: boolean;
  /** Estimated GPU bytes this entry holds (0 for pipelines, samplers, …). */
  bytes: number;
}

class Pool<H extends ResourceHandle<string>> {
  private readonly map = new Map<string, Entry<H>>();
  constructor(
    private readonly destroy: (h: H) => void,
    private readonly meter: GpuMemoryMeter,
  ) {}

  /**
   * `bytes` is the estimate for a NEW allocation; it is only charged when the
   * key misses, so a dedup hit costs nothing and never double-counts.
   */
  acquire(key: string, frame: number, create: () => H, pinned: boolean, bytes = 0): H {
    const existing = this.map.get(key);
    if (existing) {
      existing.lastFrame = frame;
      if (pinned) existing.pinned = true;
      return existing.handle;
    }
    const handle = create();
    this.map.set(key, { handle, lastFrame: frame, pinned, bytes });
    this.meter.add(bytes);
    return handle;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Dispose entries untouched since `frame - maxIdle`. Returns disposed count. */
  collect(frame: number, maxIdle: number): number {
    let n = 0;
    for (const [key, e] of this.map) {
      if (!e.pinned && frame - e.lastFrame > maxIdle) {
        this.release(e);
        this.map.delete(key);
        n += 1;
      }
    }
    return n;
  }

  get size(): number {
    return this.map.size;
  }

  free(key: string): void {
    const entry = this.map.get(key);
    if (entry) {
      this.release(entry);
      this.map.delete(key);
    }
  }

  disposeAll(): void {
    for (const e of this.map.values()) this.release(e);
    this.map.clear();
  }

  private release(e: Entry<H>): void {
    this.destroy(e.handle);
    this.meter.sub(e.bytes);
  }
}

export interface ResourceManagerOptions {
  /** Frames a resource may go untouched before GC disposes it. */
  maxIdleFrames?: number;
}

export interface ResourceManagerStats {
  buffers: number;
  textures: number;
  samplers: number;
  shaders: number;
  pipelines: number;
  bindGroups: number;
  renderTargets: number;
  /**
   * Estimated GPU bytes currently held by the pools (see `gpuMemory.ts` for
   * what is counted and how). Buffers, textures and render targets only —
   * pipelines, samplers, bind groups and shader modules are counted as 0.
   */
  gpuBytes: number;
  /** High-water mark of `gpuBytes` over the manager's lifetime. */
  gpuBytesPeak: number;
}

/** The pools a caller can ask `has` about (the count fields of the stats). */
export type PoolKind = Exclude<keyof ResourceManagerStats, 'gpuBytes' | 'gpuBytesPeak'>;

export class ResourceManager {
  private frame = 0;
  private readonly maxIdle: number;

  private readonly buffers: Pool<BufferHandle>;
  private readonly textures: Pool<TextureHandle>;
  private readonly samplers: Pool<SamplerHandle>;
  private readonly shaders: Pool<ShaderModuleHandle>;
  private readonly pipelines: Pool<PipelineHandle>;
  private readonly bindGroups: Pool<BindGroupHandle>;
  private readonly renderTargets: Pool<RenderTargetHandle>;
  /** VRAM estimate across every pool — the HUD's gauge. */
  private readonly memory = new GpuMemoryMeter();

  constructor(
    private readonly backend: RenderBackend,
    options: ResourceManagerOptions = {},
  ) {
    this.maxIdle = options.maxIdleFrames ?? 120;
    const m = this.memory;
    this.buffers = new Pool((h) => this.backend.destroyBuffer(h), m);
    this.textures = new Pool((h) => this.backend.destroyTexture(h), m);
    this.samplers = new Pool((h) => this.backend.destroySampler(h), m);
    this.shaders = new Pool((h) => this.backend.destroyShaderModule(h), m);
    this.pipelines = new Pool((h) => this.backend.destroyPipeline(h), m);
    this.bindGroups = new Pool((h) => this.backend.destroyBindGroup(h), m);
    this.renderTargets = new Pool((h) => this.backend.destroyRenderTarget(h), m);
  }

  /** Advance the frame clock; call once per rendered frame. */
  beginFrame(frame: number): void {
    this.frame = frame;
  }

  buffer(key: string, desc: BufferDescriptor, pinned = false): BufferHandle {
    return this.buffers.acquire(
      key, this.frame, () => this.backend.createBuffer(desc), pinned, estimateBufferBytes(desc),
    );
  }
  texture(key: string, desc: TextureDescriptor, pinned = false): TextureHandle {
    return this.textures.acquire(
      key, this.frame, () => this.backend.createTexture(desc), pinned,
      estimateTextureBytes(desc, this.backend.capabilities.maxTextureSize || Infinity),
    );
  }
  /** Upload pixel data into a texture (image bitmap, canvas, video frame, or raw
   *  bytes). Thin passthrough so a `TextureProvider` — which only receives the
   *  ResourceManager — can populate the textures it allocates. */
  writeTexture(texture: TextureHandle, source: TextureSource): void {
    this.backend.writeTexture(texture, source);
  }
  sampler(key: string, desc: SamplerDescriptor, pinned = false): SamplerHandle {
    return this.samplers.acquire(key, this.frame, () => this.backend.createSampler(desc), pinned);
  }
  shader(key: string, desc: ShaderModuleDescriptor, pinned = false): ShaderModuleHandle {
    return this.shaders.acquire(key, this.frame, () => this.backend.createShaderModule(desc), pinned);
  }
  pipeline(key: string, desc: PipelineDescriptor, pinned = false): PipelineHandle {
    return this.pipelines.acquire(key, this.frame, () => this.backend.createPipeline(desc), pinned);
  }
  bindGroup(key: string, desc: BindGroupDescriptor, pinned = false): BindGroupHandle {
    return this.bindGroups.acquire(key, this.frame, () => this.backend.createBindGroup(desc), pinned);
  }
  renderTarget(key: string, desc: RenderTargetDescriptor, pinned = false): RenderTargetHandle {
    return this.renderTargets.acquire(
      key, this.frame, () => this.backend.createRenderTarget(desc), pinned, estimateRenderTargetBytes(desc),
    );
  }

  freeTexture(key: string): void {
    this.textures.free(key);
  }

  /** Whether the live backend can allocate / filter rgba32float textures. */
  get float32Textures(): boolean {
    return this.backend.capabilities.float32Textures;
  }

  /** Maximum 2D texture dimension supported by the live backend. */
  get maxTextureSize(): number {
    return this.backend.capabilities.maxTextureSize;
  }

  has(kind: PoolKind, key: string): boolean {
    return this.poolFor(kind).has(key);
  }

  /** Run garbage collection. Returns the number of resources disposed. */
  collectGarbage(): number {
    return (
      this.buffers.collect(this.frame, this.maxIdle) +
      this.textures.collect(this.frame, this.maxIdle) +
      this.samplers.collect(this.frame, this.maxIdle) +
      this.shaders.collect(this.frame, this.maxIdle) +
      this.pipelines.collect(this.frame, this.maxIdle) +
      this.bindGroups.collect(this.frame, this.maxIdle) +
      this.renderTargets.collect(this.frame, this.maxIdle)
    );
  }

  stats(): ResourceManagerStats {
    return {
      buffers: this.buffers.size,
      textures: this.textures.size,
      samplers: this.samplers.size,
      shaders: this.shaders.size,
      pipelines: this.pipelines.size,
      bindGroups: this.bindGroups.size,
      renderTargets: this.renderTargets.size,
      gpuBytes: this.memory.bytes,
      gpuBytesPeak: this.memory.peak,
    };
  }

  dispose(): void {
    this.buffers.disposeAll();
    this.textures.disposeAll();
    this.samplers.disposeAll();
    this.shaders.disposeAll();
    this.pipelines.disposeAll();
    this.bindGroups.disposeAll();
    this.renderTargets.disposeAll();
  }

  private poolFor(kind: PoolKind): { has(key: string): boolean } {
    switch (kind) {
      case 'buffers':
        return this.buffers;
      case 'textures':
        return this.textures;
      case 'samplers':
        return this.samplers;
      case 'shaders':
        return this.shaders;
      case 'pipelines':
        return this.pipelines;
      case 'bindGroups':
        return this.bindGroups;
      case 'renderTargets':
        return this.renderTargets;
    }
  }
}
