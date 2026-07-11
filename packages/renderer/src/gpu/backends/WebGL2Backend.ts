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
  texUniform: WebGLUniformLocation | null;
}
interface NativeRenderTarget {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
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

  async initialize(surface?: RenderSurface): Promise<void> {
    if (!surface) throw new Error('WebGL2Backend requires a canvas surface');
    const gl = surface.canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true }) as GL | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.capabilities.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.vao = gl.createVertexArray();
    gl.enable(gl.BLEND);
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
    return h('buffer', { buffer, target } satisfies NativeBuffer);
  }
  writeBuffer(buffer: BufferHandle, byteOffset: number, data: ArrayBufferView): void {
    const gl = this.gl;
    const nb = buffer.native as NativeBuffer;
    gl.bindBuffer(nb.target, nb.buffer);
    gl.bufferSubData(nb.target, byteOffset, data as unknown as BufferSource);
  }
  destroyBuffer(buffer: BufferHandle): void {
    this.gl.deleteBuffer((buffer.native as NativeBuffer).buffer);
  }

  createTexture(desc: TextureDescriptor): TextureHandle {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, desc.width, desc.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
    this.gl.deleteTexture(texture.native as WebGLTexture);
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
    return h('sampler', sampler);
  }
  destroySampler(sampler: SamplerHandle): void {
    this.gl.deleteSampler(sampler.native as WebGLSampler);
  }

  createShaderModule(desc: ShaderModuleDescriptor): ShaderModuleHandle {
    if (!desc.glsl) throw new Error('WebGL2 requires GLSL source');
    const gl = this.gl;
    const program = link(gl, compile(gl, gl.VERTEX_SHADER, desc.glsl.vertex), compile(gl, gl.FRAGMENT_SHADER, desc.glsl.fragment));
    const blockIndex = gl.getUniformBlockIndex(program, 'Object');
    if (blockIndex !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, blockIndex, 0);
    return h('shader', { program } satisfies NativeProgram);
  }
  destroyShaderModule(shader: ShaderModuleHandle): void {
    this.gl.deleteProgram((shader.native as NativeProgram).program);
  }

  createPipeline(desc: PipelineDescriptor): PipelineHandle {
    const gl = this.gl;
    const program = (desc.shader.native as NativeProgram).program;
    const texUniform = gl.getUniformLocation(program, 'uTex');
    return h('pipeline', {
      program,
      blend: desc.blend,
      topology: desc.topology,
      layout: desc.buffers,
      texUniform,
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
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, desc.width, desc.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { kind: 'render-target', id: nextId(), native: { fbo, texture } satisfies NativeRenderTarget };
  }
  renderTargetTexture(target: RenderTargetHandle): TextureHandle {
    return { kind: 'texture', id: target.id, native: (target.native as NativeRenderTarget).texture };
  }
  destroyRenderTarget(target: RenderTargetHandle): void {
    const rt = target.native as NativeRenderTarget;
    this.gl.deleteFramebuffer(rt.fbo);
    this.gl.deleteTexture(rt.texture);
  }

  beginFrame(): void {}
  beginRenderPass(desc: RenderPassDescriptor): RenderPassEncoder {
    const gl = this.gl;
    const attach = desc.color;
    if (attach.target === 'surface') gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    else gl.bindFramebuffer(gl.FRAMEBUFFER, (attach.target.native as NativeRenderTarget).fbo);
    gl.bindVertexArray(this.vao);
    if (attach.clear) {
      gl.clearColor(attach.clear.r, attach.clear.g, attach.clear.b, attach.clear.a);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return new WebGL2PassEncoder(gl);
  }
  endFrame(): void {
    this.gl.bindVertexArray(null);
  }
  present(): void {}
  resize(width: number, height: number): void {
    this.gl.viewport(0, 0, width, height);
  }
  dispose(): void {
    if (this.vao) this.gl.deleteVertexArray(this.vao);
  }
}

class WebGL2PassEncoder implements RenderPassEncoder {
  private pipeline: NativePipeline | null = null;
  private vertexBuffer: NativeBuffer | null = null;

  constructor(private readonly gl: GL) {}

  setPipeline(pipeline: PipelineHandle): void {
    this.pipeline = pipeline.native as NativePipeline;
    this.gl.useProgram(this.pipeline.program);
    applyBlend(this.gl, this.pipeline.blend);
  }
  setBindGroup(_index: number, group: BindGroupHandle): void {
    const gl = this.gl;
    let unit = 0;
    for (const e of (group.native as { entries: BindGroupResource[] }).entries) {
      if ('buffer' in e) {
        const nb = e.buffer.native as NativeBuffer;
        if (e.offsetBytes || e.sizeBytes) gl.bindBufferRange(gl.UNIFORM_BUFFER, e.binding === 0 ? 0 : e.binding, nb.buffer, e.offsetBytes ?? 0, e.sizeBytes ?? 0);
        else gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, nb.buffer);
      } else if ('texture' in e) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, e.texture.native as WebGLTexture);
        if (this.pipeline?.texUniform) gl.uniform1i(this.pipeline.texUniform, unit);
        unit += 1;
      } else {
        gl.bindSampler(Math.max(0, unit - 1), e.sampler.native as WebGLSampler);
      }
    }
  }
  setVertexBuffer(_slot: number, buffer: BufferHandle): void {
    this.vertexBuffer = buffer.native as NativeBuffer;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer.buffer);
    if (this.pipeline) configureAttribs(gl, this.pipeline.layout);
  }
  setIndexBuffer(buffer: BufferHandle): void {
    const nb = buffer.native as NativeBuffer;
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, nb.buffer);
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
    if (instanceCount > 1) gl.drawElementsInstanced(mode, indexCount, gl.UNSIGNED_INT, 0, instanceCount);
    else gl.drawElements(mode, indexCount, gl.UNSIGNED_INT, 0);
  }
  end(): void {}
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
    default:
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied over
  }
  gl.blendEquation(gl.FUNC_ADD);
}
