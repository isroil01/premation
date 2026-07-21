/**
 * VectorRasterizer — the formal rasterizer seam (engine-unification Phase 1).
 *
 * ONE component turns resolved vector content (shape paths, text glyphs, masks,
 * gradients) into GPU textures; the GPU compositor then does all blending,
 * mattes, effects, and motion blur. This is the After Effects / Toon Boom
 * model: vectors rasterized on CPU, frames composed on GPU, one definition of
 * what a vector layer's pixels are.
 *
 * STATUS: contract + resolution-tier logic. The concrete `Canvas2DVectorRasterizer`
 * is produced by MOVING the raster functions currently duplicated in
 * `src/core/rendering/AppTextureProvider.ts` (rasterizePath/rasterizeText/
 * rasterizeLight/rasterizeGradient + mask paint) and `Canvas2DBackend.ts`
 * (shapePath/strokeShape/drawGlyphs/…) into a single implementation both
 * backends delegate to — closing the stroke/text drift the golden suite
 * measures. See the phase plan; this file defines the shape that work fills.
 *
 * Cache key = contentHash (from the snapshot; see src/core/rendering/contentHash.ts)
 * × resolution tier (below) × padding class. Transform-only animation reuses the
 * texture (contentHash unchanged); crossing a resolution tier (zoom / 4K export)
 * re-rasters at native scale instead of upscaling a stale texture.
 */

/** A GPU texture handle owned by the rasterizer's cache. Binds to the renderer's
 *  concrete texture handle when Canvas2DVectorRasterizer is implemented. */
export interface EngineTexture {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A fully-resolved drawable from the snapshot: geometry + fill/stroke/gradient +
 * glyph runs + mask geometry, plus the content hash the snapshot already carries
 * (RenderLayer.contentHash). NO document references — snapshot data only. Typed
 * loosely here; binds to RenderLayer's vector projection at implementation time.
 */
export interface ResolvedVectorDrawable {
  readonly contentHash: string;
  readonly width: number;
  readonly height: number;
  readonly [field: string]: unknown;
}

export interface RasterRequest {
  drawable: ResolvedVectorDrawable;
  /** Device pixels per scene unit for this raster (zoom / export scale aware). */
  resolutionScale: number;
  /** Extra padding in px around tight bounds (feather, stroke overshoot, mesh). */
  padding: number;
}

export interface RasterResult {
  texture: EngineTexture;
  /** Placement rect in scene units incl. padding. */
  uvRect: Rect;
  resolutionScale: number;
}

export interface RasterStats {
  textures: number;
  bytes: number;
  hits: number;
  misses: number;
}

export interface VectorRasterizer {
  /** Cache-aware; the hot path must be a lookup (contentHash × tier × padding). */
  rasterize(req: RasterRequest): RasterResult;
  invalidate(contentHash: string): void;
  stats(): RasterStats;
}

// ── Resolution tiers ────────────────────────────────────────────────────────
// Quantize the target scale to discrete steps so a continuous zoom re-rasters
// only when it crosses a tier (not every frame), while a 4K export still gets a
// native-resolution raster instead of upscaling a viewport-resolution texture.

/** Discrete rasterization scales. A drawable is rastered at its box × tier. */
export const RESOLUTION_TIERS = [0.5, 1, 2, 4] as const;

/**
 * The tier to rasterize at for a target device scale: the smallest tier that is
 * >= the requested scale (round UP so content is never softer than requested),
 * clamped to the tier range. So scale 1.0 → 1, 1.3 → 2, 0.4 → 0.5, 6 → 4.
 */
export function resolutionTier(scale: number): number {
  if (!(scale > 0) || Number.isNaN(scale)) return 1;
  for (const t of RESOLUTION_TIERS) {
    if (scale <= t) return t;
  }
  return RESOLUTION_TIERS[RESOLUTION_TIERS.length - 1]!;
}

/**
 * Padding class bucket (px) — coarse buckets so feather/stroke-overshoot
 * variations don't fragment the cache into near-duplicate entries. Rounds a
 * padding request up to the next bucket.
 */
export const PADDING_CLASSES = [0, 8, 24, 64] as const;

export function paddingClass(padding: number): number {
  const p = Math.max(0, padding || 0);
  for (const c of PADDING_CLASSES) {
    if (p <= c) return c;
  }
  return PADDING_CLASSES[PADDING_CLASSES.length - 1]!;
}

/** The full cache key for a raster: content × tier × padding class. */
export function rasterCacheKey(contentHash: string, scale: number, padding: number): string {
  return `${contentHash}@${resolutionTier(scale)}~${paddingClass(padding)}`;
}
