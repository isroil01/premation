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
  TextureFormat,
  TextureHandle,
  TextureSource,
  VertexBufferLayout,
  IndexFormat,
} from '../types';
import { ENV_SAMPLER_BINDING, ENV_TEXTURE_BINDING } from '../types';
import { sourcePassesThrough } from '../types';
import { nextId } from '../../utils/ids';

type GL = WebGL2RenderingContext;

interface NativeBuffer {
  buffer: WebGLBuffer;
  target: number;
}
interface NativeTexture {
  texture: WebGLTexture;
  format: TextureFormat;
}
/** A linked GLSL program, as carried on a `ShaderModuleHandle`'s `native`.
 *  Distinct from {@link NativePipeline}, which pairs one with its draw state. */
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
  /**
   * Sampler uniforms in TEXTURE-entry order, for a material that DECLARED them
   * (`MaterialDescriptor.glslSamplers`). Non-empty only for shaders with more
   * than two textures — the mesh PBR path — because two is as far as the
   * name-guessing above can reach. When set it supersedes both fields above.
   */
  texUniforms: (WebGLUniformLocation | null)[];
}
interface NativeRenderTarget {
  /** Single-sample FBO wrapping `texture` — what everything SAMPLES from. */
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  /** Colour format of this target, so a pass can tell its pipelines what it is. */
  format: TextureFormat;
  /** Depth renderbuffer — used for MSAA depth (not sampleable). */
  depth?: WebGLRenderbuffer;
  /**
   * Single-sample depth TEXTURE when the target has depth and no MSAA.
   * Sampleable via `renderTargetDepthTexture`. Mutually exclusive with `depth`
   * as a renderbuffer on the resolve FBO.
   */
  depthTex?: WebGLTexture;
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

function glTexture(native: unknown): WebGLTexture {
  if (native && typeof native === 'object' && 'texture' in native) {
    return (native as NativeTexture).texture;
  }
  return native as WebGLTexture;
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
  /** Lazy sRGB→linear byte LUT shared by every instance (readRenderTargetFloat fallback). */
  private static srgbToLinearLut: Float32Array | null = null;
  readonly kind = 'webgl2' as const;
  /** GL FBOs are written bottom-up: full-screen samples of a target flip V. */
  readonly renderTargetFlipV = true;
  /**
   * Declared PESSIMISTICALLY; `initialize()` replaces each entry with what the
   * context actually reports.
   *
   * `float16Textures` was declared `true` here and only corrected in
   * `initialize()` — which reads as harmless and is not. Anything that asks a
   * constructed-but-uninitialised backend what it supports gets a yes, and the
   * caller takes the float branch on a context that may have no
   * `EXT_color_buffer_float` at all. The failure that produces is an incomplete
   * framebuffer, not an error message.
   *
   * The rule for this object is therefore: a capability starts at the value
   * that is safe to be wrong about. `false` for a feature (worst case: a
   * cheaper path is taken until the probe lands), and a conservative floor for
   * a limit — 4096 is the WebGL2 spec minimum, so a texture that fits it fits
   * every implementation.
   */
  capabilities: BackendCapabilities = {
    kind: 'webgl2',
    maxTextureSize: 4096,
    instancing: true,
    storageBuffers: false,
    float16Textures: false,
    float32Textures: false,
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

    // Float render targets (the rgba16float compositing intermediates) need this
    // extension to be colour-renderable AND multisample-renderable on WebGL2.
    // Half-float LINEAR filtering is already core in WebGL2, so no separate
    // texture-filter extension is required. Reflect the REAL capability: when it
    // is absent, resolveTargets falls the intermediates back to 8-bit rather than
    // creating an incomplete framebuffer.
    //
    // 32-bit float textures (RGBA32F) require OES_texture_float_linear to be
    // sampled with LINEAR filtering. Without it, sampling RGBA32F with a linear
    // sampler marks the texture incomplete and returns transparent black (0,0,0,0).
    const floatColor = !!gl.getExtension('EXT_color_buffer_float');
    const floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.capabilities.float16Textures = floatColor;
    this.capabilities.float32Textures = floatColor && floatLinear;
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
    /*
      Honour `desc.format`.

      This allocated RGBA8 unconditionally and ignored the field entirely, while
      `createRenderTarget` below reads it properly. So the two halves of one
      backend disagreed about what a format request means: ask for
      `rgba16float` and you got a float RENDER TARGET and an 8-bit TEXTURE,
      silently, depending only on which function the caller happened to reach.

      That is a divergence generator rather than a bug with one symptom, which
      is why it is worth fixing BEFORE any GPU effect porting. A ported effect
      allocating a float intermediate through `createTexture` would work on
      WebGPU, quantise to 8 bits here, and present as "that effect bands on
      WebGL2" — a fresh mystery per effect, instead of one wrong line.

      Formats beyond these two keep the RGBA8 they already got: `r8unorm` and
      `bgra8unorm` have no `createTexture` caller today, and inventing untested
      mappings would be a guess. `depth24plus` is a render-target concern and
      never arrives here.

      Gated on the CAPABILITY as well as the request, exactly as
      `createRenderTarget` is — without `EXT_color_buffer_float` a half-float
      texture is not renderable, and silently producing an incomplete
      framebuffer is worse than the 8-bit fallback.
    */
    const float16 = desc.format === 'rgba16float' && this.capabilities.float16Textures;
    const float32 = desc.format === 'rgba32float' && this.capabilities.float32Textures;
    const srgb = desc.format === 'rgba8unorm-srgb';
    const internalFormat = float32 ? gl.RGBA32F : float16 ? gl.RGBA16F : srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
    const texType = float32 ? gl.FLOAT : float16 ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, desc.width, desc.height, 0, gl.RGBA, texType, null);
    this.liveTextures.add(texture);
    return h('texture', { texture, format: desc.format } satisfies NativeTexture);
  }
  writeTexture(texture: TextureHandle, source: TextureSource): void {
    const gl = this.gl;
    const native = texture.native as NativeTexture;
    gl.bindTexture(gl.TEXTURE_2D, native.texture);
    if (source.type === 'buffer') {
      // Raw bytes are handed to us already in the invariant's space — there is
      // no decode step to reinterpret, so the unpack flags do not apply.
      const fmt = source.format ?? native.format;
      const float32 = fmt === 'rgba32float' && this.capabilities.float32Textures;
      const float16 = fmt === 'rgba16float' && this.capabilities.float16Textures;
      const internalFormat = float32 ? gl.RGBA32F : float16 ? gl.RGBA16F : gl.RGBA8;
      const texType = float32 ? gl.FLOAT : float16 ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, float32 || float16 ? 1 : 4);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, internalFormat,
        source.width, source.height, 0,
        gl.RGBA, texType,
        source.data as unknown as ArrayBufferView,
      );
    } else {
      // THE ALPHA INVARIANT (see TextureSource in ../types.ts): premultiplied
      // alpha, every source kind, both backends.
      //
      // This flag means "the DESTINATION shall be premultiplied" — the browser
      // converts from whatever the source declares itself to be. It does NOT mean
      // "multiply the source", which is how it was first read here, and reading it
      // that way un-premultiplied every canvas raster and left the shader dividing
      // a straight texture (50% fill opacity rendered at 97.3% of full).
      //
      // Note it is ignored entirely for ImageBitmap sources — a bitmap carries its
      // premultiply state from creation and this cannot override it. That is why
      // footage is converted at DECODE; see `decodeOptions` in AppTextureProvider.
      //
      // Set explicitly rather than left to the default: the default is false
      // today, and a future flip would silently change the alpha space on this
      // backend with no code change to blame.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !sourcePassesThrough(source));
      const src = source.type === 'bitmap' ? source.bitmap : source.type === 'video' ? source.video : source.canvas;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    }
  }
  destroyTexture(texture: TextureHandle): void {
    const t = (texture.native as NativeTexture).texture;
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
      texUniforms: (desc.samplerNames ?? []).map((n) => gl.getUniformLocation(program, n)),
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
    // In WebGL2, only 8-bit and 16-bit float renderbuffers support multisampling.
    // RGBA32F is not multisample-renderable.
    const canMsaa = desc.format !== 'rgba32float';
    const samples = (wanted > 1 && canMsaa)
      ? Math.min(wanted, (gl.getParameter(gl.MAX_SAMPLES) as number) || 1)
      : 1;
    const msaa = samples > 1;

    // The resolve side: a plain texture + FBO. Always built, so
    // renderTargetTexture has something single-sampled to hand out whether or
    // not multisampling is in play.
    // Honour the requested colour format. rgba16float only reaches here when the
    // backend advertised float support (EXT_color_buffer_float); every other
    // format is the 8-bit path exactly as before.
    const float32 = desc.format === 'rgba32float' && this.capabilities.float32Textures;
    const float16 = desc.format === 'rgba16float' && this.capabilities.float16Textures;
    const internalFormat = float32 ? gl.RGBA32F : float16 ? gl.RGBA16F : gl.RGBA8;
    const texType = float32 ? gl.FLOAT : float16 ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, desc.width, desc.height, 0, gl.RGBA, texType, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    let depth: WebGLRenderbuffer | undefined;
    let depthTex: WebGLTexture | undefined;
    let msaaFbo: WebGLFramebuffer | undefined;
    let msaaColor: WebGLRenderbuffer | undefined;

    if (msaa) {
      // Draws go into multisample renderbuffers. Depth must be multisampled too
      // — mixing sample counts across attachments is an incomplete framebuffer.
      msaaFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo);
      msaaColor = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, msaaColor);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, internalFormat, desc.width, desc.height);
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
      // Single-sample SAMPLEABLE depth texture on the resolve FBO.
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      depthTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, depthTex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24,
        desc.width, desc.height, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.liveTextures.add(depthTex);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.liveTextures.add(texture);
    this.liveFramebuffers.add(fbo);
    return {
      kind: 'render-target',
      id: nextId(),
      native: {
        fbo, texture, depth, depthTex, msaaFbo, msaaColor,
        width: desc.width, height: desc.height,
        format: desc.format,
      } satisfies NativeRenderTarget,
    };
  }
  renderTargetTexture(target: RenderTargetHandle): TextureHandle {
    return { kind: 'texture', id: target.id, native: (target.native as NativeRenderTarget).texture };
  }
  renderTargetDepthTexture(target: RenderTargetHandle): TextureHandle | null {
    const rt = target.native as NativeRenderTarget;
    if (!rt.depthTex) return null;
    return { kind: 'texture', id: target.id + 0.5, native: rt.depthTex };
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
    if (rt.depthTex) {
      this.liveTextures.delete(rt.depthTex);
      this.gl.deleteTexture(rt.depthTex);
      rt.depthTex = undefined;
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
    // Tell the encoder the target's colour format so QuadRenderer builds
    // matching pipelines. WebGL2 doesn't validate pipeline format, but keeping
    // it correct means the shared pipeline cache key is right across backends.
    const format: TextureFormat = native?.format ?? 'rgba8unorm';
    return new WebGL2PassEncoder(gl, native?.msaaFbo ? native : undefined, format);
  }
  endFrame(): void {
    this.gl.bindVertexArray(null);
  }
  present(): void {}
  readRenderTargetFloat(target: RenderTargetHandle, width: number, height: number): Float32Array | null {
    const gl = this.gl;
    const rt = target.native as NativeRenderTarget;
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    const float = rt.format === 'rgba16float' || rt.format === 'rgba32float';
    if (float && this.capabilities.float16Textures) {
      const data = new Float32Array(width * height * 4);
      try {
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
        const out = new Float32Array(data.length);
        const row = width * 4;
        for (let y = 0; y < height; y++) {
          out.set(data.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
        return out;
      } catch {
        gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
        return null;
      }
    }
    const u8 = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    // The contract is LINEAR light. An 8-bit target holds sRGB-encoded colour,
    // so the byte fallback must undo the transfer curve — alpha stays linear.
    const srgbLut = WebGL2Backend.srgbToLinearLut ??= (() => {
      const lut = new Float32Array(256);
      for (let v = 0; v < 256; v++) {
        const c = v / 255;
        lut[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }
      return lut;
    })();
    const out = new Float32Array(u8.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * row;
      const dst = y * row;
      for (let i = 0; i < row; i += 4) {
        out[dst + i] = srgbLut[u8[src + i]!]!;
        out[dst + i + 1] = srgbLut[u8[src + i + 1]!]!;
        out[dst + i + 2] = srgbLut[u8[src + i + 2]!]!;
        out[dst + i + 3] = u8[src + i + 3]! / 255;
      }
    }
    return out;
  }
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
    readonly format?: TextureFormat,
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
    // The environment map gets its OWN sampler on its OWN unit. Every other
    // sampler is broadcast (see below), and the env one must not be: it wraps
    // in u, and letting it reach unit 0 would silently switch every layer
    // texture from clamp to repeat.
    let envSampler: WebGLSampler | null = null;
    let envUnit = -1;
    for (const e of (group.native as { entries: BindGroupResource[] }).entries) {
      if ('buffer' in e) {
        const nb = e.buffer.native as NativeBuffer;
        if (e.offsetBytes || e.sizeBytes) gl.bindBufferRange(gl.UNIFORM_BUFFER, e.binding === 0 ? 0 : e.binding, nb.buffer, e.offsetBytes ?? 0, e.sizeBytes ?? 0);
        else gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, nb.buffer);
      } else if ('texture' in e) {
        gl.activeTexture(gl.TEXTURE0 + texIndex);
        gl.bindTexture(gl.TEXTURE_2D, glTexture(e.texture.native));
        const declared = this.pipeline?.texUniforms;
        const uni = declared && declared.length > 0
          ? declared[texIndex]
          : (texIndex === 0 ? this.pipeline?.texUniform : this.pipeline?.tex1Uniform);
        if (uni) gl.uniform1i(uni, texIndex);
        if (e.binding === ENV_TEXTURE_BINDING) envUnit = texIndex;
        texIndex += 1;
      } else if (e.binding === ENV_SAMPLER_BINDING) {
        envSampler = e.sampler.native as WebGLSampler;
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
    // AFTER the broadcast, so the env unit keeps the wrapping sampler even
    // when the draw also carries a layer sampler.
    if (envSampler && envUnit >= 0) gl.bindSampler(envUnit, envSampler);
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
  drawIndexed(indexCount: number, instanceCount = 1, firstIndex = 0): void {
    const gl = this.gl;
    const mode = this.pipeline ? topo(gl, this.pipeline.topology) : gl.TRIANGLES;
    const u16 = this.indexFormat === 'uint16';
    const type = u16 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    const offset = firstIndex * (u16 ? 2 : 4);
    if (instanceCount > 1) gl.drawElementsInstanced(mode, indexCount, type, offset, instanceCount);
    else gl.drawElements(mode, indexCount, type, offset);
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

  // ALPHA IS COVERAGE, and coverage composites `over` no matter what the
  // colour equation does. The plain blendFunc/blendEquation calls set BOTH
  // channels, so the additive and min/max modes dragged alpha along with the
  // colour: two opaque layers under 'add' wrote a = 2 into the float16 scene
  // target (floats don't clamp), and the alpha-aware encode blit then doubled
  // the composite — the root of the webgl2-vs-webgpu additive divergence
  // family (blend-add, light-rays, light-sweep, lens-flare, …). WebGPU's
  // table always blended alpha `over` (see WebGPUBackend.blendFor); this
  // mirrors it exactly, per channel.
  gl.blendEquationSeparate(
    blend === 'subtract' ? gl.FUNC_REVERSE_SUBTRACT
      : blend === 'darken' ? gl.MIN
        : blend === 'lighten' ? gl.MAX
          : gl.FUNC_ADD,
    gl.FUNC_ADD,
  );

  const alphaOver = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA] as const;
  switch (blend) {
    case 'add':
    case 'subtract':
    case 'darken':
    case 'lighten':
      gl.blendFuncSeparate(gl.ONE, gl.ONE, alphaOver[0], alphaOver[1]);
      break;
    case 'multiply':
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, alphaOver[0], alphaOver[1]);
      break;
    case 'screen':
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, alphaOver[0], alphaOver[1]);
      break;
    default:
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied over
  }
}
