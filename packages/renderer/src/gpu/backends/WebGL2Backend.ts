/**
 * WebGL2 backend (fallback). Implements the backend contract on WebGL2 for
 * environments without WebGPU. Uses uniform-buffer objects (std140) so it shares
 * the exact uniform layout with the WebGPU path; geometry is the shared unit
 * quad. Native GL objects ride on `handle.native`.
 *
 * Not exercised by the headless test suite (needs a GL context); it compiles
 * against the DOM WebGL2 types and implements the core draw path.
 */

import type { RenderBackend, RenderPassEncoder, RenderSurface } from '../RenderBackend';
import type {
  BackendCapabilities,
  BindGroupDescriptor,
  BindGroupHandle,
  BindGroupResource,
  BlendMode,
  BufferDescriptor,
  BufferHandle,
  PipelineDescriptor,
  PipelineHandle,
  PrimitiveTopology,
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
  VertexBufferLayout,
  IndexFormat,
} from '../types';
import { nextId } from '../../utils/ids';

type GL = WebGL2RenderingContext;

interface NativeBuffer {
  buffer: WebGLBuffer;
  target: number;
}
interface NativeProgram {
  program: WebGLProgram;
}
interface NativePipeline {
  program: WebGLProgram;
  blend: BlendMode;
  topology: PrimitiveTopology;
  layout: VertexBufferLayout[];
  /** Depth-tested pipeline (3D layer path); applied at bind time. */
  depthTest: boolean;
  depthWrite: boolean;
  texUniform: WebGLUniformLocation | null;
  /** Secondary sampler (uMaskTex / uMapTex / uLutTex) for two-texture shaders —
   *  masks, displacement map, colour LUT. Previously never resolved or set, so
   *  every second sampler silently read texture unit 0. */
  tex1Uniform: WebGLUniformLocation | null;
}
interface NativeRenderTarget {
  /** Single-sample FBO wrapping `texture` — what everything SAMPLES from. */
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  /** Depth renderbuffer, present when the target was created with depth. */
  depth?: WebGLRenderbuffer;
  /**
   * Multisample FBO that draws actually go into, when MSAA is active. Resolved
   * into `fbo` by a blit at pass end, so readers keep seeing a plain texture.
   */
  msaaFbo?: WebGLFramebuffer;
  msaaColor?: WebGLRenderbuffer;
  width: number;
  height: number;
}

function h<K extends string>(kind: K, native: unknown): ResourceHandle<K> {
  return { kind, id: nextId(), native };
}

function topo(gl: GL, t: PrimitiveTopology): number {
  switch (t) {
    case 'triangle-list':
      return gl.TRIANGLES;
    case 'triangle-strip':
      return gl.TRIANGLE_STRIP;
    case 'line-list':
      return gl.LINES;
    case 'point-list':
      return gl.POINTS;
  }
}

export class WebGL2Backend implements RenderBackend {
  readonly kind = 'webgl2' as const;
  /** GL FBOs are written bottom-up: full-screen samples of a target flip V. */
  readonly renderTargetFlipV = true;
  capabilities: BackendCapabilities = {
    kind: 'webgl2',
    maxTextureSize: 4096,
    instancing: true,
    storageBuffers: false,
    float16Textures: true,
    timestampQueries: false,
  };

  private gl!: GL;
  private vao: WebGLVertexArrayObject | null = null;

  // Every GL object this backend allocates, so dispose can release them all
  // and then explicitly lose the context. Without this, each editor
  // enter/leave leaked a live WebGL2 context (only the VAO was deleted) until
  // Chrome's per-page context cap made getContext('webgl2') return null —
  // the intermittent blank-canvas-on-reentry bug.
  private readonly liveBuffers = new Set<WebGLBuffer>();
  private readonly liveTextures = new Set<WebGLTexture>();
  private readonly liveSamplers = new Set<WebGLSampler>();
  private readonly livePrograms = new Set<WebGLProgram>();
  private readonly liveFramebuffers = new Set<WebGLFramebuffer>();
  /** Depth renderbuffers (3D render targets) — tracked like every other GL
   *  object so dispose stays leak-free. */
  private readonly liveRenderbuffers = new Set<WebGLRenderbuffer>();

  // Context-loss plumbing (see initialize).
  private contextLost = false;
  private boundCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private onContextLost: ((event: Event) => void) | null = null;
  private onContextRestored: (() => void) | null = null;
  private readonly lossListeners = new Set<() => void>();
  private readonly restoreListeners = new Set<() => void>();

