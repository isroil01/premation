/**
 * @motion/renderer — framework-independent rendering engine.
 *
 * WebGPU primary, WebGL2 fallback, Null (headless) for tests. No React, no DOM
 * manipulation, no timeline/animation logic — it renders a `FrameScene` and
 * nothing else. Public API surface below.
 */

// ── Engine façade + lifecycle ─────────────────────────────────────
export { Renderer, type RendererOptions, type FrameResult } from './core/renderer/Renderer';
export type { FrameInfo } from './core/Frame';

// ── Backends ──────────────────────────────────────────────────────
export type { RenderBackend, RenderPassEncoder, RenderSurface } from './gpu/RenderBackend';
export { NullBackend, type NullBackendStats, type RecordedDraw } from './gpu/backends/NullBackend';
export { WebGPUBackend } from './gpu/backends/WebGPUBackend';
export { WebGL2Backend } from './gpu/backends/WebGL2Backend';
export * from './gpu/types';

// ── Vector rasterizer seam (Phase 1) ──────────────────────────────
export {
  resolutionTier,
  continuousResolutionTier,
  maxContinuousTier,
  CONTINUOUS_RESOLUTION_TIERS,
  DEFAULT_MAX_RASTER_DIMENSION,
  DEFAULT_MAX_RASTER_PIXELS,
  paddingClass,
  rasterCacheKey,
  RESOLUTION_TIERS,
  type VectorRasterizer,
  type RasterRequest,
  type RasterResult,
} from './raster/VectorRasterizer';

// ── GPU resource management ───────────────────────────────────────
export {
  ResourceManager,
  type ResourceManagerOptions,
  type ResourceManagerStats,
} from './gpu/ResourceManager';

// ── Shaders / materials ───────────────────────────────────────────
export { ShaderRegistry } from './shaders/ShaderRegistry';
export { ShaderCache } from './shaders/ShaderCache';
export { BUILTIN_SHADERS, type ShaderSource } from './shaders/builtin';
export {
  LINEAR_WORKING_SPACE,
  LINEAR_INTERMEDIATE_STORAGE,
  HARDWARE_SRGB_UPLOADS,
  displayReferredUploadFormat,
  isSrgbTextureFormat,
  needsEncodeBlit,
  toWorkingColor,
} from './shaders/linearWorkingSpace';
export {
  setActiveColorPipeline,
  getActiveColorPipeline,
  DEFAULT_COLOR_PIPELINE,
  intermediateFloatFormat,
  type ColorPipelineConfig,
  type WorkingSpace,
  type DisplayTransform,
  type IntermediateBitDepth,
} from './shaders/colorPipeline';
export {
  MaterialSystem,
  SOLID_MATERIAL,
  TEXTURED_MATERIAL,
  type MaterialDescriptor,
} from './shaders/Material';

// ── Textures / geometry ───────────────────────────────────────────
export {
  DefaultTextureProvider,
  type TextureProvider,
  type ResolvedTexture,
} from './resources/TextureProvider';
export { QUAD_LAYOUT, QUAD_VERTEX_COUNT, unitQuadBuffer } from './resources/Geometry';

// ── Render graph + passes ─────────────────────────────────────────
export { RenderGraph, RenderGraphError, type RenderGraphExecuteArgs } from './rendergraph/RenderGraph';
export { RenderPass, SURFACE, type RenderPassContext, type RenderServices } from './rendergraph/RenderPass';
export * from './rendergraph/passes';

// ── Commands / pipeline ───────────────────────────────────────────
export { CommandBuffer, type DrawItem, type CommandBatch } from './commands/DrawCommand';
export { QuadRenderer, type DrawStats } from './pipeline/QuadRenderer';
export * from './pipeline/uniforms';

// ── Camera / viewport ─────────────────────────────────────────────
export { Camera2D, type CameraState } from './camera/Camera2D';
export {
  Viewport,
  type ViewportOptions,
  type ViewportOverlays,
  type Guide,
} from './viewport/Viewport';

// ── Scene input contract + adapter ────────────────────────────────
export {
  type FrameScene,
  type Renderable,
  type RenderableKind,
  type RenderableSdf,
  type RenderableGlass,
  type RenderableColorMatrix,
  type RenderableEffect,
  type CompositionInfo,
  type SceneLight3D,
  emptyScene,
  depthEligible3D,
} from './scene/FrameScene';
export { buildFrameScene, toRenderable, type SceneItemInput } from './integration/buildFrameScene';

// ── Math + utils ──────────────────────────────────────────────────
export { Mat3 } from './core/math/Mat3';
export {
  squareToQuad,
  project as projectHomography,
  invertProjective,
  isConvexQuad,
  isIdentityQuad,
  fitHomography,
  unitQuadThrough,
  UNIT_QUAD,
  type Quad,
} from './core/math/Homography';
export { Vec2 } from './core/math/Vec2';
export { Color } from './core/math/Color';
export { Rect, type Size } from './core/math/geometry';
export { Logger, type LogLevel } from './utils/Logger';
export { type Disposable, DisposalBag } from './utils/Disposable';
