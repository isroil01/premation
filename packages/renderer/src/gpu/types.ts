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

/**
 * ## THE ALPHA INVARIANT
 *
 * **Every texture this renderer samples holds PREMULTIPLIED alpha** — uploaded
 * footage, canvas rasters, video frames and intermediate render targets alike,
 * on every backend, from every source kind.
 *
 * It is a requirement each backend enforces at its upload call, not a
 * description of what a browser happens to do: the defaults disagree across
 * source kinds and across backends, and leaving it undefined is how the same
 * project came to render different pixels on WebGPU and WebGL2.
 *
 * ### Why premultiplied
 *
 * Because it is the correct space to FILTER in. Bilinear and mipmap sampling
 * average neighbouring texels, and in straight space that averages the RGB of
 * transparent texels — arbitrary values, or zero for anything that came off a
 * canvas — so soft and magnified edges pick up a halo toward that colour.
 *
 * Measured on `alpha-filter-hard-edge`, a hard alpha edge magnified 30×: under
 * the previous STRAIGHT invariant the half-covered column read red 181 where
 * correct filtering predicts 243.8 — a 63-of-255-level dark halo, matching the
 * straight-space prediction to within one level. That measurement is why this
 * flipped.
 *
 * It also removes an asymmetry rather than adding one. WebGL2's
 * `UNPACK_PREMULTIPLY_ALPHA_WEBGL` can only MULTIPLY, never divide, so under a
 * straight invariant it was necessary but never sufficient and the real
 * conversion had to happen at decode. Multiplying is the only direction this
 * invariant ever needs.
 *
 * ### Where a FILE's own alpha mode is handled
 *
 * Here, via `alreadyPremultiplied` — not in the shader. `FootageInterpretation
 * .alpha` used to select one of six `-premul` shader variants; those are gone.
 * A straight file is multiplied on upload, a file that is already premultiplied
 * is passed through untouched, and both arrive premultiplied, which is what lets
 * one shader path serve every draw.
 *
 * Proven by: packages/render-tests/scripts/verify-alpha.mjs — `a straight source
 * composites LINEARLY in alpha` (the upload is the only thing that can make a
 * straight source read as quadratic) and the filtering-cost measurement on
 * `alpha-filter-hard-edge`.
 */
export type TextureSource = (
  | { type: 'bitmap'; bitmap: ImageBitmap }
  | { type: 'video'; video: HTMLVideoElement }
  | { type: 'buffer'; data: ArrayBufferView; width: number; height: number }
  | { type: 'canvas'; canvas: HTMLCanvasElement | OffscreenCanvas }
) & {
  /**
   * True when this source's bytes are ALREADY premultiplied but the source does
   * not DECLARE it, so the upload must pass them through untouched.
   *
   * The distinction is about the source's self-declaration, not about its
   * content, because that is what the upload APIs act on. Both
   * `UNPACK_PREMULTIPLY_ALPHA_WEBGL` and WebGPU's
   * `GPUCopyExternalImageDestInfo.premultipliedAlpha` mean *"the DESTINATION
   * shall be premultiplied"* — the browser converts from whatever the source
   * says it is. So under this invariant the honest answer is `true` almost
   * everywhere, and the flag exists only for the one case where the source lies:
   *
   *   a premultiplied FILE decoded with `premultiplyAlpha: 'none'` carries
   *   premultiplied bytes while reporting itself straight. Asking for a
   *   premultiplied destination would multiply it a second time.
   *
   * A 2D canvas needs nothing here: its store is premultiplied AND the browser
   * knows it, so a premultiplied destination is a no-op. Special-casing canvas
   * was tried and was wrong — it made the upload UN-premultiply the canvas,
   * handing the shader a straight texture it then divided as though premultiplied
   * (measured: 50% fill opacity rendered at 97.3% of full instead of 50%).
   */
  alreadyPremultiplied?: boolean;
};

/**
 * Should the upload leave this source's bytes exactly as they are?
 *
 * The single place the question is answered, so both backends agree. See the
 * alpha invariant on `TextureSource` — the answer is "no, convert" for every
 * honest source, and "yes, pass through" only for the one that misdeclares
 * itself.
 */
export function sourcePassesThrough(source: TextureSource): boolean {
  return source.alreadyPremultiplied === true;
}

export interface TextureDescriptor {
  label?: string;
  width: number;
  height: number;
  format: TextureFormat;
  mipmapped?: boolean;
  /** Marks the texture as a color attachment target. */
  renderable?: boolean;
  /** Texture will be uploaded from an external image (bitmap/canvas/video).
   *  WebGPU's copyExternalImageToTexture requires the destination to carry
   *  RENDER_ATTACHMENT usage, so backends must add it when this is set. */
  externalCopy?: boolean;
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
  /** Depth-tested pipeline (3D layer path). When set the pipeline is only
   *  valid inside a render pass that carries a depth attachment (WebGPU bakes
   *  the depth state into the pipeline; WebGL2 applies it at bind time). */
  depthTest?: boolean;
  /** Write depth as well as test it (defaults to `depthTest`). */
  depthWrite?: boolean;
  /**
   * MSAA sample count of the pass this pipeline draws into (defaults to 1).
   *
   * WebGPU validates this against the pass's attachments, so it belongs to the
   * pipeline; WebGL2 ignores it entirely.
   */
  samples?: number;
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
  /**
   * MSAA sample count (1 = off). Backends may clamp to their device maximum, or
   * ignore it entirely — a target is always readable as a single-sample texture,
   * so callers never have to branch on whether multisampling actually happened.
   *
   * This exists because the 3D path draws each face as its own alpha-blended
   * quad with SDF edge antialiasing. Two faces meeting along a shared edge each
   * contribute ~50% coverage there, and the nearer one writes depth, so the
   * farther one is rejected rather than filling in — leaving a visible seam
   * along every join. Resolving coverage at sample level is what removes it.
   */
  samples?: number;
}

/** A color attachment for a render pass — either the swapchain or a render target. */
export type ColorAttachment =
  | { target: 'surface'; clear?: Color }
  | { target: RenderTargetHandle; clear?: Color };

export interface RenderPassDescriptor {
  label?: string;
  color: ColorAttachment;
  /** Use the target's depth attachment for this pass (3D group rendering).
   *  Only valid when the color target was created with `depth: true`; every
   *  pipeline used inside such a pass must set `depthTest` (WebGPU requires
   *  pass/pipeline depth state to agree). `clearDepth` clears to the given
   *  value (1 = far) at pass start. */
  depth?: { clearDepth?: number };
}

export interface BackendCapabilities {
  kind: BackendKind;
  maxTextureSize: number;
  instancing: boolean;
  storageBuffers: boolean;
  float16Textures: boolean;
  timestampQueries: boolean;
}