  async initialize(surface?: RenderSurface): Promise<void> {
    if (!surface) throw new Error('WebGL2Backend requires a canvas surface');
    const canvas = surface.canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true }) as GL | null;
    if (!gl) throw new Error('WebGL2 is not available');
    // A canvas whose context was killed with WEBGL_lose_context (which dispose
    // below does, deliberately, to free a context slot) hands back that SAME lost
    // context object on the next getContext — not null. So the guard above passes,
    // every subsequent GL call silently no-ops, getParameter returns null, and the
    // caller "succeeds" onto a permanently dead canvas. That is the blank-viewport
    // -after-remount bug (React StrictMode and Vite HMR both remount without
    // replacing the canvas DOM node). Ask for a restore, then refuse if still lost.
    if (gl.isContextLost()) {
      gl.getExtension('WEBGL_lose_context')?.restoreContext();
      if (gl.isContextLost()) {
        throw new Error('WebGL2 context is lost and could not be restored (canvas already used)');
      }
    }
    this.gl = gl;

    // Context loss is silent otherwise: GL calls become no-ops while the renderer
    // happily reports ready, so the user sees a frozen viewport and no error.
    // preventDefault is REQUIRED — without it the context can never be restored.
    this.onContextLost = (event: Event): void => {
      event.preventDefault();
      this.contextLost = true;
      this.lossListeners.forEach((fn) => fn());
    };
    this.onContextRestored = (): void => {
      this.contextLost = false;
      this.restoreListeners.forEach((fn) => fn());
    };
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    // OffscreenCanvas is an EventTarget too, so the listeners above are valid for
    // both; only the stored reference needs the wider type.
    this.boundCanvas = canvas;

    this.capabilities.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.vao = gl.createVertexArray();
    gl.enable(gl.BLEND);
  }

  /** True while the GL context is lost — draws are no-ops until restore. */
  isLost(): boolean {
    return this.contextLost || (!!this.gl && this.gl.isContextLost());
  }

  /** Subscribe to context loss / restore. Returns an unsubscribe function. */
  onContextChange(onLost: () => void, onRestored: () => void): () => void {
    this.lossListeners.add(onLost);
    this.restoreListeners.add(onRestored);
    return () => {
      this.lossListeners.delete(onLost);
      this.restoreListeners.delete(onRestored);
    };
  }

  createBuffer(desc: BufferDescriptor): BufferHandle {
    const gl = this.gl;
    const buffer = gl.createBuffer()!;
    const target = desc.usage.includes('index')
      ? gl.ELEMENT_ARRAY_BUFFER
      : desc.usage.includes('uniform')
        ? gl.UNIFORM_BUFFER
        : gl.ARRAY_BUFFER;
    gl.bindBuffer(target, buffer);
    if (desc.data) gl.bufferData(target, desc.data as unknown as BufferSource, gl.DYNAMIC_DRAW);
    else gl.bufferData(target, desc.sizeBytes, gl.DYNAMIC_DRAW);
    this.liveBuffers.add(buffer);
    return h('buffer', { buffer, target } satisfies NativeBuffer);
  }
  writeBuffer(buffer: BufferHandle, byteOffset: number, data: ArrayBufferView): void {
    const gl = this.gl;
    const nb = buffer.native as NativeBuffer;
    gl.bindBuffer(nb.target, nb.buffer);
    gl.bufferSubData(nb.target, byteOffset, data as unknown as BufferSource);
  }
  destroyBuffer(buffer: BufferHandle): void {
    const b = (buffer.native as NativeBuffer).buffer;
    this.liveBuffers.delete(b);
    this.gl.deleteBuffer(b);
  }

  createTexture(desc: TextureDescriptor): TextureHandle {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, desc.width, desc.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.liveTextures.add(texture);
    return h('texture', texture);
  }
  writeTexture(texture: TextureHandle, source: TextureSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture.native as WebGLTexture);
    if (source.type === 'buffer') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data as unknown as ArrayBufferView);
    } else {
      const src = source.type === 'bitmap' ? source.bitmap : source.type === 'video' ? source.video : source.canvas;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    }
  }
  destroyTexture(texture: TextureHandle): void {
    const t = texture.native as WebGLTexture;
    this.liveTextures.delete(t);
    this.gl.deleteTexture(t);
  }

  createSampler(desc: SamplerDescriptor): SamplerHandle {
    const gl = this.gl;
    const sampler = gl.createSampler()!;
    const filter = (f?: 'nearest' | 'linear') => (f === 'nearest' ? gl.NEAREST : gl.LINEAR);
    const wrap = (a?: 'clamp' | 'repeat' | 'mirror') =>
      a === 'repeat' ? gl.REPEAT : a === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter(desc.min));
    gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter(desc.mag));
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, wrap(desc.addressU));
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, wrap(desc.addressV));
    this.liveSamplers.add(sampler);
    return h('sampler', sampler);
  }
  destroySampler(sampler: SamplerHandle): void {
    const s = sampler.native as WebGLSampler;
    this.liveSamplers.delete(s);
    this.gl.deleteSampler(s);
  }

  createShaderModule(desc: ShaderModuleDescriptor): ShaderModuleHandle {
    if (!desc.glsl) throw new Error('WebGL2 requires GLSL source');
    const gl = this.gl;
    const program = link(gl, compile(gl, gl.VERTEX_SHADER, desc.glsl.vertex), compile(gl, gl.FRAGMENT_SHADER, desc.glsl.fragment));
    const blockIndex = gl.getUniformBlockIndex(program, 'Object');
    if (blockIndex !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, blockIndex, 0);
    this.livePrograms.add(program);
    return h('shader', { program } satisfies NativeProgram);
  }
  destroyShaderModule(shader: ShaderModuleHandle): void {
    const p = (shader.native as NativeProgram).program;
    this.livePrograms.delete(p);
    this.gl.deleteProgram(p);
  }

  createPipeline(desc: PipelineDescriptor): PipelineHandle {
    const gl = this.gl;
    const program = (desc.shader.native as NativeProgram).program;
    const texUniform = gl.getUniformLocation(program, 'uTex');
    // The secondary sampler, whatever a two-texture shader calls it. A shader
    // declares at most one, so first match wins.
    const tex1Uniform =
      gl.getUniformLocation(program, 'uMaskTex') ??
      gl.getUniformLocation(program, 'uMapTex') ??
      gl.getUniformLocation(program, 'uLutTex') ??
      gl.getUniformLocation(program, 'uMatteTex');
    return h('pipeline', {
      program,
      blend: desc.blend,
      topology: desc.topology,
      layout: desc.buffers,
      depthTest: desc.depthTest === true,
      depthWrite: desc.depthWrite ?? desc.depthTest === true,
      texUniform,
      tex1Uniform,
    } satisfies NativePipeline);
  }
  destroyPipeline(_pipeline: PipelineHandle): void {}

  createBindGroup(desc: BindGroupDescriptor): BindGroupHandle {
    // WebGL binds at draw time; the group just captures the resolved entries.
    return h('bindgroup', { entries: desc.entries });
  }
  destroyBindGroup(_group: BindGroupHandle): void {}

  createRenderTarget(desc: RenderTargetDescriptor): RenderTargetHandle {
    const gl = this.gl;
    // Clamp to what the device actually supports; 1 disables MSAA entirely.
    const wanted = Math.max(1, Math.floor(desc.samples ?? 1));
    const samples = wanted > 1
      ? Math.min(wanted, (gl.getParameter(gl.MAX_SAMPLES) as number) || 1)
      : 1;
    const msaa = samples > 1;

    // The resolve side: a plain texture + FBO. Always built, so
    // renderTargetTexture has something single-sampled to hand out whether or
    // not multisampling is in play.
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, desc.width, desc.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    let depth: WebGLRenderbuffer | undefined;
    let msaaFbo: WebGLFramebuffer | undefined;
    let msaaColor: WebGLRenderbuffer | undefined;

    if (msaa) {
      // Draws go into multisample renderbuffers. Depth must be multisampled too
      // — mixing sample counts across attachments is an incomplete framebuffer.
      msaaFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo);
      msaaColor = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, msaaColor);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, desc.width, desc.height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msaaColor);
      if (desc.depth) {
        depth = gl.createRenderbuffer()!;
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, desc.width, desc.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        this.liveRenderbuffers.add(depth);
      }
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      // Fall back to the plain path if the driver refuses this combination,
      // rather than rendering into an incomplete framebuffer.
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(msaaFbo);
        gl.deleteRenderbuffer(msaaColor);
        if (depth) {
          this.liveRenderbuffers.delete(depth);
          gl.deleteRenderbuffer(depth);
          depth = undefined;
        }
        msaaFbo = undefined;
        msaaColor = undefined;
      } else {
        this.liveRenderbuffers.add(msaaColor);
        this.liveFramebuffers.add(msaaFbo);
      }
    }

    if (!msaaFbo && desc.depth) {
      // Single-sample depth, attached to the resolve FBO that draws will use.
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      depth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, desc.width, desc.height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      this.liveRenderbuffers.add(depth);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.liveTextures.add(texture);
    this.liveFramebuffers.add(fbo);
    return {
      kind: 'render-target',
      id: nextId(),
      native: {
        fbo, texture, depth, msaaFbo, msaaColor,
        width: desc.width, height: desc.height,
      } satisfies NativeRenderTarget,
    };
  }
  renderTargetTexture(target: RenderTargetHandle): TextureHandle {
    return { kind: 'texture', id: target.id, native: (target.native as NativeRenderTarget).texture };
  }
  destroyRenderTarget(target: RenderTargetHandle): void {
    const rt = target.native as NativeRenderTarget;
    this.liveFramebuffers.delete(rt.fbo);
    this.liveTextures.delete(rt.texture);
    this.gl.deleteFramebuffer(rt.fbo);
    this.gl.deleteTexture(rt.texture);
    if (rt.depth) {
      this.liveRenderbuffers.delete(rt.depth);
      this.gl.deleteRenderbuffer(rt.depth);
    }
    if (rt.msaaFbo) {
      this.liveFramebuffers.delete(rt.msaaFbo);
      this.gl.deleteFramebuffer(rt.msaaFbo);
    }
    if (rt.msaaColor) {
      this.liveRenderbuffers.delete(rt.msaaColor);
      this.gl.deleteRenderbuffer(rt.msaaColor);
    }
  }

  /** Surface clip rect (surface px, top-left origin), or null. */
  private frameClip: { x: number; y: number; width: number; height: number } | null = null;

  setFrameClip(rect: { x: number; y: number; width: number; height: number } | null): void {
    this.frameClip = rect;
  }

  beginFrame(): void {}
  beginRenderPass(desc: RenderPassDescriptor): RenderPassEncoder {
    const gl = this.gl;
    const attach = desc.color;
    // Surface-ness is decided by the ACTUAL framebuffer bound, not just the
    // 'surface' string sentinel: a target handle whose native fbo is missing
    // binds the DEFAULT framebuffer (GL coerces null/undefined), so its draws
    // land on the canvas and must be frame-clipped like any surface pass.
    const native = attach.target === 'surface'
      ? undefined
      : (attach.target.native as NativeRenderTarget | undefined);
    // Draw into the MULTISAMPLE fbo when the target has one; `end` resolves it
    // down into the sampleable texture. `toSurface` still keys off the resolve
    // fbo being absent, so frame-clipping behaviour is unchanged.
    const drawFbo = native?.msaaFbo ?? native?.fbo ?? null;
    const fbo = native?.fbo ?? null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, drawFbo);
    const toSurface = fbo === null;
    gl.bindVertexArray(this.vao);
    // Depth state is per-pipeline (applied at bind time); start every pass with
    // it off and writes enabled so clears work and 2D passes are unaffected.
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);
    // Clears are always full-canvas (the pasteboard outside the comp keeps the
    // clear colour); only DRAWS are scissored, and only on the surface.
    gl.disable(gl.SCISSOR_TEST);
    let clearBits = 0;
    if (attach.clear) {
      gl.clearColor(attach.clear.r, attach.clear.g, attach.clear.b, attach.clear.a);
      clearBits |= gl.COLOR_BUFFER_BIT;
    }
    if (desc.depth) {
      gl.clearDepth(desc.depth.clearDepth ?? 1);
      clearBits |= gl.DEPTH_BUFFER_BIT;
    }
    if (clearBits) gl.clear(clearBits);
    const clip = toSurface ? this.frameClip : null;
    if (clip) {
      // gl.scissor is bottom-left origin; the contract is top-left.
      const h = gl.drawingBufferHeight;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(
        Math.max(0, Math.round(clip.x)),
        Math.max(0, Math.round(h - clip.y - clip.height)),
        Math.max(0, Math.round(clip.width)),
        Math.max(0, Math.round(clip.height)),
      );
    }
    return new WebGL2PassEncoder(gl, native?.msaaFbo ? native : undefined);
  }
  endFrame(): void {
    this.gl.bindVertexArray(null);
  }
  present(): void {}
  resize(width: number, height: number, devicePixelRatio = 1): void {
    // width/height arrive in CSS px (Renderer.resize contract); the canvas
    // backing store is CSS×dpr. The GL viewport is in PHYSICAL pixels — using
    // CSS px here drew everything at 1/dpr scale in a corner of the surface on
    // scaled displays (Windows 125%/150%), which Canvas2D never did.
    this.gl.viewport(
      0,
      0,
      Math.max(1, Math.round(width * devicePixelRatio)),
      Math.max(1, Math.round(height * devicePixelRatio)),
    );
  }
  dispose(): void {
    // Detach the loss listeners before anything else: dispose deliberately
    // loses the context below, which fires 'webglcontextlost' on the canvas, and
    // a still-attached handler would report that self-inflicted loss to whatever
    // is subscribed. Runs even if we never got a context.
    if (this.boundCanvas) {
      if (this.onContextLost) this.boundCanvas.removeEventListener('webglcontextlost', this.onContextLost);
      if (this.onContextRestored) this.boundCanvas.removeEventListener('webglcontextrestored', this.onContextRestored);
      this.boundCanvas = null;
      this.onContextLost = null;
      this.onContextRestored = null;
    }
    this.lossListeners.clear();
    this.restoreListeners.clear();

    // May be called before initialize succeeded (getContext returned null),
    // or twice (Renderer.dispose is idempotent but defensive callers exist).
    const gl = this.gl as GL | undefined;
    if (!gl) return;
    for (const fbo of this.liveFramebuffers) gl.deleteFramebuffer(fbo);
    for (const tex of this.liveTextures) gl.deleteTexture(tex);
    for (const rb of this.liveRenderbuffers) gl.deleteRenderbuffer(rb);
    for (const buf of this.liveBuffers) gl.deleteBuffer(buf);
    for (const s of this.liveSamplers) gl.deleteSampler(s);
    for (const p of this.livePrograms) gl.deleteProgram(p);
    this.liveFramebuffers.clear();
    this.liveTextures.clear();
    this.liveRenderbuffers.clear();
    this.liveBuffers.clear();
    this.liveSamplers.clear();
    this.livePrograms.clear();
    if (this.vao) {
      gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Release the context itself. Browsers cap live WebGL contexts per page
    // (~16 in Chromium); relying on GC to reclaim them made re-entry blank
    // once the cap was hit. Explicit loseContext frees the slot immediately.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = undefined as unknown as GL;
  }
}

