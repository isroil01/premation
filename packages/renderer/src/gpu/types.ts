/**
 * Backend-independent GPU value types. These are the *descriptions* and opaque
 * *handles* the renderer speaks; concrete backends (WebGPU/WebGL2/Null) map them
 * to their native objects. Nothing above the backend imports a native GPU type.
 */

import type { Color } from '../core/math/Color';

export type BackendKind = 'webgpu' | 'webgl2' | 'null';

// ── Opaque resource handles ───────────────────────────────────────
// Handles carry a numeric id + a brand so they can't be mixed up structurally.
export interface ResourceHandle<K extends string> {
  readonly kind: K;
  readonly id: number;
  /** Backend-private payload (native object). Never read above the backend. */
  readonly native?: unknown;
}
export type BufferHandle = ResourceHandle<'buffer'>;
export type TextureHandle = ResourceHandle<'texture'>;
export type SamplerHandle = ResourceHandle<'sampler'>;
export type ShaderModuleHandle = ResourceHandle<'shader'>;
export type PipelineHandle = ResourceHandle<'pipeline'>;
export type BindGroupHandle = ResourceHandle<'bindgroup'>;
export type RenderTargetHandle = ResourceHandle<'render-target'>;

// ── Enumerations (string unions map cleanly to both APIs) ─────────
export type BufferUsage = 'vertex' | 'index' | 'uniform' | 'storage' | 'copy';
export type IndexFormat = 'uint16' | 'uint32';
export type TextureFormat = 'rgba8unorm' | 'bgra8unorm' | 'rgba16float' | 'r8unorm' | 'depth24plus';
export type FilterMode = 'nearest' | 'linear';
export type AddressMode = 'clamp' | 'repeat' | 'mirror';
export type PrimitiveTopology = 'triangle-list' | 'triangle-strip' | 'line-list' | 'point-list';
export type ShaderStage = 'vertex' | 'fragment' | 'compute';

/** Portable blend modes; the backend expands them into concrete blend state. */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'add'
  | 'subtract'
  | 'darken'
  | 'lighten'
  | 'none';

// ── Descriptors ───────────────────────────────────────────────────
export interface BufferDescriptor {
  label?: string;
  sizeBytes: number;
  usage: BufferUsage[];
  /** Optional initial contents. */
  data?: ArrayBufferView;
}

export type TextureSource =
  | { type: 'bitmap'; bitmap: ImageBitmap }
  | { type: 'video'; video: HTMLVideoElement }
  | { type: 'buffer'; data: ArrayBufferView; width: number; height: number }
  | { type: 'canvas'; canvas: HTMLCanvasElement | OffscreenCanvas };

export interface TextureDescriptor {
  label?: string;
  width: number;
  height: number;
  format: TextureFormat;
  mipmapped?: boolean;
  /** Marks the texture as a color attachment target. */
  renderable?: boolean;
}

export interface SamplerDescriptor {
  label?: string;
  min?: FilterMode;
  mag?: FilterMode;
  addressU?: AddressMode;
  addressV?: AddressMode;
  mipmapped?: boolean;
}

export interface ShaderModuleDescriptor {
  label?: string;
  /** WGSL for WebGPU; GLSL ES 3.0 for WebGL2. Backend picks the matching field. */
  wgsl?: string;
  glsl?: { vertex: string; fragment: string };
}

export interface VertexAttribute {
  shaderLocation: number;
  offsetBytes: number;
  format: 'float32' | 'float32x2' | 'float32x3' | 'float32x4' | 'uint32';
}
export interface VertexBufferLayout {
  strideBytes: number;
  stepMode: 'vertex' | 'instance';
  attributes: VertexAttribute[];
}

export type BindingType = 'uniform-buffer' | 'storage-buffer' | 'texture' | 'sampler';
export interface BindGroupLayoutEntry {
  binding: number;
  type: BindingType;
  stages: ShaderStage[];
}

export interface PipelineDescriptor {
  label?: string;
  shader: ShaderModuleHandle;
  vertexEntry?: string;
  fragmentEntry?: string;
  buffers: VertexBufferLayout[];
  layout: BindGroupLayoutEntry[];
  topology: PrimitiveTopology;
  blend: BlendMode;
  colorFormat: TextureFormat;
  /** Optional depth attachment format for this pipeline. */
  depthFormat?: TextureFormat;
}

export type BindGroupResource =
  | { binding: number; buffer: BufferHandle; offsetBytes?: number; sizeBytes?: number }
  | { binding: number; texture: TextureHandle }
  | { binding: number; sampler: SamplerHandle };

export interface BindGroupDescriptor {
  label?: string;
  pipeline: PipelineHandle;
  entries: BindGroupResource[];
}

export interface RenderTargetDescriptor {
  label?: string;
  width: number;
  height: number;
  format: TextureFormat;
  depth?: boolean;
}

/** A color attachment for a render pass — either the swapchain or a render target. */
export type ColorAttachment =
  | { target: 'surface'; clear?: Color }
  | { target: RenderTargetHandle; clear?: Color };

export interface RenderPassDescriptor {
  label?: string;
  color: ColorAttachment;
}

export interface BackendCapabilities {
  kind: BackendKind;
  maxTextureSize: number;
  instancing: boolean;
  storageBuffers: boolean;
  float16Textures: boolean;
  timestampQueries: boolean;
}
