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
const BUF = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, QUERY_RESOLVE: 512 };
const TEX = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
const STAGE = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

function h<K extends string>(kind: K, native: unknown): ResourceHandle<K> {
  return { kind, id: nextId(), native };
}

/** IEEE-754 binary16 → number (for rgba16float readback). */
function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * (2 ** -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : s ? -Infinity : Infinity;
  return (s ? -1 : 1) * (2 ** (e - 15)) * (1 + f / 1024);
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

/** Staging buffers for the GPU-time readback: frames that may be in flight at once. */
const GPU_TIME_RING = 4;
/** Two u64 timestamps. */
const GPU_TIME_BYTES = 16;

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
    float32Textures: false,
    timestampQueries: false,
  };

  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private surfaceFormat = 'bgra8unorm';
  private encoder: GPUCommandEncoder | null = null;
  /** The pass encoder most recently begun — closed by `abortOpenPass` when the
   *  code drawing into it threw before calling `end`. */
  private openPass: WebGPUPassEncoder | null = null;
  private deviceLostHandler: ((reason: string) => void) | null = null;

  /** See `RenderBackend.onDeviceLost`. Attach before `initialize`. */
  onDeviceLost(handler: (reason: string) => void): void {
    this.deviceLostHandler = handler;
  }

  // ── GPU frame time (timestamp queries) ───────────────────────────
  //
  // How a frame's GPU time is measured, and why it is shaped this way:
  //
  //   * Chromium removed `GPUCommandEncoder.writeTimestamp` from the standard
  //     `timestamp-query` feature (it lives behind a chromium-experimental
  //     flag now), so the portable spelling is `timestampWrites` on a PASS:
  //     a query index written when the pass begins and one when it ends.
  //   * A frame is many passes and nobody knows which is the last one when it
  //     begins. So the FIRST pass of a frame writes query 0 at its beginning,
  //     and EVERY pass writes query 1 at its end — later passes overwrite the
  //     same slot, and what survives is the end of the last pass. Two queries
  //     per frame, no per-pass bookkeeping.
  //   * `endFrame` resolves the two queries into `gpuTimeResolve` and copies
  //     them into a free slot of a small ring of MAP_READ staging buffers,
  //     inside the frame's own command buffer, then maps that slot AFTER the
  //     submit. The map is the only asynchronous part and the hot path never
  //     waits on it; when every slot is still mapping (the GPU is more than
  //     `GPU_TIME_RING` frames behind) the frame is simply not measured.
  //   * The readback completes when the GPU has finished the frame, which is
  //     1–3 frames after submit. The handler therefore describes an EARLIER
  //     frame than the one currently being encoded.
  //
  // Output-neutral: `timestampWrites` changes nothing about what a pass
  // draws, stores or resolves. Cost: two 8-byte timestamp writes per pass on
  // the GPU timeline, one 16-byte resolve + copy per frame, and one mapAsync
  // promise per frame (its `then` callbacks are bound once per slot, so the
  // promise is the frame's only allocation — the same as `onSubmittedWorkDone`).
  //
  // Not measured: queue writes (`writeTexture`/`writeBuffer` uploads run
  // before the first pass and outside the query pair) and presentation.
  private gpuTimeHandler: ((ms: number) => void) | null = null;
  private gpuTimeQueries: GPUQuerySet | null = null;
  private gpuTimeResolve: GPUBuffer | null = null;
  private readonly gpuTimeStaging: GPUBuffer[] = [];
  /** Per staging slot: true while a mapAsync is outstanding. */
  private readonly gpuTimeBusy: boolean[] = [];
  /** Per staging slot: the `then` callbacks, bound once so a frame allocates only the promise. */
  private readonly gpuTimeOnMapped: Array<() => void> = [];
  private readonly gpuTimeOnFailed: Array<() => void> = [];
  /** Whether the current frame has begun a pass (query 0 written). */
  private gpuTimeFrameStarted = false;

  /** See `RenderBackend.onGpuFrameTime`. Attach any time; silent without the feature. */
  onGpuFrameTime(handler: (ms: number) => void): void {
    this.gpuTimeHandler = handler;
  }

  /** Allocate the query set and staging ring. Called once from `initialize` when the feature is on. */
  private setupGpuTime(): void {
    try {
      this.gpuTimeQueries = this.device.createQuerySet({ type: 'timestamp', count: 2, label: 'frame-time' });
      this.gpuTimeResolve = this.device.createBuffer({
        label: 'frame-time/resolve',
        size: GPU_TIME_BYTES,
        usage: BUF.QUERY_RESOLVE | BUF.COPY_SRC,
      });
      for (let i = 0; i < GPU_TIME_RING; i++) {
        const staging = this.device.createBuffer({
          label: `frame-time/staging${i}`,
          size: GPU_TIME_BYTES,
          usage: BUF.MAP_READ | BUF.COPY_DST,
        });
        this.gpuTimeStaging.push(staging);
        this.gpuTimeBusy.push(false);
        this.gpuTimeOnMapped.push(() => this.readGpuTime(i));
        this.gpuTimeOnFailed.push(() => { this.gpuTimeBusy[i] = false; });
      }
    } catch {
      // The adapter advertised the feature and the device refused the query
      // set (SwiftShader has done this). Behave as if the feature were absent.
      this.teardownGpuTime();
      this.capabilities.timestampQueries = false;
    }
  }

  private teardownGpuTime(): void {
    try { this.gpuTimeQueries?.destroy(); } catch { /* device gone */ }
    try { this.gpuTimeResolve?.destroy(); } catch { /* device gone */ }
    for (const b of this.gpuTimeStaging) { try { b.destroy(); } catch { /* device gone */ } }
    this.gpuTimeQueries = null;
    this.gpuTimeResolve = null;
    this.gpuTimeStaging.length = 0;
    this.gpuTimeBusy.length = 0;
    this.gpuTimeOnMapped.length = 0;
    this.gpuTimeOnFailed.length = 0;
    this.gpuTimeFrameStarted = false;
  }

  /** The `timestampWrites` entry for the pass about to begin, or undefined when not measuring. */
  private gpuTimestampWrites(): Record<string, unknown> | undefined {
    if (!this.gpuTimeQueries) return undefined;
    if (this.gpuTimeFrameStarted) return { querySet: this.gpuTimeQueries, endOfPassWriteIndex: 1 };
    this.gpuTimeFrameStarted = true;
    return { querySet: this.gpuTimeQueries, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }

  /**
   * Encode the resolve + copy for this frame. Returns the staging slot to map
   * after submit, or -1 when nothing was measured (no pass this frame, no
   * handler, or every slot is still in flight).
   */
  private encodeGpuTimeReadback(encoder: GPUCommandEncoder): number {
    if (!this.gpuTimeQueries || !this.gpuTimeResolve || !this.gpuTimeHandler || !this.gpuTimeFrameStarted) return -1;
    let slot = -1;
    for (let i = 0; i < this.gpuTimeBusy.length; i++) {
      if (!this.gpuTimeBusy[i]) { slot = i; break; }
    }
    if (slot < 0) return -1;
    encoder.resolveQuerySet(this.gpuTimeQueries, 0, 2, this.gpuTimeResolve, 0);
    encoder.copyBufferToBuffer(this.gpuTimeResolve, 0, this.gpuTimeStaging[slot]!, 0, GPU_TIME_BYTES);
    return slot;
  }

  /** Map the slot the frame just submitted into; the result arrives via `readGpuTime`. */
  private mapGpuTime(slot: number): void {
    const staging = this.gpuTimeStaging[slot];
    if (!staging) return;
    this.gpuTimeBusy[slot] = true;
    try {
      staging
        .mapAsync(typeof GPUMapMode !== 'undefined' ? GPUMapMode.READ : 0x0001)
        .then(this.gpuTimeOnMapped[slot], this.gpuTimeOnFailed[slot]);
    } catch {
      this.gpuTimeBusy[slot] = false;
    }
  }

  /** mapAsync resolved: read the two u64 nanosecond stamps and free the slot. */
  private readGpuTime(slot: number): void {
    const staging = this.gpuTimeStaging[slot];
    this.gpuTimeBusy[slot] = false;
    if (!staging) return; // torn down while mapping
    try {
      const stamps = new BigUint64Array(staging.getMappedRange());
      const begin = stamps[0]!;
      const end = stamps[1]!;
      staging.unmap();
      // A quantised clock (Chromium rounds timestamps to 100 µs unless
      // --enable-webgpu-developer-features) can make end == begin: that is a
      // real 0.0 ms. end < begin never happens on a sane device — skip it.
      if (end < begin) return;
      const ms = Number(end - begin) / 1e6;
      if (Number.isFinite(ms)) this.gpuTimeHandler?.(ms);
    } catch {
      try { staging.unmap(); } catch { /* not mapped */ }
    }
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

    const hasFloat32Filterable = !!adapter.features?.has?.('float32-filterable');
    const requiredFeatures: string[] = [];
    if (hasFloat32Filterable) {
      requiredFeatures.push('float32-filterable');
    }
    // GPU frame time for the HUD. Optional in the spec; SwiftShader and some
    // mobile adapters do not offer it, and without it the frame simply is not
    // timed (see the GPU-frame-time block below).
    const hasTimestampQuery = !!adapter.features?.has?.('timestamp-query');
    if (hasTimestampQuery) {
      requiredFeatures.push('timestamp-query');
    }

    const requiredLimits: Record<string, number> = {};
    if (adapter.limits?.maxTextureDimension2D) {
      requiredLimits.maxTextureDimension2D = adapter.limits.maxTextureDimension2D;
    }

    this.device = await adapter.requestDevice({
      ...(requiredFeatures.length > 0 ? { requiredFeatures } : {}),
      ...(Object.keys(requiredLimits).length > 0 ? { requiredLimits } : {}),
    });
    this.capabilities.float32Textures = hasFloat32Filterable;
    this.capabilities.maxTextureSize = this.device.limits?.maxTextureDimension2D ?? adapter.limits?.maxTextureDimension2D ?? 8192;
    // Trust the DEVICE, not the adapter: a device may come back without a
    // feature that was asked for, and a query set created then is invalid.
    this.capabilities.timestampQueries = hasTimestampQuery && !!this.device.features?.has?.('timestamp-query');
    if (this.capabilities.timestampQueries) this.setupGpuTime();

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
    if (desc.data) this.device.queue.writeBuffer(buffer, 0, align4Write(desc.data));
    return h('buffer', buffer);
  }
  writeBuffer(buffer: BufferHandle, byteOffset: number, data: ArrayBufferView): void {
    this.device.queue.writeBuffer(buffer.native as GPUBuffer, byteOffset, align4Write(data));
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
    const maxDim = this.capabilities.maxTextureSize || 8192;
    const tw = Math.max(1, Math.min(maxDim, desc.width));
    const th = Math.max(1, Math.min(maxDim, desc.height));
    const texture = this.device.createTexture({
      label: desc.label,
      size: { width: tw, height: th },
      format: desc.format,
      mipLevelCount: desc.mipmapped ? mipCount(tw, th) : 1,
      usage,
    });
    return h('texture', texture);
  }
  writeTexture(texture: TextureHandle, source: TextureSource): void {
    const tex = texture.native as GPUTexture;
    if (source.type === 'buffer') {
      const fmt = source.format ?? (tex.format as string);
      const bpp = fmt === 'rgba32float' ? 16 : fmt === 'rgba16float' ? 8 : 4;
      const rowBytes = source.width * bpp;
      // Spec: bytesPerRow must be a multiple of 256 when copy height > 1.
      const bytesPerRow = source.height > 1 ? Math.ceil(rowBytes / 256) * 256 : rowBytes;
      let data: ArrayBufferView = source.data;
      if (bytesPerRow !== rowBytes) {
        const src = new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength);
        const packed = new Uint8Array(bytesPerRow * source.height);
        for (let y = 0; y < source.height; y++) {
          packed.set(src.subarray(y * rowBytes, y * rowBytes + rowBytes), y * bytesPerRow);
        }
        data = packed;
      }
      this.device.queue.writeTexture(
        { texture: tex },
        data,
        { bytesPerRow, rowsPerImage: source.height },
        { width: source.width, height: source.height },
      );
    } else {
      const src = source.type === 'bitmap' ? source.bitmap
        : source.type === 'video' ? source.video
        : source.type === 'videoFrame' ? source.frame
        : source.canvas;
      let width = 0;
      let height = 0;
      if (source.type === 'bitmap') {
        width = source.bitmap.width;
        height = source.bitmap.height;
      } else if (source.type === 'video') {
        width = source.video.videoWidth;
        height = source.video.videoHeight;
      } else if (source.type === 'videoFrame') {
        // Display size, as the texture was allocated. The destination's
        // default `colorSpace: 'srgb'` converts the frame's YUV exactly as a
        // 2D canvas draw would, so this matches the canvas route it replaces.
        width = source.frame.displayWidth;
        height = source.frame.displayHeight;
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
        // A depth-format view (depth24plus) may only bind where the layout says
        // so — the default `{}` means filterable float and rejects the group.
        // `unfilterable-float` pairs with WGSL `texture_2d<f32>` + textureLoad.
        else if (e.type === 'depth-texture') entry.texture = { sampleType: 'unfilterable-float' };
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
      // COPY_SRC so EXR export can read linear float RTs back to CPU.
      usage: TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING | TEX.COPY_SRC,
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
    // colour attachment's. Single-sample depth also gets TEXTURE_BINDING so a
    // later pass can read it (per-pixel DOF); MSAA depth cannot be sampled.
    let depthTexture: GPUTexture | undefined;
    let depthView: GPUTextureView | undefined;
    if (desc.depth) {
      depthTexture = this.device.createTexture({
        label: desc.label ? `${desc.label}/depth` : 'render-target-depth',
        size: { width: desc.width, height: desc.height },
        format: 'depth24plus',
        ...(sampleCount > 1 ? { sampleCount } : {}),
        usage: sampleCount > 1
          ? TEX.RENDER_ATTACHMENT
          : TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING,
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
  renderTargetDepthTexture(target: RenderTargetHandle): TextureHandle | null {
    const native = target.native as {
      depthTexture?: GPUTexture;
      sampleCount?: number;
    };
    if (!native.depthTexture || (native.sampleCount ?? 1) > 1) return null;
    return { kind: 'texture', id: target.id + 0.5, native: native.depthTexture };
  }
  destroyRenderTarget(target: RenderTargetHandle): void {
    const native = target.native as { texture: GPUTexture; msaaTexture?: GPUTexture; depthTexture?: GPUTexture };
    native.texture.destroy();
    native.msaaTexture?.destroy();
    native.depthTexture?.destroy();
  }

  beginFrame(): void {
    this.encoder = this.device.createCommandEncoder();
    this.gpuTimeFrameStarted = false;
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
    // Undefined when the frame is not being timed — the descriptor then has no
    // `timestampWrites` key at all, exactly as before.
    const timestampWrites = this.gpuTimestampWrites();
    const pass = this.encoder.beginRenderPass({
      label: desc.label,
      ...(timestampWrites ? { timestampWrites } : {}),
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
    const encoder = new WebGPUPassEncoder(pass, sampleCount, format);
    this.openPass = encoder;
    return encoder;
  }
  /** See `RenderBackend.abortOpenPass`. */
  abortOpenPass(): void {
    const open = this.openPass;
    this.openPass = null;
    if (open && !open.ended) {
      try { open.end(); } catch { /* the encoder is already invalid — nothing to close */ }
    }
  }
  endFrame(): void {
    this.openPass = null;
    if (!this.encoder) return;
    // Resolve + copy ride in the frame's own command buffer, so they are
    // ordered after the last pass without a second submit.
    const slot = this.encodeGpuTimeReadback(this.encoder);
    this.device.queue.submit([this.encoder.finish()]);
    this.encoder = null;
    this.gpuTimeFrameStarted = false;
    if (slot >= 0) this.mapGpuTime(slot);
  }
  present(): void {
    // WebGPU presents implicitly on submit.
  }

  /**
   * Sync float readback is not available on WebGPU (mapAsync is required).
   * Use {@link readRenderTargetFloatAsync} from export paths.
   */
  readRenderTargetFloat(
    _target: RenderTargetHandle,
    _width: number,
    _height: number,
  ): Float32Array | null {
    return null;
  }

  /**
   * Copy a render target to a mapped staging buffer and return linear RGBA float.
   * Supports rgba8unorm (0..1), rgba16float, and rgba32float colour targets.
   */
  async readRenderTargetFloatAsync(
    target: RenderTargetHandle,
    width: number,
    height: number,
  ): Promise<Float32Array | null> {
    const native = target.native as { texture: GPUTexture; format?: string };
    const tex = native.texture;
    const format = (native.format ?? 'rgba8unorm') as string;
    const bpp = format === 'rgba32float' ? 16 : format === 'rgba16float' ? 8 : 4;
    const unalignedRow = width * bpp;
    const bytesPerRow = Math.ceil(unalignedRow / 256) * 256;
    const size = bytesPerRow * height;
    const buffer = this.device.createBuffer({
      size,
      usage: BUF.COPY_DST | BUF.MAP_READ,
    });
    try {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: tex },
        { buffer, bytesPerRow },
        { width, height },
      );
      this.device.queue.submit([enc.finish()]);
      await buffer.mapAsync(typeof GPUMapMode !== 'undefined' ? GPUMapMode.READ : 0x0001);
      const mapped = buffer.getMappedRange();
      const out = new Float32Array(width * height * 4);
      if (format === 'rgba32float') {
        for (let y = 0; y < height; y++) {
          const row = new Float32Array(mapped, y * bytesPerRow, width * 4);
          out.set(row, y * width * 4);
        }
      } else if (format === 'rgba16float') {
        const u16 = new Uint16Array(mapped);
        for (let y = 0; y < height; y++) {
          const rowOff = (y * bytesPerRow) / 2;
          const dst = y * width * 4;
          for (let x = 0; x < width * 4; x++) {
            out[dst + x] = halfToFloat(u16[rowOff + x]!);
          }
        }
      } else {
        const src = new Uint8Array(mapped);
        for (let y = 0; y < height; y++) {
          const rowOff = y * bytesPerRow;
          const dst = y * width * 4;
          for (let x = 0; x < width; x++) {
            const s = rowOff + x * 4;
            const d = dst + x * 4;
            out[d] = src[s]! / 255;
            out[d + 1] = src[s + 1]! / 255;
            out[d + 2] = src[s + 2]! / 255;
            out[d + 3] = src[s + 3]! / 255;
          }
        }
      }
      buffer.unmap();
      return out;
    } catch {
      return null;
    } finally {
      try { buffer.destroy(); } catch { /* */ }
    }
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
    this.openPass = null;
    this.teardownGpuTime();
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
  /** Set by `end` — ending a pass twice is a validation error, not a no-op. */
  ended = false;
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
    this.ended = true;
    this.pass.end();
  }
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * A view whose byte length is a multiple of 4, as `queue.writeBuffer` demands.
 *
 * A `Uint16Array` index buffer with an ODD number of indices is 2 mod 4, and
 * WebGPU rejects the write outright — "Number of bytes to write must be a
 * multiple of 4" — which takes the whole draw with it. `createBuffer` already
 * rounds the ALLOCATION up with align4; this is the other half of that, and
 * the half that was missing: an extruded mesh whose triangle list happens to
 * end on an odd index (a bevelled ellipse does) could not upload at all.
 *
 * Copies only when it has to, so every aligned upload — which is all of them
 * but this one case — pays nothing.
 */
function align4Write(data: ArrayBufferView): ArrayBufferView {
  if (data.byteLength % 4 === 0) return data;
  const padded = new Uint8Array(align4(data.byteLength));
  padded.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return padded;
}
function mipCount(w: number, h: number): number {
  return 1 + Math.floor(Math.log2(Math.max(w, h)));
}