class WebGL2PassEncoder implements RenderPassEncoder {
  private pipeline: NativePipeline | null = null;
  private vertexBuffer: NativeBuffer | null = null;
  private indexFormat: IndexFormat = 'uint32';

  /** `msaaTarget` is set only for a multisample pass — see end. */
  constructor(
    private readonly gl: GL,
    private readonly msaaTarget?: NativeRenderTarget,
  ) {}

  setPipeline(pipeline: PipelineHandle): void {
    this.pipeline = pipeline.native as NativePipeline;
    this.gl.useProgram(this.pipeline.program);
    applyBlend(this.gl, this.pipeline.blend);
    // Depth state rides the pipeline (mirrors WebGPU, where it is baked in).
    if (this.pipeline.depthTest) {
      this.gl.enable(this.gl.DEPTH_TEST);
      this.gl.depthFunc(this.gl.LEQUAL);
      this.gl.depthMask(this.pipeline.depthWrite);
    } else {
      this.gl.disable(this.gl.DEPTH_TEST);
      this.gl.depthMask(true);
    }
  }
  setBindGroup(_index: number, group: BindGroupHandle): void {
    const gl = this.gl;
    // Each texture entry gets its OWN unit and its OWN sampler uniform, in the
    // order the entries appear (primary = uTex@0, secondary = uMaskTex/uMapTex/
    // uLutTex@1). The old code set the single `uTex` uniform for every texture,
    // so a second texture bound to unit 1 while `uTex` pointed at unit 1 too —
    // the primary silently read the secondary, and the secondary uniform was
    // never assigned. That is why masks / displacement never sampled right.
    let texIndex = 0;
    let sampler: WebGLSampler | null = null;
    for (const e of (group.native as { entries: BindGroupResource[] }).entries) {
      if ('buffer' in e) {
        const nb = e.buffer.native as NativeBuffer;
        if (e.offsetBytes || e.sizeBytes) gl.bindBufferRange(gl.UNIFORM_BUFFER, e.binding === 0 ? 0 : e.binding, nb.buffer, e.offsetBytes ?? 0, e.sizeBytes ?? 0);
        else gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, nb.buffer);
      } else if ('texture' in e) {
        gl.activeTexture(gl.TEXTURE0 + texIndex);
        gl.bindTexture(gl.TEXTURE_2D, e.texture.native as WebGLTexture);
        const uni = texIndex === 0 ? this.pipeline?.texUniform : this.pipeline?.tex1Uniform;
        if (uni) gl.uniform1i(uni, texIndex);
        texIndex += 1;
      } else {
        sampler = e.sampler.native as WebGLSampler;
      }
    }
    // Bind the sampler to EVERY texture unit used. Our textures are uploaded
    // without mipmaps and never get texParameteri, so their default
    // NEAREST_MIPMAP_LINEAR min filter makes them INCOMPLETE — a unit without
    // a sampler object samples (0,0,0,1). The old code bound the sampler only
    // to the unit before it in entry order (unit 0), which left every
    // SECONDARY texture (mask/matte/LUT/displacement map) incomplete: alpha
    // read as 1, so masks silently did nothing on the GL backend.
    if (sampler) {
      for (let u = 0; u < Math.max(1, texIndex); u++) gl.bindSampler(u, sampler);
    }
  }
  setVertexBuffer(_slot: number, buffer: BufferHandle): void {
    this.vertexBuffer = buffer.native as NativeBuffer;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer.buffer);
    if (this.pipeline) configureAttribs(gl, this.pipeline.layout);
  }
  setIndexBuffer(buffer: BufferHandle, format: IndexFormat): void {
    const nb = buffer.native as NativeBuffer;
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, nb.buffer);
    this.indexFormat = format;
  }
  setViewport(x: number, y: number, width: number, height: number): void {
    this.gl.viewport(x, y, width, height);
  }
  setScissor(x: number, y: number, width: number, height: number): void {
    this.gl.scissor(x, y, width, height);
  }
  draw(vertexCount: number, instanceCount = 1): void {
    const mode = this.pipeline ? topo(this.gl, this.pipeline.topology) : this.gl.TRIANGLES;
    if (instanceCount > 1) this.gl.drawArraysInstanced(mode, 0, vertexCount, instanceCount);
    else this.gl.drawArrays(mode, 0, vertexCount);
  }
  drawIndexed(indexCount: number, instanceCount = 1): void {
    const gl = this.gl;
    const mode = this.pipeline ? topo(gl, this.pipeline.topology) : gl.TRIANGLES;
    const type = this.indexFormat === 'uint16' ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    if (instanceCount > 1) gl.drawElementsInstanced(mode, indexCount, type, 0, instanceCount);
    else gl.drawElements(mode, indexCount, type, 0);
  }
  end(): void {
    // Resolve multisample → single-sample so readers can sample the texture.
    // Nothing downstream knows MSAA happened; without this blit the resolve
    // texture would simply be empty.
    const t = this.msaaTarget;
    if (!t?.msaaFbo) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msaaFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fbo);
    // Colour only: the depth buffer is per-pass scratch and nothing samples it.
    gl.blitFramebuffer(
      0, 0, t.width, t.height,
      0, 0, t.width, t.height,
      gl.COLOR_BUFFER_BIT, gl.NEAREST,
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
}

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

