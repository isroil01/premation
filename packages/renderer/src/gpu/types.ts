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
export type TextureFormat =
  | 'rgba8unorm'
  | 'rgba8unorm-srgb'
  | 'bgra8unorm'
  | 'rgba16float'
  | 'rgba32float'
  | 'r8unorm'
  | 'depth24plus';
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
  | {
      type: 'buffer';
      data: ArrayBufferView;
      width: number;
      height: number;
      /** Pixel layout of `data`. Default `rgba8unorm` (4 bytes/texel).
       *  `rgba32float` expects a Float32Array (or view) of length width*height*4. */
      format?: TextureFormat;
    }
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
  /** Display-referred sRGB content (footage, canvas rasters). Data textures
   *  (LUT strips, masks) omit this. Used for colour-management tagging; when
   *  `HARDWARE_SRGB_UPLOADS` is on, also selects `rgba8unorm-srgb`. */
  displayReferred?: boolean;
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

/**
 * `depth-texture` binds a render target's DEPTH texture (renderTargetDepthTexture)
 * for reading. WebGPU needs the distinction at layout time — a depth-format view
 * is only bindable where the layout says `unfilterable-float` (or `depth`), and
 * the default `texture` entry means filterable float, which rejects the bind
 * group. Shaders read it with textureLoad / texelFetch, never through a
 * filtering sampler (WebGL2 depth textures only guarantee NEAREST).
 */
export type BindingType = 'uniform-buffer' | 'storage-buffer' | 'texture' | 'depth-texture' | 'sampler';
export interface BindGroupLayoutEntry {
  binding: number;
  type: BindingType;
  stages: ShaderStage[];
}

/**
 * Bind slots the specular ENVIRONMENT MAP occupies on every lit-3d material.
 *
 * 7 and 8, deliberately past everything else: 3 is the mask texture, 4 a
 * plugin effect's origin texture, and 3-6 are the mesh PBR map set. A
 * reflection is a property of the SCENE rather than of the layer, so it sits
 * clear of every per-layer slot and cannot be renumbered by one arriving later.
 *
 * Declared here, not in `pipeline/uniforms.ts`, because the WebGL2 backend has
 * to recognise the SAMPLER slot by number (it binds the env sampler to the env
 * texture unit ALONE, where every other sampler is broadcast to all units) and
 * a backend must not reach up into the pipeline layer for a constant.
 */
export const ENV_TEXTURE_BINDING = 7;
export const ENV_SAMPLER_BINDING = 8;

/**
 * Bind slots the SHADOW MAP occupies on every lit-3d material.
 *
 * 9 and 10, immediately past the environment pair, for the same reason that
 * pair sits past everything else: a shadow map is a property of the SCENE's
 * lighting, not of the layer, so it must stay clear of the mask (3), a plugin
 * origin (4) and the mesh PBR set (3-6) and cannot be renumbered by a
 * per-layer slot arriving later.
 *
 * Declared beside the env pair, and for the same backend reason: the WebGL2
 * backend has to recognise the SAMPLER slot by number, because the shadow map
 * is the one texture in a lit draw that must be sampled NEAREST (its texels
 * are a 24-bit depth packed across rgb — bilinear blending of two packed
 * values is not a depth), while every other sampler is broadcast to all units.
 */
export const SHADOW_TEXTURE_BINDING = 9;
export const SHADOW_SAMPLER_BINDING = 10;

/**
 * Bind slots the AMBIENT-OCCLUSION map occupies on every lit-3d material.
 *
 * 11 and 12, immediately past the shadow pair, and for the third time the same
 * reason: AO is a property of the RUN — one screen-space buffer every receiver
 * in the depth group reads — not of the layer, so it sits past the mask (3), a
 * plugin origin (4) and the mesh PBR set (3-6) where no per-layer slot arriving
 * later can renumber it.
 *
 * Declared beside the other two because the WebGL2 backend must recognise the
 * SAMPLER slot by number as well: this one is LINEAR-clamp, and an unlit
 * material (solid3d) carries no layer sampler at all, so there is no broadcast
 * sampler for its AO unit to inherit. Without its own slot the unit would be
 * INCOMPLETE and sample (0,0,0,1) — black AO, i.e. every ambient term erased.
 */
export const AO_TEXTURE_BINDING = 11;
export const AO_SAMPLER_BINDING = 12;

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
  /**
   * GLSL sampler uniform names in TEXTURE-entry order (WebGL2 only; WebGPU
   * binds by number and ignores this). Set by materials with more than the two
   * textures the backend can name by itself — see `MaterialDescriptor.glslSamplers`.
   */
  samplerNames?: string[];
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
  float32Textures: boolean;
  timestampQueries: boolean;
}