function link(gl: GL, vertex: WebGLShader, fragment: WebGLShader): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${log}`);
  }
  return program;
}

function configureAttribs(gl: GL, layouts: VertexBufferLayout[]): void {
  for (const layout of layouts) {
    for (const attr of layout.attributes) {
      const size = attr.format === 'float32' ? 1 : attr.format === 'float32x2' ? 2 : attr.format === 'float32x3' ? 3 : 4;
      gl.enableVertexAttribArray(attr.shaderLocation);
      gl.vertexAttribPointer(attr.shaderLocation, size, gl.FLOAT, false, layout.strideBytes, attr.offsetBytes);
    }
  }
}

function applyBlend(gl: GL, blend: BlendMode): void {
  if (blend === 'none') {
    gl.disable(gl.BLEND);
    return;
  }
  gl.enable(gl.BLEND);
  
  // Default blend equation
  gl.blendEquation(gl.FUNC_ADD);

  switch (blend) {
    case 'add':
      gl.blendFunc(gl.ONE, gl.ONE);
      break;
    case 'multiply':
      gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      break;
    case 'screen':
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      break;
    case 'subtract':
      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
      gl.blendFunc(gl.ONE, gl.ONE);
      break;
    case 'darken':
      gl.blendEquation(gl.MIN);
      gl.blendFunc(gl.ONE, gl.ONE);
      break;
    case 'lighten':
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      break;
    default:
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied over
  }
}
